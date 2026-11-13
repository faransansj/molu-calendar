/// <reference types="node" />
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import {
  createPublication,
  getOverride,
  publicationStatus,
  saveOverride,
} from "./db.ts";
import { ensureSchema } from "./calendar-store.ts";
import { loadFeed } from "./feed.ts";
import worker from "./index.ts";
import { sha256hex } from "./auth.ts";

let platform: PlatformProxy<{ DB: D1Database }>;
let directory: string;
const oldId = "a".repeat(64);
const newId = "b".repeat(64);
const eventId = "event-20261113-12345678";
const crop = { upload: null, crop: { x: 60, y: 40, zoom: 1.2 } };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "molu-calendar-d1-test-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "calendar-d1-test",
      compatibility_date: "2026-10-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "test",
          database_id: "11111111-1111-4111-8111-111111111111",
        },
      ],
    }),
  );
  platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    persist: false,
    remoteBindings: false,
  });
  await ensureSchema(platform.env.DB);
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  const db = platform.env.DB;
  await db.batch([
    db.prepare("DELETE FROM overrides"),
    db.prepare("DELETE FROM published_images"),
    db.prepare("DELETE FROM publications"),
    db.prepare("DELETE FROM calendar_state"),
    db.prepare("DELETE FROM official_event_meta"),
    db.prepare("DELETE FROM official_feeds"),
    db.prepare("UPDATE stage SET revision=0,staged_at=NULL WHERE singleton=1"),
    db
      .prepare("INSERT INTO official_feeds VALUES(?,?,?,1,'[]',1)")
      .bind(oldId, "2026-11-13T00:00:00Z", "2026-11-13T00:00:00Z"),
    db
      .prepare("INSERT INTO official_feeds VALUES(?,?,?,1,'[]',1)")
      .bind(newId, "2026-11-13T01:00:00Z", "2026-11-13T01:00:00Z"),
    db
      .prepare("INSERT INTO official_event_meta VALUES(?,?,'interval',0)")
      .bind(oldId, eventId),
    db
      .prepare("INSERT INTO official_event_meta VALUES(?,?,'deadline',1)")
      .bind(newId, eventId),
    db.prepare("INSERT INTO calendar_state VALUES(1,?,NULL,NULL)").bind(oldId),
  ]);
});

test("an official rotation rejects a stale image save without changing draft, stage or publication", async () => {
  const db = platform.env.DB;
  const read = await loadFeed(db);
  await saveOverride(db, eventId, "image", crop, read.id, read.events);
  const before = await db.prepare("SELECT * FROM overrides").all();
  const stage = await db.prepare("SELECT * FROM stage").all();
  await db
    .prepare(
      "UPDATE calendar_state SET previous_feed_id=feed_id,feed_id=? WHERE singleton=1",
    )
    .bind(newId)
    .run();
  await expect(
    saveOverride(
      db,
      eventId,
      "image",
      { ...crop, crop: { ...crop.crop, x: 20 } },
      read.id,
      read.events,
      crop,
    ),
  ).rejects.toMatchObject({ status: 409, code: "stage-conflict" });
  await expect(
    saveOverride(
      db,
      eventId,
      "schedule",
      {
        start: "2026-11-13T02:00:00Z",
        end: null,
        start_after_maintenance: false,
      },
      read.id,
      read.events,
    ),
  ).rejects.toMatchObject({ status: 409, code: "stage-conflict" });
  expect((await db.prepare("SELECT * FROM overrides").all()).results).toEqual(
    before.results,
  );
  expect((await db.prepare("SELECT * FROM stage").all()).results).toEqual(
    stage.results,
  );
  expect(
    await db.prepare("SELECT published_id FROM calendar_state").first(),
  ).toEqual({ published_id: null });
});

test("incompatible saved schedule remains editable and cannot hide a valid image after kind/all_day rotation", async () => {
  const db = platform.env.DB;
  const stored = {
    start: "2026-11-13T02:00:00Z",
    end: "2026-11-14T02:00:00Z",
    start_after_maintenance: false,
  };
  const baseline = await loadFeed(db);
  await saveOverride(db, eventId, "image", crop, baseline.id, baseline.events);
  await db
    .prepare("UPDATE overrides SET schedule=? WHERE event_id=?")
    .bind(JSON.stringify(stored), eventId)
    .run();
  await db
    .prepare(
      "UPDATE calendar_state SET previous_feed_id=feed_id,feed_id=? WHERE singleton=1",
    )
    .bind(newId)
    .run();
  const current = await loadFeed(db);
  expect(current.id).toBe(newId);
  expect(current.events.get(eventId)).toEqual({
    kind: "deadline",
    all_day: true,
  });
  const override = await getOverride(db, eventId, current.events);
  expect(override?.image).toEqual(crop);
  expect(override?.schedule).toEqual(stored);
});

