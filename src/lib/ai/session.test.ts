import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { useLocalAI } from "../../hooks/useLocalAI.ts";
import { localAISession as session } from "./session.ts";

// Exercise the session's real visibility listener; only the Worker transport is
// controlled. No adapter, model download or GPU inference occurs in this test.
const document = vi.hoisted(() => {
  // The session registers its visibility listener when its module loads.
  const document = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", document);
  vi.stubGlobal("addEventListener", vi.fn());
  return document;
});

function readHook<T>(useHook: () => T) {
  let snapshot!: T;
  function Probe() {
    snapshot = useHook();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return snapshot;
}

function setup() {
  document.hidden = false;
  const worker = { postMessage: vi.fn(), terminate: vi.fn() };
  const create = vi.fn(() => worker as unknown as Worker);
  session.client.workerFactory = create;
  return { worker, create, ai: readHook(useLocalAI) };
}

afterAll(() => vi.unstubAllGlobals());

describe("local AI preparation preflight", () => {
  it.each(["signal", "stop", "hide"])(
    "%s cancels before the Worker reports its first load progress",
    async (reason) => {
      const { worker, ai } = setup();
      const controller = new AbortController();
      const loading = ai.prepare("download", controller.signal);
      expect(session.owner).toBe("settings");
      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "load", mode: "download" }),
      );
      if (reason === "signal") controller.abort();
      else if (reason === "stop") ai.cancel();
      else {
        document.hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      }
      await expect(loading).rejects.toMatchObject({
        code: reason === "hide" ? "hidden" : "cancelled",
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.postMessage).toHaveBeenCalledOnce();
      expect(session.busy).toBe(false);
      expect(session.ready).toBe(false);
    },
  );

  it("never starts a Worker when aborted or already hidden", async () => {
    const { create, ai } = setup();
    await expect(
      ai.prepare("cache-only", AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "cancelled" });
    document.hidden = true;
    await expect(ai.prepare("cache-only")).rejects.toMatchObject({
      code: "hidden",
    });
    expect(create).not.toHaveBeenCalled();
  });
});
