import type { FeedEvent } from "../lib/calendar/feed.ts";
import { EVENT_ID } from "../lib/admin/overrides.ts";

export type EventMetadata = Pick<FeedEvent, "kind" | "all_day">;
export type FeedMetadata = ReadonlyMap<string, EventMetadata>;

const feeds = new WeakMap<Fetcher, Promise<FeedMetadata>>();

export function loadFeed(assets: Fetcher): Promise<FeedMetadata> {
  const cached = feeds.get(assets);
  if (cached) return cached;
  const loading = fetchFeed(assets).catch((cause: unknown) => {
    feeds.delete(assets);
    throw cause;
  });
  feeds.set(assets, loading);
  return loading;
}

async function fetchFeed(assets: Fetcher): Promise<FeedMetadata> {
  const response = await assets.fetch("https://assets.local/data/events.json");
  if (!response.ok) throw new Error("Feed unavailable");
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("events" in data) ||
    !Array.isArray(data.events)
  ) {
    throw new Error("Invalid feed");
  }
  const events = new Map<string, EventMetadata>();
  for (const value of data.events as unknown[]) {
    if (
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !EVENT_ID.test(value.id) ||
      !("kind" in value) ||
      (value.kind !== "interval" &&
        value.kind !== "release" &&
        value.kind !== "deadline") ||
      !("all_day" in value) ||
      typeof value.all_day !== "boolean"
    ) {
      throw new Error("Invalid feed event");
    }
    events.set(value.id, { kind: value.kind, all_day: value.all_day });
  }
  return events;
}
