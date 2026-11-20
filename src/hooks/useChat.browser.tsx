// Dev-server browser regression: await (await import('/src/hooks/useChat.browser.tsx')).testChatRecovery()
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryPanel } from "../components/MemoryPanel.tsx";
import { ARONA } from "../lib/chat/students.ts";
import { ChatTranscript } from "../lib/chat/transcript.ts";
import { useChat } from "./useChat.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** An isolated real IDB database, two connections, and the mounted React hook/panel. */
export async function testChatRecovery() {
  const name = `molu-ui-test-${crypto.randomUUID()}`;
  const room = "Yuuka";
  const other = await ChatTranscript.open({ name });
  const channel = new BroadcastChannel(name);
  const rendered = new EventTarget();
  let current: ReturnType<typeof useChat> | undefined;
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    const chat = useChat(name);
    useLayoutEffect(() => {
      current = chat;
      rendered.dispatchEvent(new Event("commit"));
    });
    return (
      <MemoryPanel
        roomId={room}
        student={ARONA}
        store={chat.store}
        memories={[]}
        busy={false}
        onChange={async () => chat.notify()}
      />
    );
  }
  async function when(
    description: string,
    matches: (chat: NonNullable<typeof current>) => boolean,
  ) {
    const result = Promise.withResolvers<NonNullable<typeof current>>();
    const observe = () => {
      if (current && matches(current)) result.resolve(current);
    };
    rendered.addEventListener("commit", observe);
    const timeout = setTimeout(
      () => result.reject(new Error(`Timed out: ${description}`)),
      5000,
    );
    try {
      observe();
      return await result.promise;
    } finally {
      clearTimeout(timeout);
      rendered.removeEventListener("commit", observe);
    }
  }
  const ready = () =>
    when("storage ready", (chat) => chat.ready && !chat.error);
  async function closedWrite(write: Promise<unknown>) {
    try {
      await write;
    } catch (error) {
      check(
        error instanceof Error && error.name === "InvalidStateError",
        String(error),
      );
      return when("storage failure exposed", (chat) => !!chat.error);
    }
    throw new Error("closed connection accepted a write");
  }
  try {
    root.render(<Probe />);
    let chat = await ready();
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="새 기억"]',
    );
    check(input?.form, "missing mounted memory form");
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    const type = (value: string) =>
      flushSync(() => {
        setValue.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    type("room-specific memory");
    input.form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    type("next draft");
    chat = await when(
      "local memory invalidation",
      (state) => state.memoryVersion > 0,
    );
    check(
      (await other.memories(room))[0]?.text === "room-specific memory",
      "memory saved to display student instead of actual room",
    );
    check(
      !(await other.memories(ARONA.id)).length,
      "fallback student received memory",
    );
    check(input.value === "next draft", "delayed save erased new draft");

    const version = chat.memoryVersion;
    channel.postMessage("changed");
    await when(
      "broadcast memory invalidation",
      (state) => state.memoryVersion > version,
    );

    const empty = await other.writeHead(room);
    const guard = {
      expectedGeneration: empty.generation,
      expectedLastMessageId: null,
    };
    const q = {
      speakerType: "user",
      sourceKind: "user-input",
      text: "question",
    } as const;
    const question = await chat.append(room, { ...q, ...guard });
    const reply = {
      speakerType: "character",
      sourceKind: "model-output",
      text: "stale answer",
      expectedGeneration: empty.generation,
      expectedLastMessageId: question.id,
    } as const;
    chat.store!.close();
    chat = await closedWrite(chat.append(room, reply));
    const winner = await other.append(room, {
      ...reply,
      text: "other tab's answer",
    });
    chat.retry();
    chat = await ready();
    check(
      (await other.writeHead(room)).last?.id === winner.id,
      "retry overwrote competing reply",
    );

    chat.store!.close();
    const next = {
      ...q,
      text: "next question",
      expectedGeneration: empty.generation,
      expectedLastMessageId: winner.id,
    };
    let commits = 0;
    chat = await closedWrite(chat.append(room, next, () => commits++));
    chat.retry();
    await ready();
    check(
      commits === 1 && (await other.writeHead(room)).last?.text === next.text,
      "valid pending write did not recover on reopened connection",
    );
    return "React memory room/draft, broadcast invalidation, conflicting retry and closed-connection replay passed";
  } finally {
    root.unmount();
    other.close();
    channel.close();
    const deleted = Promise.withResolvers<void>();
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => deleted.resolve();
    request.onerror = () => deleted.reject(request.error);
    await deleted.promise;
  }
}