test("explicit publication switches an immutable snapshot and image membership; a later save stays private", async () => {
  const db = platform.env.DB;
  const feed = await loadFeed(db);
  const upload = "55555555-5555-4555-8555-555555555555.png";
  await saveOverride(
    db,
    eventId,
    "image",
    { ...crop, upload },
    feed.id,
    feed.events,
  );
  const first = await createPublication(db);
  expect(first.publication.state).toBe("published");
  expect(first.overrides[0]?.image?.upload).toBe(upload);
  expect(
    await db.prepare("SELECT published_id FROM calendar_state").first(),
  ).toEqual({ published_id: first.publication.id });
  expect(
    (
      await db
        .prepare("SELECT upload,publication_id FROM published_images")
        .all()
    ).results,
  ).toEqual([{ upload, publication_id: first.publication.id }]);
  const raw = await db
    .prepare("SELECT snapshot FROM publications WHERE id=?")
    .bind(first.publication.id)
    .first();
  await saveOverride(db, eventId, "image", crop, feed.id, feed.events, {
    ...crop,
    upload,
  });
  expect(
    await db
      .prepare("SELECT snapshot FROM publications WHERE id=?")
      .bind(first.publication.id)
      .first(),
  ).toEqual(raw);
  expect((await publicationStatus(db)).published?.id).toBe(
    first.publication.id,
  );
  expect((await publicationStatus(db)).revision).toBe(
    first.publication.revision + 1,
  );
});

test("same revision only deduplicates identical intended snapshots; official disappearance never deletes a draft", async () => {
  const db = platform.env.DB;
  const feed = await loadFeed(db);
  await saveOverride(db, eventId, "image", crop, feed.id, feed.events);
  const first = await createPublication(db);
  expect((await createPublication(db)).publication.id).toBe(
    first.publication.id,
  );
  await db.batch([
    db.prepare("DELETE FROM official_event_meta WHERE feed_id=?").bind(newId),
    db
      .prepare(
        "INSERT INTO official_event_meta VALUES(?,'event-20261113-abcdef12','interval',0)",
      )
      .bind(newId),
    db
      .prepare("UPDATE calendar_state SET feed_id=?,previous_feed_id=?")
      .bind(newId, oldId),
  ]);
  expect((await publicationStatus(db)).published?.id).toBe(
    first.publication.id,
  );
  const disappeared = await createPublication(db);
  expect(disappeared.publication.id).not.toBe(first.publication.id);
  expect(disappeared.publication.revision).toBe(first.publication.revision);
  expect(disappeared.overrides).toEqual([]);
  expect(await db.prepare("SELECT event_id FROM overrides").first()).toEqual({
    event_id: eventId,
  });
  await db
    .prepare("UPDATE calendar_state SET feed_id=?,previous_feed_id=?")
    .bind(oldId, newId)
    .run();
  const restored = await createPublication(db);
  expect(restored.publication.id).not.toBe(disappeared.publication.id);
  expect(restored.publication.revision).toBe(first.publication.revision);
  expect(restored.overrides).toEqual(first.overrides);
});

test("a known event's incompatible saved schedule rejects publication without dropping its intended edit", async () => {
  const db = platform.env.DB;
  const feed = await loadFeed(db);
  await saveOverride(
    db,
    eventId,
    "schedule",
    {
      start: "2026-11-13T00:00:00Z",
      end: "2026-11-14T00:00:00Z",
      start_after_maintenance: false,
    },
    feed.id,
    feed.events,
  );
  const first = await createPublication(db);
  await db
    .prepare("UPDATE calendar_state SET feed_id=?,previous_feed_id=?")
    .bind(newId, oldId)
    .run();
  await expect(createPublication(db)).rejects.toMatchObject({
    status: 409,
    code: "stage-conflict",
  });
  expect((await publicationStatus(db)).published?.id).toBe(
    first.publication.id,
  );
  expect(
    (await db.prepare("SELECT COUNT(*) AS n FROM publications").first())?.n,
  ).toBe(1);
});

// Fault injection changes real D1 immediately before the write batch. All
// statements, including the conditional commit, still run in workerd's D1.
async function beforePublicationCommit(
  db: D1Database,
  change: () => Promise<unknown>,
): Promise<D1Database> {
  let batches = 0;
  const guarded = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          batches++;
          if (batches === 2) await change();
          return target.batch(statements);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await ensureSchema(guarded);
  batches = 0;
  return guarded;
}

