import type { ChatMessage, ChatTranscript } from "./transcript.ts";
import type { Reference } from "./types.ts";
import {
  MESSAGE_SCAN_LIMIT,
  QUERY_MAX_LENGTH,
  selectMemories,
  selectExcerpts,
} from "./memory.ts";
import {
  completedExchanges,
  momoPromptPlan,
  momoSupportsAI,
  MOMO_HISTORY_TURNS,
} from "./prompt.ts";

export async function planChatPrompt(
  store: Pick<ChatTranscript, "memories" | "searchRoom" | "sourceMessage">,
  roomId: string,
  text: string,
  history: ChatMessage[],
  currentId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!momoSupportsAI(roomId)) throw new Error("지원하지 않는 AI 캐릭터예요.");
  const query = text.slice(0, QUERY_MAX_LENGTH).trim();
  const rows = await store.memories(roomId);
  signal?.throwIfAborted();
  const now = Date.now();
  const excludedIds = new Set([currentId]);
  for (const row of rows) {
    if (
      row.roomId === roomId &&
      row.sourceMessageId &&
      (!row.enabled || (row.expiresAt !== null && row.expiresAt <= now))
    )
      excludedIds.add(row.sourceMessageId);
  }
  const candidates = selectMemories(
    rows.filter(
      (row) => !row.sourceMessageId || !excludedIds.has(row.sourceMessageId),
    ),
    { roomId, query, now },
  );
  const recentIds = completedExchanges(history, excludedIds)
    .slice(-MOMO_HISTORY_TURNS)
    .flatMap(({ question, answer }) => [question.id, answer.id]);
  const memories: Reference[] = [];
  for (const { id, text, sourceMessageId } of candidates) {
    if (!sourceMessageId) {
      memories.push({ id, text, kind: "user-confirmed" });
      continue;
    }
    const source = await store.sourceMessage(roomId, sourceMessageId);
    signal?.throwIfAborted();
    if (!source || source.status !== "complete") continue;
    // An edited memo is the user's note about the source, not a verbatim utterance.
    memories.push({
      id,
      text,
      kind: source.text.includes(text) ? "quote" : "edited-note",
      speakerType: source.speakerType,
      speakerId: source.speakerId,
      sourceKind: source.sourceKind,
    });
    recentIds.push(sourceMessageId);
  }
  const hits = await store.searchRoom(roomId, {
    query,
    limit: MESSAGE_SCAN_LIMIT,
  });
  signal?.throwIfAborted();
  const excerpts = selectExcerpts(hits, { currentId, recentIds, excludedIds });
  const plan = momoPromptPlan({
    history,
    text,
    characterId: roomId,
    excludedIds,
    memories,
    excerpts,
  });
  if (!plan.fits)
    throw new Error("질문이 문맥 예산을 초과했어요. 더 짧게 입력해 주세요.");
  return plan;
}
