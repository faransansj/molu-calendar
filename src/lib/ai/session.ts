import {
  MODEL_CATALOG_VERSION,
  DEFAULT_MODEL_ID,
  modelById,
  errorWithCode,
} from "./models.ts";
import { LocalAIClient } from "./client.ts";

import type {
  AIClient,
  WorkerAction,
  WorkerPayloads,
  RequestOptions,
  WorkerResults,
} from "./protocol.ts";

interface Settings {
  modelId: string;
  momoEnabled: boolean;
  catalogVersion?: string;
}
interface Job {
  owner: string;
  error: Error | null;
}
export const AI_SETTINGS_KEY = "molu.local-ai.v1";

export class LocalAISession extends EventTarget {
  client: LocalAIClient;
  storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  settings: Settings;
  job: Job | null;
  notice: string;
  constructor(
    client = new LocalAIClient(),
    storage?: Pick<Storage, "getItem" | "setItem">,
  ) {
    super();
    this.client = client;
    this.job = null;
    this.notice = "";
    let raw: unknown;
    try {
      this.storage = storage ?? globalThis.localStorage;
      raw = JSON.parse(this.storage?.getItem(AI_SETTINGS_KEY) ?? "null");
    } catch {
      /* optional storage */
    }
    const settings =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    this.settings = {
      ...settings,
      modelId:
        settings.catalogVersion === MODEL_CATALOG_VERSION &&
        typeof settings.modelId === "string" &&
        modelById(settings.modelId)
          ? settings.modelId
          : DEFAULT_MODEL_ID,
      momoEnabled: settings.momoEnabled === true,
    };
  }
  get owner() {
    return this.job?.owner ?? null;
  }
  get busy() {
    return this.job !== null;
  }
  get loaded() {
    return this.client.loaded;
  }
  get modelId() {
    return this.settings.modelId;
  }
  get momoEnabled() {
    return this.settings.momoEnabled;
  }
  get ready() {
    return this.loaded === this.modelId;
  }
  notify() {
    this.dispatchEvent(new Event("change"));
  }
  save(patch: Partial<Settings>) {
    this.settings = {
      ...this.settings,
      ...patch,
      catalogVersion: MODEL_CATALOG_VERSION,
    };
    let saved = !!this.storage;
    try {
      this.storage?.setItem(AI_SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      saved = false;
    }
    this.notify();
    return saved;
  }
  async run<T>(
    owner: string,
    task: (client: AIClient & { check(): void }) => Promise<T>,
  ): Promise<T> {
    if (this.busy)
      throw errorWithCode(
        "busy",
        "다른 로컬 AI 작업이 진행 중입니다. 완료하거나 해당 화면에서 중단해 주세요.",
      );
    const job: Job = { owner, error: null };
    this.job = job;
    this.notice = "";
    this.notify();
    const check = () => {
      if (job.error) throw job.error;
      if (this.job !== job)
        throw errorWithCode("cancelled", "종료된 로컬 AI 작업입니다.");
    };
    const client = {
      check,
      request: async <K extends WorkerAction>(
        action: K,
        payload: WorkerPayloads[K],
        options?: RequestOptions,
      ): Promise<WorkerResults[K]> => {
        check();
        const result = await this.client.request(action, payload, options);
        check();
        this.notify();
        return result;
      },
      stop: () => {
        if (this.job === job && !job.error) {
          this.client.stop();
          this.notify();
        }
      },
    };
    try {
      check();
      const result = await task(client);
      check();
      return result;
    } catch (error) {
      this.client.stop(error);
      throw error;
    } finally {
      this.job = null;
      this.notify();
    }
  }
  cancel(
    owner: string | null,
    error = errorWithCode(
      "cancelled",
      "작업을 취소했습니다. 이미 받은 파일은 캐시에 남을 수 있습니다.",
    ),
  ) {
    if (this.owner !== owner) return false;
    if (this.job) this.job.error = error;
    this.notice = error.message;
    this.client.stop(error);
    this.notify();
    return true;
  }
}

export const localAISession = new LocalAISession();
if (globalThis.document) {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden)
      localAISession.cancel(
        localAISession.owner,
        errorWithCode(
          "hidden",
          "백그라운드 전환으로 로컬 AI 작업을 취소하고 모델 메모리를 해제했습니다.",
        ),
      );
  });
  globalThis.addEventListener("pagehide", () =>
    localAISession.cancel(localAISession.owner),
  );
}
