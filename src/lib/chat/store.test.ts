import { describe, expect, it } from "vitest";
import { BUNDLE_MAX_BYTES, parseChatBundle } from "./store.ts";
import type { ChatBundle, Memory } from "./types.ts";

const memory: Memory = {
  id: "memory",
  profileId: "local",
  roomId: "Arona",
  text: "금요일 독서 모임",
  sourceMessageId: null,
  sourceText: null,
  createdAt: 1,
  updatedAt: 1,
  enabled: true,
  expiresAt: null,
};
const legacy: ChatBundle = {
  format: "molu-chat-memory",
  version: 2,
  exportedAt: 1,
  rooms: [],
  messages: [],
  memories: [memory],
};

describe("v2 chat backups", () => {
  it("repairs only valid orphan memories and keeps their original fields", () => {
    const parsed = parseChatBundle(JSON.stringify(legacy));
    expect(parsed.memories).toEqual([memory]);
    expect(parsed.rooms).toEqual([
      {
        id: "Arona",
        profileId: "local",
        characterId: "Arona",
        participants: ["sensei", "Arona"],
        nextSeq: 1,
        revision: 0,
        userMessageCount: 0,
        lastMessageId: null,
      },
    ]);
    for (const patch of [
      { sourceMessageId: "missing" },
      { roomId: 123 },
      { roomId: "" },
      { roomId: "x".repeat(257) },
    ]) {
      expect(() =>
        parseChatBundle(
          JSON.stringify({ ...legacy, memories: [{ ...memory, ...patch }] }),
        ),
      ).toThrow();
    }
  });

  it("does not synthesize a room for a memory pointing at another room's message", () => {
    const { rooms } = parseChatBundle(JSON.stringify(legacy));
    const raw = {
      ...legacy,
      rooms: [
        { ...rooms[0], nextSeq: 2, userMessageCount: 1, lastMessageId: "q" },
      ],
      messages: [
        {
          profileId: "local",
          roomId: "Arona",
          id: "q",
          seq: 1,
          speakerId: "sensei",
          speakerType: "user",
          text: "secret",
          sourceKind: "user-input",
          status: "complete",
          createdAt: 1,
          replyToMessageId: null,
        },
      ],
      memories: [{ ...memory, roomId: "Yuuka", sourceMessageId: "q" }],
    };
    expect(() => parseChatBundle(JSON.stringify(raw))).toThrow(/기억 정보/);
  });

  it("uses the file's UTF-8 byte count at the inclusive 32 MiB boundary", () => {
    const raw = JSON.stringify(legacy);
    const boundary = raw + " ".repeat(BUNDLE_MAX_BYTES - new Blob([raw]).size);
    expect(parseChatBundle(boundary).memories).toEqual([memory]);
    expect(boundary.length + 1).toBeLessThan(BUNDLE_MAX_BYTES);
    expect(() => parseChatBundle(boundary + " ")).toThrow(/너무 큽니다/);
  });
});
