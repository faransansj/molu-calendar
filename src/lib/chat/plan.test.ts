import { describe, expect, it } from "vitest";
import { planChatPrompt } from "./plan.ts";
import type { ChatMessage } from "./transcript.ts";

const message = (id: string, text: string, me = true): ChatMessage => ({
  id,
  text,
  me,
  time: "12:00",
  status: "complete",
  sourceKind: me ? "user-input" : "model-output",
  speakerType: me ? "user" : "character",
  createdAt: 1,
});
const question = "금요일 독서 모임은 언제야?";
const store = {
  memories: async () => [
    {
      id: "own",
      roomId: "Arona",
      text: "금요일 독서 모임은 오후 7시",
      enabled: true,
      expiresAt: null,
      sourceMessageId: null,
      profileId: "local" as const,
      sourceText: null,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "other",
      roomId: "Yuuka",
      text: "금요일 독서 모임은 오후 8시",
      enabled: true,
      expiresAt: null,
      sourceMessageId: null,
      profileId: "local" as const,
      sourceText: null,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  searchRoom: async () => [
    { message: message("old", "금요일 독서 모임은 오후 7시"), score: 1 },
    { message: message("current", question), score: 1 },
  ],
  retryTarget: () => message("current", question),
};
describe("React chat to upstream Worker prompt boundary", () => {
  it("uses persona character counts and sends only room-scoped, restricted DTOs", async () => {
    const plan = await planChatPrompt(store, "Arona", question, []);
    expect(plan.fixedChars).toBeGreaterThan(0);
    expect(plan.promptChars).toBeLessThanOrEqual(4000);
    expect(plan.memories).toEqual([
      { id: "own", text: "금요일 독서 모임은 오후 7시" },
    ]);
    expect(plan.excerpts).toEqual([
      { id: "old", text: "금요일 독서 모임은 오후 7시" },
    ]);
    expect(plan.messages).toEqual([{ role: "user", content: question }]);
  });
  it("keeps completed exchanges and excludes their duplicated excerpts", async () => {
    const history = [
      message("old", "금요일 독서 모임은 오후 7시"),
      message("answer", "알겠어요", false),
    ];
    const plan = await planChatPrompt(store, "Arona", question, history);
    expect(plan.excerpts).toEqual([]);
    expect(plan.messages.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });
  it("rejects unsupported personas and overlong messages", async () => {
    await expect(
      planChatPrompt(store, "missing", question, []),
    ).rejects.toThrow("지원하지");
    await expect(
      planChatPrompt(store, "Arona", "x".repeat(2001), []),
    ).rejects.toThrow("2,000");
  });
});
