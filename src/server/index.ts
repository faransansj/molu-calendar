import {
  EVENT_ID,
  UPLOAD_NAME,
  validateCrop,
  validateSchedule,
  type EventOverride,
} from "../lib/admin/overrides.ts";
import { MAX_UPLOAD_BYTES, sniffImage } from "../lib/admin/images.ts";
import {
  guardMutation,
  login,
  logout,
  requireSession,
  type ServerEnv,
} from "./auth.ts";
import {
  getOverride,
  listOverrides,
  saveOverride,
  uploadReferenced,
} from "./db.ts";
import { loadFeed } from "./feed.ts";
import { calendarRoute } from "./calendar.ts";
import { publicationRoute, uploadedImage } from "./publication.ts";
import {
  error,
  HttpError,
  json,
  JSON_LIMIT,
  readBody,
  readForm,
  readJson,
} from "./http.ts";

async function route(request: Request, env: ServerEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  if (
    method === "GET" &&
    /^\/vendor\/litert-lm\/0\.17\.1\/litertlm_wasm_(?:compat_)?asyncify_internal\.wasm$/.test(
      pathname,
    )
  ) {
    const assetUrl = new URL(request.url);
    assetUrl.pathname += ".gz";
    const asset = await env.ASSETS.fetch(new Request(assetUrl));
    if (!asset.ok) return asset;
    const headers = new Headers(asset.headers);
    headers.set("Content-Type", "application/wasm");
    headers.set("Content-Encoding", "gzip");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(asset.body, {
      status: 200,
      headers,
      encodeBody: "manual",
    });
  }
  const calendar = await calendarRoute(request, env);
  if (calendar) return calendar;
  if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (pathname.startsWith("/api/admin/") && method !== "GET") {
    const denied = guardMutation(request);
    if (denied) return denied;
  }

  const publication = await publicationRoute(request, env);
  if (publication) return publication;

  if (pathname === "/api/admin/overrides") {
    if (method !== "GET") return error(405, "method-not-allowed");
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const feed = await loadFeed(env.DB);
    return json({ overrides: await listOverrides(env.DB, feed.events) });
  }

  const imagePath = /^\/api\/images\/([^/]+)$/.exec(pathname);
  if (imagePath) {
    const name = imagePath[1]!;
    if (!UPLOAD_NAME.test(name)) return error(404, "not-found");
    if (method !== "GET") return error(405, "method-not-allowed");
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    return uploadedImage(env, name);
  }

  if (pathname === "/api/admin/session") {
    if (method !== "GET") return error(405, "method-not-allowed");
    return json({
      admin: typeof (await requireSession(request, env)) === "string",
    });
  }
  if (pathname === "/api/admin/login") {
    if (method !== "POST") return error(405, "method-not-allowed");
    return login(request, env);
  }
  if (pathname === "/api/admin/logout") {
    if (method !== "POST") return error(405, "method-not-allowed");
    return logout(request, env);
  }

  const eventPath = /^\/api\/admin\/events\/([^/]+)\/(schedule|image)$/.exec(
    pathname,
  );
  if (!eventPath) return error(404, "not-found");
  const id = eventPath[1]!;
  const field = eventPath[2] === "image" ? "image" : "schedule";
  if (!EVENT_ID.test(id)) return error(404, "not-found");
  if (method !== "PUT" && method !== "DELETE") {
    return error(405, "method-not-allowed");
  }
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const feed = await loadFeed(env.DB);
  if (request.headers.get("X-MOLU-Feed") !== feed.id)
    return error(409, "stage-conflict");
  const event = feed.events.get(id);
  if (!event) return error(404, "not-found");
  const previous = await getOverride(env.DB, id, feed.events);

  if (method === "DELETE") {
    await readBody(request, JSON_LIMIT);
    const saved = await saveOverride(
      env.DB,
      id,
      field,
      null,
      feed.id,
      feed.events,
      previous?.image ?? null,
    );
    // A retained release owns its uploaded images even after a staged restore.
    if (
      field === "image" &&
      previous?.image?.upload &&
      !(await uploadReferenced(env.DB, previous.image.upload))
    ) {
      await env.IMAGES.delete(`uploads/${previous.image.upload}`);
    }
    return json({ override: saved });
  }

  if (field === "schedule") {
    const checked = validateSchedule(await readJson(request), event);
    if (!checked.ok) {
      return error(400, "invalid-schedule", { message: checked.message });
    }
    return json({
      override: await saveOverride(
        env.DB,
        id,
        field,
        checked.value,
        feed.id,
        feed.events,
      ),
    });
  }

  const form = await readForm(request);
  if (form.getAll("crop").length > 1 || form.getAll("file").length > 1)
    return error(400, "bad-request");
  for (const key of form.keys()) {
    if (key !== "crop" && key !== "file") return error(400, "bad-request");
  }
  const cropField = form.get("crop");
  let cropValue: unknown;
  try {
    cropValue = typeof cropField === "string" ? JSON.parse(cropField) : null;
  } catch {
    return error(400, "invalid-crop");
  }
  const crop = validateCrop(cropValue);
  if (!crop) return error(400, "invalid-crop");
  const file = form.get("file");
  if (file !== null && !(file instanceof Blob))
    return error(400, "bad-request");
  let uploaded: string | null = null;
  if (file) {
    if (file.size > MAX_UPLOAD_BYTES) return error(413, "payload-too-large");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = sniffImage(bytes);
    if (!image) return error(415, "unsupported-image");
    uploaded = `${crypto.randomUUID()}.${image.ext}`;
    await env.IMAGES.put(`uploads/${uploaded}`, bytes, {
      httpMetadata: { contentType: image.type },
    });
  }
  const image = {
    upload: uploaded ?? previous?.image?.upload ?? null,
    crop,
  };
  let saved: EventOverride | null;
  try {
    saved = await saveOverride(
      env.DB,
      id,
      field,
      image,
      feed.id,
      feed.events,
      previous?.image ?? null,
    );
  } catch (cause) {
    if (uploaded && !(await uploadReferenced(env.DB, uploaded))) {
      await env.IMAGES.delete(`uploads/${uploaded}`);
    }
    throw cause;
  }
  if (
    uploaded &&
    previous?.image?.upload &&
    !(await uploadReferenced(env.DB, previous.image.upload))
  ) {
    await env.IMAGES.delete(`uploads/${previous.image.upload}`);
  }
  return json({ override: saved });
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (cause) {
      if (cause instanceof HttpError) return error(cause.status, cause.code);
      // Never expose parser, storage, binding, or crypto exception details.
      return error(500, "bad-request");
    }
  },
} satisfies ExportedHandler<ServerEnv>;
