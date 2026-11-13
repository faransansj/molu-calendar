import {
  EVENT_ID,
  UPLOAD_NAME,
  validateCrop,
  validateSchedule,
  type EventOverride,
  type ImageOverride,
  type ScheduleOverride,
} from "../lib/admin/overrides.ts";
import { validDate, validInstant } from "../lib/calendar/calendar.ts";
import type { EventMetadata, FeedMetadata } from "./feed.ts";
import {
  PUBLICATION_ID,
  type Publication,
  type PublicationSnapshot,
  type PublicationStatus,
} from "../lib/admin/publication.ts";
import { HttpError } from "./http.ts";
import { ensureSchema } from "./calendar-store.ts";

const SNAPSHOT_LIMIT = 1_800_000;
const FEED_ID = /^[0-9a-f]{64}$/;

interface OverrideRow {
  event_id: string;
  image: string | null;
  schedule: string | null;
  updated_at: string;
}

// Stored JSON is not trusted: raw schedules keep their generic interval/date
// shape here; display compatibility against the current feed happens in App.
function decodeOverride(
  row: OverrideRow,
  feed: FeedMetadata,
): EventOverride | null {
  const event = feed.get(row.event_id);
  if (!EVENT_ID.test(row.event_id) || !event || !validInstant(row.updated_at)) {
    return null;
  }
  let image: ImageOverride | null = null;
  if (row.image !== null) {
    try {
      const value: unknown = JSON.parse(row.image);
      if (
        !value ||
        typeof value !== "object" ||
        Object.keys(value).length !== 2 ||
        !("upload" in value) ||
        !("crop" in value) ||
        (value.upload !== null &&
          (typeof value.upload !== "string" || !UPLOAD_NAME.test(value.upload)))
      )
        return null;
      const crop = validateCrop(value.crop);
      if (!crop) return null;
      image = { upload: value.upload, crop };
    } catch {
      return null;
    }
  }
  let schedule: ScheduleOverride | null = null;
  if (row.schedule !== null) {
    try {
      const candidate: unknown = JSON.parse(row.schedule);
      if (
        candidate &&
        typeof candidate === "object" &&
        "start" in candidate &&
        typeof candidate.start === "string"
      ) {
        const checked = validateSchedule(candidate, {
          kind: "interval",
          all_day: validDate(candidate.start),
        });
        if (checked.ok) schedule = checked.value;
        else if (!image) return null;
      } else if (!image) return null;
    } catch {
      if (!image) return null;
    }
  }
  if (!image && !schedule) return null;
  return {
    event_id: row.event_id,
    image,
    schedule,
    updated_at: row.updated_at,
  };
}

export async function listOverrides(
  db: D1Database,
  feed: FeedMetadata,
): Promise<EventOverride[]> {
  await ensureSchema(db);
  const { results } = await db
    .prepare("SELECT event_id, image, schedule, updated_at FROM overrides")
    .bind()
    .all<OverrideRow>();
  const overrides: EventOverride[] = [];
  for (const row of results) {
    const override = decodeOverride(row, feed);
    if (override) overrides.push(override);
  }
  return overrides;
}

export async function getOverride(
  db: D1Database,
  id: string,
  feed: FeedMetadata,
): Promise<EventOverride | null> {
  await ensureSchema(db);
  const row = await db
    .prepare(
      "SELECT event_id, image, schedule, updated_at FROM overrides WHERE event_id = ?",
    )
    .bind(id)
    .first<OverrideRow>();
  return row ? decodeOverride(row, feed) : null;
}

export async function saveOverride(
  db: D1Database,
  id: string,
  field: "image" | "schedule",
  value: ImageOverride | ScheduleOverride | null,
  feedId: string,
  feed: FeedMetadata,
  previousImage: ImageOverride | null = null,
): Promise<EventOverride | null> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  const encoded = value === null ? null : JSON.stringify(value);
  // Each mutation owns one column and is gated on the active feed ID. Image
  // CAS prevents an in-flight crop save from restoring an upload that a
  // concurrent replacement/restore deleted.
  const mutation =
    field === "image"
      ? db
          .prepare(
            "INSERT INTO overrides (event_id, image, schedule, updated_at) SELECT ?, ?, NULL, ? WHERE (SELECT image FROM overrides WHERE event_id = ?) IS ? AND (SELECT feed_id FROM calendar_state WHERE singleton = 1) = ? ON CONFLICT(event_id) DO UPDATE SET image = excluded.image, updated_at = excluded.updated_at",
          )
          .bind(
            id,
            encoded,
            now,
            id,
            previousImage === null ? null : JSON.stringify(previousImage),
            feedId,
          )
      : db
          .prepare(
            "INSERT INTO overrides (event_id, image, schedule, updated_at) SELECT ?, NULL, ?, ? WHERE (SELECT feed_id FROM calendar_state WHERE singleton = 1) = ? ON CONFLICT(event_id) DO UPDATE SET schedule = excluded.schedule, updated_at = excluded.updated_at",
          )
          .bind(id, encoded, now, feedId);
  const [changed, , , selected] = await db.batch<Record<string, unknown>>([
    mutation,
    db
      .prepare(
        "UPDATE stage SET revision = revision + 1, staged_at = ? WHERE singleton = 1 AND changes() = 1",
      )
      .bind(now),
    db
      .prepare(
        "DELETE FROM overrides WHERE event_id = ? AND image IS NULL AND schedule IS NULL AND changes() = 1",
      )
      .bind(id),
    db
      .prepare(
        "SELECT event_id, image, schedule, updated_at FROM overrides WHERE event_id = ?",
      )
      .bind(id),
  ]);
  if (changed!.meta.changes !== 1) throw new HttpError(409, "stage-conflict");
  const row = selected!.results[0] as unknown as OverrideRow | undefined;
  return row ? decodeOverride(row, feed) : null;
}

