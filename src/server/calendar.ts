import { CATEGORY_KEYS } from "../lib/calendar/feed.ts";
import { UPLOAD_NAME } from "../lib/admin/overrides.ts";
import { readCalendar, ensureSchema } from "./calendar-store.ts";
import { error, HttpError, response } from "./http.ts";
import type { ServerEnv } from "./auth.ts";

function matches(request: Request, etag: string): boolean {
  return (request.headers.get("If-None-Match") ?? "")
    .split(",")
    .some(
      (value) =>
        value.trim() === "*" || value.trim().replace(/^W\//, "") === etag,
    );
}

export async function calendarRoute(
  request: Request,
  env: ServerEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const feed = /^\/feeds\/([^/]+)\.ics$/.exec(pathname);
  const image = /^\/resource\/admin\/([^/]+)$/.exec(pathname);
  const api = pathname === "/api/calendar";
  const official = pathname === "/data/events.json";
  const published = pathname === "/data/published.json";
  if (
    !api &&
    !official &&
    !published &&
    !feed &&
    !image &&
    !pathname.startsWith("/feeds/") &&
    !pathname.startsWith("/resource/admin/")
  )
    return null;
  const cors =
    official || !!feed ? { "Access-Control-Allow-Origin": "*" } : undefined;
  if (request.method !== "GET" && request.method !== "HEAD")
    return error(405, "method-not-allowed", undefined, cors);
  if (
    pathname.startsWith("/feeds/") &&
    (!feed || !["all", "game", ...CATEGORY_KEYS].includes(feed[1]!))
  )
    return error(404, "not-found", undefined, cors);
  if (pathname.startsWith("/resource/admin/")) {
    if (!image || !UPLOAD_NAME.test(image[1]!)) return error(404, "not-found");
    await ensureSchema(env.DB);
    const name = image[1]!;
    const membership = await env.DB.prepare(
      "SELECT 1 AS found FROM published_images i JOIN publications p ON p.id=i.publication_id AND p.state='published' WHERE i.upload=? LIMIT 1",
    )
      .bind(name)
      .first();
    if (!membership) return error(404, "not-found");
    const key = `uploads/${name}`;
    let object: R2Object | null;
    let body: ReadableStream | null = null;
    if (request.method === "HEAD") object = await env.IMAGES.head(key);
    else {
      const fetched = await env.IMAGES.get(key);
      object = fetched;
      body = fetched?.body ?? null;
    }
    if (!object) return error(404, "not-found");
    const headers = {
      "Content-Type":
        object.httpMetadata?.contentType ??
        (name.endsWith(".png")
          ? "image/png"
          : name.endsWith(".jpg")
            ? "image/jpeg"
            : "image/webp"),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ETag: object.httpEtag,
    };
    if (matches(request, object.httpEtag)) {
      await body?.cancel();
      return response(null, 304, headers);
    }
    return response(body, 200, {
      ...headers,
      "Content-Length": String(object.size),
    });
  }
  try {
    const path = published
      ? null
      : feed
        ? `feeds/${feed[1]}.ics`
        : "data/events.json";
    const current = await readCalendar(env.DB, path);
    const etag = `"${current.feedId}${api || published ? `-${current.publishedId ?? "none"}` : feed ? `-${current.artifact!.sha256}` : ""}"`;
    const headers = {
      "Content-Type": feed
        ? "text/calendar; charset=utf-8"
        : "application/json; charset=utf-8",
      "Cache-Control": "no-cache, must-revalidate",
      ETag: etag,
      ...cors,
    };
    if (matches(request, etag)) return response(null, 304, headers);
    const body = api
      ? `{"feed_id":${JSON.stringify(current.feedId)},"feed":${current.body},"published":${current.publishedJson}}`
      : published
        ? current.publishedJson
        : current.body;
    return response(request.method === "HEAD" ? null : body, 200, headers);
  } catch (cause) {
    if (cause instanceof HttpError)
      return error(cause.status, cause.code, undefined, cors);
    throw cause;
  }
}
