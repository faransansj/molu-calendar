import { describe, expect, it } from "vitest";
import { ARONA, momoReply, momoTopicsFor, scheduleReply } from "./replies.ts";
import type { FeedEvent } from "../calendar/feed.ts";

const event = (values: Partial<FeedEvent>): FeedEvent => ({
  id: "event",
  title: "시험 일정",
  category: "event",
  kind: "interval",
  all_day: true,
  start: "2026-10-08",
  end: "2026-10-09",
  status: "confirmed",
  source_url: "",
  sources: [],
  first_seen: "",
  updated_at: "",
  ...values,
});

describe("MomoTalk", () => {
  it("routes schedule questions and preserves student replies", () => {
    expect(momoReply("오늘일정좀", ARONA)).toBe("@today");
    expect(momoReply("내일 일정 알려줘", ARONA)).toBe("@tomorrow");
    expect(momoReply("안녕", { id: "__proto__", short: "학생" })).toContain(
      "학생입니다",
    );
    expect(momoReply("안녕", ARONA)).not.toBe(
      momoReply("안녕", { id: "Hoshino", short: "호시노" }),
    );
    expect(momoTopicsFor("missing")).toBe(momoTopicsFor("default"));
  });
  it("uses KST days, exclusive ends, and unfiltered live feed data", () => {
    const now = Date.parse("2026-10-07T15:30:00Z");
    const events = [
      event({}),
      event({
        id: "expired",
        title: "종료",
        start: "2026-10-07",
        end: "2026-10-08",
      }),
      event({
        id: "tomorrow",
        title: "내일 모집",
        category: "pickup",
        start: "2026-10-09",
        end: "2026-10-10",
      }),
      event({ id: "cancelled", title: "취소", status: "cancelled" }),
    ];
    const today = scheduleReply("@today", events, now);
    expect(today).toContain("오늘 일정은 1건");
    expect(today).toContain("시험 일정");
    expect(today).not.toContain("종료");
    expect(scheduleReply("@tomorrow", events, now)).toContain("내일 모집");
    expect(scheduleReply("@today", [], now)).toContain("비어 있어요");
  });
});
