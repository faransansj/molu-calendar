import { describe, expect, it, vi } from "vitest";
import {
  deleteModelCaches,
  inspectModelCaches,
  loadModelStream,
} from "./model-cache.ts";
import { LITERT_CACHE, MODELS, modelURL } from "./models.ts";

const model = { ...MODELS[0]!, bytes: 4 };
const url = modelURL(model);
function cacheFixture() {
  const entries = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; headers: Headers; body?: boolean }
  >();
  const cache = {
    match: vi.fn(async (key: string) => {
      const entry = entries.get(key);
      return entry
        ? new Response(entry.body === false ? null : entry.bytes, {
            headers: entry.headers,
          })
        : undefined;
    }),
    put: vi.fn(async (key: string, response: Response) => {
      entries.set(key, {
        bytes: new Uint8Array(await response.arrayBuffer()),
        headers: response.headers,
      });
    }),
    delete: vi.fn(async (key: string | Request) =>
      entries.delete(typeof key === "string" ? key : key.url),
    ),
    keys: vi.fn(async () => [...entries.keys()].map((key) => new Request(key))),
  };
  const caches = {
    keys: async () => [LITERT_CACHE],
    open: async () => cache,
  } as unknown as CacheStorage;
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(new Uint8Array([1, 2, 3, 4])),
  );
  const seed = (key = url, length = model.bytes, body = true) =>
    entries.set(key, {
      bytes: new Uint8Array([1, 2, 3, 4]),
      headers: new Headers({ "Content-Length": String(length) }),
      body,
    });
  return { entries, cache, caches, fetch, seed };
}
async function bytes(stream: ReadableStream<Uint8Array>) {
  return [...new Uint8Array(await new Response(stream).arrayBuffer())];
}

