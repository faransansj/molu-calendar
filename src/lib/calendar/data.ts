import { readFile } from "node:fs/promises";
import { validateFeed } from "../../../scraper/schema.ts";
import raw from "../../../public/data/events.json";
import type { EventOverride } from "../admin/overrides.ts";
import { compareEvents } from "./calendar.ts";

export const feed = validateFeed(raw);
export const events = feed.events.toSorted(compareEvents);

let published: { overrides: EventOverride[] } = { overrides: [] };
try {
  published = JSON.parse(
    await readFile("public/data/published.json", "utf8"),
  ) as { overrides: EventOverride[] };
  if (!Array.isArray(published.overrides))
    throw new Error("public/data/published.json: invalid publication");
} catch (error) {
  // Fresh checkouts have no generated publication until build:publication runs.
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
export const publishedOverrides = published.overrides;
