import { describe, expect, it } from "vitest";
import { normalizeExcerpts } from "../ai/persona.ts";
import { selectExcerpts } from "./memory.ts";
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
  it("limits short search results to two excerpts accepted by the Worker", async () => {
    const hits = [
      message("a", "금요일에는 독서 모임에 가요."),
      message("b", "독서 모임은 오후 7시에 시작해요."),
      message("c", "독서 모임 장소는 도서관이에요."),
    ];
    const plan = await planChatPrompt(
      {
        memories: async () => [],
        retryTarget: () => null,
        searchRoom: async () => hits.map((message) => ({ message, score: 1 })),
      },
      "Arona",
      "금요일 독서 모임 정보를 다시 알려줘.",
      [],
    );
    const expected = [
      { id: "a", text: "금요일에는 독서 모임에 가요." },
      { id: "b", text: "독서 모임은 오후 7시에 시작해요." },
    ];
    expect(plan.excerpts).toEqual(expected);
    expect(normalizeExcerpts(plan.excerpts)).toEqual(expected);
  });
  it("fills excerpt slots after skipping current, recent, empty and duplicate candidates", () => {
    const excerpts = selectExcerpts(
      [
        message("current", "현재 질문"),
        message("recent", "최근 대화"),
        message("empty", "   "),
        message("a", "첫 번째 발췌"),
        message("a", "중복 발췌"),
        message("b", "두 번째 발췌"),
        message("c", "세 번째 발췌"),
      ],
      { currentId: "current", recentIds: ["recent"] },
    );
    expect(excerpts).toEqual([
      { id: "a", text: "첫 번째 발췌" },
      { id: "b", text: "두 번째 발췌" },
    ]);
  });
  it("skips an over-budget candidate and preserves two excerpts totaling 800 characters", () => {
    const excerpts = selectExcerpts([
      message("a", "가".repeat(500)),
      message("b", "나".repeat(301)),
      message("c", "다".repeat(300)),
    ]);
    const expected = [
      { id: "a", text: "가".repeat(500) },
      { id: "c", text: "다".repeat(300) },
    ];
    expect(excerpts).toEqual(expected);
    expect(excerpts.reduce((sum, { text }) => sum + text.length, 0)).toBe(800);
    expect(normalizeExcerpts(excerpts)).toEqual(expected);
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
