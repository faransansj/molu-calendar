import type {
  ChatBundle,
  RoomRecord,
  MessageRecord,
  Memory,
  StoreOptions,
  MessageDraft,
  MemoryDraft,
  MemoryPatch,
  WriteCondition,
  RecordCounts,
} from "./types.ts";

function readRequest<T>(request: IDBRequest): IDBRequest<T> {
  return request as IDBRequest<T>;
}

export const CHAT_DB_NAME = "molu-chat-memory";
export const CHAT_DB_VERSION = 2;
const SOURCES = new Set(["user-input", "model-output", "script", "app"]);
const STATUSES = new Set([
  "complete",
  "pending",
  "failed",
  "cancelled",
  "interrupted",
]);
export const BUNDLE_FORMAT = "molu-chat-memory";
export const BUNDLE_VERSION = 2;
export const MEMORY_MAX_LENGTH = 500;
const MEMORY_FIELDS = new Set([
  "id",
  "profileId",
  "roomId",
  "text",
  "sourceMessageId",
  "sourceText",
  "createdAt",
  "updatedAt",
  "enabled",
  "expiresAt",
]);
const BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
const BUNDLE_MAX_ROOMS = 2_000;
const BUNDLE_MAX_MESSAGES = 100_000;
const SPEAKER_TYPES = ["user", "character", "app"];
const ROOM_FIELDS = new Set([
  "id",
  "profileId",
  "characterId",
  "participants",
  "nextSeq",
  "revision",
  "userMessageCount",
  "lastMessageId",
]);
const MESSAGE_FIELDS = new Set([
  "id",
  "profileId",
  "roomId",
  "seq",
  "speakerId",
  "speakerType",
  "text",
  "sourceKind",
  "status",
  "createdAt",
  "replyToMessageId",
]);

function conflict(message: string) {
  const error = new Error(message);
  error.name = "ChatStorageConflict";
  return error;
}
function identifier(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.length > 256)
    throw new TypeError(`${label}이 올바르지 않습니다.`);
  return value;
}
function content(value: unknown) {
  if (typeof value !== "string" || value.length > 100_000)
    throw new TypeError("메시지 본문이 올바르지 않습니다.");
  return value; // Preserve the original text, including whitespace.
}
function roomRecord(id: string): RoomRecord {
  return {
    id,
    profileId: "local",
    characterId: id,
    participants: ["sensei", id],
    nextSeq: 1,
    revision: 0,
    userMessageCount: 0,
    lastMessageId: null,
  };
}

