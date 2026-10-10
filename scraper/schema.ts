import { z } from "zod";
import { validDate, validInstant } from "../src/lib/calendar/calendar.ts";
import {
  CATEGORY_KEYS,
  KIND_KEYS,
  STATUS_KEYS,
} from "../src/lib/calendar/feed.ts";
import type { Feed } from "../src/lib/calendar/feed.ts";

const instant = z
  .string()
  .refine(validInstant, "Use an ISO instant with an explicit offset.");
const date = z.string().refine(validDate, "Use a real YYYY-MM-DD date.");
const url = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  }, "Use an http(s) URL without credentials.");
const officialUrl = url.refine(
  (value) => value.startsWith("https://forum.nexon.com/bluearchive/"),
  "Sources must be official Nexon notices.",
);
const text = (max: number) => z.string().trim().min(1).max(max);

const dateOrInstant = z.union([date, instant]);

/** Plain dates represent all-day periods with exclusive ends. */
export const periodSchema = z.strictObject({
  label: text(120),
  start: dateOrInstant,
  end: dateOrInstant.optional(),
  start_after_maintenance: z.boolean().optional(),
});

export const eventSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z]+-\d{8}-[a-f0-9]{8}$/),
    title: text(160),
    label: text(60).optional(),
    category: z.enum(CATEGORY_KEYS),
    kind: z.enum(KIND_KEYS),
    all_day: z.boolean(),
    start: z.string(),
    end: z.string().optional(),
    start_after_maintenance: z.boolean().optional(),
    end_note: text(60).optional(),
    status: z.enum(STATUS_KEYS),
    tags: z.array(text(30)).max(10).optional(),
    students: z.array(text(40)).max(30).optional(),
    description: text(1000).optional(),
    notes: z.array(text(300)).max(12).optional(),
    periods: z.array(periodSchema).max(12).optional(),
    images: z.array(url).max(12).optional(),
    source_url: officialUrl,
    sources: z
      .array(
        z.strictObject({
          url: officialUrl,
          title: text(300),
          board: text(30),
          published_at: instant,
        }),
      )
      .min(1)
      .max(20),
    first_seen: instant,
    updated_at: instant,
  })
  .superRefine((event, ctx) => {
    const check = event.all_day ? date : instant;
    if (!check.safeParse(event.start).success)
      ctx.addIssue({
        code: "custom",
        path: ["start"],
        message: "start does not match all_day.",
      });
    if (event.end !== undefined) {
      if (!check.safeParse(event.end).success)
        ctx.addIssue({
          code: "custom",
          path: ["end"],
          message: "end does not match all_day.",
        });
      const ordered = event.all_day
        ? event.end > event.start
        : Date.parse(event.end) > Date.parse(event.start);
      if (!ordered)
        ctx.addIssue({
          code: "custom",
          path: ["end"],
          message: "end must follow start (ends are exclusive).",
        });
      if (event.kind !== "interval")
        ctx.addIssue({
          code: "custom",
          path: ["kind"],
          message: "Only intervals have an end.",
        });
    }
    if (event.source_url !== event.sources[0]?.url)
      ctx.addIssue({
        code: "custom",
        path: ["source_url"],
        message: "source_url must be the first source.",
      });
  });

export const feedSchema = z
  .strictObject({
    schema_version: z.literal(2),
    region: z.literal("KR"),
    timezone: z.literal("Asia/Seoul"),
    generated_at: instant,
    source: z.strictObject({ name: text(100), url }),
    events: z.array(eventSchema).max(5000),
  })
  .superRefine((feed, ctx) => {
    const ids = new Set<string>();
    feed.events.forEach((event, index) => {
      if (ids.has(event.id))
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "id"],
          message: `Duplicate id ${event.id}.`,
        });
      ids.add(event.id);
    });
  });

export function validateFeed(input: unknown): Feed {
  return feedSchema.parse(input) as Feed;
}