describe("model cache stream boundary (not GPU inference)", () => {
  it("waits for EOF and cache commit, then reuses the identical bytes without a fetch or estimate", async () => {
    const fixture = cacheFixture();
    const { promise: commit, resolve: finish } = Promise.withResolvers<void>();
    const originalPut = fixture.cache.put.getMockImplementation()!;
    fixture.cache.put.mockImplementation(async (key, response) => {
      await commit;
      await originalPut(key, response);
    });
    const emit = vi.fn();
    let resolved = false;
    const loading = loadModelStream(model, emit, fixture).then((stream) => {
      resolved = true;
      return stream;
    });
    await vi.waitFor(() => expect(fixture.cache.put).toHaveBeenCalledOnce());
    expect(resolved).toBe(false);
    expect(fixture.entries.has(url)).toBe(false);
    finish();
    expect(await bytes(await loading)).toEqual([1, 2, 3, 4]);
    expect(emit).toHaveBeenCalledWith("progress", {
      progress: 1,
      text: "모델 저장을 마무리하고 있어요",
    });
    fixture.fetch.mockClear();
    const estimate = vi.fn(async () => ({ quota: 1, usage: 1 }));
    expect(
      await bytes(
        await loadModelStream(model, emit, {
          ...fixture,
          storage: { estimate },
        }),
      ),
    ).toEqual([1, 2, 3, 4]);
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(estimate).not.toHaveBeenCalled();
  });

  it.each([3, 5])(
    "rejects %i downloaded bytes instead of publishing an incomplete model",
    async (size) => {
      const fixture = cacheFixture();
      fixture.fetch.mockResolvedValue(new Response(new Uint8Array(size)));
      await expect(
        loadModelStream(model, () => {}, fixture),
      ).rejects.toMatchObject({ code: "model_size_mismatch" });
      expect(fixture.entries.has(url)).toBe(false);
    },
  );

  it("preserves an original reader failure even when put reports a different exception", async () => {
    const fixture = cacheFixture();
    const cause = new Error("connection reset during read");
    let reads = 0;
    fixture.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
            else controller.error(cause);
          },
        }),
      ),
    );
    fixture.cache.put.mockImplementation(async (_key, response) => {
      try {
        await response.arrayBuffer();
      } catch {
        throw new TypeError("Cache.put network error");
      }
    });
    await expect(
      loadModelStream(model, () => {}, fixture),
    ).rejects.toMatchObject({ code: "download_failed", cause });
    expect(fixture.entries.has(url)).toBe(false);
  });

  it.each([
    [new DOMException("quota", "QuotaExceededError"), "storage_low"],
    [new TypeError("Cache.put network error"), "cache_write_failed"],
  ])(
    "classifies put failure %s independently of bytes received",
    async (cause, code) => {
      const fixture = cacheFixture();
      const cancelled = vi.fn();
      fixture.fetch.mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel: cancelled,
          }),
        ),
      );
      fixture.cache.put.mockImplementation(async (key, response) => {
        fixture.seed(key);
        const sink = response.body!.getReader();
        await sink.read();
        const pendingRead = sink.read();
        await Promise.resolve();
        await sink.cancel(cause);
        await pendingRead;
        throw cause;
      });
      await expect(
        loadModelStream(model, () => {}, fixture),
      ).rejects.toMatchObject({ code, cause });
      expect(cancelled).toHaveBeenCalled();
      expect(fixture.entries.has(url)).toBe(false);
    },
  );

  it.each([
    new Error("offline"),
    new Response(null, { status: 503 }),
    new Response(null),
  ])(
    "classifies fetch rejection, HTTP failure and missing body",
    async (result) => {
      const fixture = cacheFixture();
      if (result instanceof Error) fixture.fetch.mockRejectedValue(result);
      else fixture.fetch.mockResolvedValue(result);
      await expect(
        loadModelStream(model, () => {}, fixture),
      ).rejects.toMatchObject({
        code: "download_failed",
        cause: expect.any(Error),
      });
      expect(fixture.entries.has(url)).toBe(false);
    },
  );

  it("rejects insufficient origin quota before fetching, but proceeds when estimation fails", async () => {
    const fixture = cacheFixture();
    const estimate = vi.fn(async () => ({
      quota: 512 * 1024 * 1024 + model.bytes - 1,
      usage: 0,
    }));
    await expect(
      loadModelStream(model, () => {}, { ...fixture, storage: { estimate } }),
    ).rejects.toMatchObject({ code: "storage_low" });
    expect(fixture.fetch).not.toHaveBeenCalled();
    estimate.mockRejectedValue(new Error("private storage estimate"));
    expect(
      await bytes(
        await loadModelStream(model, () => {}, {
          ...fixture,
          storage: { estimate },
        }),
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it.each([0, 3])("replaces invalid cached length %i", async (length) => {
    const fixture = cacheFixture();
    fixture.seed(url, length);
    expect(
      await bytes(await loadModelStream(model, () => {}, fixture)),
    ).toEqual([1, 2, 3, 4]);
    expect(fixture.cache.delete).toHaveBeenCalledWith(url);
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it("inspects only matching metadata with a body and never mutates entries", async () => {
    const fixture = cacheFixture();
    fixture.seed(url, 3);
    expect(await inspectModelCaches(fixture)).toEqual({
      counts: { [model.id]: 0 },
      bytes: { [model.id]: 0 },
    });
    fixture.seed(url, MODELS[0]!.bytes, false);
    expect((await inspectModelCaches(fixture)).counts[model.id]).toBe(0);
    fixture.seed(url, MODELS[0]!.bytes);
    expect(await inspectModelCaches(fixture)).toEqual({
      counts: { [model.id]: 1 },
      bytes: { [model.id]: MODELS[0]!.bytes },
    });
    expect(fixture.cache.delete).not.toHaveBeenCalled();
  });

  it("deletes only the same repository/model across revisions", async () => {
    const fixture = cacheFixture();
    fixture.seed();
    fixture.seed(modelURL({ ...model, revision: "previous-revision" }));
    const unrelated = [
      modelURL({ ...model, id: "other-model" }),
      url.replace("/litert-community/", "/other-owner/"),
      url.replace("huggingface.co", "example.com"),
      url.replace("/resolve/", "/other/"),
      `${url}/extra`,
      url.replace(`${model.id}.litertlm`, `${model.id}.litertlm.backup`),
    ];
    for (const key of unrelated) fixture.seed(key);
    expect(await deleteModelCaches({ ...fixture, modelId: model.id })).toEqual({
      counts: { [model.id]: 0 },
      bytes: { [model.id]: 0 },
    });
    expect([...fixture.entries.keys()]).toEqual(unrelated);
  });
});
