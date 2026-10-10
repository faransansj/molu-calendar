import { openChatStore, CHAT_DB_NAME } from "./store.ts";
import { searchMessages } from "./memory.ts";

import type {
  ChatMessage,
  MessageRecord,
  RoomCache,
  Summary,
  StoreOptions,
  MessageDraft,
  MemoryDraft,
  MemoryPatch,
} from "./types.ts";
import type { ChatStore } from "./store.ts";
export type { ChatMessage, Memory, RoomCache, Summary } from "./types.ts";

export const ROOM_PAGE = 50;
export const ROOM_CACHE = 300;

const pad = (value: number) => String(value).padStart(2, "0");
const timeOf = (createdAt: number) => {
  const date = new Date(createdAt + 9 * 60 * 60 * 1000);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

export function viewMessage(record: MessageRecord): ChatMessage {
  return {
    id: record.id,
    me: record.speakerType === "user",
    text: record.text,
    time: timeOf(record.createdAt),
    status: record.status,
    speakerType: record.speakerType,
    sourceKind: record.sourceKind,
    createdAt: record.createdAt,
  };
}

export class ChatTranscript {
  #store: ChatStore;
  #rooms = new Map<string, RoomCache>();
  #summaries = new Map<string, Summary>();

  constructor(store: ChatStore) {
    this.#store = store;
  }

  static async open({
    indexedDB,
    name = CHAT_DB_NAME,
    onBlocked,
  }: StoreOptions = {}) {
    const store = await openChatStore({ indexedDB, name, onBlocked });
    return new ChatTranscript(store);
  }

  close() {
    this.#store.close();
  }

  async refreshSummaries() {
    const rooms = await this.#store.listRooms();
    this.#summaries = new Map<string, Summary>();
    for (const room of rooms) {
      const [last] = await this.#store.readMessages(room.id, { limit: 1 });
      if (!last) continue;
      const view = viewMessage(last);
      this.#summaries.set(room.id, {
        roomId: room.id,
        last: view,
        userMessageCount: room.userMessageCount,
        revision: room.revision,
        activityAt: view.createdAt,
      });
    }
    return this.summaries();
  }

  summaries() {
    return [...this.#summaries.values()].sort(
      (a, b) =>
        b.activityAt - a.activityAt ||
        (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0),
    );
  }

  summary(roomId: string) {
    return this.#summaries.get(roomId) ?? null;
  }

  async load(roomId: string) {
    const [page, room] = await Promise.all([
      this.#store.readMessages(roomId, { limit: ROOM_PAGE }),
      this.#store.getRoom(roomId),
    ]);
    const cache = {
      roomId,
      records: page,
      messages: page.map(viewMessage),
      hasMore: page.length === ROOM_PAGE,
      userMessageCount: room?.userMessageCount ?? 0,
      revision: room?.revision ?? 0,
    };
    this.#rooms.set(roomId, cache);
    return cache;
  }

  cached(roomId: string) {
    return this.#rooms.get(roomId) ?? null;
  }

  async loadOlder(roomId: string) {
    const cache = this.#rooms.get(roomId);
    if (!cache || !cache.hasMore) return cache ?? null;
    const before = cache.records[0]?.seq;
    const older =
      before === undefined
        ? []
        : await this.#store.readMessages(roomId, { before, limit: ROOM_PAGE });
    cache.records = [...older, ...cache.records];
    cache.hasMore = older.length === ROOM_PAGE;
    // While paging backward, drop newer rows so the oldest cursor keeps advancing.
    if (cache.records.length > ROOM_CACHE) cache.records.splice(ROOM_CACHE);
    cache.messages = cache.records.map(viewMessage);
    return cache;
  }

  // Keep the in-memory window bounded; the dropped oldest page stays reachable through loadOlder().
  #trim(cache: RoomCache) {
    if (cache.records.length <= ROOM_CACHE) return;
    const excess = cache.records.length - ROOM_CACHE;
    cache.records.splice(0, excess);
    cache.hasMore = true;
  }

  async append(
    roomId: string,
    {
      id,
      speakerType,
      text,
      sourceKind,
      status = "complete",
      createdAt,
      expectedLastMessageId,
    }: Omit<MessageDraft, "roomId"> & { expectedLastMessageId?: string },
  ) {
    const record = await this.#store.appendMessage(
      {
        roomId,
        id,
        speakerType,
        text,
        sourceKind,
        status,
        createdAt: createdAt ?? Date.now(),
      },
      { expectedLastMessageId },
    );
    const cache = this.#rooms.get(roomId);
    if (cache) {
      cache.records.push(record);
      cache.userMessageCount += speakerType === "user" ? 1 : 0;
      cache.revision++;
      this.#trim(cache);
      cache.messages = cache.records.map(viewMessage);
    }
    const view = viewMessage(record);
    const summary = this.#summaries.get(roomId);
    if (summary) {
      summary.last = view;
      summary.userMessageCount =
        cache?.userMessageCount ??
        summary.userMessageCount + (speakerType === "user" ? 1 : 0);
      summary.revision = cache?.revision ?? summary.revision + 1;
      summary.activityAt = view.createdAt;
    } else {
      this.#summaries.set(roomId, {
        roomId,
        last: view,
        userMessageCount: speakerType === "user" ? 1 : 0,
        revision: 1,
        activityAt: view.createdAt,
      });
    }
    return view;
  }

  // A trailing complete user message is an unanswered turn: the reply was cancelled, failed or lost on reload.
  retryTarget(roomId: string) {
    const cache = this.#rooms.get(roomId);
    const last = cache?.messages.at(-1);
    return last && last.me && last.status === "complete" ? last : null;
  }

  async seed(seeds: MessageDraft[]) {
    const appended = [];
    for (const seed of seeds) {
      const [existing] = await this.#store.readMessages(seed.roomId, {
        limit: 1,
      });
      if (existing) continue;
      appended.push(await this.append(seed.roomId, seed));
    }
    return appended;
  }

  async deleteRoom(roomId: string) {
    const result = await this.#store.deleteRoom(roomId);
    this.#rooms.delete(roomId);
    this.#summaries.delete(roomId);
    return result;
  }

  async deleteAll() {
    const result = await this.#store.deleteAll();
    this.#rooms.clear();
    this.#summaries.clear();
    return result;
  }

  async searchRoom(
    roomId: string,
    {
      query,
      limit = 2,
      extraPages = 2,
    }: { query?: string; limit?: number; extraPages?: number } = {},
  ) {
    const cache = this.#rooms.get(roomId);
    if (!cache) return [];
    const rows = cache.records.map(viewMessage);
    let hasMore = cache.hasMore;
    let before = cache.records[0]?.seq;
    for (
      let page = 0;
      page < extraPages && hasMore && before !== undefined;
      page++
    ) {
      const older = await this.#store.readMessages(roomId, {
        before,
        limit: ROOM_PAGE,
      });
      if (!older.length) break;
      rows.unshift(...older.map(viewMessage));
      before = older[0]!.seq;
      hasMore = older.length === ROOM_PAGE;
    }
    return searchMessages(rows, { query, limit });
  }

  memories(roomId: string) {
    return this.#store.listMemories(roomId);
  }
  saveMemory(draft: MemoryDraft) {
    return this.#store.saveMemory(draft);
  }
  updateMemory(id: string, patch: MemoryPatch) {
    return this.#store.updateMemory(id, patch);
  }
  deleteMemory(id: string) {
    return this.#store.deleteMemory(id);
  }

  exportBundle(exportedAt = Date.now()) {
    return this.#store.exportBundle(exportedAt);
  }

  async importBundle(raw: string, options?: { replace?: boolean }) {
    const result = await this.#store.importBundle(raw, options);
    this.#rooms.clear();
    await this.refreshSummaries();
    return result;
  }
}
