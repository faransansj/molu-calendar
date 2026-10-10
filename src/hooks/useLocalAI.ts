import { useCallback, useEffect, useState } from "react";
import { inspectEnvironment, inspectModelCaches } from "../lib/ai/client.ts";
import { MODELS } from "../lib/ai/models.ts";
import { localAISession } from "../lib/ai/session.ts";

export const MODEL = MODELS[0]!;

// Loading outlives the settings view, so its progress lives beside the session.
let progress: number | null = null;
let cached: boolean | null = null;

async function scanCache() {
  try {
    const scan = await inspectModelCaches();
    cached = (scan.counts[localAISession.modelId] ?? 0) > 0;
  } catch {
    cached = null;
  }
  localAISession.notify();
}

function snapshot() {
  return {
    ready: localAISession.ready,
    enabled: localAISession.momoEnabled,
    busy: localAISession.busy,
    loading: progress !== null,
    progress: progress ?? 0,
    notice: localAISession.notice,
    cached,
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

  const setEnabled = useCallback(
    (enabled: boolean) => localAISession.save({ momoEnabled: enabled }),
    [],
  );

  const prepare = useCallback(async () => {
    progress = 0;
    localAISession.notify();
    try {
      const environment = await inspectEnvironment();
      if (!environment.engines.litert?.supported)
        throw new Error(
          environment.engines.litert?.reason ??
            environment.reason ??
            "WebGPU 실행 환경을 확인해 주세요.",
        );
      await localAISession.run("settings", (client) =>
        client.request(
          "load",
          { modelId: localAISession.modelId },
          {
            timeoutMs: 600000,
            onEvent: (event) => {
              if (Number.isFinite(event.progress))
                progress = Math.max(progress ?? 0, event.progress!);
              if (event.text) localAISession.notice = event.text;
              localAISession.notify();
            },
          },
        ),
      );
      localAISession.notice = "";
    } finally {
      progress = null;
      await scanCache();
    }
  }, []);

  const cancel = useCallback(() => {
    localAISession.cancel("settings");
    localAISession.cancel("momotalk");
  }, []);

  const remove = useCallback(async () => {
    await localAISession.run("settings", (client) =>
      client.request("delete", { modelId: localAISession.modelId }),
    );
    localAISession.notice = "";
    await scanCache();
  }, []);

  return { ...state, setEnabled, prepare, cancel, remove };
}
