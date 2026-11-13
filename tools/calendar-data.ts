import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { validateFeed } from "../scraper/schema.ts";
import type { Feed } from "../src/lib/calendar/feed.ts";
import { ADMIN_SCHEMA, CALENDAR_SCHEMA } from "../src/server/schema.ts";
import {
  validateManifest,
  validateLegacySnapshot,
  type PublishedManifest,
} from "../src/lib/admin/publication.ts";
import { validateSchedule } from "../src/lib/admin/overrides.ts";
import { sniffImage, MAX_UPLOAD_BYTES } from "../src/lib/admin/images.ts";
import {
  buildOfficialBundle,
  sha256Hex,
  utf8Bytes,
  OFFICIAL_JSON_PATH,
  type OfficialBundle,
  type OfficialManifestEntry,
} from "../src/lib/calendar/artifacts.ts";
import { z } from "zod";
import {
  createLocalD1,
  createRemoteD1,
  readRemoteConfig,
  executeBounded,
  type D1Adapter,
  type D1Statement,
} from "./cloudflare-d1.ts";

const execFile = promisify(execFileCallback);
const FEED_ID = /^[a-f0-9]{64}$/;
interface Pointer {
  feed_id: string;
  previous_feed_id: string | null;
  published_id: string | null;
}
interface StoredPublication {
  id: string;
  revision: number;
  state: string;
  created_at: string;
  updated_at: string;
  snapshot: string;
}

