import { CATEGORIES } from "./calendar.ts";
import { CATEGORY_KEYS } from "./feed.ts";
import type { Feed, FeedEvent } from "./feed.ts";
import { toICS } from "./ics.ts";

/**
 * Pure official artifact generation for the Node importer.
 * The Worker only serves these precomputed strings; it never builds them.
 * Callers must validate `Feed` with the scraper schema first; this module
 * only rejects empty feeds and over-limit artifacts.
 */

/** Maximum UTF-8 bytes per D1 artifact chunk. */
export const ARTIFACT_CHUNK_BYTES = 32 * 1024;
/** Maximum UTF-8 bytes per stored artifact file. */
export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
/** Stored path of the canonical official JSON artifact. */
export const OFFICIAL_JSON_PATH = "data/events.json";

/** Subscription scopes in deterministic artifact order. */
export const OFFICIAL_SCOPES = ["all", "game", ...CATEGORY_KEYS] as const;
export type OfficialScope = (typeof OFFICIAL_SCOPES)[number];

export interface OfficialManifestEntry {
  path: string;
  parts: number;
  bytes: number;
  sha256: string;
}

export interface OfficialArtifactChunk {
  path: string;
  /** Zero-based chunk index within `path`. */
  part: number;
  body: string;
}

export interface OfficialEventMeta {
  event_id: string;
  kind: FeedEvent["kind"];
  all_day: boolean;
}

export interface OfficialFile {
  path: string;
  body: string;
}

export interface OfficialBundle {
  /** SHA-256 of the exact compact feed JSON bytes (64 lowercase hex). */
  feedId: string;
  feedJson: string;
  generatedAt: string;
  eventCount: number;
  /** JSON first, then ICS in `OFFICIAL_SCOPES` order. */
  files: OfficialFile[];
  manifest: OfficialManifestEntry[];
  /** All file chunks in manifest order, contiguous per path. */
  chunks: OfficialArtifactChunk[];
  eventMeta: OfficialEventMeta[];
}

export interface BuildOfficialBundleOptions {
  /** Production HTTPS origin; HTTP loopback is allowed for local use. */
  siteUrl: string;
  /** Astro base path, defaults to "/". */
  basePath?: string;
}

const textEncoder = new TextEncoder();

export function officialScopeTitle(scope: OfficialScope): string {
  if (scope === "all") return "MOLU · 블루 아카이브 전체 일정";
  if (scope === "game") return "MOLU · 블루 아카이브 게임 일정";
  return `MOLU · ${CATEGORIES[scope].label}`;
}

export function officialScopePath(scope: OfficialScope): string {
  return `feeds/${scope}.ics`;
}

export function isOfficialScope(name: string): name is OfficialScope {
  return (OFFICIAL_SCOPES as readonly string[]).includes(name);
}

export function officialScopeEvents(
  feed: Feed,
  scope: OfficialScope,
): FeedEvent[] {
  if (scope === "all") return feed.events;
  if (scope === "game")
    return feed.events.filter(
      (event) =>
        event.category !== "community" && event.category !== "maintenance",
    );
  return feed.events.filter((event) => event.category === scope);
}

/**
 * Validate SITE_URL as an origin and return its normalized form.
 * HTTPS is required; HTTP is allowed only for loopback hosts.
 */
