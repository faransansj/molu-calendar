import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FACTS,
  conversation,
  questionText,
  retrieve,
  sourceMemory,
  sourceText,
} from "./probe_fixture.ts";
import type { PromptMessage } from "../../src/lib/chat/types.ts";

interface Row {
  id: string;
  variant: string;
  question: string;
  messages: PromptMessage[];
  promptChars: number;
  expect: { available: boolean; value: number; unit: string };
}

test("rendered probe cohorts exercise source-backed exclusions and app retrieval", async () => {
  const root = await mkdtemp(join(tmpdir(), "molu-probes-"));
  try {
    for (const [suite, expectedRows] of [
      ["memory", 30],
      ["context", 18],
      ["style", 56],
    ] as const) {
      const path = join(root, `${suite}.jsonl`);
      execFileSync(process.execPath, [`build_${suite}_probes.ts`, path], {
        cwd: import.meta.dirname,
      });
      const rows: Row[] = (await readFile(path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(rows.length, expectedRows);
      assert.equal(new Set(rows.map((row) => row.id)).size, expectedRows);
      for (const row of rows) {
        assert.equal(row.messages.at(-1)?.role, "user");
        assert(row.messages.at(-1)?.content.endsWith(row.question));
        assert.equal(
          row.promptChars,
          row.messages.reduce((n, message) => n + message.content.length, 0),
        );
        if (suite === "style") continue;
        const fact = FACTS.find(({ id }) => row.id.startsWith(`${id}-`))!;
        const expected = [
          "memory",
          "window4",
          "window4-memory",
          "window2-memory",
          "excerpt-on",
        ].includes(row.variant);
        assert.deepEqual(row.expect, {
          available: expected,
          value: fact.value,
          unit: fact.unit,
        });
        assert(!row.question.includes(String(fact.value)));
        const source = sourceText(fact);
        assert.equal(
          row.messages.some((m) => m.content.includes(source)),
          expected,
        );
        assert(
          !row.messages.some(
            (m) => m.role === "system" && m.content.includes(source),
          ),
        );
        if (["memory", "excerpt-on"].includes(row.variant)) {
          assert(row.messages.at(-1)!.content.includes(source));
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an otherwise retrievable original disappears when its saved memory is disabled or expires", async () => {
  for (const fact of FACTS) {
    const source = sourceText(fact);
    const turns: [string, string][] = [[source, "네."]];
    for (let i = 0; i < 5; i++) turns.push(["안녕.", "반가워요."]);
    const history = conversation(fact.characterId, turns, questionText(fact));
    const memory = sourceMemory(fact, history[0]!);
    const unblocked = await retrieve(fact.characterId, history, []);
    assert(unblocked.excerpts.some((ref) => ref.id === memory.sourceMessageId));
    for (const blocked of [
      { ...memory, enabled: false },
      { ...memory, expiresAt: 1 },
    ]) {
      const plan = await retrieve(fact.characterId, history, [blocked]);
      assert.equal(plan.memories.length, 0);
      assert(!plan.excerpts.some((ref) => ref.id === memory.sourceMessageId));
      assert(
        !plan.messages.some((message) => message.content.includes(source)),
      );
    }
  }
});
