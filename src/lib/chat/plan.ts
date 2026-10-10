import type { ChatMessage, ChatTranscript } from "./transcript.ts";
import { selectMemories, selectExcerpts } from "./memory.ts";
import { momoPromptPlan } from "./prompt.ts";
import { promptCharsFor } from "../ai/persona.ts";

export async function planChatPrompt(
  store: Pick<ChatTranscript, "memories" | "searchRoom" | "retryTarget">,
  roomId: string,
  text: string,
  history: ChatMessage[],
) {
  const fixed = promptCharsFor(roomId);
  if (!fixed) throw new Error("지원하지 않는 AI 캐릭터예요.");
  const query = text.slice(0, 200);
  const memories = selectMemories(await store.memories(roomId), {
    roomId,
    query,
  }).map(({ id, text }) => ({ id, text }));
  const excerpts = selectExcerpts(
    await store.searchRoom(roomId, { query, limit: 10 }),
    {
      currentId: store.retryTarget(roomId)?.id,
      recentIds: history.slice(-8).map((message) => message.id),
    },
  );
  const plan = momoPromptPlan({
    history,
    text,
    fixedChars: fixed.system + fixed.examples,
    memories,
    excerpts,
  });
  if (!plan.fits)
    throw new Error("질문이 문맥 예산을 초과했어요. 더 짧게 입력해 주세요.");
  return plan;
}
