import type { Kind } from "../src/lib/calendar/feed.ts";

export function shouldExcludeCalendarEvent(item: {
  kind: Kind;
  title?: string;
  end?: string;
  end_note?: string;
}): boolean {
  if (item.kind !== "interval" || item.end) return false;
  if (/소진/.test(item.end_note ?? "")) return false;
  const season = /시즌\s*\d+/.test(item.title ?? "");
  return !(season && /별도\s*(?:안내|공지)/.test(item.end_note ?? ""));
}
