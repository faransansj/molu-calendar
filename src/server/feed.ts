import type { FeedEvent } from "../lib/calendar/feed.ts";
import { EVENT_ID } from "../lib/admin/overrides.ts";
import { ensureSchema } from "./calendar-store.ts";
import { HttpError } from "./http.ts";

export type EventMetadata = Pick<FeedEvent, "kind" | "all_day">;
export type FeedMetadata = ReadonlyMap<string, EventMetadata>;

const FEED_ID = /^[0-9a-f]{64}$/;

interface MetaRow {
  feed_id: string;
  event_id: string | null;
  kind: string | null;
  all_day: number | null;
}

export async function loadFeed(
  db: D1Database,
): Promise<{ id: string; events: FeedMetadata }> {
  await ensureSchema(db);
  const { results } = await db
    .prepare(
      "SELECT s.feed_id AS feed_id, m.event_id AS event_id, m.kind AS kind, m.all_day AS all_day FROM calendar_state s JOIN official_feeds f ON f.id = s.feed_id AND f.ready = 1 LEFT JOIN official_event_meta m ON m.feed_id = s.feed_id WHERE s.singleton = 1 ORDER BY m.event_id",
    )
    .bind()
    .all<MetaRow>();
  if (results.length === 0) throw new HttpError(503, "calendar-unavailable");
  const id = results[0]!.feed_id;
  if (typeof id !== "string" || !FEED_ID.test(id))
    throw new HttpError(503, "calendar-unavailable");
  const events = new Map<string, EventMetadata>();
  for (const row of results) {
    if (row.feed_id !== id) throw new HttpError(503, "calendar-unavailable");
    if (typeof row.event_id !== "string" || !EVENT_ID.test(row.event_id))
      throw new HttpError(503, "calendar-unavailable");
    if (
      row.kind !== "interval" &&
      row.kind !== "release" &&
      row.kind !== "deadline"
    )
      throw new HttpError(503, "calendar-unavailable");
    if (row.all_day !== 0 && row.all_day !== 1)
      throw new HttpError(503, "calendar-unavailable");
    if (events.has(row.event_id))
      throw new HttpError(503, "calendar-unavailable");
    events.set(row.event_id, {
      kind: row.kind,
      all_day: row.all_day === 1,
    });
  }
  if (events.size === 0) throw new HttpError(503, "calendar-unavailable");
  return { id, events };
}
