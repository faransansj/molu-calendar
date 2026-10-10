import type { Category, FeedEvent, Period, Status } from "./feed.ts";

export const TIME_ZONE = "Asia/Seoul";
export const DAY_MS = 86_400_000;

export const CATEGORIES: Record<
  Category,
  { label: string; short: string; color: string }
> = {
  maintenance: { label: "점검·업데이트", short: "점검", color: "#687795" },
  pickup: { label: "픽업 모집", short: "픽업", color: "#825bd5" },
  event: { label: "이벤트", short: "이벤트", color: "#008fb6" },
  raid: { label: "총력전·대결전", short: "전투", color: "#c4566b" },
  campaign: { label: "2배 캠페인", short: "캠페인", color: "#19896b" },
  story: { label: "스토리", short: "스토리", color: "#3f6fa8" },
  community: { label: "제휴·굿즈", short: "제휴", color: "#bf7a2a" },
};
export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
export const STATUSES: Record<Status, string> = {
  confirmed: "확정",
  tentative: "예정",
  postponed: "연기",
  cancelled: "취소",
};

type Moment = string | number | Date;
type Timed = Pick<
  FeedEvent,
  | "all_day"
  | "start"
  | "end"
  | "kind"
  | "status"
  | "start_after_maintenance"
  | "end_note"
>;

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const clockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function dateKey(value: Moment = new Date()): string {
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(new Date(value)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const time = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(+time) &&
    time.toISOString().slice(0, 10) === value &&
    value >= "1900-01-01" &&
    value <= "2199-12-31"
  );
}

export function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (
    !match ||
    !validDate(match[1]) ||
    +match[2]! > 23 ||
    +match[3]! > 59 ||
    +(match[4] ?? 0) > 59
  )
    return false;
  if (match[6] !== "Z") {
    const [hours, minutes] = match[6]!.slice(1).split(":").map(Number) as [
      number,
      number,
    ];
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0))
      return false;
  }
  return Number.isFinite(Date.parse(value)) && validDate(dateKey(value));
}

export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function shiftMonth(month: string, count: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 7);
}

export function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function monthDays(month: string, weeks = 6): string[] {
  const first = `${month}-01`;
  const start = addDays(first, -weekday(first));
  return Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index));
}

export function displayDays(month: string): string[] {
  const length = new Date(
    Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0),
  ).getUTCDate();
  return monthDays(month, Math.ceil((weekday(`${month}-01`) + length) / 7));
}