interface PublicationFields {
  id: string | null;
  revision: number | null;
  state: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface PointerRow extends PublicationFields {
  published_id: string | null;
}

interface PointerSnapshotRow extends PointerRow {
  snapshot: string | null;
}

interface FeedRow {
  feed_id: string;
  event_id: string | null;
  kind: string | null;
  all_day: number | null;
}

export async function publicationStatus(
  db: D1Database,
): Promise<PublicationStatus> {
  await ensureSchema(db);
  const [stage, pointed] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT revision, staged_at FROM stage WHERE singleton = 1")
      .bind(),
    db
      .prepare(
        "SELECT s.published_id AS published_id, p.id AS id, p.revision AS revision, p.state AS state, p.created_at AS created_at, p.updated_at AS updated_at FROM calendar_state s LEFT JOIN publications p ON p.id = s.published_id WHERE s.singleton = 1",
      )
      .bind(),
  ]);
  const current = stage!.results[0];
  if (
    !current ||
    typeof current.revision !== "number" ||
    !Number.isSafeInteger(current.revision) ||
    current.revision < 0 ||
    (current.staged_at !== null && typeof current.staged_at !== "string")
  )
    throw new Error("Invalid stage");
  const revision = current.revision;
  const stagedAt = current.staged_at as string | null;
  if (pointed!.results.length === 0)
    throw new HttpError(503, "calendar-unavailable");
  const row = pointed!.results[0] as unknown as PointerRow;
  if (row.published_id === null) {
    if (row.id !== null) throw new HttpError(503, "calendar-unavailable");
    return { revision, staged_at: stagedAt, published: null };
  }
  if (
    !PUBLICATION_ID.test(row.published_id) ||
    typeof row.id !== "string" ||
    row.id !== row.published_id ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    row.state !== "published" ||
    typeof row.created_at !== "string" ||
    !validInstant(row.created_at) ||
    typeof row.updated_at !== "string" ||
    !validInstant(row.updated_at)
  )
    throw new HttpError(503, "calendar-unavailable");
  return {
    revision,
    staged_at: stagedAt,
    published: {
      id: row.id,
      revision: row.revision,
      state: "published",
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  };
}

