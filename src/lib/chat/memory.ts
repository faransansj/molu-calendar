import { dice, grams, words } from "./replies.ts";

import type { Memory, Reference, MemoryDraft } from "./types.ts";

export const MEMORY_LIMIT = 5;
export const MEMORY_CHAR_BUDGET = 1_200;
export const MESSAGE_LIMIT = 20;
export const MESSAGE_SCAN_LIMIT = 2_000;
export const QUERY_MAX_LENGTH = 200;
const MIN_SCORE = 0.34; // 실측: 관련 문장 ≥.4, 무관한 문장 ≤.2
// 흔한 기능어는 어절 일치로 세지 않는다: '있어' 하나로 무관한 기억이 걸리는 것을 막는다.
const FUNCTION_WORDS = new Set([
  "있어",
  "있나",
  "있는",
  "있다",
  "있었",
  "없어",
  "하는",
  "하고",
  "해서",
  "했다",
  "해요",
  "네요",
  "거야",
  "거지",
  "같아",
  "같은",
  "이야",
  "이지",
  "되는",
  "된",
  "하는지",
  "했지",
  "했어",
]);

const clamp = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export function relevance(query: string, text: string) {
  if (typeof query !== "string" || typeof text !== "string")
    throw new TypeError("검색어와 본문은 문자열이어야 합니다.");
  const trimmed = query.trim();
  if (!trimmed) throw new TypeError("검색어를 입력해 주세요.");
  if (trimmed.length > QUERY_MAX_LENGTH)
    throw new TypeError(`검색어는 ${QUERY_MAX_LENGTH}자 이하여야 합니다.`);
  const queryWords = new Set(words(trimmed));
  const textWords = [...new Set(words(text))];
  const matched = new Set();
  for (const word of queryWords) {
    if (FUNCTION_WORDS.has(word)) continue;
    if (textWords.includes(word)) {
      matched.add(word);
      continue;
    }
    // 어미·파생형은 접두로 흡수한다(2자 이상 겹칠 때만).
    if (
      word.length >= 2 &&
      textWords.some(
        (other) =>
          other.length >= 2 &&
          (other.startsWith(word) || word.startsWith(other)),
      )
    )
      matched.add(word);
  }
  const queryGrams = grams(trimmed);
  const textGrams = grams(text);
  const wordScore = queryWords.size ? matched.size / queryWords.size : 0;
  const gramScore = queryGrams.size ? dice(queryGrams, textGrams) : 0;
  // 흔한 단어 하나만 겹치는 문장이 상위에 오르지 않도록 일치 비율을 반영한다.
  const ratio = queryWords.size ? matched.size / queryWords.size : 0;
  const exact = matched.size ? 0.35 + 0.45 * ratio : 0;
  return Math.max(wordScore * 0.7 + gramScore * 0.3, exact);
}

export function filterMemories<T extends Pick<Memory, "text">>(
  memories: T[],
  query: string,
) {
  if (!Array.isArray(memories))
    throw new TypeError("기억 목록이 배열이 아닙니다.");
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return memories;
  return memories.filter(
    (memory) =>
      memory &&
      typeof memory.text === "string" &&
      relevance(trimmed, memory.text) >= MIN_SCORE,
  );
}

export function selectMemories<
  T extends Pick<Memory, "id" | "roomId" | "text"> &
    Partial<Pick<Memory, "enabled" | "expiresAt" | "updatedAt">>,
