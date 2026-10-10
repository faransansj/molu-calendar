import { describe, expect, test } from "vitest";
import {
  addDays,
  dateKey,
  displayDays,
  endMoment,
  endTag,
  monthDays,
  overlaps,
  phase,
  rangeLabel,
  remainingLabel,
  shiftMonth,
  span,
  startTag,
  openEndedExpired,
  timeLabel,
  validDate,
  validInstant,
} from "./calendar.ts";
import type { FeedEvent } from "./feed.ts";

const base: FeedEvent = {
  id: "test-1",
  title: "점검",
  category: "maintenance",
  kind: "interval",
  all_day: false,
  start: "2026-09-29T11:00:00+09:00",
  end: "2026-09-29T14:00:00+09:00",
  status: "confirmed",
  source_url:
    "https://forum.nexon.com/bluearchive/board_view?board=1076&thread=1",
  sources: [],
  first_seen: "2026-09-28T00:00:00Z",
  updated_at: "2026-09-28T00:00:00Z",
};
const event = (patch: Partial<FeedEvent>): FeedEvent => ({ ...base, ...patch });

describe("dates", () => {
  test("validity, month boundaries, leap years and KST conversion", () => {
    expect(validDate("2024-02-29")).toBe(true);
    expect(validDate("2025-02-29")).toBe(false);
    expect(validDate("2026-04-31")).toBe(false);
    expect(validDate("2026-2-01")).toBe(false);
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthDays("2026-09")).toHaveLength(42);
    expect(validInstant("2026-09-29T11:00:00+09:00")).toBe(true);
    expect(validInstant("2026-09-29T24:00:00+09:00")).toBe(false);
    expect(validInstant("2026-09-29T11:00:00")).toBe(false);
    expect(dateKey("2026-09-29T16:00:00Z")).toBe("2026-09-30");
    expect(dateKey("2026-09-29T14:59:59Z")).toBe("2026-09-29");
  });
});

describe("month display", () => {
  test("every month from 2020 to 2039 is contiguous, Sunday-first and complete", () => {
    for (let year = 2020; year < 2040; year++) {
      for (let month = 1; month <= 12; month++) {
        const key = `${year}-${String(month).padStart(2, "0")}`;
        const days = displayDays(key);
        const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
        expect(new Date(`${days[0]}T00:00:00Z`).getUTCDay()).toBe(0);
        expect(new Date(`${days.at(-1)}T00:00:00Z`).getUTCDay()).toBe(6);
        expect(days.filter((day) => day.startsWith(key))).toHaveLength(length);
        expect(days.slice(0, 7).some((day) => day.startsWith(key))).toBe(true);
        expect(days.slice(-7).some((day) => day.startsWith(key))).toBe(true);
        days
          .slice(1)
          .forEach((day, index) => expect(day).toBe(addDays(days[index]!, 1)));
      }
    }
  });
});

describe("spans", () => {
  test("exclusive ends", () => {
    const night = event({
      start: "2026-09-29T14:00:00Z",
      end: "2026-09-29T15:00:00Z",
    });
    expect(span(night)).toEqual({ first: "2026-09-29", last: "2026-09-29" });
    expect(overlaps(night, "2026-09-30", "2026-10-01")).toBe(false);
    const allDay = event({
      all_day: true,
      start: "2026-09-29",
      end: "2026-10-02",
    });
    expect(span(allDay)).toEqual({ first: "2026-09-29", last: "2026-10-01" });
    expect(overlaps(allDay, "2026-10-02", "2026-10-03")).toBe(false);
    expect(rangeLabel(allDay)).toBe("9월 29일(화) ~ 10월 1일(목)");
  });

  test("open-ended intervals run 180 days", () => {
    const open = event({ end: undefined });
    expect(span(open)).toEqual({ first: "2026-09-29", last: "2027-03-28" });
    expect(overlaps(open, "2026-10-08", "2026-10-09")).toBe(true);
    expect(overlaps(open, "2026-09-28", "2026-09-29")).toBe(false);
    expect(overlaps(open, "2027-03-29", "2027-03-30")).toBe(false);
    expect(openEndedExpired(open, "2027-03-28T10:59:00+09:00")).toBe(false);
    expect(openEndedExpired(open, "2027-03-28T11:00:00+09:00")).toBe(true);
    const season = event({
      all_day: true,
      start: "2026-10-01",
      end: undefined,
    });
    expect(span(season).last).toBe("2027-03-29");
    expect(
      openEndedExpired(
        event({ end: "2026-09-29T14:00:00+09:00" }),
        "2030-01-01",
      ),
    ).toBe(false);
    expect(timeLabel(open, "2026-09-29")).toBe("11:00 시작");
    expect(timeLabel(open, "2026-10-08")).toBe("진행 중");
    const release = event({ kind: "release", end: undefined });
    expect(span(release)).toEqual({ first: "2026-09-29", last: "2026-09-29" });
    expect(openEndedExpired(release, "2030-01-01")).toBe(false);
  });
});

