import { describe, expect, test } from "vitest";
import { validateFeed } from "../../../scraper/schema.ts";
import {
  ARTIFACT_CHUNK_BYTES,
  OFFICIAL_SCOPES,
  buildOfficialBundle,
  chunkText,
  isOfficialScope,
  normalizeSiteOrigin,
  officialScopeEvents,
  officialScopePath,
  officialScopeTitle,
  resolveIcsSiteUrl,
  sha256Hex,
  utf8Bytes,
} from "./artifacts.ts";
import type { Feed, FeedEvent } from "./feed.ts";

const NOTICE =
  "https://forum.nexon.com/bluearchive/board_view?board=1076&thread=1";

const event = (patch: Partial<FeedEvent>): FeedEvent => ({
  id: "event-20260101-89abcdef",
  title: "이벤트",
  category: "event",
  kind: "interval",
  all_day: false,
  start: "2026-01-01T11:00:00+09:00",
  end: "2026-01-02T10:59:00+09:00",
  status: "confirmed",
  source_url: NOTICE,
  sources: [
    {
      url: NOTICE,
      title: "공지",
      board: "업데이트",
      published_at: "2026-01-01T00:00:00Z",
    },
  ],
  first_seen: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...patch,
});

const feed = (...events: FeedEvent[]): Feed =>
  validateFeed({
    schema_version: 2,
    region: "KR",
    timezone: "Asia/Seoul",
    generated_at: "2026-01-01T00:00:00Z",
    source: { name: "MOLU", url: "https://example.invalid/source" },
    events,
  });

describe("site origin validation", () => {
  test("accepts HTTPS origins and local loopback HTTP", () => {
    expect(normalizeSiteOrigin("https://molu.example")).toBe(
      "https://molu.example",
    );
    expect(normalizeSiteOrigin("https://molu.example:8443/")).toBe(
      "https://molu.example:8443",
    );
    expect(normalizeSiteOrigin("http://localhost:8811")).toBe(
      "http://localhost:8811",
    );
    expect(normalizeSiteOrigin("http://127.0.0.1:8811/")).toBe(
      "http://127.0.0.1:8811",
    );
    expect(normalizeSiteOrigin("http://[::1]:8811")).toBe("http://[::1]:8811");
    expect(resolveIcsSiteUrl("https://molu.example", "/base")).toBe(
      "https://molu.example/base/",
    );
    expect(resolveIcsSiteUrl("https://molu.example/", "/")).toBe(
      "https://molu.example/",
    );
  });

  test("rejects non-origins, remote HTTP and credentials", () => {
    for (const bad of [
      "",
      "molu.example",
      "https://molu.example/path",
      "https://molu.example/?event=x",
      "https://molu.example/#x",
      "https://user@molu.example",
      "https://user:pass@molu.example",
      "http://molu.example",
      "ftp://molu.example",
      " https://molu.example",
    ]) {
      expect(() => normalizeSiteOrigin(bad)).toThrow();
    }
    expect(() => resolveIcsSiteUrl("https://molu.example", "base")).toThrow();
    expect(() => resolveIcsSiteUrl("https://molu.example", "/a b")).toThrow();
  });
});

describe("chunking", () => {
  test("splits at code-point boundaries with every chunk within budget", () => {
    const body = `${"a".repeat(ARTIFACT_CHUNK_BYTES - 2)}한😀bcd`;
    const parts = chunkText(body);
    expect(parts.join("")).toBe(body);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(utf8Bytes(part)).toBeLessThanOrEqual(ARTIFACT_CHUNK_BYTES);
      expect(part).not.toMatch(/�/);
    }
    expect(chunkText("")).toEqual([]);
    expect(chunkText("abcd", 4)).toEqual(["abcd"]);
    expect(chunkText("한😀", 4)).toEqual(["한", "😀"]);
    expect(() => chunkText("abc", 3)).toThrow(RangeError);
  });
});

