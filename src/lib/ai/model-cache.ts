import { LITERT_CACHE, MODELS, errorWithCode, modelURL } from "./models.ts";
import type { Model } from "./models.ts";
import type { AIEvent, CacheResult, EventValue, LoadMode } from "./protocol.ts";

interface CacheOptions {
  caches?: CacheStorage;
}

interface ArtifactLocks {
  request<T>(name: string, task: () => Promise<T>): Promise<T>;
}

// Deletion covers every revision of this artifact. Writers in other tabs and
// Workers must use the same name even when their pinned revisions differ.
function withArtifactLock<T>(
  model: Model,
  locks: ArtifactLocks | undefined,
  task: () => Promise<T>,
) {
  if (!locks)
    throw new Error("이 브라우저에서 모델 저장 잠금을 사용할 수 없습니다.");
  return locks.request(`${LITERT_CACHE}:${model.id}`, task);
}

// Metadata only: this does not re-read or hash the complete cached artifact.
function validResponse(
  response: Response | undefined,
  model: Model,
): response is Response & { body: ReadableStream<Uint8Array> } {
  return (
    !!response?.body &&
    Number(response.headers.get("content-length")) === model.bytes
  );
}

export async function inspectModelCaches({
  caches: cacheStorage = globalThis.caches,
}: CacheOptions = {}): Promise<CacheResult> {
  const counts = Object.fromEntries(MODELS.map((model) => [model.id, 0]));
  const bytes = Object.fromEntries(MODELS.map((model) => [model.id, 0]));
  if (!cacheStorage)
    throw new Error("이 브라우저에서 모델 캐시를 사용할 수 없습니다.");
  if (!(await cacheStorage.keys()).includes(LITERT_CACHE))
    return { counts, bytes };
  const cache = await cacheStorage.open(LITERT_CACHE);
  for (const model of MODELS) {
    const response = await cache.match(modelURL(model));
    if (!validResponse(response, model)) continue;
    counts[model.id] = 1;
    bytes[model.id] = model.bytes;
  }
  return { counts, bytes };
}

export async function deleteModelCaches({
  caches: cacheStorage = globalThis.caches,
  locks = globalThis.navigator?.locks,
  modelId,
}: CacheOptions & {
  modelId: string;
  locks?: ArtifactLocks;
}): Promise<CacheResult> {
  const model = MODELS.find((item) => item.id === modelId);
  if (!model) throw new Error("지원하지 않는 모델입니다.");
  if (!cacheStorage)
    throw new Error("이 브라우저에서 모델 캐시를 사용할 수 없습니다.");
  await withArtifactLock(model, locks, async () => {
    if (!(await cacheStorage.keys()).includes(LITERT_CACHE)) return;
    const cache = await cacheStorage.open(LITERT_CACHE);
    const current = new URL(modelURL(model));
    const repository = current.pathname.slice(
      0,
      current.pathname.indexOf("/resolve/"),
    );
    for (const request of await cache.keys()) {
      const candidate = new URL(request.url);
      const parts = candidate.pathname.slice(repository.length).split("/");
      if (
        candidate.origin === current.origin &&
        candidate.pathname.startsWith(`${repository}/resolve/`) &&
        parts.length === 4 &&
        parts[1] === "resolve" &&
        parts[2] &&
        parts[3] === `${model.id}.litertlm`
      )
        await cache.delete(request);
    }
  });
  return inspectModelCaches({ caches: cacheStorage });
}

const messages = {
  model_not_cached: "설정에서 먼저 로컬 AI 모델을 준비해 주세요.",
  storage_low:
    "모델을 저장할 공간이 부족해요. 기기 저장 공간을 확보한 뒤 다시 시도해 주세요.",
  download_failed:
    "모델을 다운로드하지 못했어요. 네트워크 연결을 확인하고 다시 시도해 주세요.",
  model_size_mismatch:
    "다운로드 모델 크기가 고정된 파일 정보와 다릅니다. 다시 시도해 주세요.",
  cache_write_failed:
    "모델 파일을 브라우저에 저장하지 못했어요. 기기 저장 공간을 확보하거나 모델 파일을 삭제한 뒤 다시 시도해 주세요.",
};
const failure = (code: keyof typeof messages, cause?: unknown) =>
  Object.assign(errorWithCode(code, messages[code]), { cause });

