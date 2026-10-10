import { personaById } from "../ai/persona.ts";

// replies.ts scheduleReply resolves these tokens against the live calendar.
import { MOMO_KB, MOMO_QUERIES } from "./replies.ts";
export {
  MOMO_QUERIES,
  MOMO_TOPICS,
  MOMO_FALLBACK,
  MOMO_KB,
  momoTopicsFor,
  momoReply,
  stripParticle,
  words,
  grams,
  dice,
} from "./replies.ts";
import type { Reference, PromptHistory, ConversationMessage } from "./types.ts";
export const momoSupportsAI = (id: string) => !!personaById(id);

// 문자 예산이며 토큰 제한을 보장하지 않는다. Qwen3 실측 근거는 docs/chat-memory-contract.md.
export const PROMPT_CHAR_BUDGET = 4_000;
// 3왕복 전 사실 회상을 위해 4왕복을 유지한다. 근거는 training/lora/runs/context-probe.
export const MOMO_HISTORY_TURNS = 4;
export const MOMO_MESSAGE_MAX = 2_000;

const sumChars = (list: Reference[]) =>
  list.reduce((sum, item) => sum + item.text.length, 0);
function takeWhole<T extends Reference>(items: T[], budget: number) {
  const kept = [];
  let used = 0;
  for (const item of items) {
    if (used + item.text.length > budget) continue;
    kept.push(item);
    used += item.text.length;
  }
  return kept;
}
export function completedExchanges(
  history: PromptHistory[] | null | undefined,
) {
  const pairs = [];
  let user: PromptHistory | null = null;
  for (const message of history ?? []) {
    if (!message || typeof message.text !== "string") {
      user = null;
      continue;
    }
    if (message.me === true)
      user =
        !message.pending && message.text.length <= MOMO_MESSAGE_MAX
          ? message
          : null;
    else {
      if (
        message.me === false &&
        user &&
        message.text.length <= MOMO_MESSAGE_MAX
      )
        pairs.push({ question: user.text, answer: message.text });
      user = null;
    }
  }
  return pairs;
}

export function momoPromptPlan({
  history,
  text,
  fixedChars,
  memories = [],
  excerpts = [],
  budget = PROMPT_CHAR_BUDGET,
  turns = MOMO_HISTORY_TURNS,
}: {
  history?: PromptHistory[];
  text: string;
  fixedChars: number;
  memories?: Reference[];
  excerpts?: Reference[];
  budget?: number;
  turns?: number;
}) {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > MOMO_MESSAGE_MAX
  )
    throw new Error("메시지는 1~2,000자로 입력해 주세요.");
  if (!Number.isSafeInteger(fixedChars) || fixedChars < 0)
    throw new TypeError("고정 프롬프트 길이가 올바르지 않습니다.");
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new TypeError("문자 예산이 올바르지 않습니다.");
  if (!Array.isArray(memories) || !Array.isArray(excerpts))
    throw new TypeError("참고 자료는 배열이어야 합니다.");
  if (!Number.isInteger(turns) || turns < 1 || turns > 8)
    throw new TypeError("최근 왕복 수가 올바르지 않습니다.");
  const pairs = completedExchanges(history).slice(-turns);
  const available = budget - fixedChars - text.length;
  // 참고 자료가 최근 대화를 밀어내지 않도록 남은 예산의 절반을 대화에 남긴다.
  const referenceBudget = available > 0 ? Math.floor(available / 2) : 0;
  const selectedMemories = takeWhole(memories, referenceBudget);
  const selectedExcerpts = takeWhole(
    excerpts,
    referenceBudget - sumChars(selectedMemories),
  );
  const historyBudget = Math.max(
    0,
    available - sumChars(selectedMemories) - sumChars(selectedExcerpts),
  );
  const kept = [];
  let historyChars = 0;
  for (let index = pairs.length - 1; index >= 0; index--) {
    const size = pairs[index]!.question.length + pairs[index]!.answer.length;
    if (historyChars + size > historyBudget) break;
    kept.unshift(pairs[index]!);
    historyChars += size;
  }
  const messages: ConversationMessage[] = kept.flatMap((pair) => [
    { role: "user", content: pair.question },
    { role: "assistant", content: pair.answer },
  ]);
  messages.push({ role: "user", content: text });
  return {
    messages,
    memories: selectedMemories,
    excerpts: selectedExcerpts,
    fixedChars,
    historyChars,
    referenceChars: sumChars(selectedMemories) + sumChars(selectedExcerpts),
    promptChars:
      fixedChars +
      historyChars +
      sumChars(selectedMemories) +
      sumChars(selectedExcerpts) +
      text.length,
    droppedTurns: pairs.length - kept.length,
    fits: available > 0,
  };
}

// Local AI only intercepts explicit calendar phrases; fuzzy matches must not swallow character chat.
export function momoCalendarQuery(text: string) {
  if (!/오늘|내일/.test(text)) return null;
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[\s?!.,！？。]/g, "");
  const reply = MOMO_KB.find(
    (entry) =>
      typeof entry.reply === "string" &&
      MOMO_QUERIES.includes(entry.reply) &&
      entry.q.some((phrase) => normalize(phrase) === normalize(text)),
  )?.reply;
  return typeof reply === "string" ? reply : null;
}
