import { describe, expect, test } from "vitest";
import { displayDays } from "./calendar.ts";
import type { FeedEvent } from "./feed.ts";
import { toICS } from "./ics.ts";
import { allocateLanes, layoutWeek, weeks } from "./layout.ts";

const make = (
  id: string,
  start: string,
  end: string | undefined,
  patch: Partial<FeedEvent> = {},
): FeedEvent => ({
  id,
  title: id,
  category: "event",
  kind: "interval",
  all_day: false,
  start,
  end,
  status: "confirmed",
  source_url:
    "https://forum.nexon.com/bluearchive/board_view?board=1076&thread=1",
  sources: [
    {
      url: "https://forum.nexon.com/bluearchive/board_view?board=1076&thread=1",
      title: "t",
      board: "업데이트",
      published_at: "2026-09-28T09:00:00.000Z",
    },
  ],
  first_seen: "2026-09-28T09:00:00.000Z",
  updated_at: "2026-09-28T09:00:00.000Z",
  ...patch,
});
const week = weeks(displayDays("2026-10"))[1]!; // 10/4 (Sun) – 10/10 (Sat)

describe("week layout", () => {
  test("splits events at week edges and marks continuation", () => {
    const long = make(
      "long",
      "2026-09-29T14:00:00+09:00",
      "2026-10-13T10:59:00+09:00",
    );
    const { segments } = layoutWeek([long], week, 4);
    expect(segments).toEqual([
      expect.objectContaining({
        column: 0,
        length: 7,
        lane: 0,
        continuesBefore: true,
        continuesAfter: true,
      }),
    ]);
  });

  test("pickups claim lanes before long goods sales, and free gaps are reused", () => {
    const goods = make(
      "goods",
      "2026-09-29T12:00:00+09:00",
      "2026-11-18T23:59:00+09:00",
      { category: "community" },
    );
    const pickup = make(
      "pickup",
      "2026-10-06T11:00:00+09:00",
      "2026-10-13T10:59:00+09:00",
      { category: "pickup" },
    );
    const monday = make(
      "monday",
      "2026-10-05T10:00:00+09:00",
      "2026-10-05T12:00:00+09:00",
    );
    const saturday = make(
      "saturday",
      "2026-10-10T04:00:00+09:00",
      "2026-10-10T08:00:00+09:00",
    );
    const { segments, lanes } = layoutWeek(
      [goods, saturday, monday, pickup],
      week,
      4,
    );
    expect(
      segments.map((s) => [s.event.id, s.column, s.length, s.lane]),
    ).toEqual([
      ["monday", 1, 1, 0],
      ["pickup", 2, 5, 0],
      ["saturday", 6, 1, 1],
      ["goods", 0, 7, 2],
    ]);
    expect(lanes).toBe(3);
  });

  test("counts what does not fit per day", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      make(`e${i}`, "2026-10-07T11:00:00+09:00", "2026-10-08T11:00:00+09:00"),
    );
    const { segments, hidden } = layoutWeek(many, week, 3);
    expect(segments).toHaveLength(3);
    expect(hidden).toEqual([0, 0, 0, 2, 2, 0, 0]);
  });
});

describe("lane budget", () => {
  const budget = { base: 60, focusLane: 26, otherLane: 20, floor: 2 };
  const used = (lanes: number[], focus: number) =>
    lanes.reduce(
      (sum, value, index) => sum + 60 + value * (index === focus ? 26 : 20),
      0,
    );

  test("the focused week shows everything; the others keep two slim lanes", () => {
    const lanes = allocateLanes([7, 11, 6, 4, 4], 1, {
      ...budget,
      height: 300 + 11 * 26 + 8 * 20,
    });
    expect(lanes).toEqual([2, 11, 2, 2, 2]);
  });

  test("never exceeds the height, even when floors do not fit", () => {
    for (const height of [380, 500, 640, 800]) {
      const lanes = allocateLanes([9, 9, 9, 9, 9, 9], 3, { ...budget, height });
      expect(used(lanes, 3), String(height)).toBeLessThanOrEqual(height);
      expect(lanes[3]).toBeGreaterThanOrEqual(
        Math.max(...lanes.filter((_, index) => index !== 3)),
      );
    }
  });
});

describe("iCalendar export", () => {
  const ics = toICS(
    [
      make(
        "event-20261006-aaaaaaaa",
        "2026-10-06T11:00:00+09:00",
        "2026-10-13T10:59:00+09:00",
        { title: "카즈사(밴드), 요시미(밴드) 특별 픽업", category: "pickup" },
      ),
      make("event-20261009-bbbbbbbb", "2026-10-09T23:59:00+09:00", undefined, {
        kind: "deadline",
        title: "쿠폰 사용 마감",
      }),
      make("community-20261107-cccccccc", "2026-11-07", "2026-11-09", {
        all_day: true,
        category: "community",
        title: "5주년 페스티벌",
      }),
    ],
    {
      name: "MOLU",
      siteUrl: "https://molu.example",
      now: "2026-10-06T00:00:00Z",
    },
  );

  test("uses UTC instants, all-day dates and escaped text", () => {
    expect(ics).toContain("DTSTART:20261006T020000Z\r\nDTEND:20261013T015900Z");
    expect(ics).toContain(
      "SUMMARY:[픽업] 카즈사(밴드)\\, 요시미(밴드) 특별 픽업",
    );
    expect(ics).toContain("DTSTART:20261009T142900Z\r\nDTEND:20261009T145900Z");
    expect(ics).toContain(
      "DTSTART;VALUE=DATE:20261107\r\nDTEND;VALUE=DATE:20261109",
    );
  });

  test("keeps the deployment path in exported event links", () => {
    for (const siteUrl of [
      "https://faransansj.github.io/molu-calendar",
      "https://faransansj.github.io/molu-calendar/",
    ]) {
      const exported = toICS(
        [make("event-1", "2026-10-06", "2026-10-07", { all_day: true })],
        { name: "MOLU", siteUrl },
      ).replace(/\r\n /g, "");
      expect(exported).toContain(
        "MOLU: https://faransansj.github.io/molu-calendar/?event=event-1",
      );
    }
  });

  test("every line is CRLF-terminated and at most 75 octets", () => {
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    for (const line of ics.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(
      ics.split("\r\n").filter((line) => line.startsWith("BEGIN:VEVENT")),
    ).toHaveLength(3);
  });
});
