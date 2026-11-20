// On the app dev server, run in the browser console:
// await (await import('/src/lib/chat/store.browser.ts')).testChatPersistence()
import { openChatStore, parseChatBundle } from "./store.ts";
import { ChatTranscript } from "./transcript.ts";
import type { Memory } from "./types.ts";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(
  promise: Promise<unknown>,
  name: string,
  message?: string,
) {
  try {
    await promise;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === name &&
      (message === undefined || message === error.message)
    )
      return;
    throw error;
  }
  throw new Error(`Expected ${name}, but the transaction committed`);
}

function request<T>(op: IDBRequest<T>) {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  op.onsuccess = () => resolve(op.result);
  op.onerror = () => reject(op.error);
  return promise;
}

function legacyDatabase(name: string, memory: Memory) {
  const op = indexedDB.open(name, 2);
  op.onupgradeneeded = () => {
    const db = op.result;
    db.createObjectStore("rooms", { keyPath: "id" });
    const messages = db.createObjectStore("messages", { keyPath: "id" });
    messages.createIndex("roomSeq", ["roomId", "seq"], { unique: true });
    const memories = db.createObjectStore("memories", { keyPath: "id" });
    memories.createIndex("roomCreated", ["roomId", "createdAt"]);
    memories.createIndex("sourceMessage", "sourceMessageId");
    memories.add(memory);
  };
  return request(op);
}

export async function testChatPersistence() {
  const name = `molu-chat-test-${crypto.randomUUID()}`;
  const roomId = "Arona";
  const memory: Memory = {
    id: "legacy-memory",
    profileId: "local",
    roomId,
    text: "금요일 독서 모임",
    sourceMessageId: null,
    sourceText: null,
    createdAt: 1,
    updatedAt: 1,
    enabled: true,
    expiresAt: null,
  };
  const close: Array<() => void> = [];
  try {
    (await legacyDatabase(name, memory)).close();
    const store = await openChatStore({ name });
    close.push(() => store.close());
    const other = await ChatTranscript.open({ name });
    close.push(() => other.close());
    check(
      (await store.getRoom(roomId))?.nextSeq === 1,
      "v2 orphan not repaired",
    );
    check(
      (await store.listMemories(roomId))[0]?.id === memory.id,
      "v2 memory lost",
    );
    await store.saveMemory({ id: "manual", roomId: "Yuuka", text: "체크" });
    await rejects(
      store.saveMemory({ id: "manual", roomId: "rollback", text: "x" }),
      "ConstraintError",
    );
    check(
      (await store.getRoom("rollback")) === null,
      "aborted memory write left a room",
    );
    const backup = await store.exportBundle();
    const bundle = parseChatBundle(backup);
    check(
      bundle.rooms.length === 2 && bundle.messages.length === 0,
      "manual memory created messages or lost its room",
    );
    // A genuinely old backup can contain the memories without either room.
    await other.importBundle(JSON.stringify({ ...bundle, rooms: [] }), {
      replace: true,
    });
    check(
      (await store.getRoom("Yuuka"))?.lastMessageId === null,
      "backup orphan not repaired",
    );
    const old = await other.writeHead(roomId);
    check(old.last === null, "unexpected greeting");
    // Force a missing parent even after migration: deletion must still purge its children.
    const raw = await request(indexedDB.open(name));
    try {
      const tx = raw.transaction("rooms", "readwrite");
      tx.objectStore("rooms").delete(roomId);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      await promise;
    } finally {
      raw.close();
    }
    const removed = await store.deleteRoom(roomId);
    check(
      removed.memories === 1 && removed.messages === 0,
      "orphan delete counts",
    );
    check(
      (await store.listMemories(roomId)).length === 0,
      "orphan not deleted",
    );
    check(
      (await store.listMemories("Yuuka")).length === 1,
      "removed another room's memory",
    );

    const question = {
      id: "q",
      text: "question",
      speakerType: "user",
      sourceKind: "user-input",
    } as const;
    const reply = {
      text: "answer",
      speakerType: "character",
      sourceKind: "model-output",
    } as const;
    await rejects(
      other.append(roomId, {
        ...question,
        expectedLastMessageId: null,
        expectedGeneration: old.generation,
      }),
      "ChatStorageConflict",
    );
    const current = await other.writeHead(roomId);
    await other.append(roomId, {
      ...question,
      expectedLastMessageId: null,
      expectedGeneration: current.generation,
    });
    const before = await other.writeHead(roomId);
    check(before.last?.id === question.id, "wrong head question");
    check(
      (await other.sourceMessage("Yuuka", question.id)) === null,
      "cross-room message leak",
    );
    const stale = {
      ...reply,
      expectedLastMessageId: question.id,
      expectedGeneration: before.generation,
    };
    const withQuestion = await store.exportBundle();
    await store.importBundle(withQuestion, { replace: true });
    await rejects(other.append(roomId, stale), "ChatStorageConflict");
    const restored = await other.writeHead(roomId);
    check(
      restored.last?.id === question.id &&
        restored.generation !== before.generation,
      "restore reused generation or changed question ID",
    );
    await store.deleteRoom("Yuuka");
    const guard = {
      expectedLastMessageId: question.id,
      expectedGeneration: restored.generation,
    };
    const controller = new AbortController();
    const pending = other.append(roomId, {
      ...reply,
      ...guard,
      signal: controller.signal,
    });
    controller.abort();
    await rejects(pending, "AbortError");
    const answer = await other.append(roomId, { ...reply, ...guard });
    check(
      answer.replyToMessageId === question.id,
      "lost atomic question linkage",
    );
    await rejects(
      other.append(roomId, { ...reply, ...guard }),
      "ChatStorageConflict",
    );
    const deleted = await store.deleteRoom(roomId);
    check(
      deleted.messages === 2 && deleted.memories === 0,
      "message delete counts",
    );
    await store.appendMessage({ roomId, ...question });
    await rejects(
      other.append(roomId, { ...reply, ...guard }),
      "ChatStorageConflict",
    );
    const previous = await other.writeHead(roomId);
    await store.deleteAll();
    await store.appendMessage({ roomId, ...question });
    await rejects(
      other.append(roomId, {
        ...reply,
        expectedLastMessageId: question.id,
        expectedGeneration: previous.generation,
      }),
      "ChatStorageConflict",
    );

    // A Korean transcript can exceed the file picker limit with < 12M JS code units.
    const text = "한".repeat(100_000);
    for (let i = 0; i < 112; i++)
      await store.appendMessage({
        ...question,
        id: `large-${i}`,
        roomId,
        text,
      });
    await rejects(
      store.exportBundle(),
      "Error",
      "내보낼 백업이 크기 한도를 넘습니다.",
    );
    return "Native IndexedDB migration, backup, deletion, write guards, cancellation and byte limit passed";
  } finally {
    for (const disconnect of close) disconnect();
    await request(indexedDB.deleteDatabase(name));
  }
}
