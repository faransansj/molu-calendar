import { expect, test } from "vitest";
import type { FeedEvent } from "../calendar/feed.ts";
import { addDays } from "../calendar/calendar.ts";
import {
  applicableOverrides,
  applyOverrides,
  DEFAULT_CROP,
  fromKstInput,
  toKstInput,
  validateCrop,
  validateSchedule,
  type EventOverride,
} from "./overrides.ts";

const event: FeedEvent = {
  id: "event-20260324-118d85f0",
  title: "행사",
  category: "event",
  kind: "interval",
  all_day: false,
  start: "2026-11-03T11:00:00+09:00",
  end: "2026-11-04T11:00:00+09:00",
  status: "confirmed",
  source_url: "https://example.com",
  sources: [],
  first_seen: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  images: ["original", "second"],
};
const schedule = {
  start: event.start,
  end: event.end!,
  start_after_maintenance: false,
};
test("all-day inclusive end round trip preserves exclusive stored end", () => {
  const end = "2026-11-05";
  const last = addDays(end, -1);
  expect(last).toBe("2026-11-04");
  expect(
    validateSchedule(
      { ...schedule, start: "2026-11-03", end: addDays(last, 1) },
      { ...event, all_day: true },
    ),
  ).toEqual({ ok: true, value: { ...schedule, start: "2026-11-03", end } });
});
test("schedule rejects non-increasing end and end on point events", () => {
  for (const end of [event.start, "2026-11-02T11:00:00+09:00"])
    expect(validateSchedule({ ...schedule, end }, event)).toEqual({
      ok: false,
      message: "종료는 시작보다 늦어야 해요.",
    });
  for (const kind of ["deadline", "release"] as const)
    expect(validateSchedule(schedule, { ...event, kind })).toEqual({
      ok: false,
      message: "종료 시각은 기간형 일정에만 설정할 수 있어요.",
    });
  expect(
    validateSchedule(
      { ...schedule, end: null, start_after_maintenance: true },
      { ...event, kind: "deadline" },
    ).ok,
  ).toBe(false);
});
test("schedule rejects offsetless times and unknown keys", () => {
  expect(
    validateSchedule({ ...schedule, start: "2026-11-03T11:00:00" }, event).ok,
  ).toBe(false);
  expect(validateSchedule({ ...schedule, extra: true }, event).ok).toBe(false);
});
test("crop accepts only exact finite bounded coordinates", () => {
  expect(validateCrop(DEFAULT_CROP)).toEqual(DEFAULT_CROP);
  for (const crop of [
    { ...DEFAULT_CROP, extra: true },
    { ...DEFAULT_CROP, x: NaN },
    { ...DEFAULT_CROP, y: 101 },
    { ...DEFAULT_CROP, zoom: 0 },
    null,
  ])
    expect(validateCrop(crop)).toBeNull();
});
test("overrides replace schedule and first image without mutating feed", () => {
  const untouched = { ...event, id: "other" };
  const override: EventOverride = {
    event_id: event.id,
    image: {
      upload: "12345678-1234-1234-1234-123456789abc.webp",
      crop: DEFAULT_CROP,
    },
    schedule: { ...schedule, start: "2026-11-04T11:00:00+09:00", end: null },
    updated_at: event.updated_at,
  };
  const [changed, same] = applyOverrides(
    [event, untouched],
    new Map([[event.id, override]]),
  );
  expect(same).toBe(untouched);
  expect(changed?.start).toBe(override.schedule?.start);
  expect(changed).not.toHaveProperty("end");
  expect(changed?.images).toEqual([
    "/api/images/12345678-1234-1234-1234-123456789abc.webp",
    "second",
  ]);
  expect(event.end).toBe(schedule.end);
  expect(event.images).toEqual(["original", "second"]);
  expect(applyOverrides([event], new Map())).toEqual([event]);
  expect(applyOverrides([event], new Map())[0]).toBe(event);
  expect(
    applyOverrides(
      [{ ...event, images: undefined }],
      new Map([[event.id, override]]),
    )[0]?.images,
  ).toEqual(["/api/images/12345678-1234-1234-1234-123456789abc.webp"]);
});
test("KST input conversion is explicit and rejects impossible dates", () => {
  expect(fromKstInput("2026-11-03T11:00")).toBe("2026-11-03T11:00:00+09:00");
  expect(toKstInput("2026-11-03T02:00:00Z")).toBe("2026-11-03T11:00");
  expect(fromKstInput("2026-02-30T11:00")).toBeNull();
});
test("applicableOverrides omits disappeared events without touching stored rows", () => {
  const gone: EventOverride = {
    event_id: "event-20260325-00000000",
    image: {
      upload: "12345678-1234-1234-1234-123456789abc.webp",
      crop: { ...DEFAULT_CROP },
    },
    schedule: { ...schedule },
    updated_at: event.updated_at,
  };
  const kept: EventOverride = {
    event_id: event.id,
    image: null,
    schedule: { ...schedule },
    updated_at: event.updated_at,
  };
  const snapshot = JSON.parse(JSON.stringify([gone, kept]));
  const result = applicableOverrides([event], [gone, kept]);
  expect(result).toEqual([kept]);
  expect(result[0]).toBe(kept);
  expect([gone, kept]).toEqual(snapshot);
});
test("applicableOverrides preserves image/crop when schedule becomes incompatible", () => {
  const image = {
    upload: "12345678-1234-1234-1234-123456789abc.webp",
    crop: { ...DEFAULT_CROP, zoom: 2 },
  };
  const stored: EventOverride = {
    event_id: event.id,
    image,
    schedule: { ...schedule },
    updated_at: event.updated_at,
  };
  const kindChanged = { ...event, kind: "deadline" as const };
  const dayChanged = { ...event, all_day: true };
  for (const changed of [kindChanged, dayChanged]) {
    const [kept] = applicableOverrides([changed], [stored]);
    expect(kept).toEqual({ ...stored, schedule: null });
    expect(kept?.image).toBe(image);
  }
  expect(stored).toEqual({
    event_id: event.id,
    image,
    schedule: { ...schedule },
    updated_at: event.updated_at,
  });
});
test("applicableOverrides omits rows left with neither displayable field", () => {
  const scheduleOnly: EventOverride = {
    event_id: event.id,
    image: null,
    schedule: { ...schedule },
    updated_at: event.updated_at,
  };
  const point = { ...event, kind: "deadline" as const };
  expect(applicableOverrides([point], [scheduleOnly])).toEqual([]);
  expect(scheduleOnly.schedule).toEqual({ ...schedule });
  const compatible: EventOverride = {
    ...scheduleOnly,
    image: {
      upload: "12345678-1234-1234-1234-123456789abc.webp",
      crop: { ...DEFAULT_CROP },
    },
  };
  const [kept] = applicableOverrides([event], [compatible]);
  expect(kept).toBe(compatible);
});
