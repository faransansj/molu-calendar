import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PERSONAS,
  chatMessagesFor,
  promptCharsFor,
  replyLengthRange,
} from "../../src/lib/ai/persona.ts";

// 모든 캐릭터에 같은 네 가지 상황을 준다: 인사, 부탁, 감정, 일정(없는 약속을 만들지 않는지).
const QUESTIONS = [
  { id: "greeting", prompt: "안녕. 오늘은 그냥 네 목소리 듣고 싶었어." },
  { id: "request", prompt: "지금 좀 바쁠까? 잠깐 도와줄 수 있어?" },
  { id: "feelings", prompt: "오늘 하루가 좀 힘들었어. 내 이야기 들어줄래?" },
  { id: "schedule", prompt: "내일 우리 약속 있었나? 네가 확인해 줄래?" },
];
// 카드에 없는 사실을 지어내면 안 되는 질문(앱의 환각 점검과 같은 취지).
const NO_INVENT = [/약속/, /기억/];

const rows = [];
for (const persona of PERSONAS) {
  const fixed = promptCharsFor(persona.id)!;
  for (const question of QUESTIONS) {
    const messages = chatMessagesFor(persona.id, [
      { role: "user", content: question.prompt },
    ]);
    if (!messages) throw new Error(`${persona.id}: 시스템 프롬프트 없음`);
    rows.push({
      id: `${persona.id}-${question.id}`,
      characterId: persona.id,
      register: persona.register,
      sentences: replyLengthRange(persona.id),
      questionId: question.id,
      question: question.prompt,
      promptChars: fixed.system + fixed.examples + question.prompt.length,
      noInvent: NO_INVENT.some((pattern) => pattern.test(question.prompt)),
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });
  }
}
for (const row of rows) {
  if (
    row.messages.at(-1)!.role !== "user" ||
    row.messages.at(-1)!.content !== row.question
  )
    throw new Error(`${row.id}: 마지막 메시지가 질문이 아님`);
  if (!row.messages.some((message) => message.role === "system"))
    throw new Error(`${row.id}: 시스템 프롬프트 없음`);
}
const output = process.argv[2] ?? "runs/voice-probe/prompts.jsonl";
// 실험 스위치: 앱 프롬프트의 [분량] 블록만 떼어 비교한다(프로브 전용, 앱 코드는 그대로).
const noLengthBlock = process.argv.includes("--no-length-block");
if (noLengthBlock) {
  for (const row of rows) {
    if (row.messages[0]?.role !== "system")
      throw new Error(`${row.id}: 시스템 프롬프트 위치가 다름`);
    row.messages[0] = {
      ...row.messages[0],
      content: row.messages[0].content.replace(/\n\n\[분량\][\s\S]*$/, ""),
    };
    if (row.messages[0].content.includes("[분량]"))
      throw new Error(`${row.id}: [분량] 제거 실패`);
  }
}
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
const registers = rows.reduce<Record<string, number>>(
  (map, row) => ({ ...map, [row.register]: (map[row.register] ?? 0) + 1 }),
  {},
);
console.log(
  `말투 프로브 ${rows.length}건(${QUESTIONS.length}질문 × ${rows.length / QUESTIONS.length}명) → ${output}`,
  JSON.stringify(registers),
);