// Backup files are validated strictly before a single atomic write. Unknown fields are version errors,
// not silently dropped extensions: a newer format must bump BUNDLE_VERSION.
export function parseChatBundle(raw: string): ChatBundle {
  if (typeof raw !== "string" || raw.length > BUNDLE_MAX_BYTES)
    throw new TypeError("백업 파일이 올바르지 않거나 너무 큽니다.");
  let parsed: ChatBundle;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("백업 파일의 JSON을 읽을 수 없습니다.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.format !== BUNDLE_FORMAT ||
    parsed.version !== BUNDLE_VERSION ||
    !Number.isSafeInteger(parsed.exportedAt) ||
    parsed.exportedAt < 0 ||
    !Array.isArray(parsed.rooms) ||
    !Array.isArray(parsed.messages) ||
    !Array.isArray(parsed.memories) ||
    Object.keys(parsed).some(
      (key) =>
        ![
          "format",
          "version",
          "exportedAt",
          "rooms",
          "messages",
          "memories",
        ].includes(key),
    )
  ) {
    throw new TypeError("지원하지 않는 백업 형식입니다.");
  }
  if (
    parsed.rooms.length > BUNDLE_MAX_ROOMS ||
    parsed.messages.length > BUNDLE_MAX_MESSAGES ||
    parsed.memories.length > BUNDLE_MAX_MESSAGES
  ) {
    throw new TypeError("백업 파일의 기록 수가 한도를 넘습니다.");
  }
  const rooms = new Map<string, RoomRecord>();
  for (const room of parsed.rooms) {
    if (
      !room ||
      typeof room !== "object" ||
      Array.isArray(room) ||
      Object.keys(room).some((key) => !ROOM_FIELDS.has(key)) ||
      room.profileId !== "local" ||
      !room.id ||
      room.id.length > 256 ||
      !room.characterId ||
      room.characterId.length > 256 ||
      !Array.isArray(room.participants) ||
      !room.participants.length ||
      room.participants.length > 8 ||
      room.participants.some(
        (value) => typeof value !== "string" || !value || value.length > 256,
      ) ||
      !Number.isSafeInteger(room.nextSeq) ||
      room.nextSeq < 1 ||
      !Number.isSafeInteger(room.revision) ||
      room.revision < 0 ||
      !Number.isSafeInteger(room.userMessageCount) ||
      room.userMessageCount < 0 ||
      (room.lastMessageId !== null && typeof room.lastMessageId !== "string")
    ) {
      throw new TypeError("백업 파일의 대화방 정보가 올바르지 않습니다.");
    }
    if (rooms.has(room.id))
      throw new TypeError("백업 파일에 중복된 대화방 ID가 있습니다.");
    rooms.set(room.id, room);
  }
  const ids = new Set();
  const seqs = new Map<string, Set<number>>();
  const counts = new Map<string, number>();
  const lastIds = new Map<string, { seq: number; id: string }>();
  const messages: MessageRecord[] = [];
  for (const message of parsed.messages) {
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      Object.keys(message).some((key) => !MESSAGE_FIELDS.has(key)) ||
      message.profileId !== "local" ||
      !rooms.has(message.roomId) ||
      !SPEAKER_TYPES.includes(message.speakerType) ||
      !message.id ||
      message.id.length > 256 ||
      ids.has(message.id) ||
      !message.speakerId ||
      message.speakerId.length > 256 ||
      typeof message.text !== "string" ||
      message.text.length > 100_000 ||
      !SOURCES.has(message.sourceKind) ||
      !STATUSES.has(message.status) ||
      !Number.isSafeInteger(message.seq) ||
      message.seq < 1 ||
      !Number.isSafeInteger(message.createdAt) ||
      message.createdAt < 0 ||
      (message.replyToMessageId !== null &&
        typeof message.replyToMessageId !== "string")
    ) {
      throw new TypeError("백업 파일의 메시지 정보가 올바르지 않습니다.");
    }
    const roomSeq = seqs.get(message.roomId) ?? new Set();
    if (roomSeq.has(message.seq))
      throw new TypeError("백업 파일에 같은 방의 중복된 순서가 있습니다.");
    roomSeq.add(message.seq);
    seqs.set(message.roomId, roomSeq);
    ids.add(message.id);
    counts.set(
      message.roomId,
      (counts.get(message.roomId) ?? 0) +
        (message.speakerType === "user" ? 1 : 0),
    );
    if ((lastIds.get(message.roomId)?.seq ?? 0) < message.seq)
      lastIds.set(message.roomId, { seq: message.seq, id: message.id });
    messages.push(message);
  }
  for (const room of rooms.values()) {
    const last = lastIds.get(room.id) ?? null;
    if (
      room.nextSeq !== (last?.seq ?? 0) + 1 ||
      room.userMessageCount !== (counts.get(room.id) ?? 0) ||
      room.lastMessageId !== (last?.id ?? null)
    ) {
      throw new TypeError("백업 파일의 대화방 진행 정보가 메시지와 다릅니다.");
    }
  }
  messages.sort((a, b) =>
    a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : a.seq - b.seq,
  );
  const memoryIds = new Set();
  const memories = parsed.memories.map((memory) => {
    if (
      !memory ||
      typeof memory !== "object" ||
      Array.isArray(memory) ||
      Object.keys(memory).some((key) => !MEMORY_FIELDS.has(key)) ||
      memory.profileId !== "local" ||
      !rooms.has(memory.roomId) ||
      typeof memory.text !== "string" ||
      !memory.text.trim() ||
      memory.text.length > MEMORY_MAX_LENGTH ||
      !memory.id ||
      memory.id.length > 256 ||
      memoryIds.has(memory.id) ||
      (memory.sourceMessageId !== null &&
        (typeof memory.sourceMessageId !== "string" ||
          !ids.has(memory.sourceMessageId))) ||
      (memory.sourceText !== null &&
        (typeof memory.sourceText !== "string" ||
          memory.sourceText.length > 2_000)) ||
      typeof memory.enabled !== "boolean" ||
      !Number.isSafeInteger(memory.createdAt) ||
      memory.createdAt < 0 ||
      !Number.isSafeInteger(memory.updatedAt) ||
      memory.updatedAt < 0 ||
      (memory.expiresAt !== null &&
        (!Number.isSafeInteger(memory.expiresAt) || memory.expiresAt < 0))
    ) {
      throw new TypeError("백업 파일의 기억 정보가 올바르지 않습니다.");
    }
    memoryIds.add(memory.id);
    return memory;
  });
  memories.sort((a, b) =>
    a.roomId < b.roomId
      ? -1
      : a.roomId > b.roomId
        ? 1
        : a.createdAt - b.createdAt,
  );
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: parsed.exportedAt,
    rooms: [...rooms.values()],
    messages,
    memories,
  };
}

