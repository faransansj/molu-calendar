import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chatMessagesWithReferences } from "../../src/lib/ai/persona.ts";
import { searchMessages } from "../../src/lib/chat/memory.ts";
import { planChatPrompt } from "../../src/lib/chat/plan.ts";
import { PROMPT_CHAR_BUDGET } from "../../src/lib/chat/prompt.ts";
import type {
  ChatMessage,
  ConversationMessage,
  Memory,
  Reference,
} from "../../src/lib/chat/types.ts";

// Only the data access layer is a fixture. Ranking, eligibility, attribution,
// budgets and rendering are the same code paths used by a MomoTalk send.
export interface ProbeFact {
  id: string;
  characterId: string;
  topic: string;
  unit: string;
  value: number;
}

export const FACTS: ProbeFact[] = [
  {
    id: "coffee",
    characterId: "Arona",
    topic: "내 하루 커피",
    unit: "잔",
    value: 2,
  },
  {
    id: "seat",
    characterId: "Arona",
    topic: "내 열람실 좌석",
    unit: "번",
    value: 17,
  },
  {
    id: "ledger",
    characterId: "Yuuka",
    topic: "내 지출 기록 주기",
    unit: "일",
    value: 6,
  },
  {
    id: "lunch",
    characterId: "Yuuka",
    topic: "내 도시락 반찬",
    unit: "개",
    value: 4,
  },
  {
    id: "milktea",
    characterId: "Aris",
    topic: "내 밀크티 주문",
    unit: "잔",
    value: 3,
  },
  {
    id: "quest",
    characterId: "Aris",
    topic: "내 게임 캐릭터 레벨",
    unit: "단계",
    value: 12,
  },
];
export function sourceText(fact: ProbeFact) {
  return `${fact.topic}: ${fact.value}${fact.unit}.`;
}
export function questionText(fact: ProbeFact) {
  const amount = fact.unit === "일" ? "며칠" : `몇 ${fact.unit}`;
  return `${fact.topic}, ${amount}인지 기억해? 숫자와 단위로 답해 줘. 근거가 없으면 모른다고 해 줘.`;
}
export function conversation(
  roomId: string,
  turns: [string, string][],
  question: string,
) {
  const history: ChatMessage[] = [];
  function append(text: string, user: boolean) {
    const i = history.length;
    history.push({
      id: `${roomId}-m${i}`,
      me: user,
      text,
      time: "12:00",
      status: "complete",
      sourceKind: user ? "user-input" : "model-output",
      speakerId: user ? "sensei" : roomId,
      speakerType: user ? "user" : "character",
      createdAt: i + 1,
      replyToMessageId: user ? null : history[i - 1]!.id,
    });
  }
  for (const [q, a] of turns) {
    append(q, true);
    append(a, false);
  }
  append(question, true);
  return history;
}
export function sourceMemory(fact: ProbeFact, source: ChatMessage): Memory {
  return {
    id: `mem-${fact.id}`,
    profileId: "local",
    roomId: fact.characterId,
    text: source.text,
    sourceMessageId: source.id,
    sourceText: source.text,
    enabled: true,
    expiresAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

export function retrieve(
  roomId: string,
  history: ChatMessage[],
  memories: Memory[],
  otherRooms: Record<string, ChatMessage[]> = {},
) {
  const question = history.at(-1)!;
  const rooms = { ...otherRooms, [roomId]: history };
  return planChatPrompt(
    {
      memories: async (room) => memories.filter((m) => m.roomId === room),
      searchRoom: async (room, options) =>
        searchMessages(rooms[room] ?? [], options ?? {}),
      sourceMessage: async (room, id) =>
        rooms[room]?.find((row) => row.id === id) ?? null,
    },
    roomId,
    question.text,
    history,
    question.id,
  );
}

export function probeRow(
  fact: ProbeFact,
  variant: string,
  plan: {
    messages: ConversationMessage[];
    memories: Reference[];
    excerpts: Reference[];
    promptChars: number;
  },
  available: boolean,
) {
  const question = questionText(fact);
  const messages = chatMessagesWithReferences(
    fact.characterId,
    plan.messages,
    plan.memories,
    plan.excerpts,
  );
  assert(messages);
  const source = sourceText(fact);
  const id = `${fact.id}-${variant}`;
  assert.equal(messages.at(-1)?.role, "user", id);
  assert(messages.at(-1)?.content.endsWith(question), id);
  assert.equal(
    messages.some(({ content }) => content.includes(source)),
    available,
    `${id}: expected value visibility differs from the experiment`,
  );
  assert(!question.includes(String(fact.value)), id);
  if (!available) {
    const slot = new RegExp(`(?<!\\d)${fact.value}\\s*${fact.unit}`, "u");
    assert(
      !messages.some(({ content }) => slot.test(content)),
      `${id}: answer in control prompt`,
    );
  }
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  assert.equal(plan.promptChars, promptChars, id);
  assert(promptChars <= PROMPT_CHAR_BUDGET, id);
  return {
    id,
    characterId: fact.characterId,
    variant,
    question,
    reference: [...plan.memories, ...plan.excerpts].map(({ text }) => text),
    promptChars,
    messages,
    expect: { available, value: fact.value, unit: fact.unit },
  };
}

export async function writeRows(path: string, rows: unknown[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  console.log(`${rows.length} prompts → ${path}`);
}