export function normalizeSiteOrigin(siteUrl: string): string {
  let parsed: URL;
  try {
    if (typeof siteUrl !== "string" || siteUrl !== siteUrl.trim())
      throw new Error("invalid");
    parsed = new URL(siteUrl);
  } catch {
    throw new Error(
      "SITE_URL must be an https origin (http loopback allowed locally).",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error(
      "SITE_URL must be an https origin (http loopback allowed locally).",
    );
  if (parsed.pathname !== "/" && parsed.pathname !== "")
    throw new Error("SITE_URL must be an origin without a path.");
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  const loopback =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "http:" && loopback) return parsed.origin;
  throw new Error(
    "SITE_URL must be an https origin (http loopback allowed locally).",
  );
}

/** Combine a validated site origin with an Astro base path for ICS links. */
export function resolveIcsSiteUrl(siteUrl: string, basePath = "/"): string {
  const origin = normalizeSiteOrigin(siteUrl);
  if (typeof basePath !== "string" || !basePath.startsWith("/"))
    throw new Error("Base path must be an absolute path.");
  if (/[\s?#\\]/.test(basePath))
    throw new Error("Base path must not contain spaces, queries or hashes.");
  return `${origin}${basePath.replace(/\/+$/, "")}/`;
}

export function utf8Bytes(text: string): number {
  return textEncoder.encode(text).length;
}

/**
 * Split at Unicode code-point boundaries so no chunk exceeds `maxBytes`
 * of UTF-8. Empty input yields no chunks.
 */
function utf8Width(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

export function chunkText(
  body: string,
  maxBytes = ARTIFACT_CHUNK_BYTES,
): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4)
    throw new RangeError("Chunk size must be an integer of at least 4 bytes.");
  if (body === "") return [];
  const chunks: string[] = [];
  let runStart = 0;
  let runBytes = 0;
  let index = 0;
  while (index < body.length) {
    const codePoint = body.codePointAt(index)!;
    const units = codePoint > 0xffff ? 2 : 1;
    const bytes = utf8Width(codePoint);
    if (runBytes + bytes > maxBytes) {
      chunks.push(body.slice(runStart, index));
      runStart = index;
      runBytes = 0;
    }
    runBytes += bytes;
    index += units;
  }
  chunks.push(body.slice(runStart));
  return chunks;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(text)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function officialEventMeta(feed: Feed): OfficialEventMeta[] {
  return feed.events.map((event) => ({
    event_id: event.id,
    kind: event.kind,
    all_day: event.all_day,
  }));
}

export async function buildOfficialBundle(
  feed: Feed,
  options: BuildOfficialBundleOptions,
): Promise<OfficialBundle> {
  if (!feed || typeof feed !== "object" || !Array.isArray(feed.events))
    throw new Error("Feed must be a validated schema-v2 object.");
  if (feed.events.length === 0)
    throw new Error("Cannot build an official bundle from an empty feed.");
  if (typeof feed.generated_at !== "string" || feed.generated_at === "")
    throw new Error("Feed must carry generated_at.");
  if (!options || typeof options.siteUrl !== "string")
    throw new Error("Official bundle requires a site URL origin.");
  const icsSiteUrl = resolveIcsSiteUrl(options.siteUrl, options.basePath);
  const feedJson = JSON.stringify(feed);
  const feedId = await sha256Hex(feedJson);
  const files: OfficialFile[] = [
    { path: OFFICIAL_JSON_PATH, body: feedJson },
    ...OFFICIAL_SCOPES.map((scope) => ({
      path: officialScopePath(scope),
      body: toICS(officialScopeEvents(feed, scope), {
        name: officialScopeTitle(scope),
        siteUrl: icsSiteUrl,
        now: feed.generated_at,
      }),
    })),
  ];
  const sized = files.map((file) => ({ file, bytes: utf8Bytes(file.body) }));
  for (const { file, bytes } of sized) {
    if (bytes > ARTIFACT_MAX_BYTES)
      throw new Error(`${file.path} exceeds 16 MiB (${bytes} bytes).`);
  }
  const manifest: OfficialManifestEntry[] = [];
  const chunks: OfficialArtifactChunk[] = [];
  for (const { file, bytes } of sized) {
    let sha256 = feedId;
    if (file.path !== OFFICIAL_JSON_PATH) {
      sha256 = await sha256Hex(file.body);
    }
    const parts = chunkText(file.body);
    manifest.push({ path: file.path, parts: parts.length, bytes, sha256 });
    for (const [part, body] of parts.entries())
      chunks.push({ path: file.path, part, body });
  }
  return {
    feedId,
    feedJson,
    generatedAt: feed.generated_at,
    eventCount: feed.events.length,
    files,
    manifest,
    chunks,
    eventMeta: officialEventMeta(feed),
  };
}
