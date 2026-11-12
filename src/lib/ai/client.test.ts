import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { LocalAIClient } from "./client.ts";
import type { WorkerRequest } from "./protocol.ts";

function setup() {
  const workers: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: Mock;
    terminate: Mock;
  }[] = [];
  const client = new LocalAIClient(() => {
    const worker = {
      onmessage: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const send = () => {
    const onEvent = vi.fn();
    const promise = client.request(
      "generate",
      { messages: [{ role: "user", content: "안녕" }], maxTokens: 256 },
      { firstMs: 60000, timeoutMs: 180000, onEvent },
    );
    const worker = workers.at(-1)!;
    const request = worker.postMessage.mock.calls.at(-1)![0] as WorkerRequest;
    const emit = (data: object, id = request.id) =>
      worker.onmessage!({ data: { id, ...data } } as MessageEvent);
    return { promise, emit, worker, onEvent, id: request.id };
  };
  return { client, send, workers };
}
const result = { text: "안녕하세요, 선생님!", ttftMs: 13200, elapsedMs: 20000 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("local AI model readiness", () => {
  it.each(["loaded-model", "other-model"])(
    "invalidates readiness only when deleting the loaded artifact (%s)",
    async (deletedModel) => {
      const { client, workers } = setup();
      const finish = (result: unknown) => {
        const worker = workers.at(-1)!;
        const request = worker.postMessage.mock.lastCall![0] as WorkerRequest;
        worker.onmessage!({
          data: { id: request.id, done: true, result },
        } as MessageEvent);
      };
      const loading = client.request("load", { modelId: "loaded-model" });
      finish({ loadMs: 1 });
      await loading;
      expect(client.loaded).toBe("loaded-model");

      const deleting = client.request("delete", { modelId: deletedModel });
      finish({ counts: {}, bytes: {} });
      await deleting;
      expect(client.loaded).toBe(
        deletedModel === "loaded-model" ? null : "loaded-model",
      );

      const reloading = client.request("load", { modelId: "loaded-model" });
      finish({ loadMs: 1 });
      await reloading;
      expect(client.loaded).toBe("loaded-model");
    },
  );
});

describe("local AI generation deadlines", () => {
  it("accepts the first token at 13.2s and a completed answer at 20s", async () => {
    const { send } = setup();
    const request = send();
    request.emit({ event: "started" });
    await vi.advanceTimersByTimeAsync(13200);
    expect(request.worker.terminate).not.toHaveBeenCalled();
    request.emit({ event: "token", text: "안녕하세요" });
    await vi.advanceTimersByTimeAsync(6800);
    request.emit({ done: true, result });
    await expect(request.promise).resolves.toEqual(result);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out at 60s despite whitespace tokens or duplicate started events", async () => {
    const { send } = setup();
    const request = send();
    const rejected = expect(request.promise).rejects.toMatchObject({
      code: "first_timeout",
    });
    request.emit({ event: "started" });
    await vi.advanceTimersByTimeAsync(30000);
    request.emit({ event: "token", text: " \n " });
    request.emit({ event: "started" });
    await vi.advanceTimersByTimeAsync(29999);
    expect(request.worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(request.worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart a first-token timer after text, but retains the request's 180s deadline", async () => {
    const { send } = setup();
    const request = send();
    const rejected = expect(request.promise).rejects.toMatchObject({
      code: "operation_timeout",
    });
    await vi.advanceTimersByTimeAsync(1000);
    request.emit({ event: "started" });
    await vi.advanceTimersByTimeAsync(12200);
    request.emit({ event: "token", text: "안녕" });
    request.emit({ event: "started" });
    await vi.advanceTimersByTimeAsync(166799);
    expect(request.worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores other request IDs without arming or clearing deadlines", async () => {
    const { send } = setup();
    const request = send();
    const rejected = expect(request.promise).rejects.toMatchObject({
      code: "first_timeout",
    });
    request.emit({ event: "started" }, request.id + 1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(request.worker.terminate).not.toHaveBeenCalled();
    request.emit({ event: "started" });
    await vi.advanceTimersByTimeAsync(30000);
    request.emit({ event: "token", text: "stale" }, request.id + 1);
    request.emit({ done: true, result }, request.id + 1);
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(request.onEvent).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "stop"])(
    "rejects late replies after %s and completes the next request normally",
    async (reason) => {
      const { client, send } = setup();
      const previous = send();
      const rejected = expect(previous.promise).rejects.toMatchObject({
        code: reason === "timeout" ? "first_timeout" : "cancelled",
      });
      previous.emit({ event: "started" });
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(60000);
      else client.stop();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
      const next = send();
      previous.emit({ event: "token", text: "stale" });
      previous.emit({ done: true, result: { ...result, text: "stale" } });
      next.emit({ event: "started" });
      await vi.advanceTimersByTimeAsync(13200);
      expect(next.worker.terminate).not.toHaveBeenCalled();
      next.emit({ event: "token", text: result.text });
      next.emit({ done: true, result });
      await expect(next.promise).resolves.toEqual(result);
      expect(next.onEvent.mock.calls.map(([event]) => event.event)).toEqual([
        "started",
        "token",
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