export async function createPublication(
  db: D1Database,
): Promise<PublicationSnapshot> {
  await ensureSchema(db);
  // One consistent read: stage revision, drafts, active feed metadata, public pointer/snapshot.
  const [stage, drafts, feed, pointed] = await db.batch<
    Record<string, unknown>
  >([
    db.prepare("SELECT revision FROM stage WHERE singleton = 1").bind(),
    db
      .prepare(
        "SELECT event_id, image, schedule, updated_at FROM overrides ORDER BY event_id",
      )
      .bind(),
    db
      .prepare(
        "SELECT s.feed_id AS feed_id, m.event_id AS event_id, m.kind AS kind, m.all_day AS all_day FROM calendar_state s JOIN official_feeds f ON f.id = s.feed_id AND f.ready = 1 LEFT JOIN official_event_meta m ON m.feed_id = s.feed_id WHERE s.singleton = 1 ORDER BY m.event_id",
      )
      .bind(),
    db
      .prepare(
        "SELECT s.published_id AS published_id, p.id AS id, p.revision AS revision, p.state AS state, p.created_at AS created_at, p.updated_at AS updated_at, p.snapshot AS snapshot FROM calendar_state s LEFT JOIN publications p ON p.id = s.published_id WHERE s.singleton = 1",
      )
      .bind(),
  ]);
  const stageRow = stage!.results[0];
  if (
    !stageRow ||
    typeof stageRow.revision !== "number" ||
    !Number.isSafeInteger(stageRow.revision) ||
    stageRow.revision < 0
  )
    throw new Error("Invalid stage");
  const revision = stageRow.revision;
  const feedRows = feed!.results as unknown as FeedRow[];
  if (feedRows.length === 0) throw new HttpError(503, "calendar-unavailable");
  const feedId = feedRows[0]!.feed_id;
  if (typeof feedId !== "string" || !FEED_ID.test(feedId))
    throw new HttpError(503, "calendar-unavailable");
  const events = new Map<string, EventMetadata>();
  for (const row of feedRows) {
    if (row.feed_id !== feedId)
      throw new HttpError(503, "calendar-unavailable");
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
    events.set(row.event_id, { kind: row.kind, all_day: row.all_day === 1 });
  }
  if (events.size === 0) throw new HttpError(503, "calendar-unavailable");
  const pointerRows = pointed!.results as unknown as PointerSnapshotRow[];
  if (pointerRows.length === 0)
    throw new HttpError(503, "calendar-unavailable");
  const pointer = pointerRows[0]!;
  let previousId: string | null;
  let currentRevision = -1;
  let currentSnapshot = "";
  if (pointer.published_id === null) {
    if (pointer.id !== null) throw new HttpError(503, "calendar-unavailable");
    previousId = null;
  } else {
    if (
      !PUBLICATION_ID.test(pointer.published_id) ||
      typeof pointer.id !== "string" ||
      pointer.id !== pointer.published_id ||
      typeof pointer.revision !== "number" ||
      !Number.isSafeInteger(pointer.revision) ||
      pointer.revision < 0 ||
      pointer.state !== "published" ||
      typeof pointer.created_at !== "string" ||
      !validInstant(pointer.created_at) ||
      typeof pointer.updated_at !== "string" ||
      !validInstant(pointer.updated_at) ||
      typeof pointer.snapshot !== "string"
    )
      throw new HttpError(503, "calendar-unavailable");
    previousId = pointer.published_id;
    currentRevision = pointer.revision;
    currentSnapshot = pointer.snapshot;
  }
  // Known drafts validate against current metadata; unknown rows stay stored but excluded.
  // An invalid intended schedule is a conflict, never a silent partial publish.
  const overrides: EventOverride[] = [];
  for (const draft of drafts!.results as unknown as OverrideRow[]) {
    const meta = events.get(draft.event_id);
    if (!meta) continue;
    if (!EVENT_ID.test(draft.event_id) || !validInstant(draft.updated_at))
      throw new HttpError(409, "stage-conflict");
    let image: ImageOverride | null = null;
    if (draft.image !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.image);
      } catch {
        throw new HttpError(409, "stage-conflict");
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Object.keys(parsed).length !== 2 ||
        !("upload" in parsed) ||
        !("crop" in parsed) ||
        (parsed.upload !== null &&
          (typeof parsed.upload !== "string" ||
            !UPLOAD_NAME.test(parsed.upload)))
      )
        throw new HttpError(409, "stage-conflict");
      const crop = validateCrop(parsed.crop);
      if (!crop) throw new HttpError(409, "stage-conflict");
      image = { upload: parsed.upload, crop };
    }
    let schedule: ScheduleOverride | null = null;
    if (draft.schedule !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.schedule);
      } catch {
        throw new HttpError(409, "stage-conflict");
      }
      const checked = validateSchedule(parsed, meta);
      if (!checked.ok) throw new HttpError(409, "stage-conflict");
      schedule = checked.value;
    }
    if (!image && !schedule) continue;
    overrides.push({
      event_id: draft.event_id,
      image,
      schedule,
      updated_at: draft.updated_at,
    });
  }
  const snapshot = JSON.stringify(overrides);
  // Same revision plus identical bytes is a no-op only after a consistent pointer recheck.
  // A rotated feed can still require a new immutable ID at the same revision.
  if (
    previousId !== null &&
    revision === currentRevision &&
    snapshot === currentSnapshot
  ) {
    const confirmed = await db
      .prepare(
        "SELECT p.id AS id, p.revision AS revision, p.state AS state, p.created_at AS created_at, p.updated_at AS updated_at FROM stage s JOIN calendar_state c ON s.singleton = 1 AND c.singleton = 1 JOIN publications p ON p.id = c.published_id WHERE s.revision = ? AND c.feed_id = ? AND c.published_id = ? AND p.snapshot = ? AND p.state = 'published'",
      )
      .bind(revision, feedId, previousId, currentSnapshot)
      .first<PublicationFields>();
    if (
      !confirmed ||
      typeof confirmed.id !== "string" ||
      confirmed.id !== previousId ||
      typeof confirmed.revision !== "number" ||
      confirmed.revision !== revision ||
      confirmed.state !== "published" ||
      typeof confirmed.created_at !== "string" ||
      !validInstant(confirmed.created_at) ||
      typeof confirmed.updated_at !== "string" ||
      !validInstant(confirmed.updated_at)
    )
      throw new HttpError(409, "stage-conflict");
    return {
      publication: {
        id: confirmed.id,
        revision: confirmed.revision,
        state: "published",
        created_at: confirmed.created_at,
        updated_at: confirmed.updated_at,
      },
      overrides,
    };
  }
  if (new TextEncoder().encode(snapshot).length > SNAPSHOT_LIMIT)
    throw new HttpError(413, "publication-too-large");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // One atomic commit: guarded insert, exact membership backfill, guarded pointer switch, readback.
  // Zero insert changes leave membership and the public pointer untouched.
  const [inserted, , switched, selected] = await db.batch<
    Record<string, unknown>
  >([
    db
      .prepare(
        "INSERT INTO publications (id, revision, state, created_at, updated_at, snapshot) SELECT ?, ?, 'published', ?, ?, ? WHERE (SELECT revision FROM stage WHERE singleton = 1) = ? AND (SELECT feed_id FROM calendar_state WHERE singleton = 1) = ? AND (SELECT published_id FROM calendar_state WHERE singleton = 1) IS ?",
      )
      .bind(id, revision, now, now, snapshot, revision, feedId, previousId),
    db
      .prepare(
        "INSERT OR IGNORE INTO published_images (upload, publication_id) SELECT DISTINCT json_extract(item.value, '$.image.upload'), ? FROM publications, json_each(publications.snapshot) AS item WHERE publications.id = ? AND json_extract(item.value, '$.image.upload') IS NOT NULL",
      )
      .bind(id, id),
    db
      .prepare(
        "UPDATE calendar_state SET published_id = ? WHERE singleton = 1 AND feed_id = ? AND published_id IS ? AND (SELECT revision FROM stage WHERE singleton = 1) = ? AND EXISTS (SELECT 1 FROM publications WHERE id = ?)",
      )
      .bind(id, feedId, previousId, revision, id),
    db
      .prepare(
        "SELECT id, revision, state, created_at, updated_at FROM publications WHERE id = ?",
      )
      .bind(id),
  ]);
  if (inserted!.meta.changes !== 1) throw new HttpError(409, "stage-conflict");
  if (switched!.meta.changes !== 1)
    throw new Error("Publication pointer not switched");
  const publication = selected!.results[0] as unknown as
    Publication | undefined;
  if (
    !publication ||
    publication.id !== id ||
    publication.revision !== revision ||
    publication.state !== "published" ||
    publication.created_at !== now ||
    publication.updated_at !== now
  )
    throw new Error("Invalid publication commit");
  return { publication, overrides };
}

