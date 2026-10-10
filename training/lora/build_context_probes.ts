import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  chatMessagesWithReferences,
  promptCharsFor,
} from "../../src/lib/ai/persona.ts";
import {
  MEMORY_CHAR_BUDGET,
  MEMORY_LIMIT,
  searchMessages,
  selectMemories,
} from "../../src/lib/chat/memory.ts";
import type { PromptHistory, PromptMessage } from "../../src/lib/chat/types.ts";
import {
  momoPromptPlan,
  PROMPT_CHAR_BUDGET,
} from "../../src/lib/chat/prompt.ts";

// 사실은 일정이 아니라 개인 사실로 둔다: 일정은 모델이 지어내기 쉬워 회상 측정이 흐려진다.
interface ContextCase {
  characterId: string;
  fact: string;
  question: string;
  includes: string[];
  filler: [string, string][];
}
const CASES: ContextCase[] = [
  {
    characterId: "Arona",
    fact: "선생님은 커피를 하루 두 잔 마셔",
    question: "나 커피 하루에 몇 잔 마신다고 했지?",
    includes: ["두 잔", "2잔", "2컵", "두잔"],
    filler: [
      ["나 오늘 좀 피곤하네", "많이 피곤해 보이시면 제가 도와드릴게요!"],
      ["그냥 그런 날이야", "그런 날도 있는 거예요. 저는 옆에 있을게요!"],
    ],
  },
  {
    characterId: "Yuuka",
    fact: "선생님은 지출 기록을 수첩에 적어",
    question: "내가 지출 기록을 어디에 적는다고 했었지?",
    includes: ["수첩"],
    filler: [
      ["회의가 길어졌어", "네. 다음부터는 시간을 미리 확인해 두세요."],
      ["알겠어", "네, 그렇게 해 주세요."],
    ],
  },
  {
    characterId: "Aris",
    fact: "우리는 밤에 같이 게임하기로 했어",
    question: "우리 게임 언제 하기로 했지?",
    includes: ["밤"],
    filler: [
      ["오늘 뭐 했어?", "네! 아리스는 퀘스트를 진행했습니다!"],
      ["잘했어", "감사합니다! 아리스는 더 강해질 것입니다!"],
    ],
  },
];

const NOW = 1_700_000_000_000;
interface ProbeRow {
  id: string;
  characterId: string;
  variant: string;
  window: number;
  expectedTurns: number;
  memory: string | null;
  question: string;
  historyTurns: number;
  promptChars: number;
  budget: number;
  excerptChars?: number;
  messages: PromptMessage[];
  expect: { includes: string[]; excludes: string[] };
}
const ROWS: ProbeRow[] = [];
for (const testCase of CASES) {
  const fixed = promptCharsFor(testCase.characterId)!;
  const history = [
    { me: true, text: testCase.fact },
    { me: false, text: "네, 기억해 둘게요." },
    ...testCase.filler.flatMap(([question, answer]) => [
      { me: true, text: question },
      { me: false, text: answer },
    ]),
    { me: true, text: testCase.question },
  ];
  const memory = {
    id: `mem-${testCase.characterId}`,
    roomId: testCase.characterId,
    text: testCase.fact,
    enabled: true,
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    sourceMessageId: null,
    sourceText: null,
  };
  const variants: [string, (typeof memory)[], string][] = [
    ["window2", [], testCase.question],
    ["window4", [], testCase.question],
    ["window2-memory", [memory], testCase.question],
    ["window4-memory", [memory], testCase.question],
  ];
  for (const [variant, rowsForSelection, questionText] of variants) {
    const window = variant.startsWith("window4") ? 4 : 2;
    const memories = selectMemories(rowsForSelection, {
      roomId: testCase.characterId,
      query: questionText,
      now: NOW,
      limit: MEMORY_LIMIT,
      charBudget: MEMORY_CHAR_BUDGET,
    }).map((entry) => ({ id: entry.id, text: entry.text }));
    const plan = momoPromptPlan({
      history,
      text: questionText,
      fixedChars: fixed.system + fixed.examples,
      memories,
      excerpts: [],
      turns: window,
    });
    const messages = chatMessagesWithReferences(
      testCase.characterId,
      plan.messages,
      plan.memories,
      plan.excerpts,
    );
    const kept = plan.messages.filter(
      (message) => message.role === "assistant",
    ).length;
    const withMemory = memories.length > 0;
    ROWS.push({
      id: `${testCase.characterId}-${variant}`,
      characterId: testCase.characterId,
      variant,
      window,
      expectedTurns: Math.min(window, 3),
      memory: withMemory ? memory.text : null,
      question: questionText,
      historyTurns: kept,
      promptChars: plan.promptChars,
      budget: PROMPT_CHAR_BUDGET,
      messages: messages!.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      // 기억이 있거나 최근 창 안에 사실이 남아 있으면 회상이 정답이다. 창 밖 + 기억 없음이면 값을 지어내면 안 된다.
      expect:
        withMemory || window === 4
          ? { includes: testCase.includes, excludes: [] }
          : { includes: [], excludes: testCase.includes },
    });
  }
}

