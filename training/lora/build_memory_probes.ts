import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  chatMessagesWithReferences,
  promptCharsFor,
} from "../../src/lib/ai/persona.ts";
import {
  MEMORY_CHAR_BUDGET,
  MEMORY_LIMIT,
  selectMemories,
} from "../../src/lib/chat/memory.ts";
import {
  momoPromptPlan,
  PROMPT_CHAR_BUDGET,
} from "../../src/lib/chat/prompt.ts";

const NOW = 1_700_000_000_000;
const FACTS = [
  {
    id: "arona-coffee",
    characterId: "Arona",
    roomId: "Arona",
    fact: "선생님은 커피를 좋아해",
    question: "나 커피 좋아하는 거 기억해?",
    includes: ["커피"],
  },
  {
    id: "arona-window",
    characterId: "Arona",
    roomId: "Arona",
    fact: "선생님은 샬레 사무실 창가 자리에 앉는 걸 좋아해",
    question: "내가 사무실에서 어디에 앉는 걸 좋아했지?",
    includes: ["창가"],
  },
  {
    id: "yuuka-ledger",
    characterId: "Yuuka",
    roomId: "Yuuka",
    fact: "선생님은 지출 기록을 꼼꼼히 적는 편이야",
    question: "내가 지출 기록은 어떻게 하고 있어?",
    includes: ["기록", "꼼꼼"],
  },
  {
    id: "yuuka-lunch",
    characterId: "Yuuka",
    roomId: "Yuuka",
    fact: "선생님은 유우카가 만든 도시락을 좋아해",
    question: "내가 유우카가 만든 도시락 어땠다고 했었지?",
    includes: ["도시락"],
  },
  {
    id: "aris-milktea",
    characterId: "Aris",
    roomId: "Aris",
    fact: "선생님은 아리스와 게임할 때 밀크티를 마셔",
    question: "우리 같이 게임할 때 내가 뭘 마시는지 기억해?",
    includes: ["밀크티"],
  },
  {
    id: "aris-quest",
    characterId: "Aris",
    roomId: "Aris",
    fact: "선생님은 아리스에게 다음 퀘스트를 같이 하자고 약속했어",
    question: "아리스랑 다음에 뭐 하기로 했었지?",
    includes: ["퀘스트", "약속"],
  },
];
const ROOM_OF: Record<string, string> = {
  Arona: "Arona",
  Yuuka: "Yuuka",
  Aris: "Aris",
};
const OTHER_ROOM: Record<string, string> = {
  Arona: "Yuuka",
  Yuuka: "Aris",
  Aris: "Arona",
};

type Fact = (typeof FACTS)[number];
const memoryRow = (
  fact: Fact,
  {
    roomId = fact.roomId,
    expiresAt = null,
    enabled = true,
  }: { roomId?: string; expiresAt?: number | null; enabled?: boolean } = {},
) => ({
  id: `mem-${fact.id}`,
  roomId,
  text: fact.fact,
  enabled,
  expiresAt,
  createdAt: NOW - 1_000,
  updatedAt: NOW - 1_000,
  sourceMessageId: null,
  sourceText: null,
});

function build(fact: Fact, variant: string) {
  const rows =
    variant === "no-memory"
      ? []
      : variant === "expired"
        ? [memoryRow(fact, { expiresAt: NOW - 1 })]
        : variant === "disabled"
          ? [memoryRow(fact, { enabled: false })]
          : variant === "cross-room"
            ? [memoryRow(fact, { roomId: OTHER_ROOM[fact.characterId]! })]
            : [memoryRow(fact)];
  const selected = selectMemories(rows, {
    roomId: ROOM_OF[fact.characterId]!,
    query: fact.question,
    now: NOW,
    limit: MEMORY_LIMIT,
    charBudget: MEMORY_CHAR_BUDGET,
  });
  const fixed = promptCharsFor(fact.characterId)!;
  const plan = momoPromptPlan({
    history: [],
    text: fact.question,
    fixedChars: fixed.system + fixed.examples,
    memories: selected.map((memory) => ({ id: memory.id, text: memory.text })),
    excerpts: [],
  });
  const messages = chatMessagesWithReferences(
    fact.characterId,
    plan.messages,
    plan.memories,
    plan.excerpts,
  );
  const leak =
    selected.length > 0 ? plan.memories.map((memory) => memory.text) : [];
  return {
    id: `${fact.id}-${variant}`,
    characterId: fact.characterId,
    variant,
    question: fact.question,
    reference: leak,
    promptChars: plan.promptChars,
    budget: PROMPT_CHAR_BUDGET,
    messages: messages!.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    expect: {
      includes: leak.length ? fact.includes : [],
      excludes: leak.length ? [] : fact.includes,
    },
  };
}

const output = process.argv[2] ?? "runs/memory-probe/prompts.jsonl";
const rows = FACTS.flatMap((fact) =>
  ["memory", "no-memory", "expired", "disabled", "cross-room"].map((variant) =>
    build(fact, variant),
  ),
);
for (const row of rows) {
  const systemMessages = row.messages.filter(
    (message) => message.role === "system",
  );
  const referenced = systemMessages.some((message) =>
    message.content.includes("[참고 자료]"),
  );
  if ((row.variant === "memory") !== referenced)
    throw new Error(`${row.id}: 참고 자료 포함 여부가 기대와 다릅니다.`);
  if (row.messages.at(-1)!.content !== row.question)
    throw new Error(`${row.id}: 마지막 메시지가 질문이 아닙니다.`);
  if (row.promptChars > row.budget)
    throw new Error(`${row.id}: 문자 예산 초과`);
}
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
const counts = rows.reduce<Record<string, number>>(
  (map, row) => ({ ...map, [row.variant]: (map[row.variant] ?? 0) + 1 }),
  {},
);
console.log(`기억 프로브 ${rows.length}건 → ${output}`, JSON.stringify(counts));
