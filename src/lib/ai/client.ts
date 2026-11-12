import {
  MODELS,
  ENGINE_NAMES,
  MODEL_CATALOG_VERSION,
  errorWithCode,
  runtimeCompatibility,
} from "./models.ts";
import type { EngineKind, GPUAdapterView } from "./models.ts";
import {
  parseWorkerReply,
  parseWorkerResult,
  errorMessage,
} from "./protocol.ts";
import type {
  AIEvent,
  AIClient,
  WorkerAction,
  WorkerPayloads,
  WorkerResults,
  RequestOptions,
} from "./protocol.ts";
export type { AIClient, AIEvent } from "./protocol.ts";
interface EnvironmentNavigator {
  userAgent?: string;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  storage?: Pick<StorageManager, "estimate">;
  gpu?: {
    requestAdapter(options: {
      powerPreference: "high-performance";
    }): Promise<GPUAdapterView | null>;
  };
}
export interface Environment {
  supported: boolean;
  browser: string;
  gpu: string;
  vram: null;
  vramReason: string;
  memoryGB: number | null;
  memoryReason: string | null;
  cores: number | null;
  features: string[];
  limits: Record<string, number | undefined>;
  engines: Partial<
    Record<EngineKind, { supported: boolean; reason: string | null }>
  >;
  storage?: StorageEstimate | null;
  reason?: string | null;
  fingerprint?: string;
}
interface Pending {
  id: number;
  action: WorkerAction;
  modelId?: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  onEvent: (event: AIEvent) => void;
  firstMs: number;
  started: boolean;
  timer: ReturnType<typeof setTimeout>;
  firstTimer?: ReturnType<typeof setTimeout>;
}