describe("scope catalog", () => {
  test("keeps existing titles, paths and filters", () => {
    const events = [
      event({ id: "event-20260101-89abcdef", category: "event" }),
      event({ id: "maintenance-20260101-89abcdef", category: "maintenance" }),
      event({ id: "community-20260101-89abcdef", category: "community" }),
    ];
    const scoped = feed(...events);
    expect(isOfficialScope("all")).toBe(true);
    expect(isOfficialScope("unknown")).toBe(false);
    expect(officialScopePath("game")).toBe("feeds/game.ics");
    expect(officialScopeTitle("all")).toBe("MOLU · 블루 아카이브 전체 일정");
    expect(officialScopeTitle("game")).toBe("MOLU · 블루 아카이브 게임 일정");
    expect(officialScopeTitle("maintenance")).toBe("MOLU · 점검·업데이트");
    expect(officialScopeEvents(scoped, "all")).toBe(scoped.events);
    expect(officialScopeEvents(scoped, "game")).toHaveLength(1);
    expect(officialScopeEvents(scoped, "community")).toHaveLength(1);
  });
});

describe("official bundle", () => {
  test("is deterministic and round-trips through manifest chunks", async () => {
    const scoped = feed(
      event({ id: "event-20260101-89abcdef", title: "제목 😀" }),
      event({
        id: "raid-20260102-01234567",
        category: "raid",
        title: "총력전",
        start: "2026-01-02T11:00:00+09:00",
        end: "2026-01-03T10:59:00+09:00",
      }),
    );
    const left = await buildOfficialBundle(scoped, {
      siteUrl: "https://molu.example",
    });
    const right = await buildOfficialBundle(
      validateFeed(JSON.parse(JSON.stringify(scoped))),
      { siteUrl: "https://molu.example/" },
    );
    expect(right).toEqual(left);
    expect(left.feedId).toMatch(/^[0-9a-f]{64}$/);
    expect(left.feedId).toBe(await sha256Hex(left.feedJson));
    expect(left.feedJson).toBe(JSON.stringify(scoped));
    expect(left.eventCount).toBe(2);
    expect(left.files.map((file) => file.path)).toEqual([
      "data/events.json",
      ...OFFICIAL_SCOPES.map((scope) => `feeds/${scope}.ics`),
    ]);
    expect(left.manifest).toHaveLength(left.files.length);
    for (const [index, file] of left.files.entries()) {
      const entry = left.manifest[index]!;
      const parts = left.chunks.filter((chunk) => chunk.path === file.path);
      expect(parts.map((chunk) => chunk.part)).toEqual(
        parts.map((_, part) => part),
      );
      expect(parts.map((chunk) => chunk.body).join("")).toBe(file.body);
      expect(entry.path).toBe(file.path);
      expect(entry.parts).toBe(parts.length);
      expect(entry.bytes).toBe(utf8Bytes(file.body));
      expect(entry.sha256).toBe(await sha256Hex(file.body));
      for (const part of parts)
        expect(utf8Bytes(part.body)).toBeLessThanOrEqual(ARTIFACT_CHUNK_BYTES);
    }
    expect(left.manifest[0]).toMatchObject({
      path: "data/events.json",
      sha256: left.feedId,
    });
    expect(left.eventMeta).toEqual([
      { event_id: "event-20260101-89abcdef", kind: "interval", all_day: false },
      { event_id: "raid-20260102-01234567", kind: "interval", all_day: false },
    ]);
    const game = left.files.find(
      (file) => file.path === "feeds/game.ics",
    )!.body;
    expect(game).toContain("X-WR-CALNAME:MOLU · 블루 아카이브 게임 일정");
    expect(game.replace(/\r\n /g, "")).toContain(
      "MOLU: https://molu.example/?event=raid-20260102-01234567",
    );
    expect(
      left.files.find((file) => file.path === "feeds/event.ics")!.body,
    ).toContain("CATEGORIES:이벤트");
  });

  test("rejects empty feeds and oversized artifacts", async () => {
    await expect(
      buildOfficialBundle(feed(), { siteUrl: "https://molu.example" }),
    ).rejects.toThrow();
    const heavyDescription = "가".repeat(1000);
    const heavyNote = "가".repeat(300);
    const oversized = Array.from({ length: 2000 }, (_, index) =>
      event({
        id: `event-20260101-${index.toString(16).padStart(8, "0")}`,
        status: "cancelled",
        description: heavyDescription,
        notes: Array.from({ length: 12 }, () => heavyNote),
      }),
    );
    await expect(
      buildOfficialBundle(feed(...oversized), {
        siteUrl: "http://localhost:8811",
      }),
    ).rejects.toThrow();
    await expect(
      buildOfficialBundle(feed(event({})), { siteUrl: "http://molu.example" }),
    ).rejects.toThrow();
  });
});
