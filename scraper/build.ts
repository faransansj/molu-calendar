import { createHash } from "node:crypto";
import {
  DAY_MS,
  compareEvents,
  endMoment,
  openEndedExpired,
} from "../src/lib/calendar/calendar.ts";
import type {
  Feed,
  FeedEvent,
  Period,
  Source,
} from "../src/lib/calendar/feed.ts";
import { BOARDS } from "./parse.ts";
import type { Draft, Post } from "./parse.ts";
import { validateFeed } from "./schema.ts";
import { shouldExcludeCalendarEvent } from "./eligibility.ts";

export const FEED_SOURCE = {
  name: "블루 아카이브 공식 커뮤니티 (NEXON)",
  url: "https://forum.nexon.com/bluearchive",
};
const RETENTION_MS = 550 * DAY_MS;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

export function eventId(
  draft: Pick<Draft, "key" | "category" | "start">,
): string {
  return `${draft.category}-${draft.start.slice(0, 10).replace(/-/g, "")}-${hash(draft.key)}`;
}

function source(post: Post): Source {
  return {
    url: post.url,
    title: post.title.slice(0, 300),
    board: BOARDS[post.board],
    published_at: post.publishedAt,
  };
}

const unique = <T>(items: T[], key: (item: T) => string = String) => [
  ...new Map(items.map((item) => [key(item), item])).values(),
];

function priority(draft: Draft): number {
  if (draft.category === "pickup" && draft.post.board === 1018) return 0;
  if (draft.post.board === 1076) return 1;
  return 2;
}

interface Merged extends Draft {
  sources: Source[];
}

function merge(target: Merged, incoming: Draft) {
  if (!target.end && incoming.end) {
    Object.assign(target, {
      all_day: incoming.all_day,
      start: incoming.start,
      end: incoming.end,
      kind: incoming.kind,
      start_after_maintenance: incoming.start_after_maintenance,
    });
  }
  if (!target.images.length) target.images = [...incoming.images];
  target.periods = unique(
    [...target.periods, ...incoming.periods],
    (period) => period.label,
  );
  target.notes = unique([...target.notes, ...incoming.notes]);
  target.tags = unique([...target.tags, ...incoming.tags]);
  target.students = unique([...target.students, ...incoming.students]);
  if ((incoming.description?.length ?? 0) > (target.description?.length ?? 0))
    target.description = incoming.description;
  target.label ??= incoming.label;
  target.sources = unique(
    [...target.sources, source(incoming.post)],
    (item) => item.url,
  );
}

// timing() in parse.ts uses 11:00 until a notice supplies the maintenance end.
function resolveMaintenance(events: Merged[]) {
  const ends = new Map<string, string>();
  for (const event of events) {
    if (
      event.key.startsWith("maintenance:") &&
      event.key.split(":").length === 2 &&
      event.end
    )
      ends.set(event.start.slice(0, 10), event.end);
  }
  const resolve = <
    T extends {
      start: string;
      end?: string;
      start_after_maintenance?: boolean;
    },
  >(
    item: T,
  ) => {
    if (!item.start_after_maintenance) return;
    const end = ends.get(item.start.slice(0, 10));
    if (end && (!item.end || Date.parse(end) < Date.parse(item.end)))
      item.start = end;
  };
  for (const event of events) {
    resolve(event);
    event.periods.forEach((period: Period) => resolve(period));
  }
}