// 원문 발췌 검증: 사실을 25왕복 전에 말했을 때(창 밖), 발췌 검색이 회상을 가능하게 하는지 본다.
for (const testCase of CASES) {
  const fixed = promptCharsFor(testCase.characterId)!;
  const farHistory: PromptHistory[][] = [];
  for (let index = 0; index < 30; index++) {
    farHistory.push(
      index === 5
        ? [
            { me: true, text: testCase.fact },
            { me: false, text: "네, 기억해 둘게요." },
          ]
        : [
            { me: true, text: `${index}번째 잡담이야` },
            { me: false, text: `${index}번째 대답이야` },
          ],
    );
  }
  const flatHistory = farHistory.flat();
  const rowsForSearch = flatHistory.map((message, index) => ({
    id: `m${index}`,
    roomId: testCase.characterId,
    text: message.text,
    createdAt: NOW + index,
  }));
  for (const variant of ["excerpt-on", "excerpt-off"]) {
    const questionText = testCase.question;
    const hits =
      variant === "excerpt-on"
        ? searchMessages(rowsForSearch, { query: questionText, limit: 2 }).map(
            (hit) => ({
              id: hit.message.id,
              text: hit.message.text.slice(0, 500),
            }),
          )
        : [];
    const memories = selectMemories<
      import("../../src/lib/chat/types.ts").Memory
    >([], { roomId: testCase.characterId, query: questionText, now: NOW }).map(
      (entry) => ({ id: entry.id, text: entry.text }),
    );
    const plan = momoPromptPlan({
      history: [...flatHistory, { me: true, text: questionText }],
      text: questionText,
      fixedChars: fixed.system + fixed.examples,
      memories,
      excerpts: hits,
      turns: 4,
    });
    const messages = chatMessagesWithReferences(
      testCase.characterId,
      plan.messages,
      plan.memories,
      plan.excerpts,
    );
    ROWS.push({
      id: `${testCase.characterId}-${variant}`,
      characterId: testCase.characterId,
      variant,
      window: 4,
      expectedTurns: 4,
      memory: null,
      question: questionText,
      historyTurns: plan.messages.filter(
        (message) => message.role === "assistant",
      ).length,
      excerptChars: plan.referenceChars,
      promptChars: plan.promptChars,
      budget: PROMPT_CHAR_BUDGET,
      messages: messages!.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      expect:
        variant === "excerpt-on"
          ? { includes: testCase.includes, excludes: [] }
          : { includes: [], excludes: testCase.includes },
    });
  }
}

const output = process.argv[2] ?? "runs/context-probe/prompts.jsonl";
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  ROWS.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
for (const row of ROWS) {
  const hasReference = row.messages.some(
    (message) =>
      message.role === "system" && message.content.includes("[참고 자료]"),
  );
  const expectReference = Boolean(row.memory) || row.variant === "excerpt-on";
  if (hasReference !== expectReference)
    throw new Error(`${row.id}: 참고 자료 주입이 기대와 다름`);
  if (row.historyTurns !== row.expectedTurns)
    throw new Error(
      `${row.id}: 기대 왕복 ${row.expectedTurns}, 실제 ${row.historyTurns}`,
    );
  if (row.promptChars > row.budget) throw new Error(`${row.id}: 예산 초과`);
}
if (ROWS.some((row) => row.variant === "excerpt-on" && !row.excerptChars))
  throw new Error("발췌가 비어 있으면 검증이 성립하지 않는다");
const windows = ROWS.reduce<Record<string, number>>(
  (map, row) => ({ ...map, [row.variant]: (map[row.variant] ?? 0) + 1 }),
  {},
);
console.log(
  `맥락 창 프로브 ${ROWS.length}건 → ${output}`,
  JSON.stringify(windows),
);
