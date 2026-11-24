import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { LITERT_CACHE, MODELS, modelURL } from "../lib/ai/models.ts";
import "./local-ai.worker.ts";

// Drive the real message handler with a controlled cache and LiteRT boundary.
// This verifies the request sent to LiteRT, not GPU availability/model quality.
const fixture = vi.hoisted(() => {
  const port = {
    location: { href: "https://example.test/local-ai-worker.bundle.js" },
    onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
    postMessage: vi.fn(),
  };
  const match = vi.fn<CacheStorage["match"]>();
  const fetch = vi.fn();
  const inspect = vi.fn(async () => ({
    engines: { litert: { supported: true } },
  }));
  const send = vi.fn<
    (message: {
      role: string;
      content: string;
    }) => AsyncIterable<{ content: string }>
  >(async function* () {
    yield { content: "답변" };
  });
  const conversation = vi.fn(async () => ({
    sendMessageStreaming: send,
    getBenchmarkInfo: async () => ({}),
    delete: async () => {},
  }));
  vi.stubGlobal("self", port);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("caches", { match, open: async () => ({ match }) });
  return { port, match, fetch, inspect, send, conversation };
});
vi.mock("../lib/ai/client.ts", () => ({ inspectEnvironment: fixture.inspect }));
vi.mock("@litert-lm/core", () => ({
  Backend: { GPU_ARTISAN: 1 },
  getOrLoadGlobalLiteRtLm: async () => ({
    setupDefaultWebGpuDevice: async () => {},
  }),
  Engine: {
    create: async () => ({
      createConversation: fixture.conversation,
      delete: async () => {},
    }),
  },
}));
const model = MODELS[0]!;
const load = { id: 1, action: "load", mode: "cache-only", modelId: model.id };

beforeEach(() => vi.clearAllMocks());
afterAll(() => vi.unstubAllGlobals());

it("reports a current cache miss before any GPU preflight or model fetch", async () => {
  fixture.match.mockResolvedValueOnce(undefined);
  await fixture.port.onmessage!({ data: load });
  expect(fixture.match).toHaveBeenCalledWith(modelURL(model), {
    cacheName: LITERT_CACHE,
  });
  expect(fixture.port.postMessage).toHaveBeenCalledWith({
    id: load.id,
    done: true,
    error: expect.objectContaining({ code: "model_not_cached" }),
  });
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(fixture.inspect).not.toHaveBeenCalled();
});

it("serves a pre-deploy tab's load and generation without attributing its references", async () => {
  fixture.match.mockResolvedValueOnce(
    new Response(new Uint8Array([0]), {
      headers: { "Content-Length": String(model.bytes) },
    }),
  );
  await fixture.port.onmessage!({
    data: { id: 1, action: "load", modelId: model.id },
  });
  expect(fixture.port.postMessage).toHaveBeenLastCalledWith({
    id: 1,
    done: true,
    result: { loadMs: expect.any(Number) },
  });

  await fixture.port.onmessage!({
    data: {
      id: 2,
      action: "generate",
      characterId: "Arona",
      messages: [{ role: "user", content: "기억나?" }],
      memories: [{ id: "memory", text: "금요일 독서 모임" }],
      excerpts: [{ id: "excerpt", text: "열람실 17번 좌석" }],
      maxTokens: 256,
    },
  });
  const [{ content }] = fixture.send.mock.calls[0]!;
  expect(content).toContain('출처 미확인 인용: "금요일 독서 모임"');
  expect(content).toContain('출처 미확인 인용: "열람실 17번 좌석"');
  expect(content).not.toContain("사용자 확인 기억");
  expect(fixture.port.postMessage).toHaveBeenLastCalledWith({
    id: 2,
    done: true,
    result: expect.objectContaining({ text: "답변" }),
  });
});

it("passes quoted references in the actual final user message and rejects over-budget input before LiteRT", async () => {
  fixture.match.mockResolvedValueOnce(
    new Response(new Uint8Array([0]), {
      headers: { "Content-Length": String(model.bytes) },
    }),
  );
  await fixture.port.onmessage!({ data: load });
  const question = "기억나?";
  const note = "금요일 독서 모임";
  await fixture.port.onmessage!({
    data: {
      id: 2,
      action: "generate",
      characterId: "Arona",
      messages: [{ role: "user", content: question }],
      memories: [{ id: "saved", kind: "user-confirmed", text: note }],
      maxTokens: 128,
    },
  });
  const [sent] = fixture.send.mock.calls[0]!;
  expect(sent.role).toBe("user");
  expect(sent.content).toContain(note);
  expect(sent.content).toContain(question);
  expect(fixture.fetch).not.toHaveBeenCalled();

  const content = "x".repeat(1500);
  await fixture.port.onmessage!({
    data: {
      id: 3,
      action: "generate",
      messages: ["user", "assistant", "user"].map((role) => ({
        role,
        content,
      })),
      maxTokens: 128,
    },
  });
  expect(fixture.port.postMessage).toHaveBeenLastCalledWith({
    id: 3,
    done: true,
    error: expect.objectContaining({ message: expect.any(String) }),
  });
  expect(fixture.conversation).toHaveBeenCalledOnce();
});
