import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/types.ts";
import { planChatPrompt } from "../lib/chat/plan.ts";
import { sendChatTurn, unanswered } from "./chat-turn.ts";
import type { TurnInput, TurnWrite } from "./chat-turn.ts";

function message(id: string, text: string, me = true): ChatMessage {
  return {
    id,
    me,
    text,
    time: "09:00",
    createdAt: 0,
    status: "complete",
    speakerType: me ? "user" : "character",
    speakerId: me ? "sensei" : "Arona",
    sourceKind: me ? "user-input" : "model-output",
    replyToMessageId: null,
  };
}

function setup(last: ChatMessage | null = null) {
  const saved = { last, generation: "original" };
  const controller = new AbortController();
  const input: TurnInput = last ? { retryId: last.id } : { text: "question" };
  const job = {
    input,
    signal: controller.signal,
    head: vi.fn(async () => ({ ...saved })),
    prepare: vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined),
    history: vi.fn(async () => (saved.last ? [saved.last] : [])),
    append: vi.fn(async (draft: TurnWrite, onCommit?: () => void) => {
      draft.signal?.throwIfAborted();
      if (
        draft.expectedGeneration !== saved.generation ||
        draft.expectedLastMessageId !== (saved.last?.id ?? null)
      )
        throw new DOMException("changed", "ChatStorageConflict");
      saved.last = message(
        draft.id ?? draft.speakerType,
        draft.text,
        draft.speakerType === "user",
      );
      onCommit?.();
      return saved.last;
    }),
    onQuestionSaved: vi.fn(),
    plan: vi.fn<
      (
        question: Pick<ChatMessage, "id" | "text">,
        history: ChatMessage[],
      ) => Promise<string>
    >(async (question) => question.text),
    generate: vi.fn(async (text: string) => `reply to ${text}`),
  };
  return { job, controller, saved };
}

