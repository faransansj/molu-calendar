import type { FeedEvent } from "../calendar/feed.ts";
import {
  clockLabel,
  dateKey,
  endMoment,
  startMoment,
  validDate,
  validInstant,
} from "../calendar/calendar.ts";
import { sitePath } from "../urls.ts";

export interface ImageCrop {
  x: number;
  y: number;
  zoom: number;
}
export interface ImageOverride {
  upload: string | null;
  crop: ImageCrop;
}
export interface ScheduleOverride {
  start: string;
  end: string | null;
  start_after_maintenance: boolean;
}
export interface EventOverride {
  event_id: string;
  image: ImageOverride | null;
  schedule: ScheduleOverride | null;
  updated_at: string;
}
export const DEFAULT_CROP: ImageCrop = { x: 50, y: 50, zoom: 1 };
export const EVENT_ID = /^[a-z]+-\d{8}-[a-f0-9]{8}$/;
export const UPLOAD_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$/;
export function uploadSrc(name: string): string {
  return sitePath(`api/images/${name}`);
}

function exactObject(
  input: unknown,
  keys: string[],
): input is Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    return false;
  const own = Reflect.ownKeys(input);
  return (
    own.length === keys.length && keys.every((key) => Object.hasOwn(input, key))
  );
}
export function validateCrop(input: unknown): ImageCrop | null {
  if (!exactObject(input, ["x", "y", "zoom"])) return null;
  const { x, y, zoom } = input;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof zoom !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(zoom) ||
    x < 0 ||
    x > 100 ||
    y < 0 ||
    y > 100 ||
    zoom < 1 ||
    zoom > 4
  )
    return null;
  return { x, y, zoom };
}
export function validateSchedule(
  input: unknown,
  event: Pick<FeedEvent, "kind" | "all_day">,
): { ok: true; value: ScheduleOverride } | { ok: false; message: string } {
  const invalid = {
    ok: false as const,
    message: "날짜 형식이 올바르지 않아요.",
  };
  if (!exactObject(input, ["start", "end", "start_after_maintenance"]))
    return invalid;
  const valid = event.all_day ? validDate : validInstant;
  const { start, end, start_after_maintenance } = input;
  if (
    !valid(start) ||
    (end !== null && !valid(end)) ||
    typeof start_after_maintenance !== "boolean"
  )
    return invalid;
  if (end !== null && event.kind !== "interval")
    return {
      ok: false,
      message: "종료 시각은 기간형 일정에만 설정할 수 있어요.",
    };
  if (start_after_maintenance && event.kind === "deadline")
    return { ok: false, message: "마감 일정에는 점검 후 시작을 쓸 수 없어요." };
  const value = { start, end, start_after_maintenance };
  if (end !== null) {
    const timed = { ...event, start, end, status: "confirmed" as const };
    if ((endMoment(timed) ?? -Infinity) <= startMoment(timed))
      return { ok: false, message: "종료는 시작보다 늦어야 해요." };
  }
  return { ok: true, value };
}
export function applyOverrides(
  events: FeedEvent[],
  overrides: ReadonlyMap<string, EventOverride>,
  imageSrc: (name: string) => string = uploadSrc,
): FeedEvent[] {
  return events.map((event) => {
    const override = overrides.get(event.id);
    if (!override) return event;
    const result = { ...event };
    if (override.schedule) {
      result.start = override.schedule.start;
      result.start_after_maintenance =
        override.schedule.start_after_maintenance;
      if (override.schedule.end === null) delete result.end;
      else result.end = override.schedule.end;
    }
    if (override.image?.upload)
      result.images = [
        imageSrc(override.image.upload),
        ...(event.images ?? []).slice(1),
      ];
    return result;
  });
}
export function toKstInput(instant: string): string {
  return `${dateKey(instant)}T${clockLabel(instant)}`;
}
export function fromKstInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const instant = `${value}:00+09:00`;
  return validInstant(instant) ? instant : null;
}