test.each(["stage", "feed", "public pointer"] as const)(
  "a concurrent %s change loses publication CAS without orphan membership or rollback",
  async (change) => {
    const db = platform.env.DB;
    const feed = await loadFeed(db);
    const upload = "66666666-6666-4666-8666-666666666666.png";
    await saveOverride(
      db,
      eventId,
      "image",
      { ...crop, upload },
      feed.id,
      feed.events,
    );
    const rival = "77777777-7777-4777-8777-777777777777";
    const guarded = await beforePublicationCommit(db, async () => {
      if (change === "stage")
        await db.prepare("UPDATE stage SET revision=revision+1").run();
      else if (change === "feed")
        await db
          .prepare("UPDATE calendar_state SET feed_id=?")
          .bind(newId)
          .run();
      else
        await db.batch([
          db
            .prepare(
              "INSERT INTO publications VALUES(?,1,'published','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z','[]')",
            )
            .bind(rival),
          db.prepare("UPDATE calendar_state SET published_id=?").bind(rival),
        ]);
    });
    await expect(createPublication(guarded)).rejects.toMatchObject({
      status: 409,
      code: "stage-conflict",
    });
    expect(
      (await db.prepare("SELECT * FROM published_images").all()).results,
    ).toEqual([]);
    expect(
      await db.prepare("SELECT published_id FROM calendar_state").first(),
    ).toEqual({ published_id: change === "public pointer" ? rival : null });
    expect(
      (await db.prepare("SELECT id FROM publications").all()).results,
    ).toEqual(change === "public pointer" ? [{ id: rival }] : []);
  },
);

test("an oversized immutable snapshot is rejected before inserting a publication", async () => {
  const db = platform.env.DB;
  const now = "2026-11-13T00:00:00.123+09:00";
  const schedule = {
    start: now,
    end: "2026-11-14T00:00:00.123+09:00",
    start_after_maintenance: false,
  };
  const image = {
    upload: "88888888-8888-4888-8888-888888888888.png",
    crop: {
      x: 12.12345678901234,
      y: 45.12345678901234,
      zoom: 1.23456789012345,
    },
  };
  const edits = Array.from({ length: 5000 }, (_, index) => ({
    event_id: `eventoversizedsnapshot-20261113-${index.toString(16).padStart(8, "0")}`,
    image,
    schedule,
    updated_at: now,
  }));
  expect(Buffer.byteLength(JSON.stringify(edits))).toBeGreaterThan(1_800_000);
  for (let index = 0; index < edits.length; index += 50) {
    const batch = JSON.stringify(edits.slice(index, index + 50));
    await db.batch([
      db
        .prepare(
          "INSERT OR REPLACE INTO official_event_meta SELECT ?,json_extract(value,'$.event_id'),'interval',0 FROM json_each(?)",
        )
        .bind(oldId, batch),
      db
        .prepare(
          "INSERT OR REPLACE INTO overrides SELECT json_extract(value,'$.event_id'),json_extract(value,'$.image'),json_extract(value,'$.schedule'),json_extract(value,'$.updated_at') FROM json_each(?)",
        )
        .bind(batch),
    ]);
  }
  await expect(createPublication(db)).rejects.toMatchObject({
    status: 413,
    code: "publication-too-large",
  });
  expect(
    (await db.prepare("SELECT id FROM publications").all()).results,
  ).toEqual([]);
  expect(
    (await db.prepare("SELECT * FROM published_images").all()).results,
  ).toEqual([]);
  expect(
    await db.prepare("SELECT published_id FROM calendar_state").first(),
  ).toEqual({ published_id: null });
}, 30_000);

test("an authenticated stale page gets conflict guidance before newer schedule validation", async () => {
  const db = platform.env.DB;
  const token = "a".repeat(43);
  await db.batch([
    db
      .prepare("INSERT INTO sessions VALUES(?,9999999999999)")
      .bind(await sha256hex(token)),
    db
      .prepare("UPDATE calendar_state SET feed_id=?,previous_feed_id=?")
      .bind(newId, oldId),
  ]);
  const headers = {
    Origin: "http://localhost:8811",
    Cookie: `__Host-molu_admin=${token}`,
    "X-MOLU-Admin": "1",
    "X-MOLU-Feed": oldId,
    "Content-Type": "application/json",
    "Content-Length": "2",
  };
  const before = (await db.prepare("SELECT * FROM stage").all()).results;
  // Only real D1/session paths are exercised; ASSETS/R2 are not used by this route.
  const response = await worker.fetch(
    new Request(`http://localhost:8811/api/admin/events/${eventId}/schedule`, {
      method: "PUT",
      headers,
      body: "{}",
    }),
    platform.env as Env,
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "stage-conflict" });
  expect((await db.prepare("SELECT * FROM stage").all()).results).toEqual(
    before,
  );
  expect((await db.prepare("SELECT * FROM overrides").all()).results).toEqual(
    [],
  );
});
