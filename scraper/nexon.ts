import { publicationDay } from "./dates.ts";
import { decodeEntities, noticeBlocks } from "./html.ts";
import { BOARDS } from "./parse.ts";
import type { BoardId, Post } from "./parse.ts";

const BASE = "https://forum.nexon.com";
const USER_AGENT =
  "MOLU-Calendar/0.2 (+https://github.com/faransansj/molu-calendar; weekly schedule digest)";

export interface Thread {
  threadId: string;
  boardId: string;
  title: string;
  content?: string;
  createDate: number;
  modifyDate?: number;
}

export function threadUrl(board: BoardId, threadId: string): string {
  return `${BASE}/bluearchive/board_view?board=${board}&thread=${threadId}`;
}

export function toPost(board: BoardId, thread: Thread): Post {
  if (
    String(thread.boardId) !== String(board) ||
    !/^\d+$/.test(String(thread.threadId)) ||
    typeof thread.title !== "string" ||
    typeof thread.content !== "string" ||
    typeof thread.createDate !== "number"
  ) {
    throw new Error(
      `Thread ${thread.threadId} on board ${board} has an unexpected shape.`,
    );
  }
  return {
    board,
    threadId: String(thread.threadId),
    title: decodeEntities(thread.title),
    url: threadUrl(board, String(thread.threadId)),
    publishedAt: new Date(thread.createDate * 1000).toISOString(),
    publishedDay: publicationDay(thread.createDate),
    blocks: noticeBlocks(thread.content),
  };
}

export interface ClientOptions {
  fetcher?: typeof fetch;
  delay?: number;
  retries?: number;
}

export function createClient({
  fetcher = fetch,
  delay = 700,
  retries = 3,
}: ClientOptions = {}) {
  let last = 0;
  async function get<T>(path: string): Promise<T> {
    let failure: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      const wait = last + delay * (attempt + 1) - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      last = Date.now();
      try {
        const response = await fetcher(`${BASE}${path}`, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok)
          throw new Error(`HTTP ${response.status} for ${path}`);
        return (await response.json()) as T;
      } catch (error) {
        failure = error;
      }
    }
    throw new Error(
      `Nexon request failed after ${retries} attempts: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }

  /** Pages share the board's first block key. */
  async function threads(
    board: BoardId,
    { pages = 1, pageSize = 30 } = {},
  ): Promise<Thread[]> {
    const seen = new Map<string, Thread>();
    let blockKey: string[] | undefined;
    for (let page = 1; page <= pages; page++) {
      const params = new URLSearchParams({
        alias: "bluearchive",
        pageNo: String(page),
        pageSize: String(pageSize),
        blockSize: "5",
        paginationType: "PAGING",
        hideType: "WEB",
      });
      if (blockKey) {
        params.set("blockStartNo", "1");
        params.set("blockStartKey", blockKey.join(","));
      }
      const data = await get<{
        threads?: Thread[];
        totalPages?: number;
        blockStartKey?: string[];
      }>(`/api/v1/board/${board}/threads?${params}`);
      if (!Array.isArray(data.threads))
        throw new Error(
          `The listing format of board ${board} (${BOARDS[board]}) changed.`,
        );
      blockKey ??= data.blockStartKey;
      for (const thread of data.threads)
        seen.set(String(thread.threadId), thread);
      if (!data.totalPages || page >= data.totalPages || page >= 5) break;
    }
    return [...seen.values()].sort((a, b) => b.createDate - a.createDate);
  }

  async function thread(threadId: string): Promise<Thread> {
    return get<Thread>(`/api/v1/thread/${threadId}?alias=bluearchive`);
  }

  return { threads, thread };
}
