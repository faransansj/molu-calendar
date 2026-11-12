import {
  PUBLICATION_ID,
  type PublicationSnapshot,
  type PublishedManifest,
} from "../lib/admin/publication.ts";
import { UPLOAD_NAME } from "../lib/admin/overrides.ts";
import { requirePublisher, requireSession, type ServerEnv } from "./auth.ts";
import {
  createPublication,
  getPublication,
  publicationStatus,
  transitionPublication,
} from "./db.ts";
import { loadFeed } from "./feed.ts";
import { error, HttpError, json, readJson, response } from "./http.ts";

export async function uploadedImage(
  env: ServerEnv,
  name: string,
): Promise<Response> {
  const object = await env.IMAGES.get(`uploads/${name}`);
  if (!object) return error(404, "not-found");
  return response(object.body, 200, {
    "Content-Type":
      object.httpMetadata?.contentType ?? "application/octet-stream",
    "Content-Length": String(object.size),
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
}

async function livePublication(
  env: ServerEnv,
): Promise<PublicationSnapshot | null> {
  // The static deployment, not callback ordering in D1, identifies what is live.
  // Read through this deployment's binding each time; never cache across deploys.
  let manifest: PublishedManifest;
  try {
    const asset = await env.ASSETS.fetch(
      "https://assets.local/data/published.json",
    );
    if (!asset.ok) throw new Error("Missing deployed manifest");
    const value: unknown = await asset.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("publication" in value) ||
      !("overrides" in value) ||
      !Array.isArray(value.overrides)
    ) {
      throw new Error("Invalid deployed manifest");
    }
    const marker = value.publication;
    if (
      marker !== null &&
      (!marker ||
        typeof marker !== "object" ||
        !("id" in marker) ||
        typeof marker.id !== "string" ||
        !PUBLICATION_ID.test(marker.id) ||
        !("revision" in marker) ||
        typeof marker.revision !== "number" ||
        !Number.isSafeInteger(marker.revision) ||
        marker.revision < 0)
    ) {
      throw new Error("Invalid deployed marker");
    }
    if (marker === null && value.overrides.length !== 0) {
      throw new Error("Unidentified deployed overrides");
    }
    manifest = value as PublishedManifest;
  } catch {
    throw new HttpError(503, "deployed-unavailable");
  }
  if (manifest.publication === null) return null;
  const snapshot = await getPublication(env.DB, manifest.publication.id);
  if (
    !snapshot ||
    snapshot.publication.revision !== manifest.publication.revision ||
    (snapshot.publication.state !== "building" &&
      snapshot.publication.state !== "published")
  ) {
    throw new HttpError(503, "deployed-unavailable");
  }
  if (snapshot.publication.state === "building") {
    snapshot.publication = await transitionPublication(
      env.DB,
      snapshot.publication.id,
      "published",
    );
  }
  return snapshot;
}

export async function publicationRoute(
  request: Request,
  env: ServerEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  if (
    pathname === "/api/admin/publication" ||
    pathname === "/api/admin/publish"
  ) {
    const expected = pathname === "/api/admin/publication" ? "GET" : "POST";
    if (method !== expected) return error(405, "method-not-allowed");
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    if (method === "GET") {
      const live = await livePublication(env);
      return json(await publicationStatus(env.DB, live?.publication ?? null));
    }
    const body = await readJson(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0
    ) {
      return error(400, "bad-request");
    }
    // Check every production prerequisite before recording a queued release.
    const repository = env.GITHUB_REPOSITORY;
    const ref = env.GITHUB_REF ?? "deploy";
    if (
      !env.PUBLISH_TOKEN ||
      /\s/.test(env.PUBLISH_TOKEN) ||
      env.PUBLISH_TOKEN.length > 8185 ||
      !env.GITHUB_TOKEN ||
      /\s/.test(env.GITHUB_TOKEN) ||
      !repository ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(
        repository,
      ) ||
      !ref.trim() ||
      /\p{Cc}/u.test(ref)
    ) {
      return error(503, "publishing-disabled");
    }
    await livePublication(env);
    const snapshot = await createPublication(
      env.DB,
      await loadFeed(env.ASSETS),
    );
    let accepted = false;
    try {
      const dispatched = await fetch(
        `https://api.github.com/repos/${repository}/actions/workflows/update-calendar.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "molu-calendar-publisher",
          },
          body: JSON.stringify({
            ref,
            inputs: { publication_id: snapshot.publication.id },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
      accepted = dispatched.status === 204;
      await dispatched.body?.cancel();
    } catch {
      // Do not return GitHub response bodies, credentials, or infrastructure details.
    }
    if (!accepted) {
      await transitionPublication(env.DB, snapshot.publication.id, "failed");
      return error(502, "publish-failed");
    }
    return json({ publication: snapshot.publication });
  }

  if (!pathname.startsWith("/api/publish/")) return null;
  const denied = await requirePublisher(request, env);
  if (denied) return denied;
  if (pathname === "/api/publish/deployed") {
    if (method !== "GET") return error(405, "method-not-allowed");
    return json({ snapshot: await livePublication(env) });
  }
  if (pathname === "/api/publish/snapshot") {
    if (method !== "POST") return error(405, "method-not-allowed");
    const body = await readJson(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0
    ) {
      return error(400, "bad-request");
    }
    await livePublication(env);
    return json(await createPublication(env.DB, await loadFeed(env.ASSETS)));
  }
  const releasePath =
    /^\/api\/publish\/releases\/([^/]+)(?:\/(status|images\/([^/]+)))?$/.exec(
      pathname,
    );
  if (!releasePath || !PUBLICATION_ID.test(releasePath[1]!))
    return error(404, "not-found");
  const id = releasePath[1]!;
  if (releasePath[2] === "status") {
    if (method !== "PUT") return error(405, "method-not-allowed");
    const body = await readJson(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("state" in body) ||
      (body.state !== "building" &&
        body.state !== "published" &&
        body.state !== "failed")
    ) {
      return error(400, "bad-request");
    }
    if (body.state !== "building") {
      const live = await livePublication(env);
      if (body.state === "published" && live?.publication.id !== id) {
        return error(409, "not-deployed");
      }
      // A failed completion request cannot demote an actually deployed release.
      if (live?.publication.id === id) {
        return json({ publication: live.publication });
      }
    }
    return json({
      publication: await transitionPublication(env.DB, id, body.state),
    });
  }
  if (method !== "GET") return error(405, "method-not-allowed");
  const snapshot = await getPublication(env.DB, id);
  if (!snapshot) return error(404, "not-found");
  const name = releasePath[3];
  if (name !== undefined) {
    if (
      !UPLOAD_NAME.test(name) ||
      !snapshot.overrides.some((override) => override.image?.upload === name)
    ) {
      return error(404, "not-found");
    }
    return uploadedImage(env, name);
  }
  return json(snapshot);
}
