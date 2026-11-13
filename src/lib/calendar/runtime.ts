import type { Feed } from "./feed.ts";
import type { PublishedManifest } from "../admin/publication.ts";

export interface CalendarPayload {
  feed_id: string;
  feed: Feed;
  published: PublishedManifest;
}
