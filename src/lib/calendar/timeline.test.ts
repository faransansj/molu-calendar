import { describe, expect, test } from "vitest";
import type { FeedEvent } from "./feed.ts";
import { eventMatcher } from "./search.ts";
import { layoutTimeline } from "./timeline.ts";

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

describe("timeline layout", () => {
  test("draws an event once at its true times and clips it at the month edges", () => {
    const long = make(
      "long",
      "2026-09-29T14:00:00+09:00",
      "2026-10-13T11:00:00+09:00",
    );
    const [group] = layoutTimeline([long], "2026-10").groups;
    const [item] = group!.items;
    expect(item).toMatchObject({
      left: 0,
      continuesBefore: true,
      continuesAfter: false,
      point: false,
    });
    expect(item!.width).toBeCloseTo((12 + 11 / 24) / 31);
  });

  test("stacks overlaps into sub-lanes and reuses free lanes", () => {
    const a = make(
      "a",
      "2026-10-01T11:00:00+09:00",
      "2026-10-08T11:00:00+09:00",
    );
    const b = make(
      "b",
      "2026-10-03T11:00:00+09:00",
      "2026-10-05T11:00:00+09:00",
    );
    const c = make(
      "c",
      "2026-10-09T11:00:00+09:00",
      "2026-10-12T11:00:00+09:00",
    );
    const [group] = layoutTimeline([c, b, a], "2026-10").groups;
    expect(group!.items.map((item) => [item.event.id, item.lane])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 0],
    ]);
    expect(group!.lanes).toBe(2);
  });

  test("pins releases at their moment and reserves room for the label", () => {
    const release = make("release", "2026-10-06T11:00:00+09:00", undefined, {
      kind: "release",
      category: "story",
    });
    const next = make("next", "2026-10-07T00:00:00+09:00", undefined, {
      kind: "release",
      category: "story",
    });
    const old = make("old", "2026-09-01T11:00:00+09:00", undefined, {
      kind: "release",
      category: "story",
    });
    const [group] = layoutTimeline([release, next, old], "2026-10").groups;
    expect(
      group!.items.map((item) => [item.event.id, item.point, item.lane]),
    ).toEqual([
      ["release", true, 0],
      ["next", true, 1],
    ]);
  });
});

describe("search", () => {
  const kazusa = make(
    "k",
    "2026-10-06T11:00:00+09:00",
    "2026-10-13T11:00:00+09:00",
    {
      title: "카즈사(밴드), 요시미(밴드) 특별 픽업",
      label: "특별 픽업 모집",
      category: "pickup",
      students: ["카즈사(밴드)"],
    },
  );
  const raid = make(
    "r",
    "2026-10-06T11:00:00+09:00",
    "2026-10-13T11:00:00+09:00",
    { title: "대결전 호버크래프트(야전)", category: "raid" },
  );

  test("matches words in any order, ignoring spaces and case", () => {
    expect(eventMatcher("")).toBeNull();
    const match = eventMatcher("픽업 카즈사")!;
    expect(match(kazusa)).toBe(true);
    expect(match(raid)).toBe(false);
    expect(eventMatcher("호버 크래프트")!(raid)).toBe(true);
    expect(eventMatcher("총력전")!(raid)).toBe(true);
  });

  test("matches initial consonants", () => {
    expect(eventMatcher("ㅋㅈㅅ")!(kazusa)).toBe(true);
    expect(eventMatcher("ㅎㅂㅋㄹㅍㅌ")!(raid)).toBe(true);
    expect(eventMatcher("ㅋㅈㅅ")!(raid)).toBe(false);
  });
});