export function openChatStore({
  indexedDB = globalThis.indexedDB,
  name = CHAT_DB_NAME,
  onBlocked = () => {},
}: StoreOptions = {}): Promise<ChatStore> {
  if (!indexedDB)
    return Promise.reject(
      new Error("이 브라우저에서 IndexedDB를 사용할 수 없습니다."),
    );
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, CHAT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("rooms"))
        db.createObjectStore("rooms", { keyPath: "id" });
      if (!db.objectStoreNames.contains("messages")) {
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("roomSeq", ["roomId", "seq"], { unique: true });
      }
      if (!db.objectStoreNames.contains("memories")) {
        const memories = db.createObjectStore("memories", { keyPath: "id" });
        memories.createIndex("roomCreated", ["roomId", "createdAt"]);
        memories.createIndex("sourceMessage", "sourceMessageId");
      }
    };
    request.onblocked = onBlocked;
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(new ChatStore(request.result));
  });
}

export class ChatStore {
  #db: IDBDatabase | null;
  constructor(db: IDBDatabase) {
    this.#db = db;
    db.onversionchange = () => this.close();
    db.onclose = () => {
      this.#db = null;
    };
  }
  close() {
    this.#db?.close();
    this.#db = null;
  }

  // Queue only IDB requests synchronously or from their callbacks; never await model/network work.
  #transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    enqueue: (
      tx: IDBTransaction,
      done: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.#db) {
        reject(new Error("대화 저장소 연결이 닫혔습니다. 다시 열어 주세요."));
        return;
      }
      const tx = this.#db.transaction(stores, mode);
      let result: T, failure: unknown;
      const fail = (error: unknown) => {
        failure = error;
        tx.abort();
      };
      // Request success is provisional; report writes only after the transaction commits.
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure ??
            tx.error ??
            new DOMException("대화 저장이 중단되었습니다.", "AbortError"),
        );
      try {
        enqueue(
          tx,
          (value) => {
            result = value;
          },
          fail,
        );
      } catch (error) {
        fail(error);
      }
    });
  }

  getRoom(roomId: string) {
    identifier(roomId, "대화방");
    return this.#transaction<RoomRecord | null>(
      ["rooms"],
      "readonly",
      (tx, done) => {
        const request = readRequest<RoomRecord | undefined>(
          tx.objectStore("rooms").get(roomId),
        );
        request.onsuccess = () => done(request.result ?? null);
      },
    );
  }
  listRooms() {
    return this.#transaction<RoomRecord[]>(
      ["rooms"],
      "readonly",
      (tx, done) => {
        const request = readRequest<RoomRecord[]>(
          tx.objectStore("rooms").getAll(),
        );
        request.onsuccess = () => done(request.result);
      },
    );
  }
  readMessages(
    roomId: string,
    { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {},
  ) {
    identifier(roomId, "대화방");
    if (
      !Number.isSafeInteger(before) ||
      before < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new TypeError("메시지 조회 범위가 올바르지 않습니다.");
    }
    return this.#transaction<MessageRecord[]>(
      ["messages"],
      "readonly",
      (tx, done) => {
        const rows: MessageRecord[] = [];
        const request = tx
          .objectStore("messages")
          .index("roomSeq")
          .openCursor(undefined, "prev");
        let sought = false;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            done(rows.reverse());
            return;
          }
          if (!sought) {
            sought = true;
            const [id, seq] = cursor.key as [string, number];
            if (id > roomId || (id === roomId && seq >= before)) {
              cursor.continue([roomId, before - 1]);
              return;
            }
          }
          if (
            (cursor.key as [string, number])[0] !== roomId ||
            (cursor.key as [string, number])[1] >= before
          ) {
            done(rows.reverse());
            return;
          }
          rows.push(cursor.value);
          if (rows.length === limit) done(rows.reverse());
          else cursor.continue();
        };
      },
    );
  }

  appendMessage(
    {
      roomId,
      id = globalThis.crypto.randomUUID(),
      speakerType,
      text,
      sourceKind,
      status = "complete",
      createdAt = Date.now(),
    }: MessageDraft,
    { expectedRevision, expectedLastMessageId }: WriteCondition = {},
  ) {
    if (expectedLastMessageId !== undefined)
      identifier(expectedLastMessageId, "응답 대상");
    identifier(roomId, "대화방");
    identifier(id, "메시지 ID");
    content(text);
    if (
      !["user", "character", "app"].includes(speakerType) ||
      !SOURCES.has(sourceKind) ||
      !STATUSES.has(status) ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      (expectedRevision !== undefined &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
    ) {
      throw new TypeError("메시지 메타데이터가 올바르지 않습니다.");
    }
    return this.#transaction<MessageRecord>(
      ["rooms", "messages"],
      "readwrite",
      (tx, done, fail) => {
        const rooms = tx.objectStore("rooms");
        const request = readRequest<RoomRecord | undefined>(rooms.get(roomId));
        request.onsuccess = () => {
          const room = request.result ?? roomRecord(roomId);
          if (
            (expectedRevision !== undefined &&
              room.revision !== expectedRevision) ||
            (expectedLastMessageId !== undefined &&
              room.lastMessageId !== expectedLastMessageId)
          ) {
            fail(
              conflict("대화방이 변경되었습니다. 다시 읽은 뒤 저장해 주세요."),
            );
            return;
          }
          const message: MessageRecord = {
            id,
            profileId: "local",
            roomId,
            seq: room.nextSeq++,
            speakerId:
              speakerType === "user"
                ? "sensei"
                : speakerType === "app"
                  ? "app"
                  : roomId,
            speakerType,
            text,
            sourceKind,
            status,
            createdAt,
            replyToMessageId: null,
          };
          room.revision++;
          if (speakerType === "user") room.userMessageCount++;
          room.lastMessageId = id;
          tx.objectStore("messages").add(message);
          rooms.put(room);
          done(message);
        };
      },
    );
  }

  memoryRecord({
    id = globalThis.crypto.randomUUID(),
    roomId,
    text,
    sourceMessageId = null,
    sourceText = null,
    expiresAt = null,
    enabled = true,
    createdAt = Date.now(),
    updatedAt = createdAt,
  }: MemoryDraft): Memory {
    identifier(roomId, "대화방");
    identifier(id, "기억 ID");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > MEMORY_MAX_LENGTH
    ) {
      throw new TypeError(`기억은 1~${MEMORY_MAX_LENGTH}자로 입력해 주세요.`);
    }
    if (
      sourceMessageId !== null &&
      (typeof sourceMessageId !== "string" ||
        !sourceMessageId ||
        sourceMessageId.length > 256)
    ) {
      throw new TypeError("기억 출처 메시지 ID가 올바르지 않습니다.");
    }
    if (
      sourceText !== null &&
      (typeof sourceText !== "string" || sourceText.length > 2_000)
    ) {
      throw new TypeError("기억 출처 본문이 올바르지 않습니다.");
    }
    if (
      expiresAt !== null &&
      (!Number.isSafeInteger(expiresAt) || expiresAt < 0)
    )
      throw new TypeError("기억 만료 시각이 올바르지 않습니다.");
    if (
      typeof enabled !== "boolean" ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      !Number.isSafeInteger(updatedAt) ||
      updatedAt < 0
    ) {
      throw new TypeError("기억 상태가 올바르지 않습니다.");
    }
    return {
      id,
      profileId: "local",
      roomId,
      text,
      sourceMessageId,
      sourceText,
      createdAt,
      updatedAt,
      enabled,
      expiresAt,
    };
  }

  saveMemory(payload: MemoryDraft) {
    const record = this.memoryRecord(payload);
    return this.#transaction<Memory>(["memories"], "readwrite", (tx, done) => {
      tx.objectStore("memories").put(record);
      done(record);
    });
  }

  updateMemory(id: string, patch: MemoryPatch) {
    identifier(id, "기억 ID");
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some(
        (key) => !["text", "enabled", "expiresAt"].includes(key),
      )
    ) {
      throw new TypeError("기억 수정 항목이 올바르지 않습니다.");
    }
    return this.#transaction<Memory>(
      ["memories"],
      "readwrite",
      (tx, done, fail) => {
        const store = tx.objectStore("memories");
        const request = readRequest<Memory | undefined>(store.get(id));
        request.onsuccess = () => {
          if (!request.result) {
            fail(new Error("없는 기억입니다."));
            return;
          }
          let updated;
          try {
            updated = this.memoryRecord({
              ...request.result,
              ...patch,
              updatedAt: Date.now(),
            });
          } catch (error) {
            fail(error);
            return;
          }
          store.put(updated);
          done(updated);
        };
      },
    );
  }

  getMemory(id: string) {
    identifier(id, "기억 ID");
    return this.#transaction<Memory | null>(
      ["memories"],
      "readonly",
      (tx, done) => {
        const request = readRequest<Memory | undefined>(
          tx.objectStore("memories").get(id),
        );
        request.onsuccess = () => done(request.result ?? null);
      },
    );
  }

  listMemories(roomId: string) {
    identifier(roomId, "대화방");
    return this.#transaction<Memory[]>(["memories"], "readonly", (tx, done) => {
      const rows: Memory[] = [];
      const request = tx
        .objectStore("memories")
        .index("roomCreated")
        .openCursor();
      let sought = false;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          done(rows);
          return;
        }
        if (!sought) {
          sought = true;
          if ((cursor.key as [string, number])[0] !== roomId) {
            // 현재 위치보다 작은 키로 continue하면 DataError가 난다.
            if ((cursor.key as [string, number])[0] > roomId) {
              done(rows);
              return;
            }
            cursor.continue([roomId]);
            return;
          }
        }
        if ((cursor.key as [string, number])[0] !== roomId) {
          done(rows);
          return;
        }
        rows.push(cursor.value);
        cursor.continue();
      };
    });
  }

  deleteMemory(id: string) {
    identifier(id, "기억 ID");
    return this.#transaction<boolean>(["memories"], "readwrite", (tx, done) => {
      const store = tx.objectStore("memories");
      const request = readRequest<Memory | undefined>(store.get(id));
      request.onsuccess = () => {
        if (!request.result) {
          done(false);
          return;
        }
        store.delete(id);
        done(true);
      };
    });
  }

  deleteRoom(roomId: string) {
    identifier(roomId, "대화방");
    return this.#transaction<{ messages: number; memories: number }>(
      ["rooms", "messages", "memories"],
      "readwrite",
      (tx, done) => {
        const rooms = tx.objectStore("rooms");
        const request = readRequest<RoomRecord | undefined>(rooms.get(roomId));
        request.onsuccess = () => {
          if (!request.result) {
            done({ messages: 0, memories: 0 });
            return;
          }
          const keys: IDBValidKey[] = [];
          const memoryKeys: IDBValidKey[] = [];
          const cursorRequest = tx
            .objectStore("messages")
            .index("roomSeq")
            .openKeyCursor();
          let sought = false;
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            const finish = () => {
              const messages = tx.objectStore("messages");
              for (const key of keys) messages.delete(key);
              rooms.delete(roomId);
              // 파생 기억은 출처가 사라지면 함께 무효화한다.
              const memories = tx.objectStore("memories");
              const memoryRequest = memories
                .index("roomCreated")
                .openKeyCursor();
              let memorySought = false;
              memoryRequest.onsuccess = () => {
                const memoryCursor = memoryRequest.result;
                const finishMemories = () => {
                  for (const key of memoryKeys) memories.delete(key);
                  done({ messages: keys.length, memories: memoryKeys.length });
                };
                if (!memoryCursor) {
                  finishMemories();
                  return;
                }
                if (!memorySought) {
                  memorySought = true;
                  if ((memoryCursor.key as [string, number])[0] !== roomId) {
                    if ((memoryCursor.key as [string, number])[0] > roomId) {
                      finishMemories();
                      return;
                    }
                    memoryCursor.continue([roomId]);
                    return;
                  }
                }
                if ((memoryCursor.key as [string, number])[0] !== roomId) {
                  finishMemories();
                  return;
                }
                memoryKeys.push(memoryCursor.primaryKey);
                memoryCursor.continue();
              };
            };
            if (!cursor) {
              finish();
              return;
            }
            if (!sought) {
              sought = true;
              if ((cursor.key as [string, number])[0] !== roomId) {
                if ((cursor.key as [string, number])[0] > roomId) {
                  finish();
                  return;
                }
                cursor.continue([roomId]);
                return;
              }
            }
            if ((cursor.key as [string, number])[0] !== roomId) {
              finish();
              return;
            }
            keys.push(cursor.primaryKey);
            cursor.continue();
          };
        };
      },
    );
  }

  deleteAll() {
    return this.#transaction<RecordCounts>(
      ["rooms", "messages", "memories"],
      "readwrite",
      (tx, done) => {
        const rooms = tx.objectStore("rooms");
        const messages = tx.objectStore("messages");
        const memories = tx.objectStore("memories");
        const counts: RecordCounts = { rooms: 0, messages: 0, memories: 0 };
        const roomCount = rooms.count();
        roomCount.onsuccess = () => {
          counts.rooms = roomCount.result;
          const messageCount = messages.count();
          messageCount.onsuccess = () => {
            counts.messages = messageCount.result;
            const memoryCount = memories.count();
            memoryCount.onsuccess = () => {
              counts.memories = memoryCount.result;
              rooms.clear();
              messages.clear();
              memories.clear();
              done(counts);
            };
          };
        };
      },
    );
  }

  exportBundle(exportedAt = Date.now()) {
    if (!Number.isSafeInteger(exportedAt) || exportedAt < 0)
      throw new TypeError("내보내기 시각이 올바르지 않습니다.");
    return this.#transaction<string>(
      ["rooms", "messages", "memories"],
      "readonly",
      (tx, done, fail) => {
        const rooms = readRequest<RoomRecord[]>(
          tx.objectStore("rooms").getAll(),
        );
        const messages = readRequest<MessageRecord[]>(
          tx.objectStore("messages").getAll(),
        );
        const memories = readRequest<Memory[]>(
          tx.objectStore("memories").getAll(),
        );
        rooms.onsuccess = () => {
          messages.onsuccess = () => {
            memories.onsuccess = () => {
              if (messages.result.length > BUNDLE_MAX_MESSAGES) {
                fail(new Error("내보낼 메시지가 한도를 넘습니다."));
                return;
              }
              const bundle = {
                format: BUNDLE_FORMAT,
                version: BUNDLE_VERSION,
                exportedAt,
                rooms: rooms.result,
                messages: messages.result
                  .slice()
                  .sort((a, b) =>
                    a.roomId < b.roomId
                      ? -1
                      : a.roomId > b.roomId
                        ? 1
                        : a.seq - b.seq,
                  ),
                memories: memories.result
                  .slice()
                  .sort((a, b) =>
                    a.roomId < b.roomId
                      ? -1
                      : a.roomId > b.roomId
                        ? 1
                        : a.createdAt - b.createdAt,
                  ),
              };
              const text = JSON.stringify(bundle);
              if (text.length > BUNDLE_MAX_BYTES) {
                fail(new Error("내보낼 백업이 크기 한도를 넘습니다."));
                return;
              }
              done(text);
            };
          };
        };
      },
    );
  }

  // Restore is explicit and never merges: a nonempty transcript needs replace:true from the user's own confirm.
  importBundle(raw: string, { replace = false } = {}) {
    const bundle = parseChatBundle(raw);
    return this.#transaction<RecordCounts>(
      ["rooms", "messages", "memories"],
      "readwrite",
      (tx, done, fail) => {
        const rooms = tx.objectStore("rooms");
        const messages = tx.objectStore("messages");
        const memories = tx.objectStore("memories");
        const roomCount = rooms.count();
        roomCount.onsuccess = () => {
          const messageCount = messages.count();
          messageCount.onsuccess = () => {
            const memoryCount = memories.count();
            memoryCount.onsuccess = () => {
              if (
                (roomCount.result ||
                  messageCount.result ||
                  memoryCount.result) &&
                !replace
              ) {
                fail(
                  conflict(
                    "기록이 있는 상태에서는 백업을 가져올 수 없습니다. 먼저 기록을 삭제해 주세요.",
                  ),
                );
                return;
              }
              if (
                roomCount.result ||
                messageCount.result ||
                memoryCount.result
              ) {
                rooms.clear();
                messages.clear();
                memories.clear();
              }
              for (const room of bundle.rooms) rooms.add(room);
              for (const message of bundle.messages) messages.add(message);
              for (const memory of bundle.memories) memories.add(memory);
              done({
                rooms: bundle.rooms.length,
                messages: bundle.messages.length,
                memories: bundle.memories.length,
              });
            };
          };
        };
      },
    );
  }
}
