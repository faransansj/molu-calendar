import { sitePath } from "../urls.ts";
import type {
  EventOverride,
  ImageCrop,
  ScheduleOverride,
} from "./overrides.ts";
import type { Publication, PublicationStatus } from "./publication.ts";

interface ErrorDetails {
  message?: string;
  retry_after?: number;
  remaining?: number;
}

export class AdminError extends Error {
  code: string;
  status: number;
  retryAfter?: number;
  remaining?: number;

  constructor(code: string, status: number, details: ErrorDetails = {}) {
    const messages: Record<string, string> = {
      unauthorized: "관리자 세션이 만료됐어요. 다시 켜 주세요.",
      "unsupported-image": "PNG·JPEG·WebP 이미지만 올릴 수 있어요.",
      "payload-too-large": "이미지는 5MB 이하여야 해요.",
      offline: "관리 서버에 연결하지 못했어요.",
      "calendar-unavailable":
        "현재 일정을 불러오지 못했어요. 다시 시도해 주세요.",
      "publication-too-large":
        "게시할 수정이 너무 커요. 스테이지 내용을 줄인 뒤 다시 시도해 주세요.",
      "stage-conflict":
        "공식 일정이나 다른 수정과 겹쳤어요. 페이지를 새로 불러온 뒤 저장해 주세요.",
    };
    super(
      (code === "invalid-schedule" ? details.message : messages[code]) ??
        "저장하지 못했어요.",
    );
    this.name = "AdminError";
    this.code = code;
    this.status = status;
    this.retryAfter = details.retry_after;
    this.remaining = details.remaining;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(sitePath(`api/${path}`), {
      ...init,
      credentials: "same-origin",
    });
  } catch {
    throw new AdminError("offline", 0);
  }
  if (!response.ok) {
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = parsed as Record<string, unknown>;
    } catch {
      // Preserve the HTTP status even when a proxy returns a non-JSON error.
    }
    throw new AdminError(
      typeof body.error === "string" ? body.error : "bad-request",
      response.status,
      {
        message: typeof body.message === "string" ? body.message : undefined,
        retry_after:
          typeof body.retry_after === "number" ? body.retry_after : undefined,
        remaining:
          typeof body.remaining === "number" ? body.remaining : undefined,
      },
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    // Astro's dev server serves HTML at API paths when no Worker is running.
    throw new AdminError("offline", 0);
  }
}

function jsonMutation(
  method: string,
  body: unknown = {},
  feedId?: string,
): RequestInit {
  return {
    method,
    headers: {
      "X-MOLU-Admin": "1",
      "Content-Type": "application/json",
      ...(feedId === undefined ? {} : { "X-MOLU-Feed": feedId }),
    },
    body: JSON.stringify(body),
  };
}

export async function listOverrides(): Promise<EventOverride[]> {
  const body = await request<{ overrides: EventOverride[] }>("admin/overrides");
  if (!body || !Array.isArray(body.overrides))
    throw new AdminError("offline", 0);
  return body.overrides;
}

export async function getSession(): Promise<boolean> {
  const body = await request<{ admin: boolean }>("admin/session");
  if (!body || typeof body.admin !== "boolean")
    throw new AdminError("offline", 0);
  return body.admin;
}

export function getPublication(): Promise<PublicationStatus> {
  return request("admin/publication");
}

export async function publish(): Promise<Publication> {
  const body = await request<{ publication: Publication }>(
    "admin/publish",
    jsonMutation("POST"),
  );
  return body.publication;
}

export function login(password: string): Promise<void> {
  return request("admin/login", jsonMutation("POST", { password }));
}

export function logout(): Promise<void> {
  return request("admin/logout", jsonMutation("POST"));
}

interface OverrideResponse {
  override: EventOverride | null;
}

function eventPath(id: string, field: "image" | "schedule"): string {
  return `admin/events/${encodeURIComponent(id)}/${field}`;
}

export async function saveSchedule(
  id: string,
  schedule: ScheduleOverride,
  feedId: string,
): Promise<EventOverride | null> {
  const body = await request<OverrideResponse>(
    eventPath(id, "schedule"),
    jsonMutation("PUT", schedule, feedId),
  );
  return body.override;
}

export async function restoreSchedule(
  id: string,
  feedId: string,
): Promise<EventOverride | null> {
  const body = await request<OverrideResponse>(
    eventPath(id, "schedule"),
    jsonMutation("DELETE", {}, feedId),
  );
  return body.override;
}

export async function saveImage(
  id: string,
  crop: ImageCrop,
  file: Blob | null,
  feedId: string,
): Promise<EventOverride | null> {
  const form = new FormData();
  form.set("crop", JSON.stringify(crop));
  if (file) form.set("file", file, "image");
  const body = await request<OverrideResponse>(eventPath(id, "image"), {
    method: "PUT",
    headers: { "X-MOLU-Admin": "1", "X-MOLU-Feed": feedId },
    body: form,
  });
  return body.override;
}

export async function restoreImage(
  id: string,
  feedId: string,
): Promise<EventOverride | null> {
  const body = await request<OverrideResponse>(
    eventPath(id, "image"),
    jsonMutation("DELETE", {}, feedId),
  );
  return body.override;
}
