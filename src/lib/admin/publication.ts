import { z } from "zod";
import { validDate, validInstant } from "../calendar/calendar.ts";
import {
  EVENT_ID,
  UPLOAD_NAME,
  validateCrop,
  validateSchedule,
} from "./overrides.ts";
import type { EventOverride } from "./overrides.ts";

export interface Publication {
  id: string;
  revision: number;
  state: "published";
  created_at: string;
  updated_at: string;
}
export interface PublicationSnapshot {
  publication: Publication;
  overrides: EventOverride[];
}
export interface PublicationStatus {
  revision: number;
  staged_at: string | null;
  published: Publication | null;
}
export const PUBLICATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PublishedManifest {
  publication: Pick<Publication, "id" | "revision"> | null;
  overrides: EventOverride[];
}

const instant = z.string().refine(validInstant);
const legacyPublicationSchema = z.strictObject({
  id: z.string().regex(PUBLICATION_ID),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["queued", "building", "published", "failed"]),
  created_at: instant,
  updated_at: instant,
});
const publicationSchema = legacyPublicationSchema.extend({
  state: z.literal("published"),
});
const cropSchema = z
  .strictObject({ x: z.number(), y: z.number(), zoom: z.number() })
  .refine((crop) => validateCrop(crop) !== null);
const scheduleSchema = z
  .strictObject({
    start: z.string(),
    end: z.string().nullable(),
    start_after_maintenance: z.boolean(),
  })
  .refine(
    (schedule) =>
      validateSchedule(schedule, {
        kind: "interval",
        all_day: validDate(schedule.start),
      }).ok,
  );
const overridesSchema = z
  .array(
    z.strictObject({
      event_id: z.string().regex(EVENT_ID),
      image: z
        .strictObject({
          upload: z.string().regex(UPLOAD_NAME).nullable(),
          crop: cropSchema,
        })
        .nullable(),
      schedule: scheduleSchema.nullable(),
      updated_at: instant,
    }),
  )
  .max(5000)
  .refine(
    (overrides) =>
      new Set(overrides.map((override) => override.event_id)).size ===
      overrides.length,
    "Duplicate override event IDs",
  )
  .refine(
    (overrides) =>
      overrides.every(
        (override) => override.image !== null || override.schedule !== null,
      ),
    "Empty override",
  );
const snapshotSchema = z.strictObject({
  publication: publicationSchema,
  overrides: overridesSchema,
});
const manifestSchema = z
  .strictObject({
    publication: publicationSchema
      .pick({ id: true, revision: true })
      .nullable(),
    overrides: overridesSchema,
  })
  .refine(
    (manifest) =>
      manifest.publication !== null || manifest.overrides.length === 0,
  );

export function validatePublication(input: unknown): Publication {
  return publicationSchema.parse(input);
}
export function validateSnapshot(input: unknown): PublicationSnapshot {
  return snapshotSchema.parse(input);
}
// Historical states are accepted only by the explicit migration tool.
export function validateLegacySnapshot(input: unknown) {
  return snapshotSchema
    .extend({ publication: legacyPublicationSchema })
    .parse(input);
}
export function validateManifest(input: unknown): PublishedManifest {
  return manifestSchema.parse(input);
}
