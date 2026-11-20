import { useCallback, useEffect, useRef, useState } from "react";
import { ChatTranscript } from "../lib/chat/transcript.ts";
import { CHAT_DB_NAME } from "../lib/chat/store.ts";
import type {
  ChatMessage,
  RoomCache,
  Summary,
} from "../lib/chat/transcript.ts";
import type { TurnWrite } from "./chat-turn.ts";

type PendingWrite = (store: ChatTranscript) => Promise<ChatMessage>;

export function useChat(initialName: string = CHAT_DB_NAME) {
  const [name] = useState(initialName);
  const transcript = useRef<ChatTranscript | null>(null);
  const [store, setStore] = useState<ChatTranscript | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const [rooms, setRooms] = useState<Record<string, ChatMessage[]>>({});
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [memoryVersion, setMemoryVersion] = useState(0);
  const reopening = useRef(false);
  const loadedRooms = useRef(new Set<string>());
  const pending = useRef<{
    write: PendingWrite;
    signal?: AbortSignal;
  } | null>(null);
  const update = useCallback((cache: RoomCache | null) => {
    if (cache)
      setRooms((previous) => ({
        ...previous,
        [cache.roomId]: [...cache.messages],
      }));
  }, []);
  const refresh = useCallback(async () => {
    const store = transcript.current;
    if (!store) return;
    const summaries = await store.refreshSummaries();
    if (transcript.current !== store) return;
    setSummaries(summaries);
    for (const id of loadedRooms.current) {
      const cache = await store.load(id);
      if (transcript.current !== store) return;
      update(cache);
    }
  }, [update]);
  useEffect(() => {
    let disposed = false;
    let opened: ChatTranscript | null = null;
    void ChatTranscript.open({
      name,
      onBlocked: () => {
        if (!disposed) setError("다른 탭을 닫고 다시 시도해 주세요.");
      },
    })
      .then(async (store) => {
        opened = store;
        if (disposed) {
          store.close();
          return;
        }
        transcript.current = store;
        setStore(store);
        // Replay on the freshly opened connection, with the original ID and
        // preconditions. A conflicting write has been superseded, not failed.
        if (pending.current) {
          try {
            if (!pending.current.signal?.aborted)
              await pending.current.write(store);
          } catch (cause) {
            if (
              !pending.current.signal?.aborted &&
              !(cause instanceof Error && cause.name === "ChatStorageConflict")
            )
              throw cause;
          }
          pending.current = null;
        }
        await refresh();
        if (!disposed) {
          setReady(true);
          setError("");
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(String(cause));
      })
      .finally(() => {
        if (!disposed) reopening.current = false;
      });
    const broadcasts = new BroadcastChannel(name);
    channel.current = broadcasts;
    broadcasts.onmessage = () => {
      setMemoryVersion((version) => version + 1);
      void refresh().catch((cause: unknown) => setError(String(cause)));
    };
    return () => {
      disposed = true;
      opened?.close();
      transcript.current = null;
      channel.current = null;
      broadcasts.close();
    };
  }, [attempt, name, refresh]);
  const read = async <T>(
    operation: (store: ChatTranscript) => Promise<T>,
    signal?: AbortSignal,
  ) => {
    const store = transcript.current;
    if (!store) throw new Error("대화 저장소를 준비 중이에요.");
    try {
      return await operation(store);
    } catch (cause) {
      if (!signal?.aborted && transcript.current === store)
        setError(String(cause));
      throw cause;
    }
  };
  const load = async (id: string, signal?: AbortSignal) => {
    loadedRooms.current.add(id);
    const cache = await read((store) => store.load(id), signal);
    if (!signal?.aborted) update(cache);
    return cache;
  };
  const append = async (
    id: string,
    message: TurnWrite,
    onCommit?: () => void,
  ) => {
    const store = transcript.current;
    if (!store) throw new Error("대화 저장소를 준비 중이에요.");
    const draft = {
      ...message,
      id: message.id ?? crypto.randomUUID(),
      createdAt: Date.now(),
    };
    const write: PendingWrite = async (connection) => {
      const result = await connection.append(id, draft);
      if (transcript.current === connection) {
        update(connection.cached(id));
        setSummaries(connection.summaries());
        channel.current?.postMessage("changed");
        onCommit?.();
      }
      return result;
    };
    try {
      return await write(store);
    } catch (cause) {
      if (
        !draft.signal?.aborted &&
        !(cause instanceof Error && cause.name === "ChatStorageConflict")
      ) {
        pending.current = { write, signal: draft.signal };
        setError(String(cause));
      }
      throw cause;
    }
  };
  const retry = () => {
    if (reopening.current) return;
    reopening.current = true;
    setReady(false);
    setStore(null);
    setError("");
    setAttempt((value) => value + 1);
  };
  return {
    transcript,
    store,
    rooms,
    summaries,
    error,
    ready,
    update,
    read,
    load,
    append,
    refresh,
    retry,
    memoryVersion,
    notify: () => {
      setMemoryVersion((version) => version + 1);
      channel.current?.postMessage("changed");
    },
  };
}
