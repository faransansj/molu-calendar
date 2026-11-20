import type {
  ChatMessage,
  MessageDraft,
  WriteCondition,
} from "../lib/chat/types.ts";

export type TurnInput =
  { text: string; replaceId?: string } | { retryId: string };
export type TurnWrite = Omit<MessageDraft, "roomId"> & WriteCondition;
type Append = (draft: TurnWrite, onCommit?: () => void) => Promise<ChatMessage>;

export function unanswered(last: ChatMessage | null | undefined) {
  return last?.speakerType === "user" &&
    last.sourceKind === "user-input" &&
    last.status === "complete"
    ? last
    : null;
}

// A slow readonly IDB request cannot be interrupted. Release the Web Lock on
// stop; its eventual result must not advance this turn to the next stage.
async function readUntilStopped<T>(
  signal: AbortSignal,
  read: () => Promise<T>,
) {
  signal.throwIfAborted();
  const stopped = Promise.withResolvers<never>();
  const abort = () => stopped.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([read(), stopped.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function changed() {
  return new DOMException(
    "대화방이 변경되었어요. 최신 대화를 확인해 주세요.",
    "ChatStorageConflict",
  );
}

/** Run inside the per-room Web Lock; all writes carry the original storage generation. */
export async function sendChatTurn<Plan>({
  input,
  signal,
  head,
  prepare,
  history,
  append,
  onQuestionSaved,
  plan,
  generate,
}: {
  input: TurnInput;
  signal: AbortSignal;
  head: () => Promise<{ generation: string; last: ChatMessage | null }>;
  prepare: (signal: AbortSignal) => Promise<void>;
  history: () => Promise<ChatMessage[]>;
  append: Append;
  onQuestionSaved: () => void;
  plan: (
    question: Pick<ChatMessage, "id" | "text">,
    history: ChatMessage[],
  ) => Promise<Plan>;
  generate: (plan: Plan) => Promise<string>;
}) {
  const { generation, last } = await readUntilStopped(signal, head);
  signal.throwIfAborted();
  const pending = unanswered(last);
  if ("retryId" in input) {
    if (pending?.id !== input.retryId) throw changed();
  } else if (input.replaceId !== undefined) {
    if (pending?.id !== input.replaceId) throw changed();
  } else if (pending) {
    throw new Error(
      "답장을 기다리는 메시지가 있어요. 다시 시도를 눌러 주세요.",
    );
  }
  const messages = await readUntilStopped(signal, history);
  signal.throwIfAborted();
  if (messages.at(-1)?.id !== last?.id) throw changed();
  const condition = { expectedGeneration: generation, signal };
  const question =
    "retryId" in input
      ? pending!
      : { id: crypto.randomUUID(), text: input.text.trim() };
  const context = await readUntilStopped(signal, () =>
    plan(question, "retryId" in input ? messages.slice(0, -1) : messages),
  );
  signal.throwIfAborted();
  await prepare(signal);
  signal.throwIfAborted();
  if ("text" in input) {
    await append(
      {
        ...condition,
        ...question,
        expectedLastMessageId: last?.id ?? null,
        speakerType: "user",
        sourceKind: "user-input",
      },
      onQuestionSaved,
    );
  }
  const latest = await readUntilStopped(signal, head);
  signal.throwIfAborted();
  if (latest.generation !== generation || latest.last?.id !== question.id)
    throw changed();
  const text = await generate(context);
  signal.throwIfAborted();
  await append({
    ...condition,
    expectedLastMessageId: question.id,
    speakerType: "character",
    sourceKind: "model-output",
    text,
  });
}
