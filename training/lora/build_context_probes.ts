import assert from "node:assert/strict";
import { momoPromptPlan } from "../../src/lib/chat/prompt.ts";
import {
  FACTS,
  conversation,
  probeRow,
  questionText,
  retrieve,
  sourceMemory,
  sourceText,
  writeRows,
} from "./probe_fixture.ts";

const rows = [];
for (const fact of FACTS.filter(({ id }) =>
  ["coffee", "ledger", "quest"].includes(id),
)) {
  const question = questionText(fact);
  const source = sourceText(fact);
  const history = conversation(
    fact.characterId,
    [
      [source, "네, 기억해 둘게요."],
      ["회의가 길었어.", "고생하셨어요."],
      ["고마워.", "다음에 또 봐요."],
    ],
    question,
  );
  for (const withMemory of [false, true]) {
    const retrieved = await retrieve(
      fact.characterId,
      history,
      withMemory ? [sourceMemory(fact, history[0]!)] : [],
    );
    assert.equal(retrieved.memories.length, Number(withMemory));
    for (const window of [2, 4]) {
      const variant = `window${window}${withMemory ? "-memory" : ""}`;
      // A controlled history-window ablation: keep retrieval constant, remove
      // excerpts deliberately in both conditions, and vary only the pair cap.
      const plan = momoPromptPlan({
        characterId: fact.characterId,
        text: question,
        history,
        memories: retrieved.memories,
        excerpts: [],
        turns: window,
      });
      assert.equal(plan.messages.length, 2 * Math.min(window, 3) + 1);
      rows.push(probeRow(fact, variant, plan, withMemory || window === 4));
    }
  }

  // Three relevant old messages plus the current question compete for two
  // excerpt slots. Never pre-truncate the search result before the app planner.
  const farHistory = conversation(
    fact.characterId,
    Array.from({ length: 30 }, (_, i): [string, string] => [
      i === 5
        ? source
        : i === 2 || i === 3
          ? `${fact.topic} 이야기는 나중에 하자.`
          : `${i}번째 잡담이야.`,
      "잘 들었어요.",
    ]),
    question,
  );
  const on = await retrieve(fact.characterId, farHistory, []);
  assert.equal(on.excerpts.length, 2);
  assert(
    on.excerpts.some(
      (ref) => ref.id === farHistory[10]!.id && ref.text === source,
    ),
  );
  rows.push(probeRow(fact, "excerpt-on", on, true));
  const off = momoPromptPlan({
    characterId: fact.characterId,
    text: question,
    history: farHistory,
    memories: on.memories,
    excerpts: [],
  });
  assert.deepEqual(off.messages, on.messages);
  rows.push(probeRow(fact, "excerpt-off", off, false));
}
await writeRows(process.argv[2] ?? "runs/context-probe/prompts.jsonl", rows);