describe("labels", () => {
  test("midnight ends display as 24:00 on the previous day", () => {
    const midnight = event({
      start: "2026-09-29T23:00:00+09:00",
      end: "2026-09-30T00:00:00+09:00",
    });
    expect(timeLabel(midnight, "2026-09-29")).toBe("23:00–24:00");
    expect(timeLabel(midnight, "2026-09-30")).toBe("");
  });

  test("end tags stay silent for routine ends until the day before", () => {
    const pickup = event({
      start: "2026-10-06T11:00:00+09:00",
      end: "2026-10-13T10:59:00+09:00",
    });
    expect(endTag(pickup, "2026-10-08T12:00:00+09:00")).toBeNull();
    expect(endTag(pickup, "2026-10-12T09:00:00+09:00")).toEqual({
      text: "내일 10:59",
      soon: true,
    });
    expect(endTag(pickup, "2026-10-13T09:00:00+09:00")).toEqual({
      text: "오늘 10:59",
      soon: true,
    });
    const coupon = event({
      start: "2026-09-11T17:00:00+09:00",
      end: "2026-10-09T23:59:00+09:00",
    });
    expect(endTag(coupon, "2026-10-01T12:00:00+09:00")).toEqual({
      text: "~23:59",
      soon: false,
    });
    expect(endTag(event({ end: undefined }))).toBeNull();
  });

  test("start tags stay silent for routine starts until the day before", () => {
    const pickup = event({
      start: "2026-10-13T11:00:00+09:00",
      end: "2026-10-20T10:59:00+09:00",
    });
    expect(startTag(pickup, "2026-10-08T12:00:00+09:00")).toBeNull();
    expect(startTag(pickup, "2026-10-12T20:00:00+09:00")).toEqual({
      text: "내일 11:00",
      soon: true,
    });
    expect(startTag(pickup, "2026-10-13T09:00:00+09:00")).toEqual({
      text: "오늘 11:00",
      soon: true,
    });
    expect(startTag(pickup, "2026-10-14T09:00:00+09:00")).toBeNull();
    expect(
      startTag(
        { ...pickup, start_after_maintenance: true },
        "2026-10-08T12:00:00+09:00",
      ),
    ).toEqual({ text: "점검 후", soon: false });
    expect(
      startTag(
        event({
          start: "2026-10-13T14:00:00+09:00",
          end: "2026-10-20T10:59:00+09:00",
        }),
        "2026-10-01T00:00:00+09:00",
      ),
    ).toEqual({ text: "14:00", soon: false });
    expect(startTag(event({ kind: "deadline", end: undefined }))).toBeNull();
  });

  test("after-maintenance starts never show an invented clock", () => {
    const pickup = event({
      start: "2026-09-29T14:00:00+09:00",
      end: "2026-10-06T10:59:00+09:00",
      start_after_maintenance: true,
    });
    expect(timeLabel(pickup, "2026-09-29")).toBe("점검 후 시작");
    expect(rangeLabel(pickup)).toBe(
      "9월 29일(화) 점검 후 ~ 10월 6일(화) 10:59",
    );
  });
});

describe("countdowns and phases", () => {
  const pickup = event({
    category: "pickup",
    start: "2026-10-06T11:00:00+09:00",
    end: "2026-10-13T10:59:00+09:00",
  });

  test("count to the start, then to the end", () => {
    expect(remainingLabel(pickup, "2026-10-04T11:00:00+09:00")).toBe(
      "시작까지 D-2",
    );
    expect(remainingLabel(pickup, "2026-10-06T08:30:00+09:00")).toBe(
      "시작까지 2:30",
    );
    expect(remainingLabel(pickup, "2026-10-10T10:59:00+09:00")).toBe(
      "종료까지 D-3",
    );
    expect(remainingLabel(pickup, "2026-10-13T11:00:00+09:00")).toBeNull();
    expect(phase(pickup, "2026-10-13T11:00:00+09:00")).toBe("ended");
  });

  test("all-day events last until midnight after their final day", () => {
    const festival = event({
      all_day: true,
      start: "2026-11-07",
      end: "2026-11-09",
    });
    expect(remainingLabel(festival, "2026-11-08T23:00:00+09:00")).toBe(
      "종료까지 1:00",
    );
  });

  test("open-ended all-day events stay ongoing", () => {
    const season = event({
      all_day: true,
      start: "2026-10-01",
      end: undefined,
      end_note: "별도 안내 시까지",
    });
    expect(endMoment(season)).toBeNull();
    expect(phase(season, "2026-12-01T00:00:00+09:00")).toBe("ongoing");
    expect(remainingLabel(season, "2026-12-01T00:00:00+09:00")).toBeNull();
  });

  test("deadlines count down to the deadline itself", () => {
    const coupon = event({
      kind: "deadline",
      end: undefined,
      start: "2026-10-09T23:59:00+09:00",
    });
    expect(remainingLabel(coupon, "2026-10-08T23:59:00+09:00")).toBe(
      "마감까지 D-1",
    );
    expect(remainingLabel(coupon, "2026-10-10T00:00:00+09:00")).toBeNull();
  });
});