describe("MomoTalk send under the room lock", () => {
  it("preserves the draft and writes nothing when cache-only preparation misses", async () => {
    const { job } = setup();
    const miss = Object.assign(new Error("model not cached"), {
      code: "model_not_cached",
    });
    job.prepare.mockRejectedValueOnce(miss);
    await expect(sendChatTurn(job)).rejects.toBe(miss);
    expect(job.append).not.toHaveBeenCalled();
    expect(job.onQuestionSaved).not.toHaveBeenCalled();
    expect(job.generate).not.toHaveBeenCalled();
  });

  it("rejects an obsolete retry ID before model preparation even for identical texts", async () => {
    const { job } = setup(message("newest", "question"));
    await expect(
      sendChatTurn({ ...job, input: { retryId: "older" } }),
    ).rejects.toMatchObject({ name: "ChatStorageConflict" });
    expect(job.prepare).not.toHaveBeenCalled();
    expect(job.append).not.toHaveBeenCalled();
  });

  it("uses the persisted question's text, not stale page text, and never appends another question on retry", async () => {
    const current = message("newest", "latest question");
    const { job } = setup(current);
    const old = message("older", "old question");
    job.history.mockResolvedValueOnce([old, { ...current, text: "stale" }]);
    await sendChatTurn(job);
    expect(job.plan).toHaveBeenCalledWith(current, [old]);
    expect(job.append).toHaveBeenCalledTimes(1);
    expect(job.append).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "reply to latest question",
        expectedLastMessageId: "newest",
        expectedGeneration: "original",
      }),
    );
    expect(job.onQuestionSaved).not.toHaveBeenCalled();
  });

  it("only treats a completed user message as retryable", () => {
    const question = message("q", "question");
    expect(unanswered(question)).toBe(question);
    expect(unanswered({ ...question, status: "interrupted" })).toBeNull();
    expect(unanswered({ ...question, sourceKind: "script" })).toBeNull();
    expect(unanswered(message("reply", "answer", false))).toBeNull();
  });

  it("keeps an over-budget 2,000-character draft editable without loading the model or persisting it", async () => {
    const { job, saved } = setup();
    const text = "꺾".repeat(2000);
    await expect(
      sendChatTurn({
        ...job,
        input: { text },
        plan: async (question, history) => {
          await planChatPrompt(
            {
              memories: async () => [],
              searchRoom: async () => [],
              sourceMessage: async () => null,
            },
            "Arona",
            question.text,
            history,
            question.id,
          );
          return question.text;
        },
      }),
    ).rejects.toThrow("더 짧게");
    expect(saved.last).toBeNull();
    expect(job.prepare).not.toHaveBeenCalled();
    expect(job.onQuestionSaved).not.toHaveBeenCalled();
    expect(job.append).not.toHaveBeenCalled();
  });

  it("requires explicit replacement of the same unanswered question and links the answer to the new ID", async () => {
    const original = message("past", "oversized historical question");
    const { job } = setup(original);
    await expect(
      sendChatTurn({ ...job, input: { text: "new question" } }),
    ).rejects.toThrow("답장을 기다리는");
    await expect(
      sendChatTurn({
        ...job,
        input: { text: "new question", replaceId: "older" },
      }),
    ).rejects.toMatchObject({ name: "ChatStorageConflict" });
    expect(job.append).not.toHaveBeenCalled();
    await sendChatTurn({
      ...job,
      input: { text: "new question", replaceId: original.id },
    });
    const next = job.append.mock.calls[0]![0];
    expect(next.expectedLastMessageId).toBe(original.id);
    expect(next.id).not.toBe(original.id);
    expect(job.append.mock.calls[1]![0].expectedLastMessageId).toBe(next.id);
  });

  it("does not clear the input or start generation if the question write fails", async () => {
    const { job } = setup();
    const error = new Error("write failed");
    job.append.mockRejectedValueOnce(error);
    await expect(sendChatTurn(job)).rejects.toBe(error);
    expect(job.onQuestionSaved).not.toHaveBeenCalled();
    expect(job.generate).not.toHaveBeenCalled();
  });

  it("stopping during the first storage read releases the lock without waiting for that read", async () => {
    const { job, controller, saved } = setup();
    const read = Promise.withResolvers<typeof saved>();
    job.head.mockReturnValueOnce(read.promise);
    const result = sendChatTurn(job);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    read.resolve(saved);
    expect(job.prepare).not.toHaveBeenCalled();
    expect(job.append).not.toHaveBeenCalled();
  });

  it("does not append if preparation finishes after stop", async () => {
    const { job, controller } = setup();
    job.prepare.mockImplementationOnce(async (signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
    });
    await expect(sendChatTurn(job)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(job.append).not.toHaveBeenCalled();
  });

  it("stopping while a question write commits leaves that question unanswered", async () => {
    const { job, controller, saved } = setup();
    job.onQuestionSaved.mockImplementationOnce(() => controller.abort());
    await expect(sendChatTurn(job)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(saved.last?.me).toBe(true);
    expect(job.generate).not.toHaveBeenCalled();
  });

  it("releases a stopped planning read immediately without late generation", async () => {
    const { job, controller } = setup(message("q", "question"));
    const entered = Promise.withResolvers<void>();
    const read = Promise.withResolvers<string>();
    job.plan.mockImplementationOnce(() => {
      entered.resolve();
      return read.promise;
    });
    const result = sendChatTurn(job);
    await entered.promise;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    read.resolve("late");
    expect(job.generate).not.toHaveBeenCalled();
    expect(job.append).not.toHaveBeenCalled();
  });

  it("rejects a restored backup with the same latest ID before generation", async () => {
    const { job, saved } = setup(message("q", "question"));
    job.plan.mockImplementationOnce(async () => {
      saved.generation = "restored";
      return "question";
    });
    await expect(sendChatTurn(job)).rejects.toMatchObject({
      name: "ChatStorageConflict",
    });
    expect(job.generate).not.toHaveBeenCalled();
    expect(job.append).not.toHaveBeenCalled();
  });

  it("fences the eventual reply with the pre-generation snapshot", async () => {
    const { job, saved } = setup();
    job.generate.mockImplementationOnce(async () => {
      saved.generation = "restored";
      return "obsolete reply";
    });
    await expect(sendChatTurn(job)).rejects.toMatchObject({
      name: "ChatStorageConflict",
    });
    expect(saved.last?.text).toBe("question");
    expect(job.onQuestionSaved).toHaveBeenCalledTimes(1);
  });

  it("never writes partial or cancelled output", async () => {
    const { job, controller } = setup(message("q", "question"));
    job.generate.mockImplementationOnce(async () => {
      controller.abort();
      return "partial";
    });
    await expect(sendChatTurn(job)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(job.append).not.toHaveBeenCalled();
  });
});
