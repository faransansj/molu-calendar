import {
  Engine as LiteRTEngine,
  Backend,
  getOrLoadGlobalLiteRtLm,
} from "@litert-lm/core";
import {
  MODEL_CONTEXT,
  LITERT_ASSET_PATH,
  LITERT_CACHE,
  modelURL,
  modelById,
  errorWithCode,
} from "../lib/ai/models.ts";
import {
  chatMessagesWithReferences,
  normalizeMemories,
  normalizeExcerpts,
  referenceChars,
} from "../lib/ai/persona.ts";
import {
  inspectEnvironment,
  inspectModelCaches,
  deleteModelCaches,
} from "../lib/ai/client.ts";

import type { Model } from "../lib/ai/models.ts";
import type { PromptMessage } from "../lib/chat/types.ts";
import {
  parseWorkerRequest,
  errorCode,
  errorMessage,
} from "../lib/ai/protocol.ts";
import type {
  AIEvent,
  EventValue,
  WorkerRequest,
  WorkerResults,
} from "../lib/ai/protocol.ts";
declare const self: DedicatedWorkerGlobalScope & {
  Module?: { locateFile(name: string): string };
};

let engine: LiteRTEngine | null = null;
let loaded: string | null = null;
let liteRuntime:
  Awaited<ReturnType<typeof getOrLoadGlobalLiteRtLm>> | undefined;

async function unload() {
  await engine?.delete();
  engine = null;
  loaded = null;
}

async function liteModelStream(
  model: Model,
  emit: (event: AIEvent["event"], value?: EventValue) => void,
) {
  if (!globalThis.caches)
    throw new Error("이 브라우저에서 모델 캐시를 사용할 수 없습니다.");
  const cache = await caches.open(LITERT_CACHE);
  const url = modelURL(model);
  let response = await cache.match(url);
  if (!response) {
    const download = await fetch(url, { credentials: "omit" });
    if (!download.ok || !download.body)
      throw new Error(`모델 다운로드 HTTP ${download.status}`);
    let received = 0;
    let reported = 0;
    const body = download.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > model.bytes)
            throw new Error(
              "다운로드 모델 크기가 고정된 파일 정보와 다릅니다.",
            );
          if (performance.now() - reported > 200 || received === model.bytes) {
            emit("progress", {
              progress: received / model.bytes,
              text: `모델 다운로드 ${(received / 1e9).toFixed(2)} / ${(model.bytes / 1e9).toFixed(2)} GB`,
            });
            reported = performance.now();
          }
          controller.enqueue(chunk);
        },
        flush() {
          if (received !== model.bytes)
            throw new Error(
              "모델 다운로드가 완료되지 않았습니다. 다시 시도해 주세요.",
            );
        },
      }),
    );
    // Stream directly to disk, then read the cache. clone()/tee() would buffer GBs for the slower reader.
    await cache.put(
      url,
      new Response(body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(model.bytes),
        },
      }),
    );
    response = await cache.match(url);
  }
  if (!response?.body)
    throw new Error(
      "저장된 모델을 읽을 수 없습니다. 캐시를 삭제하고 다시 시도해 주세요.",
    );
  return response.body;
}

