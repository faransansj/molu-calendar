import { LOGIN_WINDOW_MS, loginDecision } from "../lib/admin/limits.ts";
import { verifyPassword } from "../lib/admin/password.ts";
import {
  addFailure,
  clearFailures,
  createSession,
  deleteSession,
  ensureSchema,
  failures,
  findSession,
  prune,
} from "./db.ts";
import {
  error,
  IMAGE_LIMIT,
  JSON_LIMIT,
  readBody,
  readJson,
  response,
} from "./http.ts";

export type ServerEnv = Env & {
  ADMIN_PASSWORD_HASH?: string;
  PUBLISH_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_REF?: string;
};

const COOKIE = "__Host-molu_admin";
const SESSION_SECONDS = 8 * 60 * 60;

export async function sha256hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function sessionToken(request: Request): string | null {
  let token: string | null = null;
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const cookie = part.trim();
    if (!cookie.startsWith(`${COOKIE}=`)) continue;
    if (token !== null) return null;
    token = cookie.slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  }
  return token;
}

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export async function requireSession(
  request: Request,
  env: ServerEnv,
): Promise<string | Response> {
  const token = sessionToken(request);
  if (!token) return error(401, "unauthorized");
  const hash = await sha256hex(token);
  if (!(await findSession(env.DB, hash, Date.now()))) {
    return error(401, "unauthorized");
  }
  return hash;
}

export async function requirePublisher(
  request: Request,
  env: ServerEnv,
): Promise<Response | null> {
  // CI uses only bearer credentials. Browser origins are never accepted here.
  if (request.headers.has("Origin")) return error(403, "forbidden");
  if (
    !env.PUBLISH_TOKEN ||
    /\s/.test(env.PUBLISH_TOKEN) ||
    env.PUBLISH_TOKEN.length > 8185
  )
    return error(503, "publishing-disabled");
  const authorization = request.headers.get("Authorization") ?? "";
  if (authorization.length > 8192) return error(401, "unauthorized");
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return error(401, "unauthorized");
  const [supplied, expected] = await Promise.all([
    sha256hex(match[1]!),
    sha256hex(env.PUBLISH_TOKEN),
  ]);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (difference !== 0) return error(401, "unauthorized");
  if (request.method !== "GET") {
    const contentType = request.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") return error(400, "bad-request");
    const length = request.headers.get("Content-Length");
    if (length !== null) {
      if (!/^\d+$/.test(length)) return error(400, "bad-request");
      if (
        !Number.isSafeInteger(Number(length)) ||
        Number(length) > JSON_LIMIT
      ) {
        return error(413, "payload-too-large");
      }
    }
  }
  return null;
}

export function guardMutation(request: Request): Response | null {
  const url = new URL(request.url);
  if (
    request.headers.get("Origin") !== url.origin ||
    request.headers.get("X-MOLU-Admin") !== "1"
  )
    return error(403, "forbidden");
  const length = request.headers.get("Content-Length");
  if (length === null) return error(411, "length-required");
  if (!/^\d+$/.test(length)) return error(400, "bad-request");
  const imageUpload =
    request.method === "PUT" &&
    /^\/api\/admin\/events\/[^/]+\/image$/.test(url.pathname);
  const limit = imageUpload ? IMAGE_LIMIT : JSON_LIMIT;
  const size = Number(length);
  if (!Number.isSafeInteger(size) || size > limit) {
    return error(413, "payload-too-large");
  }
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    (imageUpload && contentType !== "multipart/form-data") ||
    (!imageUpload && contentType !== "application/json")
  )
    return error(400, "bad-request");
  return null;
}

export async function login(
  request: Request,
  env: ServerEnv,
): Promise<Response> {
  await ensureSchema(env.DB);
  const now = Date.now();
  await prune(env.DB, now);
  const bucket = `ip:${await sha256hex(request.headers.get("CF-Connecting-IP") ?? "unknown")}`;
  const since = now - LOGIN_WINDOW_MS;
  const [ipFailures, globalFailures] = await Promise.all([
    failures(env.DB, bucket, since),
    failures(env.DB, "all", since),
  ]);
  const decision = loginDecision(ipFailures, globalFailures, now);
  if (!decision.allowed) {
    return error(
      429,
      "too-many-attempts",
      {
        retry_after: decision.retryAfter,
      },
      { "Retry-After": String(decision.retryAfter) },
    );
  }
  if (!env.ADMIN_PASSWORD_HASH) return error(503, "admin-disabled");
  const body = await readJson(request);
  if (
    !body ||
    typeof body !== "object" ||
    Object.keys(body).length !== 1 ||
    !("password" in body) ||
    typeof body.password !== "string" ||
    body.password.length < 1 ||
    body.password.length > 64
  )
    return error(400, "bad-request");
  if (!(await verifyPassword(body.password, env.ADMIN_PASSWORD_HASH))) {
    await Promise.all([
      addFailure(env.DB, bucket, now),
      addFailure(env.DB, "all", now),
    ]);
    return error(401, "invalid-password", {
      remaining: decision.remaining - 1,
    });
  }
  await clearFailures(env.DB, bucket);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  await createSession(
    env.DB,
    await sha256hex(token),
    now + SESSION_SECONDS * 1000,
  );
  return response(null, 204, {
    "Set-Cookie": sessionCookie(token, SESSION_SECONDS),
  });
}

export async function logout(
  request: Request,
  env: ServerEnv,
): Promise<Response> {
  await readBody(request, JSON_LIMIT);
  const token = sessionToken(request);
  if (token) await deleteSession(env.DB, await sha256hex(token));
  return response(null, 204, { "Set-Cookie": sessionCookie("", 0) });
}
