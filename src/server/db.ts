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
import type { FeedMetadata } from "./feed.ts";
import type {
  Publication,
  PublicationSnapshot,
  PublicationState,
  PublicationStatus,
} from "../lib/admin/publication.ts";
import { HttpError } from "./http.ts";

const schemas = new WeakMap<D1Database, Promise<void>>();
const QUEUED_LEASE_MS = 30 * 60_000;

export function ensureSchema(db: D1Database): Promise<void> {
  const cached = schemas.get(db);
  if (cached) return cached;
  const creating = db
    .batch([
      db
        .prepare(
          "CREATE TABLE IF NOT EXISTS overrides (event_id TEXT PRIMARY KEY, image TEXT, schedule TEXT, updated_at TEXT NOT NULL)",
        )
        .bind(),
      db
        .prepare(
          "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
        )
        .bind(),
      db
        .prepare(
          "CREATE TABLE IF NOT EXISTS login_failures (bucket TEXT NOT NULL, at INTEGER NOT NULL)",
        )
        .bind(),
      db
        .prepare(
          "CREATE INDEX IF NOT EXISTS login_failures_bucket_at ON login_failures (bucket, at)",
        )
        .bind(),
      db
        .prepare(
          "CREATE TABLE IF NOT EXISTS stage (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL, staged_at TEXT)",
        )
        .bind(),
      db
        .prepare(
          "INSERT OR IGNORE INTO stage (singleton, revision, staged_at) SELECT 1, CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END, MAX(updated_at) FROM overrides",
        )
        .bind(),
      db
        .prepare(
          "CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('queued', 'building', 'published', 'failed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot TEXT NOT NULL)",
        )
        .bind(),
      db
        .prepare(
          "CREATE UNIQUE INDEX IF NOT EXISTS publications_one_active ON publications ((1)) WHERE state IN ('queued', 'building')",
        )
        .bind(),
    ])
    .then(() => undefined)
    .catch((cause: unknown) => {
      schemas.delete(db);
      throw cause;
    });
  schemas.set(db, creating);
  return creating;
}

interface OverrideRow {
  event_id: string;
  image: string | null;
  schedule: string | null;
  updated_at: string;
}

// Stored JSON is not trusted: schedules must match this deployment's feed.
function decodeOverride(
  row: OverrideRow,
  feed: FeedMetadata,
): EventOverride | null {
  const event = feed.get(row.event_id);
  if (!EVENT_ID.test(row.event_id) || !event || !validInstant(row.updated_at)) {
    return null;
  }
  try {
    let image: ImageOverride | null = null;
    let schedule: ScheduleOverride | null = null;
    if (row.image !== null) {
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
    }
    if (row.schedule !== null) {
      const checked = validateSchedule(JSON.parse(row.schedule), event);
      if (!checked.ok) return null;
      schedule = checked.value;
    }
    if (!image && !schedule) return null;
    return {
      event_id: row.event_id,
      image,
      schedule,
      updated_at: row.updated_at,
    };
  } catch {
    return null;
  }
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
  feed: FeedMetadata,
  previousImage: ImageOverride | null = null,
): Promise<EventOverride | null> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  const encoded = value === null ? null : JSON.stringify(value);
  // Each mutation owns one column. Image CAS prevents an in-flight crop save
  // from restoring an upload that a concurrent replacement/restore deleted.
  const mutation =
    field === "image"
      ? db
          .prepare(
            "INSERT INTO overrides (event_id, image, schedule, updated_at) SELECT ?, ?, NULL, ? WHERE (SELECT image FROM overrides WHERE event_id = ?) IS ? ON CONFLICT(event_id) DO UPDATE SET image = excluded.image, updated_at = excluded.updated_at",
          )
          .bind(
            id,
            encoded,
            now,
            id,
            previousImage === null ? null : JSON.stringify(previousImage),
          )
      : db
          .prepare(
            "INSERT INTO overrides (event_id, image, schedule, updated_at) VALUES (?, NULL, ?, ?) ON CONFLICT(event_id) DO UPDATE SET schedule = excluded.schedule, updated_at = excluded.updated_at",
          )
          .bind(id, encoded, now);
  const [changed, , , selected] = await db.batch<Record<string, unknown>>([
    mutation,
    db
      .prepare(
        "UPDATE stage SET revision = revision + 1, staged_at = ? WHERE singleton = 1 AND changes() = 1",
      )
      .bind(now),
    db
      .prepare(
        "DELETE FROM overrides WHERE event_id = ? AND image IS NULL AND schedule IS NULL",
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

interface PublicationRow extends Publication {
  snapshot: string;
}

function parseSnapshotOverrides(snapshot: string): EventOverride[] {
  const parsed: unknown = JSON.parse(snapshot);
  if (!Array.isArray(parsed)) throw new Error("Invalid publication snapshot");
  const overrides: EventOverride[] = [];
  const ids = new Set<string>();
  for (const value of parsed as unknown[]) {
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).length !== 4 ||
      !("event_id" in value) ||
      typeof value.event_id !== "string" ||
      !EVENT_ID.test(value.event_id) ||
      ids.has(value.event_id) ||
      !("updated_at" in value) ||
      typeof value.updated_at !== "string" ||
      !validInstant(value.updated_at) ||
      !("image" in value) ||
      !("schedule" in value)
    ) {
      throw new Error("Invalid publication override");
    }
    let image: ImageOverride | null = null;
    if (value.image !== null) {
      const candidate = value.image;
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Object.keys(candidate).length !== 2 ||
        !("upload" in candidate) ||
        !("crop" in candidate) ||
        (candidate.upload !== null &&
          (typeof candidate.upload !== "string" ||
            !UPLOAD_NAME.test(candidate.upload)))
      )
        throw new Error("Invalid publication image");
      const crop = validateCrop(candidate.crop);
      if (!crop) throw new Error("Invalid publication crop");
      image = { upload: candidate.upload, crop };
    }
    let schedule: ScheduleOverride | null = null;
    if (value.schedule !== null) {
      const candidate = value.schedule;
      if (
        !candidate ||
        typeof candidate !== "object" ||
        !("start" in candidate) ||
        typeof candidate.start !== "string"
      )
        throw new Error("Invalid publication schedule");
      // Validate the immutable wire shape without consulting a newer official feed.
      const checked = validateSchedule(candidate, {
        kind: "interval",
        all_day: validDate(candidate.start),
      });
      if (!checked.ok) throw new Error("Invalid publication schedule");
      schedule = checked.value;
    }
    if (!image && !schedule) throw new Error("Empty publication override");
    ids.add(value.event_id);
    overrides.push({
      event_id: value.event_id,
      image,
      schedule,
      updated_at: value.updated_at,
    });
  }
  return overrides;
}