self.onmessage = async ({ data: raw }: MessageEvent<unknown>) => {
  let data: WorkerRequest;
  try {
    data = parseWorkerRequest(raw);
  } catch (error) {
    const id = raw && typeof raw === "object" && "id" in raw ? raw.id : null;
    self.postMessage({
      id,
      done: true,
      error: { message: errorMessage(error).slice(0, 500) },
    });
    return;
  }
  const { id } = data;
  const modelId = "modelId" in data ? data.modelId : undefined;
  const emit = (event: AIEvent["event"], value: EventValue = {}) =>
    self.postMessage({ id, event, ...value });
  try {
    let result: WorkerResults[keyof WorkerResults];
    if (data.action === "cache") result = await inspectModelCaches();
    else if (data.action === "delete") {
      if (loaded === modelId) await unload();
      result = await deleteModelCaches({ modelId: data.modelId });
    } else if (data.action === "load") {
      const model = modelById(modelId);
      if (!model) throw new Error("지원하지 않는 모델입니다.");
      // The Worker's adapter may differ from the page's adapter. Check the selected engine only.
      const environment = await inspectEnvironment();
      const runtime = environment.engines[model.engine];
      if (!runtime?.supported)
        throw errorWithCode(
          "webgpu_unsupported",
          runtime?.reason ??
            environment.reason ??
            "WebGPU 실행 환경을 확인해 주세요.",
        );
      await unload();
      const started = performance.now();
      {
        emit("progress", {
          progress: 0.02,
          text: "LiteRT-LM 실행 파일·WebGPU 초기화 중 (모델 다운로드 전)",
        });
        if (!liteRuntime) {
          const assetURL = new URL(
            `./${LITERT_ASSET_PATH.replace(/^\//, "")}`,
            self.location.href,
          ).href;
          // Emscripten otherwise locates WASM beside the Worker, not beside the imported script.
          self.Module = { locateFile: (name) => new URL(name, assetURL).href };
          liteRuntime = await getOrLoadGlobalLiteRtLm(assetURL);
        }
        await liteRuntime.setupDefaultWebGpuDevice();
        const stream = await liteModelStream(model, (event, value = {}) =>
          emit(
            event,
            event === "progress" &&
              typeof value.progress === "number" &&
              Number.isFinite(value.progress)
              ? { ...value, progress: 0.1 + value.progress * 0.8 }
              : value,
          ),
        );
        emit("progress", {
          progress: 0.95,
          text: "캐시에서 GPU로 모델 준비 중 · 다운로드 완료",
        });
        engine = await LiteRTEngine.create({
          model: stream,
          backend: Backend.GPU_ARTISAN,
          benchmarkEnabled: true,
          mainExecutorSettings: { maxNumTokens: MODEL_CONTEXT },
        });
      }
      loaded = data.modelId;
      result = { loadMs: performance.now() - started };
    } else if (data.action === "generate") {
      if (!engine || !loaded) throw new Error("먼저 모델을 로드해 주세요.");
      const { messages, maxTokens } = data;
      if (
        !Array.isArray(messages) ||
        !messages.length ||
        messages.length > 9 ||
        messages.some(
          (message) =>
            !message ||
            !["user", "assistant"].includes(message.role) ||
            typeof message.content !== "string" ||
            message.content.length > 2000,
        ) ||
        messages.at(-1)!.role !== "user" ||
        messages.reduce((sum, message) => sum + message.content.length, 0) >
          6000 ||
        !Number.isInteger(maxTokens) ||
        maxTokens < 1 ||
        maxTokens > 256
      )
        throw new Error("테스트 입력이 허용 범위를 벗어났습니다.");
      // Only a built-in persona can become a system message, and its few-shot examples come from the dataset.
      // A client cannot supply its own system prompt or examples.
      let chatMessages: PromptMessage[] = messages;
      if (data.characterId !== undefined) {
        const memories = normalizeMemories(data.memories);
        const excerpts = normalizeExcerpts(data.excerpts);
        const assembled = chatMessagesWithReferences(
          data.characterId,
          messages,
          memories,
          excerpts,
        );
        if (!assembled) throw new Error("지원하지 않는 테스트 캐릭터입니다.");
        chatMessages = assembled;
        emit("trace", {
          characterId: data.characterId,
          messageChars: messages.reduce(
            (sum, message) => sum + message.content.length,
            0,
          ),
          memories: memories.length,
          excerpts: excerpts.length,
          referenceChars: referenceChars(memories, excerpts),
          promptChars: chatMessages.reduce(
            (sum, message) => sum + message.content.length,
            0,
          ),
        });
      }
      const started = performance.now();
      let ttftMs: number | null = null;
      let text = "";
      let tokens: number | undefined;
      let tokensPerSecond: number | undefined;
      const output = (value: string) => {
        text = value;
        if (ttftMs === null && text.trim())
          ttftMs = performance.now() - started;
        if (text.trim()) emit("token", { text });
      };
      emit("started");
      {
        const conversation = await engine.createConversation({
          sessionConfig: {
            maxOutputTokens: maxTokens,
            samplerParams: { seed: 42, temperature: 0.6, p: 0.9 },
          },
          preface: {
            messages: chatMessages
              .slice(0, -1)
              .map(({ role, content }) => ({ role, content })),
            extra_context: { enable_thinking: false },
          },
          prefillPrefaceOnInit: false,
        });
        try {
          for await (const chunk of conversation.sendMessageStreaming({
            ...messages.at(-1)!,
          })) {
            const delta =
              typeof chunk.content === "string"
                ? chunk.content
                : Array.isArray(chunk.content)
                  ? chunk.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("")
                  : "";
            // Reasoning channels and tool calls are not visible answers or executable actions.
            if (delta) output(text + delta);
          }
          const info = await conversation.getBenchmarkInfo();
          tokens = info.lastDecodeTokenCount;
          tokensPerSecond = info.lastDecodeTokensPerSecond;
        } finally {
          await conversation.delete();
        }
      }
      if (ttftMs === null || !text.trim())
        throw errorWithCode("empty_output", "빈 답변이 생성되었습니다.");
      result = {
        text,
        ttftMs,
        tokens,
        tokensPerSecond,
        elapsedMs: performance.now() - started,
      };
    } else throw new Error("알 수 없는 실행 요청입니다.");
    self.postMessage({ id, done: true, result });
  } catch (error) {
    self.postMessage({
      id,
      done: true,
      error: {
        code: errorCode(error),
        message: errorMessage(error).slice(0, 500),
      },
    });
  }
};
