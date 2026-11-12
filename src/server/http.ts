const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

export type ErrorCode =
  | "bad-request"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "method-not-allowed"
  | "length-required"
  | "payload-too-large"
  | "unsupported-image"
  | "invalid-crop"
  | "invalid-schedule"
  | "invalid-password"
  | "too-many-attempts"
  | "admin-disabled"
  | "publishing-disabled"
  | "publish-failed"
  | "publish-busy"
  | "stage-conflict"
  | "deployed-unavailable"
  | "not-deployed"
  | "invalid-transition";

export function response(
  body: BodyInit | null,
  status: number,
  extra?: HeadersInit,
): Response {
  const headers = new Headers(API_HEADERS);
  if (extra)
    new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(body, { status, headers });
}

export function json(
  body: unknown,
  status = 200,
  extra?: HeadersInit,
): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return response(JSON.stringify(body), status, headers);
}

export function error(
  status: number,
  code: ErrorCode,
  extra?: Record<string, unknown>,
  headers?: HeadersInit,
): Response {
  return json({ error: code, ...extra }, status, headers);
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const JSON_LIMIT = 8 * 1024;
export const IMAGE_LIMIT = 6 * 1024 * 1024;

// Enforce the actual byte count too: Content-Length is not a trusted bound.
export async function readBody(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "payload-too-large");
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof HttpError) throw cause;
    throw new HttpError(400, "bad-request");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJson(request: Request): Promise<unknown> {
  const bytes = await readBody(request, JSON_LIMIT);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new HttpError(400, "bad-request");
  }
}

export async function readForm(request: Request): Promise<FormData> {
  const bytes = await readBody(request, IMAGE_LIMIT);
  try {
    return await new Response(bytes, {
      headers: { "Content-Type": request.headers.get("Content-Type") ?? "" },
    }).formData();
  } catch {
    throw new HttpError(400, "bad-request");
  }
}
