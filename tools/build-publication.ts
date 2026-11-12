import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { validateFeed } from "../scraper/schema.ts";
import { validDate, validInstant } from "../src/lib/calendar/calendar.ts";
import {
  EVENT_ID,
  UPLOAD_NAME,
  validateCrop,
  validateSchedule,
} from "../src/lib/admin/overrides.ts";
import { MAX_UPLOAD_BYTES, sniffImage } from "../src/lib/admin/images.ts";
import {
  PUBLICATION_ID,
  type Publication,
  type PublicationSnapshot,
  type PublishedManifest,
} from "../src/lib/admin/publication.ts";

export const SNAPSHOT_PATH = ".publication/snapshot.json";
export const IMAGE_DIRECTORY = "public/resource/admin";
const instant = z.string().refine(validInstant);
const publicationSchema = z.strictObject({
  id: z.string().regex(PUBLICATION_ID),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["queued", "building", "published", "failed"]),
  created_at: instant,
  updated_at: instant,
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
const snapshotSchema = z.strictObject({
  publication: publicationSchema,
  overrides: z
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
    ),
});

export function validatePublication(input: unknown): Publication {
  return publicationSchema.parse(input);
}

export function validateSnapshot(input: unknown): PublicationSnapshot {
  return snapshotSchema.parse(input);
}

export function referencedImages(snapshot: PublicationSnapshot): Set<string> {
  return new Set(
    snapshot.overrides.flatMap((override) =>
      override.image?.upload ? [override.image.upload] : [],
    ),
  );
}

export function validateImage(name: string, bytes: Uint8Array): void {
  if (!UPLOAD_NAME.test(name) || bytes.byteLength > MAX_UPLOAD_BYTES)
    throw new Error("Invalid publication image name or size");
  const image = sniffImage(bytes);
  if (!image || !name.endsWith(`.${image.ext}`))
    throw new Error(`Invalid publication image bytes: ${name}`);
}

export async function readSnapshot(): Promise<PublicationSnapshot | null> {
  let text: string;
  try {
    text = await readFile(SNAPSHOT_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const input: unknown = JSON.parse(text);
  return input === null ? null : validateSnapshot(input);
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function buildPublication(): Promise<void> {
  const feed = validateFeed(
    JSON.parse(await readFile("public/data/events.json", "utf8")),
  );
  const snapshot = await readSnapshot();
  const events = new Map(feed.events.map((event) => [event.id, event]));
  const overrides = (snapshot?.overrides ?? []).filter((override) => {
    const event = events.get(override.event_id);
    if (!event) return false; // Official feed rotation can retire staged events.
    if (override.schedule) {
      const result = validateSchedule(override.schedule, event);
      if (!result.ok)
        throw new Error(`Invalid schedule for ${event.id}: ${result.message}`);
    }
    return true;
  });
  const images = new Set(
    overrides.flatMap((override) =>
      override.image?.upload ? [override.image.upload] : [],
    ),
  );
  for (const name of images)
    validateImage(name, await readFile(`${IMAGE_DIRECTORY}/${name}`));
  await mkdir(IMAGE_DIRECTORY, { recursive: true });
  const retained = snapshot ? referencedImages(snapshot) : new Set<string>();
  for (const name of await readdir(IMAGE_DIRECTORY)) {
    if (UPLOAD_NAME.test(name) && !retained.has(name))
      await rm(`${IMAGE_DIRECTORY}/${name}`);
  }
  const manifest: PublishedManifest = {
    publication: snapshot
      ? {
          id: snapshot.publication.id,
          revision: snapshot.publication.revision,
        }
      : null,
    overrides,
  };
  await writeJsonAtomic("public/data/published.json", manifest);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await buildPublication();
}