export function kstMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00+09:00`);
}

// These seasons have run 4 to 5 months; allow another month before hiding them.
export const OPEN_ENDED_DAYS = 180;

function openEnded(event: Timed): boolean {
  return event.kind === "interval" && !event.end;
}

export function openEndedLimit(event: Timed): number | null {
  return openEnded(event)
    ? startMoment(event) + OPEN_ENDED_DAYS * DAY_MS
    : null;
}

export function openEndedExpired(
  event: Timed,
  now: Moment = new Date(),
): boolean {
  const limit = openEndedLimit(event);
  return limit !== null && +new Date(now) >= limit;
}

/** Inclusive KST display dates derived from the feed's exclusive end. */
export function span(event: Timed): { first: string; last: string } {
  const first = event.all_day ? event.start : dateKey(event.start);
  if (!event.end)
    return {
      first,
      last: openEnded(event) ? dateKey(openEndedLimit(event)! - 1) : first,
    };
  return {
    first,
    last: event.all_day
      ? addDays(event.end, -1)
      : dateKey(Date.parse(event.end) - 1),
  };
}

export function overlaps(event: Timed, from: string, to: string): boolean {
  const { first, last } = span(event);
  return first < to && last >= from;
}

export function clockLabel(value: Moment): string {
  return clockFormatter.format(new Date(value));
}

function startClock(event: Timed): string {
  return event.start_after_maintenance ? "점검 후" : clockLabel(event.start);
}

/** Exclusive midnight ends display as 24:00 on the previous day. */
export function endClock(event: Timed): string | null {
  if (event.all_day || event.kind !== "interval" || !event.end) return null;
  return dateKey(event.end) > span(event).last
    ? "24:00"
    : clockLabel(event.end);
}

const ROUTINE_ENDS = new Set(["03:59", "10:59"]);

export function endTag(
  event: Timed,
  now: Moment = new Date(),
): { text: string; soon: boolean } | null {
  const clock = endClock(event);
  if (!clock) return null;
  const today = dateKey(now);
  const { last } = span(event);
  if (phase(event, now) === "ongoing" && last <= addDays(today, 1)) {
    return { text: `${last === today ? "오늘" : "내일"} ${clock}`, soon: true };
  }
  return ROUTINE_ENDS.has(clock) ? null : { text: `~${clock}`, soon: false };
}

const ROUTINE_STARTS = new Set(["04:00", "11:00"]);

export function startTag(
  event: Timed,
  now: Moment = new Date(),
): { text: string; soon: boolean } | null {
  if (event.all_day || event.kind === "deadline") return null;
  const clock = startClock(event);
  const today = dateKey(now);
  const day = dateKey(event.start);
  if (+new Date(now) < startMoment(event) && day <= addDays(today, 1)) {
    return { text: `${day === today ? "오늘" : "내일"} ${clock}`, soon: true };
  }
  return ROUTINE_STARTS.has(clock) ? null : { text: clock, soon: false };
}

export function dayFraction(value: Moment): number {
  const time = +new Date(value);
  return (time - kstMidnight(dateKey(time))) / DAY_MS;
}

export function timeLabel(event: Timed, day?: string): string {
  const { first, last } = span(event);
  day ??= first;
  if (day < first || day > last) return "";
  if (event.status === "cancelled") return "취소";
  if (event.status === "postponed") return "연기";
  if (event.kind === "deadline")
    return event.all_day ? "마감" : `${clockLabel(event.start)} 마감`;
  if (event.all_day) return "종일";
  if (event.kind === "release") return `${startClock(event)} 오픈`;
  if (!event.end)
    return day === first ? `${startClock(event)} 시작` : "진행 중";
  const end = endClock(event)!;
  if (first === last) return `${startClock(event)}–${end}`;
  if (day === first) return `${startClock(event)} 시작`;
  if (day === last) return `${end} 종료`;
  return "진행 중";
}

export function dayLabel(day: string, withYear = false): string {
  const label = `${+day.slice(5, 7)}월 ${+day.slice(8, 10)}일(${WEEKDAYS[weekday(day)]})`;
  return withYear ? `${day.slice(0, 4)}년 ${label}` : label;
}

export function momentLabel(
  value: string,
  options: {
    afterMaintenance?: boolean;
    allDay?: boolean;
    isEnd?: boolean;
  } = {},
): string {
  if (options.allDay)
    return dayLabel(options.isEnd ? addDays(value, -1) : value);
  const day = dateKey(value);
  return `${dayLabel(day)} ${options.afterMaintenance ? "점검 후" : clockLabel(value)}`;
}

export function rangeLabel(event: Timed): string {
  if (event.kind === "deadline")
    return `${momentLabel(event.start, { allDay: event.all_day })} 마감`;
  if (event.all_day) {
    const { first, last } = span(event);
    return first === last
      ? `${dayLabel(first)} · 종일`
      : `${dayLabel(first)} ~ ${dayLabel(last)}`;
  }
  const start = momentLabel(event.start, {
    afterMaintenance: event.start_after_maintenance,
  });
  if (event.kind === "release") return `${start}부터`;
  if (!event.end) return `${start} ~ ${event.end_note ?? "종료 미정"}`;
  return `${start} ~ ${momentLabel(event.end)}`;
}

export function periodRange(period: Period): string {
  const allDay = period.start.length === 10;
  const start = momentLabel(period.start, {
    allDay,
    afterMaintenance: period.start_after_maintenance,
  });
  if (!period.end) return `${start}부터`;
  return `${start} ~ ${momentLabel(period.end, { allDay, isEnd: allDay })}`;
}

export function startMoment(event: Timed): number {
  return event.all_day ? kstMidnight(event.start) : Date.parse(event.start);
}

export function endMoment(event: Timed): number | null {
  if (event.kind === "deadline")
    return startMoment(event) + (event.all_day ? DAY_MS : 0);
  if (event.all_day) return event.end ? kstMidnight(event.end) : null;
  return event.end ? Date.parse(event.end) : null;
}

export function compareEvents(a: FeedEvent, b: FeedEvent): number {
  return startMoment(a) - startMoment(b) || a.id.localeCompare(b.id);
}

export type Phase = "upcoming" | "ongoing" | "ended";

export function phase(event: Timed, now: Moment = new Date()): Phase {
  const time = +new Date(now);
  const end = endMoment(event);
  if (event.kind === "deadline")
    return end !== null && time >= end ? "ended" : "ongoing";
  if (time < startMoment(event)) return "upcoming";
  if (event.kind === "release")
    return time - startMoment(event) < 7 * DAY_MS ? "ongoing" : "ended";
  return end !== null && time >= end ? "ended" : "ongoing";
}

function countdown(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return `D-${days}`;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export function remainingLabel(
  event: Timed,
  now: Moment = new Date(),
): string | null {
  if (event.status === "cancelled" || event.status === "postponed") return null;
  const time = +new Date(now);
  const start = startMoment(event);
  const end = endMoment(event);
  if (event.kind === "deadline")
    return end !== null && time < end
      ? `마감까지 ${countdown(end - time)}`
      : null;
  if (time < start)
    return `${event.kind === "release" ? "오픈까지" : "시작까지"} ${countdown(start - time)}`;
  if (event.kind === "release" || end === null || time >= end) return null;
  return `종료까지 ${countdown(end - time)}`;
}