export async function inspectEnvironment(
  nav: EnvironmentNavigator = navigator as EnvironmentNavigator,
  secure = isSecureContext,
) {
  const ua = nav.userAgent ?? "";
  const browser = /Firefox\//.test(ua)
    ? "Firefox"
    : /Safari\//.test(ua) && !/Chrome\//.test(ua)
      ? "Safari"
      : /Edg\//.test(ua)
        ? "Edge"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : "확인 불가";
  const result: Environment = {
    supported: false,
    browser,
    gpu: "확인 불가",
    vram: null,
    vramReason:
      "브라우저 API는 설치된 VRAM 용량과 남은 GPU 메모리를 공개하지 않습니다. 모델 추정치와 저장 여유로 판단해 주세요.",
    memoryGB: nav.deviceMemory ?? null,
    memoryReason: nav.deviceMemory
      ? null
      : "이 브라우저가 시스템 RAM 용량을 공개하지 않았습니다 (Safari/Firefox는 미지원).",
    cores: nav.hardwareConcurrency ?? null,
    features: [],
    limits: {},
    engines: {},
  };
  try {
    const storage = await nav.storage?.estimate();
    result.storage = storage
      ? { quota: storage.quota, usage: storage.usage }
      : null;
  } catch {
    result.storage = null;
  }
  if (!secure) result.reason = "HTTPS 또는 localhost에서 열어 주세요.";
  else if (!nav.gpu)
    result.reason =
      "이 브라우저에서 WebGPU를 사용할 수 없습니다. GPU 가속이 켜진 최신 Chrome/Edge를 확인해 주세요.";
  else {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let adapter;
      try {
        adapter = await Promise.race([
          nav.gpu.requestAdapter({ powerPreference: "high-performance" }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("GPU 확인 시간 초과. 다시 확인해 주세요.")),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!adapter)
        result.reason =
          "사용 가능한 GPU 어댑터가 없습니다. 브라우저 GPU 가속과 드라이버를 확인해 주세요.";
      else {
        const info = adapter.info;
        result.gpu =
          [info?.vendor, info?.architecture, info?.description]
            .filter(Boolean)
            .join(" · ") || "GPU 정보 비공개";
        result.features = [...adapter.features];
        result.limits = Object.fromEntries(
          ["maxStorageBufferBindingSize", "maxBufferSize"].map((key) => [
            key,
            adapter.limits?.[key],
          ]),
        );
        for (const engine of Object.keys(ENGINE_NAMES) as EngineKind[]) {
          const reason = runtimeCompatibility(adapter);
          result.engines[engine] = { supported: reason === null, reason };
        }
        result.supported = Object.values(result.engines).some(
          (engine) => engine.supported,
        );
        result.reason = result.supported ? null : result.engines.litert?.reason;
      }
    } catch (error) {
      result.reason = `GPU 확인 실패: ${errorMessage(error).slice(0, 160)}`;
    }
  }
  result.fingerprint = JSON.stringify([
    MODEL_CATALOG_VERSION,
    MODELS.map((model) => [model.id, model.revision]),
    nav.userAgent,
    result.gpu,
    result.features.slice().sort(),
    result.limits,
  ]);
  return result;
}

// A single worker owns a single model. Termination also cancels stalled GPU/download work.
export class LocalAIClient implements AIClient {
  workerFactory: () => Worker;
  worker: Worker | null;
  pending: Pending | null;
  nextId: number;
  loaded: string | null;
  // LiteRT's pinned loader uses importScripts, so this bundle must be a classic Worker.
  constructor(
    workerFactory = () =>
      new Worker(
        new URL(
          `${(import.meta.env?.BASE_URL ?? "/").replace(/\/?$/, "/")}local-ai-worker.bundle.js`,
          globalThis.location.href,
        ),
      ),
  ) {
    this.workerFactory = workerFactory;
    this.worker = null;
    this.pending = null;
    this.nextId = 0;
    this.loaded = null;
  }
  request(
    action: "cache",
    payload?: WorkerPayloads["cache"],
    options?: RequestOptions,
  ): Promise<WorkerResults["cache"]>;
  request<K extends WorkerAction>(
    action: K,
    payload: WorkerPayloads[K],
    options?: RequestOptions,
  ): Promise<WorkerResults[K]>;
  request<K extends WorkerAction>(
    action: K,
    payload?: WorkerPayloads[K],
    {
      onEvent = () => {},
      firstMs = 0,
      timeoutMs = 60000,
      timeoutCode = "operation_timeout",
    }: RequestOptions = {},
  ): Promise<WorkerResults[K]> {
    if (this.pending)
      return Promise.reject(
        errorWithCode("busy", "이미 실행 중인 작업이 있습니다."),
      );
    if (!this.worker) {
      try {
        this.worker = this.workerFactory();
        this.worker.onmessage = ({ data: raw }: MessageEvent<unknown>) => {
          const pending = this.pending;
          if (
            !pending ||
            !raw ||
            typeof raw !== "object" ||
            !("id" in raw) ||
            raw.id !== pending.id
          )
            return;
          let data;
          try {
            data = parseWorkerReply(raw);
          } catch (error) {
            this.stop(error);
            return;
          }
          if ("event" in data) {
            if (data.event === "started" && !pending.started) {
              pending.started = true;
              if (pending.firstMs)
                pending.firstTimer = setTimeout(
                  () =>
                    this.stop(
                      errorWithCode(
                        "first_timeout",
                        `첫 답변이 ${Math.ceil(pending.firstMs / 1000)}초 안에 시작되지 않았어요. 다시 시도해 주세요.`,
                      ),
                    ),
                  pending.firstMs,
                );
            }
            if (data.event === "token" && data.text?.trim()) {
              pending.started = true;
              clearTimeout(pending.firstTimer);
            }
            pending.onEvent(data);
          } else if ("done" in data) {
            this.pending = null;
            clearTimeout(pending.timer);
            clearTimeout(pending.firstTimer);
            if ("error" in data)
              pending.reject(
                errorWithCode(data.error.code || "runtime", data.error.message),
              );
            else {
              try {
                const result = parseWorkerResult(pending.action, data.result);
                if (pending.action === "load")
                  this.loaded = pending.modelId ?? null;
                else if (
                  pending.action === "delete" &&
                  this.loaded === pending.modelId
                )
                  this.loaded = null;
                pending.resolve(result);
              } catch (error) {
                pending.reject(error);
              }
            }
          }
        };
        const failed = () =>
          this.stop(
            errorWithCode(
              "worker",
              "실행 Worker가 종료되었습니다. 다시 로드해 주세요.",
            ),
          );
        this.worker.onerror = failed;
        this.worker.onmessageerror = failed;
      } catch (error) {
        this.worker = null;
        return Promise.reject(error);
      }
    }
    return new Promise<WorkerResults[K]>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(
        () =>
          this.stop(
            errorWithCode(
              timeoutCode,
              action === "generate"
                ? "답변 생성 시간이 초과됐어요. 다시 시도해 주세요."
                : "작업 시간 제한을 초과했습니다. 다운로드·초기화 또는 생성 상태를 확인해 주세요.",
            ),
          ),
        timeoutMs,
      );
      this.pending = {
        id,
        action,
        modelId: payload && "modelId" in payload ? payload.modelId : undefined,
        resolve: (value) => resolve(value as WorkerResults[K]),
        reject,
        onEvent,
        firstMs,
        started: false,
        timer,
      };
      try {
        this.worker!.postMessage({ id, action, ...payload });
      } catch (error) {
        this.stop(error);
      }
    });
  }
  stop(
    error: unknown = errorWithCode(
      "cancelled",
      "작업을 취소했습니다. 이미 받은 파일은 캐시에 남을 수 있습니다.",
    ),
  ) {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      clearTimeout(pending.firstTimer);
      pending.reject(error);
    }
  }
}