>(
  memories: T[],
  {
    roomId,
    query,
    now = Date.now(),
    limit = MEMORY_LIMIT,
    charBudget = MEMORY_CHAR_BUDGET,
  }: {
    roomId: string;
    query?: string;
    now?: number;
    limit?: number;
    charBudget?: number;
  },
) {
  if (!Array.isArray(memories))
    throw new TypeError("기억 목록이 배열이 아닙니다.");
  if (typeof roomId !== "string" || !roomId)
    throw new TypeError("대화방 ID가 필요합니다.");
  if (!Number.isSafeInteger(now) || now < 0)
    throw new TypeError("기준 시각이 올바르지 않습니다.");
  const scoped = memories.filter(
    (memory) =>
      memory &&
      memory.roomId === roomId &&
      memory.enabled !== false &&
      (memory.expiresAt === null ||
        memory.expiresAt === undefined ||
        memory.expiresAt > now),
  );
  const scored = scoped.map((memory) => ({
    memory,
    score: query ? relevance(query, memory.text) : 1,
  }));
  // 흔한 단어만 겹치는 기억이 예산을 차지하지 않도록 최상위 점수의 80%를 하한으로 둔다.
  const best = scored.reduce((max, entry) => Math.max(max, entry.score), 0);
  const floor = query ? Math.max(MIN_SCORE, best * 0.8) : 0;
  const selected = [];
  let used = 0;
  for (const entry of scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.memory.updatedAt ?? 0) - (a.memory.updatedAt ?? 0),
  )) {
    if (query && entry.score < floor) continue;
    if (selected.length >= limit) break;
    if (used + entry.memory.text.length > charBudget) continue;
    selected.push(entry.memory);
    used += entry.memory.text.length;
  }
  return selected;
}

// 현재 질문과 최근 대화는 프롬프트에 이미 있으므로 발췌로 중복하지 않는다.
export function selectExcerpts(
  hits: (Reference | { message: Reference })[],
  {
    currentId = null,
    recentIds = [],
    itemChars = 500,
    maxChars = 800,
  }: {
    currentId?: string | null;
    recentIds?: string[];
    itemChars?: number;
    maxChars?: number;
  } = {},
) {
  if (!Array.isArray(hits)) throw new TypeError("검색 결과가 배열이 아닙니다.");
  const seen = new Set([currentId, ...recentIds].filter(Boolean));
  const chosen = [];
  let used = 0;
  for (const hit of hits) {
    const message = "message" in hit ? hit.message : hit;
    if (!message || typeof message.text !== "string" || seen.has(message.id))
      continue;
    const text = message.text.slice(0, itemChars).trim();
    if (!text || used + text.length > maxChars) continue;
    chosen.push({ id: message.id, text });
    used += text.length;
    seen.add(message.id);
  }
  return chosen;
}

export function searchMessages<
  T extends Reference & {
    createdAt?: number | null;
  },
>(
  rows: T[],
  {
    query,
    from = null,
    to = null,
    limit = MESSAGE_LIMIT,
  }: {
    query?: string;
    from?: number | null;
    to?: number | null;
    limit?: number;
  } = {},
) {
  if (!Array.isArray(rows))
    throw new TypeError("메시지 목록이 배열이 아닙니다.");
  if (from !== null && (!Number.isSafeInteger(from) || from < 0))
    throw new TypeError("시작 시각이 올바르지 않습니다.");
  if (to !== null && (!Number.isSafeInteger(to) || to < (from ?? 0)))
    throw new TypeError("끝 시각이 올바르지 않습니다.");
  const hits = [];
  for (const row of rows) {
    if (!row || typeof row.text !== "string") continue;
    const at = row.createdAt ?? null;
    if (from !== null && (at === null || at < from)) continue;
    if (to !== null && (at === null || at > to)) continue;
    const score = query ? relevance(query, row.text) : 1;
    if (query && score < MIN_SCORE) continue;
    hits.push({ message: row, score });
  }
  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.message.createdAt ?? 0) - (a.message.createdAt ?? 0),
    )
    .slice(0, limit);
}

export function memoryDraftFromMessage(
  message: Reference & { roomId: string },
  maxLength = 500,
): MemoryDraft {
  if (!message || typeof message.text !== "string" || !message.text.trim())
    throw new TypeError("기억으로 만들 메시지가 아닙니다.");
  if (typeof message.roomId !== "string" || !message.roomId)
    throw new TypeError("메시지에 대화방이 없습니다.");
  return {
    roomId: message.roomId,
    text: clamp(message.text.trim(), maxLength),
    sourceMessageId: message.id ?? null,
    sourceText: clamp(message.text.trim(), 2_000),
  };
}
