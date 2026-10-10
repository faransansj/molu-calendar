import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { FeedEvent } from "../lib/calendar/feed.ts";

export interface Calendar {
  events: FeedEvent[];
  shown: FeedEvent[];
  matches: Set<string> | null;
  /** The search result to bring into view; `n` changes on every jump. */
  flash: { id: string; n: number } | null;
  month: string;
  selected: string;
  today: string;
  now: number;
  bookmarks: Set<string>;
  select: (day: string) => void;
  open: (id: string) => void;
}

export const CalendarContext = createContext<Calendar | null>(null);
export const useCalendar = () => useContext(CalendarContext)!;

export function useNow(interval: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setNow(Date.now());
      timer = window.setTimeout(tick, interval - (Date.now() % interval));
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (!document.hidden) tick();
    };
    timer = window.setTimeout(tick, interval - (Date.now() % interval));
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [interval]);
  return now;
}

function readStorage<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or a full quota: keep working for this session.
  }
}

export function usePersistentState<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
) {
  const [value, setValue] = useState<T>(() =>
    readStorage(key, fallback, valid),
  );
  useEffect(() => writeStorage(key, value), [key, value]);
  return [value, setValue] as const;
}

const BOOKMARKS = "molu.bookmarks.v2";
const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function useBookmarks() {
  const [ids, setIds] = usePersistentState<string[]>(BOOKMARKS, [], isIdList);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === BOOKMARKS) setIds(readStorage(BOOKMARKS, [], isIdList));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setIds]);
  const toggle = useCallback(
    (id: string) => {
      setIds((current) =>
        current.includes(id)
          ? current.filter((item) => item !== id)
          : [...current, id],
      );
    },
    [setIds],
  );
  return { bookmarks: new Set(ids), toggle };
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => {
      const media = matchMedia(query);
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}
