import {
  chatMessagesFor,
  personaById,
  referencePrefix,
} from "../ai/persona.ts";
import { MODEL_CONTEXT } from "../ai/models.ts";
import type {
  Reference,
  QuoteReference,
  PromptHistory,
  PromptMessage,
  ConversationMessage,
} from "./types.ts";
export const momoSupportsAI = (id: string) => !!personaById(id);

export const PROMPT_CHAR_BUDGET = 4_000;
// 3왕복 전 사실 회상을 위해 4왕복을 유지한다. 근거는 training/lora/runs/context-probe.
export const MOMO_HISTORY_TURNS = 4;
export const MOMO_MESSAGE_MAX = 2_000;

export const OUTPUT_RESERVE = 256;

// Pinned Gemma SentencePiece BPE model, SHA256 of its ModelProto:
// e594c8a90eb08d8bda498ff4747977dc827ae0c3c56b5c0d41a605a22d02ef03.
// Identity normalization, no dummy prefix, byte fallback. These frequent corpus
// characters are NORMAL single-code-point pieces in that model. BPE merges can
// only decrease the initial cost. All other scalars cost at most their UTF-8
// bytes (space maps to the single ▁ piece). No tokenizer download at runtime.
const singlePieces = new Set(
  "·…⋯가각간감같개거걱건걸것게겠겨격경계고과관괜교구귀그금기긴길까께나난날내너네년노누느는늘니님다단담답당대댓더던데도동되된두드든들디따딱때또라락람랑래러런럼렇레려력로루르른를리린마만많말맞며면명모못무문물뭐미밀바반받발밝방배버번법변보부분불비사상새생샬서선설세소속수쉬스슨습시식신실심싶쓰아안않알야어언엄업없었에여역연예오와요용우운웃워원위유으은을음응의이인일임있자작잔잘잠장저적전절정제조존좀종좋주중줘즐지직진차찮책처청츠치칙친침카코키터테투트티파평폐표풀프하학한할합해했행허험헤헨호화회후흥히힘",
);

function tokenBound(text: string) {
  let count = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    count +=
      cp < 0x80 || singlePieces.has(char)
        ? 1
        : cp < 0x800
          ? 2
          : cp < 0x10000
            ? 3
            : 4;
  }
  return count;
}

// Text-only Jinja template from the pinned .litertlm (no tools/thinking).
// Charge every ASCII byte of the markers instead of assuming special tokens.
function turnTokens(role: PromptMessage["role"], content: string) {
  return (
    "<|turn>\n<turn|>\n".length +
    (role === "assistant" ? "model" : role).length +
    tokenBound(content)
  );
}

export function measurePrompt(messages: PromptMessage[]) {
  let promptChars = 0;
  let inputTokenBound = "<bos><|turn>model\n".length;
  for (const { role, content } of messages) {
    promptChars += content.length;
    inputTokenBound += turnTokens(role, content);
  }
  return {
    promptChars,
    inputTokenBound,
    fits:
      promptChars <= PROMPT_CHAR_BUDGET &&
      inputTokenBound + OUTPUT_RESERVE <= MODEL_CONTEXT,
  };
}

export function completedExchanges(
  history: PromptHistory[],
  excludedIds?: ReadonlySet<string>,
) {
  const pairs = [];
  let user: PromptHistory | null = null;
  for (const message of history) {
    if (
      message.status !== "complete" ||
      !message.text.trim() ||
      message.text.length > MOMO_MESSAGE_MAX ||
      excludedIds?.has(message.id)
    ) {
      user = null;
      continue;
    }
    if (message.speakerType === "user" && message.sourceKind === "user-input") {
      user = message;
    } else {
      // Older v2 records have no reply ID. They must still be adjacent.
      if (
        user &&
        message.speakerType === "character" &&
        message.sourceKind === "model-output" &&
        (message.replyToMessageId === null ||
          message.replyToMessageId === user.id)
      ) {
        pairs.push({ question: user, answer: message });
      }
      user = null;
    }
  }
  return pairs;
}

export function momoPromptPlan({
  history = [],
  text,
  characterId,
  excludedIds,
  memories = [],
  excerpts = [],
  budget = PROMPT_CHAR_BUDGET,
  turns = MOMO_HISTORY_TURNS,
}: {
  history?: PromptHistory[];
  text: string;
  characterId: string;
  excludedIds?: ReadonlySet<string>;
  memories?: Reference[];
  excerpts?: QuoteReference[];
  budget?: number;
  turns?: number;
}) {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > MOMO_MESSAGE_MAX
  )
    throw new Error("메시지는 1~2,000자로 입력해 주세요.");
  if (
    !Number.isSafeInteger(budget) ||
    budget <= 0 ||
    budget > PROMPT_CHAR_BUDGET
  )
    throw new TypeError("문자 예산이 올바르지 않습니다.");
  if (!Array.isArray(memories) || !Array.isArray(excerpts))
    throw new TypeError("참고 자료는 배열이어야 합니다.");
  if (!Number.isInteger(turns) || turns < 1 || turns > MOMO_HISTORY_TURNS)
    throw new TypeError("최근 왕복 수가 올바르지 않습니다.");
  const current: ConversationMessage = { role: "user", content: text };
  const base = chatMessagesFor(characterId, [current]);
  if (!base) throw new Error("지원하지 않는 AI 캐릭터예요.");
  const initial = measurePrompt(base);
  const fixedChars = initial.promptChars - text.length;
  const availableChars = budget - initial.promptChars;
  const availableTokens =
    MODEL_CONTEXT - OUTPUT_RESERVE - initial.inputTokenBound;
  const selectedMemories: Reference[] = [];
  const selectedExcerpts: QuoteReference[] = [];
  let refChars = 0;
  let refTokens = 0;
  // Count the entire rendered prefix, including escaped quotes and both headers.
  function select<T extends Reference>(candidates: T[], selected: T[]) {
    for (const item of candidates) {
      selected.push(item);
      const prefix = referencePrefix(selectedMemories, selectedExcerpts);
      const size = tokenBound(prefix);
      if (prefix.length * 2 > availableChars || size * 2 > availableTokens) {
        selected.pop();
      } else {
        refChars = prefix.length;
        refTokens = size;
      }
    }
  }
  select(memories, selectedMemories);
  select(excerpts, selectedExcerpts);
  const pairs = completedExchanges(history, excludedIds).slice(-turns);
  const messages: ConversationMessage[] = [current];
  let historyChars = 0;
  let historyTokens = 0;
  for (let index = pairs.length - 1; index >= 0; index--) {
    const { question, answer } = pairs[index]!;
    const chars = question.text.length + answer.text.length;
    const tokens =
      turnTokens("user", question.text) + turnTokens("assistant", answer.text);
    if (
      historyChars + chars > availableChars - refChars ||
      historyTokens + tokens > availableTokens - refTokens
    )
      break;
    messages.unshift(
      { role: "user", content: question.text },
      { role: "assistant", content: answer.text },
    );
    historyChars += chars;
    historyTokens += tokens;
  }
  return {
    messages,
    memories: selectedMemories,
    excerpts: selectedExcerpts,
    fixedChars,
    historyChars,
    referenceChars: refChars,
    promptChars: initial.promptChars + historyChars + refChars,
    inputTokenBound: initial.inputTokenBound + historyTokens + refTokens,
    droppedTurns: pairs.length - (messages.length - 1) / 2,
    fits: availableChars >= 0 && availableTokens >= 0,
  };
}
