import raw from "../../../public/data/events.json";
import { compareEvents } from "./calendar.ts";
import type { Feed } from "./feed.ts";

export const feed = raw as Feed;
if (feed.schema_version !== 2 || !Array.isArray(feed.events))
  throw new Error("public/data/events.json: unsupported schema");
export const events = feed.events.toSorted(compareEvents);