export async function uploadReferenced(
  db: D1Database,
  name: string,
): Promise<boolean> {
  await ensureSchema(db);
  const row = await db
    .prepare(
      "SELECT 1 AS found FROM overrides WHERE json_extract(image, '$.upload') = ? UNION ALL SELECT 1 AS found FROM publications, json_each(publications.snapshot) AS item WHERE json_extract(item.value, '$.image.upload') = ? LIMIT 1",
    )
    .bind(name, name)
    .first();
  return row !== null;
}

export async function createSession(
  db: D1Database,
  hash: string,
  expiresAt: number,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)")
    .bind(hash, expiresAt)
    .run();
}

export async function findSession(
  db: D1Database,
  hash: string,
  now: number,
): Promise<boolean> {
  await ensureSchema(db);
  const row = await db
    .prepare(
      "SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?",
    )
    .bind(hash, now)
    .first<{ token_hash: string }>();
  return row !== null;
}

export async function deleteSession(
  db: D1Database,
  hash: string,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(hash)
    .run();
}

export async function failures(
  db: D1Database,
  bucket: string,
  since: number,
): Promise<number[]> {
  await ensureSchema(db);
  const { results } = await db
    .prepare(
      "SELECT at FROM login_failures WHERE bucket = ? AND at > ? ORDER BY at",
    )
    .bind(bucket, since)
    .all<{ at: number }>();
  return results.map((row) => row.at);
}

export async function addFailure(
  db: D1Database,
  bucket: string,
  at: number,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("INSERT INTO login_failures (bucket, at) VALUES (?, ?)")
    .bind(bucket, at)
    .run();
}

export async function clearFailures(
  db: D1Database,
  bucket: string,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM login_failures WHERE bucket = ?")
    .bind(bucket)
    .run();
}

export async function prune(db: D1Database, now: number): Promise<void> {
  await ensureSchema(db);
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db
      .prepare("DELETE FROM login_failures WHERE at < ?")
      .bind(now - 86_400_000),
  ]);
}