export async function loadModelStream(
  model: Model,
  emit: (event: AIEvent["event"], value?: EventValue) => void,
  {
    mode,
    caches: cacheStorage = globalThis.caches,
    fetch: fetchModel = globalThis.fetch,
    storage = globalThis.navigator?.storage,
    locks = globalThis.navigator?.locks,
  }: CacheOptions & {
    mode: LoadMode;
    fetch?: typeof globalThis.fetch;
    storage?: Pick<StorageManager, "estimate">;
    locks?: ArtifactLocks;
  },
): Promise<ReadableStream<Uint8Array>> {
  if (!cacheStorage)
    throw new Error("이 브라우저에서 모델 캐시를 사용할 수 없습니다.");
  const url = modelURL(model);
  // CacheStorage.match does not even create an empty named cache on a miss.
  if (mode === "cache-only") {
    const cached = await cacheStorage.match(url, { cacheName: LITERT_CACHE });
    if (!validResponse(cached, model)) throw failure("model_not_cached");
    return cached.body;
  }
  return withArtifactLock(model, locks, async () => {
    const cache = await cacheStorage.open(LITERT_CACHE);
    return downloadOrReuse(cache, model, url, emit, fetchModel, storage);
  });
}

async function downloadOrReuse(
  cache: Cache,
  model: Model,
  url: string,
  emit: (event: AIEvent["event"], value?: EventValue) => void,
  fetchModel: typeof globalThis.fetch,
  storage: Pick<StorageManager, "estimate"> | undefined,
) {
  const cached = await cache.match(url);
  if (validResponse(cached, model)) return cached.body;
  if (cached) await cache.delete(url);

  let estimate: StorageEstimate | undefined;
  try {
    estimate = await storage?.estimate();
  } catch {
    /* Unavailable estimates must not block downloads. */
  }
  // Origin quota is not a measurement of free physical disk space.
  if (
    typeof estimate?.quota === "number" &&
    Number.isFinite(estimate.quota) &&
    typeof estimate.usage === "number" &&
    Number.isFinite(estimate.usage) &&
    estimate.quota - estimate.usage < model.bytes + 512 * 1024 * 1024
  )
    throw failure("storage_low");

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let downloadError: Error | undefined;
  let putFailed = false;
  let complete = false;
  try {
    let download: Response;
    try {
      download = await fetchModel(url, { credentials: "omit" });
      if (!download.ok || !download.body)
        throw new Error(
          `모델 다운로드 HTTP ${download.status} (body: ${!!download.body})`,
        );
    } catch (cause) {
      throw failure("download_failed", cause);
    }
    reader = download.body!.getReader();
    const source = reader;
    let received = 0;
    let reported = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await source.read();
        } catch (cause) {
          if (!putFailed) downloadError = failure("download_failed", cause);
          controller.error(downloadError ?? cause);
          return;
        }
        if (putFailed) return;
        if (chunk.done) {
          if (received !== model.bytes) {
            downloadError = failure("model_size_mismatch");
            controller.error(downloadError);
          } else {
            complete = true;
            controller.close();
          }
          return;
        }
        received += chunk.value.byteLength;
        if (received > model.bytes) {
          downloadError = failure("model_size_mismatch");
          controller.error(downloadError);
          return;
        }
        if (performance.now() - reported > 200 || received === model.bytes) {
          emit("progress", {
            progress: received / model.bytes,
            text:
              received === model.bytes
                ? "모델 저장을 마무리하고 있어요"
                : `모델 다운로드 ${(received / 1e9).toFixed(2)} / ${(model.bytes / 1e9).toFixed(2)} GB`,
          });
          reported = performance.now();
        }
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        // Cache.put may cancel its input before rejecting. That is not a download EOF/error.
        putFailed = true;
        return source.cancel(reason);
      },
    });
    // Avoid a whole-model JS buffer and clone/tee. Cache API may still stage Blobs on disk.
    try {
      await cache.put(
        url,
        new Response(body, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(model.bytes),
          },
        }),
      );
    } catch (cause) {
      putFailed = true;
      if (downloadError) throw downloadError;
      if (cause instanceof Error && cause.name === "QuotaExceededError")
        throw failure("storage_low", cause);
      throw failure("cache_write_failed", cause);
    }
    let response: Response | undefined;
    try {
      response = await cache.match(url);
    } catch (cause) {
      throw failure("cache_write_failed", cause);
    }
    if (!complete || !validResponse(response, model)) {
      // Only this successful put could have created the invalid entry: the
      // model lock is still held. Rejected puts are atomic and need no delete.
      await cache.delete(url).catch(() => {});
      throw failure(
        "cache_write_failed",
        new Error("캐시 저장 완료를 확인하지 못했습니다."),
      );
    }
    return response.body;
  } catch (error) {
    putFailed = true;
    try {
      await reader?.cancel();
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  }
}