export async function publicationStatus(
  db: D1Database,
  deployed: Publication | null,
): Promise<PublicationStatus> {
  await ensureSchema(db);
  const [stage, latest] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT revision, staged_at FROM stage WHERE singleton = 1")
      .bind(),
    db
      .prepare(
        "SELECT id, revision, state, created_at, updated_at FROM publications ORDER BY rowid DESC LIMIT 1",
      )
      .bind(),
  ]);
  const current = stage!.results[0];
  if (
    !current ||
    typeof current.revision !== "number" ||
    (current.staged_at !== null && typeof current.staged_at !== "string")
  )
    throw new Error("Invalid stage");
  return {
    revision: current.revision,
    staged_at: current.staged_at,
    latest: (latest!.results[0] as unknown as Publication | undefined) ?? null,
    deployed,
  };
}

export async function createPublication(
  db: D1Database,
  feed: FeedMetadata,
): Promise<PublicationSnapshot> {
  await ensureSchema(db);
  // D1 batches run transactionally: the revision and override rows are one view.
  const [stage, rows] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT revision FROM stage WHERE singleton = 1").bind(),
    db
      .prepare(
        "SELECT event_id, image, schedule, updated_at FROM overrides ORDER BY event_id",
      )
      .bind(),
  ]);
  const current = stage!.results[0];
  if (!current || typeof current.revision !== "number")
    throw new Error("Invalid stage");
  const revision = current.revision;
  const overrides: EventOverride[] = [];
  for (const row of rows!.results) {
    const override = decodeOverride(row as unknown as OverrideRow, feed);
    if (override) overrides.push(override);
  }
  const now = new Date().toISOString();
  const publication: Publication = {
    id: crypto.randomUUID(),
    revision,
    state: "queued",
    created_at: now,
    updated_at: now,
  };
  // Check the revision again inside the INSERT, not in a separate query.
  // A simultaneous stage edit or publisher loses cleanly without a stale snapshot.
  const [, inserted] = await db.batch([
    db
      .prepare(
        "UPDATE publications SET state = 'failed', updated_at = ? WHERE state = 'queued' AND created_at <= ?",
      )
      .bind(now, new Date(Date.parse(now) - QUEUED_LEASE_MS).toISOString()),
    db
      .prepare(
        "INSERT INTO publications (id, revision, state, created_at, updated_at, snapshot) SELECT ?, ?, 'queued', ?, ?, ? FROM stage WHERE singleton = 1 AND revision = ? AND NOT EXISTS (SELECT 1 FROM publications WHERE state IN ('queued', 'building'))",
      )
      .bind(
        publication.id,
        revision,
        now,
        now,
        JSON.stringify(overrides),
        revision,
      ),
  ]);
  if (inserted!.meta.changes !== 1) throw new HttpError(409, "publish-busy");
  return { publication, overrides };
}

export async function getPublication(
  db: D1Database,
  id: string,
): Promise<PublicationSnapshot | null> {
  await ensureSchema(db);
  const row = await db
    .prepare(
      "SELECT id, revision, state, created_at, updated_at, snapshot FROM publications WHERE id = ?",
    )
    .bind(id)
    .first<PublicationRow>();
  if (!row) return null;
  const { snapshot, ...publication } = row;
  return { publication, overrides: parseSnapshotOverrides(snapshot) };
}

export async function transitionPublication(
  db: D1Database,
  id: string,
  state: Exclude<PublicationState, "queued">,
): Promise<Publication> {
  await ensureSchema(db);
  const now = new Date().toISOString();
  const [changed, selected] = await db.batch([
    db
      .prepare(
        "UPDATE publications SET state = ?, updated_at = ? WHERE id = ? AND ((state = 'queued' AND (? = 'failed' OR (? = 'building' AND created_at > ?))) OR (state = 'building' AND ? IN ('published', 'failed')))",
      )
      .bind(
        state,
        now,
        id,
        state,
        state,
        new Date(Date.parse(now) - QUEUED_LEASE_MS).toISOString(),
        state,
      ),
    db
      .prepare(
        "SELECT id, revision, state, created_at, updated_at FROM publications WHERE id = ?",
      )
      .bind(id),
  ]);
  const publication = selected!.results[0] as unknown as
    Publication | undefined;
  if (!publication) throw new HttpError(404, "not-found");
  if (changed!.meta.changes !== 1 && publication.state !== state) {
    throw new HttpError(409, "invalid-transition");
  }
  // Same-state callbacks do not change updated_at or the deployed ordering.
  return publication;
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
