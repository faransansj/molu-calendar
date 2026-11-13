import { ADMIN_SCHEMA, CALENDAR_SCHEMA } from "./schema.ts";
import { HttpError } from "./http.ts";

const schemas = new WeakMap<D1Database, Promise<void>>();
export function ensureSchema(db: D1Database): Promise<void> {
  const cached = schemas.get(db);
  if (cached) return cached;
  const creating = db
    .batch([...ADMIN_SCHEMA, ...CALENDAR_SCHEMA].map((sql) => db.prepare(sql)))
    .then(() => undefined)
    .catch((cause: unknown) => {
      schemas.delete(db);
      throw cause;
    });
  schemas.set(db, creating);
  return creating;
}

interface CalendarRow {
  tag: number;
  feed_id: string;
  published_id: string | null;
  revision: number | null;
  state: string | null;
  snapshot: string | null;
  manifest: string | null;
  part: number;
  body: string | null;
}
interface ArtifactEntry {
  path: string;
  parts: number;
  bytes: number;
  sha256: string;
}
export interface StoredCalendar {
  feedId: string;
  publishedId: string | null;
  publishedJson: string;
  artifact: ArtifactEntry | null;
  body: string | null;
}

export async function readCalendar(
  db: D1Database,
  path: string | null,
): Promise<StoredCalendar> {
  await ensureSchema(db);
  // Tagged rows avoid repeating the immutable publication snapshot for every chunk.
  // One statement pins all returned rows to one pointer/version, including pruning races.
  const { results } = await db
    .prepare(
      "WITH active AS (SELECT s.feed_id,s.published_id,p.revision,p.state,p.snapshot,f.manifest FROM calendar_state s JOIN official_feeds f ON f.id=s.feed_id AND f.ready=1 LEFT JOIN publications p ON p.id=s.published_id WHERE s.singleton=1) SELECT 0 AS tag,feed_id,published_id,revision,state,snapshot,manifest,-1 AS part,NULL AS body FROM active UNION ALL SELECT 1,a.feed_id,NULL,NULL,NULL,NULL,NULL,c.part,c.body FROM active a JOIN official_artifacts c ON c.feed_id=a.feed_id AND c.path=? ORDER BY tag,part",
    )
    .bind(path)
    .all<CalendarRow>();
  const current = results[0];
  if (
    !current ||
    current.tag !== 0 ||
    !/^[a-f0-9]{64}$/.test(current.feed_id) ||
    !current.manifest ||
    (current.published_id !== null &&
      (current.state !== "published" ||
        current.snapshot === null ||
        !Number.isSafeInteger(current.revision)))
  )
    throw new HttpError(503, "calendar-unavailable");
  let manifest: ArtifactEntry[];
  try {
    const parsed: unknown = JSON.parse(current.manifest);
    if (!Array.isArray(parsed)) throw new Error("manifest");
    manifest = parsed as ArtifactEntry[];
  } catch {
    throw new HttpError(503, "calendar-unavailable");
  }
  const artifact =
    path === null
      ? null
      : (manifest.find((entry) => entry?.path === path) ?? null);
  let body: string | null = null;
  if (path !== null) {
    if (
      !artifact ||
      !Number.isSafeInteger(artifact.parts) ||
      artifact.parts < 1 ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifact.bytes > 16 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      results.length !== artifact.parts + 1
    )
      throw new HttpError(503, "calendar-unavailable");
    const parts: string[] = [];
    for (let index = 1; index < results.length; index++) {
      const row = results[index]!;
      if (
        row.tag !== 1 ||
        row.feed_id !== current.feed_id ||
        row.part !== index - 1 ||
        typeof row.body !== "string" ||
        row.body.length === 0
      )
        throw new HttpError(503, "calendar-unavailable");
      parts.push(row.body);
    }
    body = parts.join("");
  }
  const publication =
    current.published_id === null
      ? "null"
      : JSON.stringify({
          id: current.published_id,
          revision: current.revision,
        });
  return {
    feedId: current.feed_id,
    publishedId: current.published_id,
    publishedJson: `{"publication":${publication},"overrides":${current.snapshot ?? "[]"}}`,
    artifact,
    body,
  };
}
