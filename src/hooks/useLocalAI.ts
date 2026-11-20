import { useCallback, useEffect, useState } from "react";
import { inspectModelCaches } from "../lib/ai/model-cache.ts";
import { MODELS } from "../lib/ai/models.ts";
import { errorCode } from "../lib/ai/protocol.ts";
import type { LoadMode } from "../lib/ai/protocol.ts";
import { localAISession } from "../lib/ai/session.ts";

export const MODEL = MODELS[0]!;

// Loading outlives the settings view, so its progress lives beside the session.
let progress: number | null = null;
let cached: boolean | null = null;
let cacheWriteFailed = false;
let cacheScan = 0;

async function scanCache() {
  const scanId = ++cacheScan;
  try {
    const scan = await inspectModelCaches();
    if (scanId !== cacheScan) return;
    cached = (scan.counts[localAISession.modelId] ?? 0) > 0;
  } catch {
    if (scanId !== cacheScan) return;
    cached = null;
  }
  localAISession.notify();
}

function snapshot() {
  return {
    ready: localAISession.ready,
    busy: localAISession.busy,
    loading: progress !== null,
    progress: progress ?? 0,
    notice: localAISession.notice,
    cached,
    cacheWriteFailed,
  };
}

export function useLocalAI() {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    const changed = () => setState(snapshot());
    localAISession.addEventListener("change", changed);
    if (cached === null) void scanCache();
    return () => localAISession.removeEventListener("change", changed);
  }, []);

  const prepare = useCallback(
    (mode: LoadMode, signal?: AbortSignal) =>
      localAISession.run(
        mode === "download" ? "settings" : "momotalk",
        async (client) => {
          progress = 0;
          cacheWriteFailed = false;
          localAISession.notify();
          try {
            // The Worker checks its own adapter. Session cancellation also stops
            // that preflight, before it can proceed to download or engine setup.
            await client.request(
              "load",
              { modelId: localAISession.modelId, mode },
              {
                timeoutMs: 600000,
                onEvent: (event) => {
                  if (Number.isFinite(event.progress))
                    progress = Math.max(progress ?? 0, event.progress!);
                  if (event.text) localAISession.notice = event.text;
                  localAISession.notify();
                },
              },
            );
            localAISession.notice = "";
          } catch (error) {
            const code = errorCode(error);
            if (code === "cache_write_failed" || code === "storage_low")
              cacheWriteFailed = true;
            if (code === "model_not_cached") cached = false;
            throw error;
          } finally {
            progress = null;
            void scanCache();
          }
        },
        signal,
      ),
    [],
  );

  const cancel = useCallback(() => {
    localAISession.cancel("settings");
    localAISession.cancel("momotalk");
  }, []);

  const remove = useCallback(async () => {
    await localAISession.run("settings", (client) =>
      client.request("delete", { modelId: localAISession.modelId }),
    );
    localAISession.notice = "";
    cacheWriteFailed = false;
    await scanCache();
  }, []);

  return { ...state, prepare, cancel, remove };
}
