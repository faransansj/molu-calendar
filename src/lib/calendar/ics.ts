import { CATEGORIES, addDays, periodRange, rangeLabel } from "./calendar.ts";
import type { FeedEvent } from "./feed.ts";
import { sitePath } from "../urls.ts";

function escape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/[,;]/g, (match) => `\\${match}`);
}

/** Fold lines longer than 75 octets without splitting a UTF-8 character. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function utc(value: string | number): string {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function date(value: string): string {
  return value.replace(/-/g, "");
}

const HOUR = 3_600_000;

function timing(event: FeedEvent): string[] {
  if (event.all_day) {
    const end =
      event.kind === "interval" && event.end
        ? event.end
        : addDays(event.start, 1);
    return [
      `DTSTART;VALUE=DATE:${date(event.start)}`,
      `DTEND;VALUE=DATE:${date(end)}`,
    ];
  }
  const start = Date.parse(event.start);
  if (event.kind === "deadline")
    return [`DTSTART:${utc(start - HOUR / 2)}`, `DTEND:${utc(start)}`];
  const end =
    event.kind === "interval" && event.end
      ? Date.parse(event.end)
      : start + HOUR;
  return [`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`];
}

function summary(event: FeedEvent): string {
  const suffix = event.kind === "interval" && !event.end ? " (종료 미정)" : "";
  return `[${CATEGORIES[event.category].short}] ${event.title}${suffix}`;
}

function description(event: FeedEvent, siteUrl?: string): string {
  return [
    rangeLabel(event) +
      (event.start_after_maintenance
        ? " (점검 종료 시각은 변동될 수 있습니다)"
        : ""),
    ...(event.periods ?? []).map(
      (period) => `· ${period.label}: ${periodRange(period)}`,
    ),
    ...(event.notes ?? []),
    "",
    `공식 공지: ${event.source_url}`,
    ...(siteUrl
      ? [
          `MOLU: ${siteUrl.replace(/\/$/, "")}/?event=${encodeURIComponent(event.id)}`,
        ]
      : []),
  ].join("\n");
}

export interface CalendarOptions {
  name: string;
  /** Absolute site URL including the base path for deep links. Omitted when unknown. */
  siteUrl?: string;
  now?: string;
}

export function toICS(
  events: FeedEvent[],
  { name, siteUrl, now = new Date().toISOString() }: CalendarOptions,
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MOLU//Blue Archive KR schedule//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escape(name)}`,
    "X-WR-TIMEZONE:Asia/Seoul",
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    "X-PUBLISHED-TTL:PT12H",
  ];
  for (const event of events) {
    if (event.status === "cancelled") continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.id}@molu-calendar`,
      `DTSTAMP:${utc(event.updated_at || now)}`,
      ...timing(event),
      `SUMMARY:${escape(summary(event))}`,
      `DESCRIPTION:${escape(description(event, siteUrl))}`,
      `URL:${event.source_url}`,
      `CATEGORIES:${escape(CATEGORIES[event.category].label)}`,
      ...(event.status === "tentative"
        ? ["STATUS:TENTATIVE"]
        : ["STATUS:CONFIRMED"]),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

export function downloadICS(
  events: FeedEvent[],
  name: string,
  filename: string,
) {
  const blob = new Blob(
    [
      toICS(events, {
        name,
        siteUrl: new URL(sitePath(), location.origin).href,
      }),
    ],
    {
      type: "text/calendar;charset=utf-8",
    },
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
