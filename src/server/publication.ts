import { requireSession, type ServerEnv } from "./auth.ts";
import { createPublication, publicationStatus } from "./db.ts";
import { error, json, readJson, response } from "./http.ts";

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

export async function publicationRoute(
  request: Request,
  env: ServerEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (
    pathname !== "/api/admin/publication" &&
    pathname !== "/api/admin/publish"
  )
    return null;
  const expected = pathname === "/api/admin/publication" ? "GET" : "POST";
  if (request.method !== expected) return error(405, "method-not-allowed");
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  if (request.method === "GET") return json(await publicationStatus(env.DB));
  const body = await readJson(request);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 0
  )
    return error(400, "bad-request");
  const snapshot = await createPublication(env.DB);
  return json({ publication: snapshot.publication });
}
