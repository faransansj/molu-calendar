import assert from "node:assert/strict";
import {
  FACTS,
  conversation,
  probeRow,
  questionText,
  retrieve,
  sourceMemory,
  sourceText,
  writeRows,
  type ProbeFact,
} from "./probe_fixture.ts";

async function build(fact: ProbeFact, variant: string) {
  const question = questionText(fact);
  const source = sourceText(fact);
  const present = variant !== "no-memory" && variant !== "cross-room";
  // The source is outside the recent window but searchable. A disabled or
  // expired memory must not reappear as an excerpt of its linked message.
  const turns: [string, string][] = [
    [present ? source : "오늘도 안녕.", "안녕하세요."],
    ...Array.from({ length: 5 }, (_, i): [string, string] => [
      `${i}번째 잡담이야.`,
      "네, 잘 들었어요.",
    ]),
  ];
  const history = conversation(fact.characterId, turns, question);
  const otherId = fact.characterId === "Arona" ? "Yuuka" : "Arona";
  const other =
    variant === "cross-room"
      ? conversation(otherId, [[source, "네."]], "안녕.")
      : null;
  const memory = sourceMemory(fact, (other ?? history)[0]!);
  if (variant === "expired") memory.expiresAt = 1;
  if (variant === "disabled") memory.enabled = false;
  if (other) memory.roomId = otherId;
  const plan = await retrieve(
    fact.characterId,
    history,
    variant === "no-memory" ? [] : [memory],
    other ? { [otherId]: other } : {},
  );
  const enabled = variant === "memory";
  assert.deepEqual(
    plan.memories.map(({ id }) => id),
    enabled ? [memory.id] : [],
  );
  if (!enabled)
    assert.equal(
      plan.excerpts.some((e) => e.text === source),
      false,
    );
  return probeRow(fact, variant, plan, enabled);
}

const rows = [];
for (const fact of FACTS) {
  for (const variant of [
    "memory",
    "no-memory",
    "expired",
    "disabled",
    "cross-room",
  ])
    rows.push(await build(fact, variant));
}
await writeRows(process.argv[2] ?? "runs/memory-probe/prompts.jsonl", rows);