async function report(message: string): Promise<void> {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

async function pointer(db: D1Adapter): Promise<Pointer | null> {
  return (
    (
      await db.query<Pointer>(
        "SELECT feed_id,previous_feed_id,published_id FROM calendar_state WHERE singleton=1",
      )
    ).rows[0] ?? null
  );
}
async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function validatePublishedImages(
  db: D1Adapter,
  rows: StoredPublication[],
): Promise<void> {
  const names = new Set<string>();
  for (const row of rows) {
    const snapshot = validateLegacySnapshot({
      publication: {
        id: row.id,
        revision: row.revision,
        state: row.state,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      overrides: JSON.parse(row.snapshot),
    });
    for (const override of snapshot.overrides)
      if (override.image?.upload) names.add(override.image.upload);
  }
  await mkdir(".calendar/images", { recursive: true });
  for (const name of names) {
    const path = resolve(`.calendar/images/${crypto.randomUUID()}`);
    try {
      await execFile(
        "pnpm",
        [
          "exec",
          "wrangler",
          "r2",
          "object",
          "get",
          `molu-admin-images/uploads/${name}`,
          db.target === "remote" ? "--remote" : "--local",
          "--file",
          path,
        ],
        { timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
      const bytes = await readFile(path);
      const image = sniffImage(bytes);
      if (
        bytes.byteLength > MAX_UPLOAD_BYTES ||
        !image ||
        !name.endsWith(`.${image.ext}`)
      )
        throw new Error("Invalid retained published image");
    } catch {
      throw new Error(
        "Retained published image unavailable or invalid; migration aborted",
      );
    } finally {
      await rm(path, { force: true });
    }
  }
}

async function migrationRows(
  db: D1Adapter,
  feed: Feed,
  manifest: PublishedManifest,
): Promise<StoredPublication[]> {
  const rows = (
    await db.query<StoredPublication>(
      "SELECT id,revision,state,created_at,updated_at,snapshot FROM publications ORDER BY rowid",
    )
  ).rows;
  const live = manifest.publication;
  if (live) {
    const row = rows.find((row) => row.id === live.id);
    if (!row || row.revision !== live.revision || row.state === "failed")
      throw new Error("Live publication marker disagrees with D1");
    const snapshot = validateLegacySnapshot({
      publication: {
        id: row.id,
        revision: row.revision,
        state: row.state,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      overrides: JSON.parse(row.snapshot),
    });
    const events = new Map(feed.events.map((event) => [event.id, event]));
    const filtered = snapshot.overrides.filter((override) => {
      const event = events.get(override.event_id);
      if (!event) return false;
      if (override.schedule && !validateSchedule(override.schedule, event).ok)
        throw new Error(
          "Live publication schedule disagrees with official feed",
        );
      return true;
    });
    if (JSON.stringify(filtered) !== JSON.stringify(manifest.overrides))
      throw new Error("Live publication overrides disagree with D1");
  }
  return rows.filter((row) => row.state === "published" || row.id === live?.id);
}

const manifestSchema = z
  .array(
    z.strictObject({
      path: z.string().regex(/^(data\/events\.json|feeds\/[a-z]+\.ics)$/),
      parts: z.number().int().positive(),
      bytes: z
        .number()
        .int()
        .positive()
        .max(16 * 1024 * 1024),
      sha256: z.string().regex(FEED_ID),
    }),
  )
  .min(1)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.path)).size === entries.length,
  );

async function verifyArtifact(
  entry: OfficialManifestEntry,
  rows: readonly { part: number; body: string }[],
): Promise<string> {
  if (
    rows.length !== entry.parts ||
    rows.some(
      (row, index) =>
        row.part !== index ||
        typeof row.body !== "string" ||
        utf8Bytes(row.body) > 32768,
    )
  )
    throw new Error("Official artifact chunks are missing or corrupt");
  const body = rows.map((row) => row.body).join("");
  if (
    utf8Bytes(body) !== entry.bytes ||
    (await sha256Hex(body)) !== entry.sha256
  )
    throw new Error("Official artifact digest mismatch");
  return body;
}

async function verifyVersion(
  db: D1Adapter,
  bundle: OfficialBundle,
): Promise<void> {
  const stored = (
    await db.query<{
      manifest: string;
      event_count: number;
      generated_at: string;
    }>(
      "SELECT manifest,event_count,generated_at FROM official_feeds WHERE id=?",
      [bundle.feedId],
    )
  ).rows[0];
  if (
    !stored ||
    stored.manifest !== JSON.stringify(bundle.manifest) ||
    stored.event_count !== bundle.eventCount ||
    stored.generated_at !== bundle.generatedAt
  )
    throw new Error(
      "Existing official version disagrees with deterministic artifacts",
    );
  const manifest = manifestSchema.parse(JSON.parse(stored.manifest));
  if (!manifest.some((entry) => entry.path === OFFICIAL_JSON_PATH))
    throw new Error("Official JSON missing from manifest");
  const paths = (
    await db.query<{ path: string }>(
      "SELECT DISTINCT path FROM official_artifacts WHERE feed_id=? ORDER BY path",
      [bundle.feedId],
    )
  ).rows.map((row) => row.path);
  if (
    JSON.stringify(paths) !==
    JSON.stringify(bundle.manifest.map((entry) => entry.path).sort())
  )
    throw new Error("Official artifact paths mismatch");
  for (const entry of bundle.manifest) {
    const rows = (
      await db.query<{ part: number; body: string }>(
        "SELECT part,body FROM official_artifacts WHERE feed_id=? AND path=? ORDER BY part",
        [bundle.feedId, entry.path],
      )
    ).rows;
    await verifyArtifact(entry, rows);
  }
  const metadata = (
    await db.query<{ event_id: string; kind: string; all_day: number }>(
      "SELECT event_id,kind,all_day FROM official_event_meta WHERE feed_id=? ORDER BY event_id",
      [bundle.feedId],
    )
  ).rows;
  const expected = bundle.eventMeta
    .map((event) => ({ ...event, all_day: Number(event.all_day) }))
    .sort((a, b) => a.event_id.localeCompare(b.event_id));
  if (JSON.stringify(metadata) !== JSON.stringify(expected))
    throw new Error("Official event metadata mismatch");
}

async function installVersion(
  db: D1Adapter,
  bundle: OfficialBundle,
): Promise<void> {
  const existing = (
    await db.query<{ ready: number; manifest: string }>(
      "SELECT ready,manifest FROM official_feeds WHERE id=?",
      [bundle.feedId],
    )
  ).rows[0];
  if (
    existing?.manifest !== undefined &&
    existing.manifest !== JSON.stringify(bundle.manifest)
  )
    throw new Error(
      "Content ID already has different artifacts; refusing overwrite",
    );
  if (existing?.ready === 1) {
    await verifyVersion(db, bundle);
    return;
  }
  await db.query(
    "INSERT OR IGNORE INTO official_feeds(id,generated_at,created_at,event_count,manifest) VALUES(?,?,?,?,?)",
    [
      bundle.feedId,
      bundle.generatedAt,
      new Date().toISOString(),
      bundle.eventCount,
      JSON.stringify(bundle.manifest),
    ],
  );
  const statements: D1Statement[] = bundle.chunks.map((chunk) => ({
    sql: "INSERT OR IGNORE INTO official_artifacts(feed_id,path,part,body) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM official_feeds WHERE id=? AND ready=0)",
    params: [bundle.feedId, chunk.path, chunk.part, chunk.body, bundle.feedId],
  }));
  statements.push(
    ...bundle.eventMeta.map((event) => ({
      sql: "INSERT OR IGNORE INTO official_event_meta(feed_id,event_id,kind,all_day) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM official_feeds WHERE id=? AND ready=0)",
      params: [
        bundle.feedId,
        event.event_id,
        event.kind,
        Number(event.all_day),
        bundle.feedId,
      ],
    })),
  );
  await executeBounded(db, statements);
  await verifyVersion(db, bundle);
  await db.query(
    "UPDATE official_feeds SET ready=1 WHERE id=? AND manifest=?",
    [bundle.feedId, JSON.stringify(bundle.manifest)],
  );
}

export async function initializeCalendar(
  db: D1Adapter,
  feed: Feed,
  manifest: PublishedManifest,
  siteUrl: string,
): Promise<string> {
  const bundle = await buildOfficialBundle(feed, { siteUrl });
  await executeBounded(
    db,
    [...ADMIN_SCHEMA, ...CALENDAR_SCHEMA].map((sql) => ({ sql })),
  );
  const active = await pointer(db);
  const publishedId = manifest.publication?.id ?? null;
  if (active) {
    if (active.feed_id !== bundle.feedId || active.published_id !== publishedId)
      throw new Error(
        "Calendar already initialized with different migration inputs",
      );
    await validatePublishedImages(db, await migrationRows(db, feed, manifest));
    await verifyVersion(db, bundle);
    return active.feed_id;
  }
  const retained = await migrationRows(db, feed, manifest);
  await validatePublishedImages(db, retained);
  await installVersion(db, bundle);
  const live = retained.find((row) => row.id === publishedId);
  const guard =
    "NOT EXISTS(SELECT 1 FROM calendar_state WHERE singleton=1) AND (? IS NULL OR EXISTS(SELECT 1 FROM publications WHERE id=? AND revision=? AND state IN ('queued','building','published')))";
  const guardParams = [publishedId, publishedId, live?.revision ?? null];
  const now = new Date().toISOString();
  try {
    await db.batch([
      {
        sql: `UPDATE publications SET state='published',updated_at=? WHERE id=? AND ${guard}`,
        params: [now, publishedId, ...guardParams],
      },
      {
        sql: `INSERT OR IGNORE INTO published_images(upload,publication_id) SELECT json_extract(item.value,'$.image.upload'),p.id FROM publications p,json_each(p.snapshot) item WHERE p.state='published' AND json_extract(item.value,'$.image.upload') IS NOT NULL AND ${guard}`,
        params: guardParams,
      },
      {
        sql: `UPDATE publications SET state='failed',updated_at=? WHERE state IN ('queued','building') AND id IS NOT ? AND ${guard}`,
        params: [now, publishedId, ...guardParams],
      },
      {
        sql: `INSERT INTO calendar_state(singleton,feed_id,previous_feed_id,published_id) SELECT 1,?,NULL,? WHERE ${guard} AND EXISTS(SELECT 1 FROM official_feeds WHERE id=? AND ready=1)`,
        params: [bundle.feedId, publishedId, ...guardParams, bundle.feedId],
      },
    ]);
  } catch (cause) {
    const selected = await pointer(db);
    if (
      selected?.feed_id !== bundle.feedId ||
      selected.published_id !== publishedId
    )
      throw cause;
  }
  const selected = await pointer(db);
  if (
    selected?.feed_id !== bundle.feedId ||
    selected.published_id !== publishedId
  )
    throw new Error("Concurrent calendar initialization conflict");
  await report(
    `Initialized official feed ${bundle.feedId}; events=${bundle.eventCount}; publication=${publishedId ?? "null"}`,
  );
  return bundle.feedId;
}

export async function exportCalendar(
  db: D1Adapter,
  out: string,
): Promise<string> {
  // The pointer, manifest and chunks share one SQLite snapshot, even during pruning.
  const rows = (
    await db.query<{
      tag: number;
      feed_id: string;
      manifest: string | null;
      part: number;
      body: string | null;
    }>(
      "WITH active AS (SELECT f.id,f.manifest FROM calendar_state s JOIN official_feeds f ON f.id=s.feed_id AND f.ready=1 WHERE s.singleton=1) SELECT 0 AS tag,id AS feed_id,manifest,-1 AS part,NULL AS body FROM active UNION ALL SELECT 1,a.id,NULL,c.part,c.body FROM active a JOIN official_artifacts c ON c.feed_id=a.id AND c.path='data/events.json' ORDER BY tag,part",
    )
  ).rows;
  const meta = rows[0];
  if (!meta || meta.tag !== 0 || !FEED_ID.test(meta.feed_id) || !meta.manifest)
    throw new Error(
      "Current official baseline unavailable; explicit init is required",
    );
  const manifest = manifestSchema.parse(JSON.parse(meta.manifest));
  const entry = manifest.find((entry) => entry.path === OFFICIAL_JSON_PATH);
  if (!entry || entry.sha256 !== meta.feed_id)
    throw new Error("Current official baseline manifest is corrupt");
  const chunks = rows.slice(1).map((row) => {
    if (row.tag !== 1 || row.feed_id !== meta.feed_id || row.body === null)
      throw new Error("Current official baseline chunks are corrupt");
    return { part: row.part, body: row.body };
  });
  const body = await verifyArtifact(entry, chunks);
  const feed = validateFeed(JSON.parse(body));
  if (!feed.events.length)
    throw new Error("Current official baseline is empty");
  await atomicJson(out, feed);
  await atomicJson(resolve(dirname(out), "base.json"), {
    feed_id: meta.feed_id,
  });
  await report(
    `Exported official feed ${meta.feed_id}; events=${feed.events.length}`,
  );
  return meta.feed_id;
}

async function pruneVersions(db: D1Adapter): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const excluded =
    "id NOT IN (SELECT feed_id FROM calendar_state UNION SELECT previous_feed_id FROM calendar_state WHERE previous_feed_id IS NOT NULL)";
  const candidates = (
    await db.query<{ id: string }>(
      `SELECT id FROM official_feeds WHERE created_at<? AND ${excluded} ORDER BY created_at LIMIT 10`,
      [cutoff],
    )
  ).rows;
  for (const { id } of candidates) {
    // Withdraw readiness first, so an uploader cannot activate a pruning version.
    const claimed = await db.query(
      `UPDATE official_feeds SET ready=0 WHERE id=? AND created_at<? AND ${excluded}`,
      [id, cutoff],
    );
    if (claimed.changes !== 1) continue;
    const safe = `EXISTS(SELECT 1 FROM official_feeds WHERE id=? AND ready=0 AND created_at<? AND ${excluded})`;
    for (const table of [
      "official_artifacts",
      "official_event_meta",
    ] as const) {
      let removed: number;
      do {
        removed = (
          await db.query(
            `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE feed_id=? LIMIT 100) AND ${safe}`,
            [id, id, cutoff],
          )
        ).changes;
      } while (removed === 100);
    }
    await db.query(
      `DELETE FROM official_feeds WHERE id=? AND ready=0 AND created_at<? AND ${excluded} AND NOT EXISTS(SELECT 1 FROM official_artifacts WHERE feed_id=?) AND NOT EXISTS(SELECT 1 FROM official_event_meta WHERE feed_id=?)`,
      [id, cutoff, id, id],
    );
  }
}

export async function uploadCalendar(
  db: D1Adapter,
  feed: Feed,
  predecessor: string,
  siteUrl: string,
): Promise<string> {
  if (!FEED_ID.test(predecessor))
    throw new Error("Invalid expected predecessor feed ID");
  const bundle = await buildOfficialBundle(feed, { siteUrl });
  const active = await pointer(db);
  if (!active)
    throw new Error(
      "Current official baseline unavailable; explicit init is required",
    );
  if (active.feed_id === bundle.feedId) {
    await verifyVersion(db, bundle);
    await report(
      `Official feed ${bundle.feedId} already active; events=${bundle.eventCount}; no writes`,
    );
    return bundle.feedId;
  }
  if (active.feed_id !== predecessor)
    throw new Error("Official predecessor conflict; re-export current feed");
  await installVersion(db, bundle);
  try {
    const activated = await db.query(
      "UPDATE calendar_state SET previous_feed_id=feed_id,feed_id=? WHERE singleton=1 AND feed_id=? AND EXISTS(SELECT 1 FROM official_feeds WHERE id=? AND ready=1)",
      [bundle.feedId, predecessor, bundle.feedId],
    );
    if (
      activated.changes !== 1 &&
      (await pointer(db))?.feed_id !== bundle.feedId
    )
      throw new Error("Official predecessor conflict; re-export current feed");
  } catch (cause) {
    if ((await pointer(db))?.feed_id !== bundle.feedId) throw cause;
  }
  await report(
    `Activated official feed ${bundle.feedId}; predecessor=${predecessor}; events=${bundle.eventCount}`,
  );
  await pruneVersions(db);
  return bundle.feedId;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      local: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      out: { type: "string" },
      base: { type: "string" },
      feed: { type: "string" },
      published: { type: "string" },
    },
  });
  if (
    values.local === values.remote ||
    positionals.length !== 1 ||
    !["init", "export", "upload"].includes(positionals[0]!)
  )
    throw new Error(
      "Usage: calendar-data.ts init|export|upload --local|--remote",
    );
  const siteUrl = process.env.SITE_URL;
  if (!siteUrl && positionals[0] !== "export")
    throw new Error("SITE_URL is required");
  const db = values.local
    ? createLocalD1()
    : createRemoteD1(readRemoteConfig());
  const command = positionals[0];
  if (command === "export") {
    if (!values.out) throw new Error("export requires --out");
    await exportCalendar(db, values.out);
  } else if (command === "init") {
    if (!values.feed || !values.published)
      throw new Error("init requires --feed and --published");
    await initializeCalendar(
      db,
      validateFeed(await jsonFile(values.feed)),
      validateManifest(await jsonFile(values.published)),
      siteUrl!,
    );
  } else {
    if (!values.feed || !values.base)
      throw new Error("upload requires --feed and --base");
    const base = z
      .strictObject({ feed_id: z.string().regex(FEED_ID) })
      .parse(await jsonFile(values.base));
    await uploadCalendar(
      db,
      validateFeed(await jsonFile(values.feed)),
      base.feed_id,
      siteUrl!,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
