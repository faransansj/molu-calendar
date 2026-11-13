import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createLocalD1 } from "../../../tools/cloudflare-d1.ts";

test("real local CLI reports affected rows and preserves SQLite changes across conditional statements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "molu-d1-cli-test-"));
  try {
    await symlink(
      resolve("node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ type: "module", packageManager: "pnpm@10.11.0" }),
    );
    await writeFile(
      join(directory, "wrangler.json"),
      JSON.stringify({
        name: "d1-cli-test",
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
    const db = createLocalD1({ cwd: directory });
    const inserted = await db.batch([
      { sql: "CREATE TABLE items(id INTEGER PRIMARY KEY,body TEXT NOT NULL)" },
      {
        sql: "WITH RECURSIVE n(id) AS (SELECT 0 UNION ALL SELECT id+1 FROM n WHERE id<200) INSERT INTO items SELECT id,? FROM n",
        params: ["한🌸 O'Reilly; SELECT 'not SQL'"],
      },
      { sql: "SELECT COUNT(*) AS n FROM items" },
    ]);
    expect(inserted[1]!.changes).toBe(201);
    expect(inserted[2]!.changes).toBe(0);
    expect(inserted[2]!.rows).toEqual([{ n: 201 }]);
    const changed = await db.batch([
      { sql: "UPDATE items SET body=? WHERE id=0", params: ["changed"] },
      {
        sql: "UPDATE items SET body=? WHERE id=1 AND changes()=1",
        params: ["conditional"],
      },
      { sql: "UPDATE items SET body=? WHERE id=-1", params: ["no match"] },
      { sql: "SELECT id,body FROM items WHERE id<3 ORDER BY id" },
    ]);
    expect(changed.map((result) => result.changes)).toEqual([1, 1, 0, 0]);
    expect(changed[3]!.rows).toEqual([
      { id: 0, body: "changed" },
      { id: 1, body: "conditional" },
      { id: 2, body: "한🌸 O'Reilly; SELECT 'not SQL'" },
    ]);
    const removed: number[] = [];
    for (let index = 0; index < 3; index++)
      removed.push(
        (
          await db.query(
            "DELETE FROM items WHERE id IN (SELECT id FROM items LIMIT 100)",
          )
        ).changes,
      );
    expect(removed).toEqual([100, 100, 1]);
    expect((await db.query("SELECT COUNT(*) AS n FROM items")).rows).toEqual([
      { n: 0 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