function toEvent(draft: Merged, now: string): FeedEvent {
  const optional = <K extends keyof FeedEvent>(
    key: K,
    value: FeedEvent[K] | undefined | false,
  ) =>
    value === undefined ||
    value === false ||
    (Array.isArray(value) && !value.length)
      ? {}
      : { [key]: value };
  return {
    id: eventId(draft),
    title: draft.title,
    ...optional("label", draft.label),
    category: draft.category,
    kind: draft.kind,
    all_day: draft.all_day,
    start: draft.start,
    ...optional("end", draft.end),
    ...optional("start_after_maintenance", draft.start_after_maintenance),
    ...optional("end_note", draft.end_note),
    status: "confirmed",
    ...optional("tags", draft.tags),
    ...optional("students", draft.students),
    ...optional("description", draft.description),
    ...optional(
      "notes",
      draft.notes.map((note) => note.slice(0, 300)).slice(0, 12),
    ),
    ...optional("periods", draft.periods.slice(0, 12)),
    ...optional("images", draft.images.slice(0, 6)),
    source_url: draft.sources[0]!.url,
    sources: draft.sources.slice(0, 20),
    first_seen: now,
    updated_at: now,
  } as FeedEvent;
}

export function eventsFromDrafts(drafts: Draft[], now: string): FeedEvent[] {
  const byKey = new Map<string, Merged>();
  for (const draft of [...drafts].sort(
    (a, b) =>
      priority(a) - priority(b) ||
      b.post.publishedAt.localeCompare(a.post.publishedAt),
  )) {
    if (shouldExcludeCalendarEvent(draft)) continue;
    const existing = byKey.get(draft.key);
    if (existing) merge(existing, draft);
    else
      byKey.set(draft.key, {
        ...draft,
        images: [...draft.images],
        sources: [source(draft.post)],
      });
  }
  const merged = [...byKey.values()];
  resolveMaintenance(merged);
  return merged.map((draft) => toEvent(draft, now));
}

const comparable = (event: FeedEvent) =>
  JSON.stringify({ ...event, first_seen: undefined, updated_at: undefined });

export interface ArchiveReport {
  added: FeedEvent[];
  changed: FeedEvent[];
  removed: FeedEvent[];
  kept: number;
}

/** Drop removed events from re-read notices; retain notices outside this run. */
export function mergeArchive(
  previous: FeedEvent[],
  fresh: FeedEvent[],
  fetchedUrls: Set<string>,
  now: string,
): { events: FeedEvent[]; report: ArchiveReport } {
  const report: ArchiveReport = {
    added: [],
    changed: [],
    removed: [],
    kept: 0,
  };
  const old = new Map(previous.map((event) => [event.id, event]));
  const result = new Map<string, FeedEvent>();
  for (const event of fresh) {
    if (shouldExcludeCalendarEvent(event) || openEndedExpired(event, now))
      continue;
    const before = old.get(event.id);
    if (!before) {
      report.added.push(event);
      result.set(event.id, event);
      continue;
    }
    const sources = unique(
      [
        ...event.sources,
        ...before.sources.filter((item) => !fetchedUrls.has(item.url)),
      ],
      (item) => item.url,
    );
    const next = {
      ...event,
      sources,
      source_url: sources[0]!.url,
      first_seen: before.first_seen,
    };
    if (comparable(next) === comparable({ ...before }))
      result.set(event.id, before);
    else {
      report.changed.push(next);
      result.set(event.id, { ...next, updated_at: now });
    }
  }
  const cutoff = Date.parse(now) - RETENTION_MS;
  for (const event of previous) {
    if (result.has(event.id)) continue;
    if (shouldExcludeCalendarEvent(event)) {
      report.removed.push(event);
      continue;
    }
    if (event.sources.every((item) => fetchedUrls.has(item.url))) {
      report.removed.push(event);
      continue;
    }
    if (openEndedExpired(event, now)) continue;
    if ((endMoment(event) ?? Date.parse(event.start)) < cutoff) continue;
    report.kept += 1;
    result.set(event.id, event);
  }
  return { events: [...result.values()].sort(compareEvents), report };
}

export function buildFeed(
  events: FeedEvent[],
  previous: Feed | null,
  now: string,
): Feed {
  const unchanged =
    previous && JSON.stringify(previous.events) === JSON.stringify(events);
  return validateFeed({
    schema_version: 2,
    region: "KR",
    timezone: "Asia/Seoul",
    generated_at: unchanged ? previous.generated_at : now,
    source: FEED_SOURCE,
    events,
  });
}
