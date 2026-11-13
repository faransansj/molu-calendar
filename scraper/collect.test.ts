import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { buildCollectedFeed, collectOnlinePosts } from "./collect.ts";
import { createClient, toPost, type Thread } from "./nexon.ts";
import type { BoardId, Post } from "./parse.ts";

const now = "2026-10-06T00:00:00.000Z";
function fixture(name: string): Post {
  const thread = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Thread;
  return toPost(Number(thread.boardId) as BoardId, thread);
}

test("strict collection rejects exhausted notice fetch even when another notice succeeded", async () => {
  const thread = JSON.parse(
    readFileSync(
      new URL("./fixtures/pickup-1006.json", import.meta.url),
      "utf8",
    ),
  ) as Thread;
  let failures = 0;
  const client = createClient({
    delay: 0,
    retries: 2,
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes("/threads?"))
        return Response.json({
          threads: url.includes(`/board/${thread.boardId}/`)
            ? [thread, { ...thread, threadId: "999999" }]
            : [],
          totalPages: 1,
        });
      if (url.includes("/thread/999999?")) {
        failures++;
        throw new Error("fixture network failure");
      }
      return Response.json(thread);
    },
  });
  await expect(
    collectOnlinePosts({
      pages: 1,
      pageSize: 30,
      since: 0,
      strict: true,
      client,
    }),
  ).rejects.toThrow("after 2 attempts");
  expect(failures).toBe(2);
});

test("strict build rejects parser exceptions rather than retaining a partial update", () => {
  const good = fixture("pickup-1006");
  const invalid = { ...good, blocks: undefined } as unknown as Post;
  expect(() => buildCollectedFeed([good, invalid], null, now, true)).toThrow();
});

test("a successfully parsed notice with no schedule still removes its superseded source events", () => {
  const pickup = fixture("pickup-1006");
  const maintenance = fixture("maintenance-0929");
  const previous = buildCollectedFeed(
    [pickup, maintenance],
    null,
    now,
    true,
  ).feed;
  const pickupIds = previous.events
    .filter((event) =>
      event.sources.every((source) => source.url === pickup.url),
    )
    .map((event) => event.id);
  expect(pickupIds.length).toBeGreaterThan(0);
  const withdrawn = { ...pickup, title: "일정 안내", blocks: [] };
  const next = buildCollectedFeed(
    [withdrawn, maintenance],
    previous,
    now,
    true,
  );
  expect(next.report.removed.map((event) => event.id)).toEqual(
    expect.arrayContaining(pickupIds),
  );
  expect(next.feed.events.some((event) => pickupIds.includes(event.id))).toBe(
    false,
  );
  expect(
    next.feed.events.some((event) =>
      event.sources.some((source) => source.url === maintenance.url),
    ),
  ).toBe(true);
});

test("zero notices and zero fresh recognized events cannot publish an archive-only refresh", () => {
  const previous = buildCollectedFeed(
    [fixture("pickup-1006")],
    null,
    now,
    true,
  ).feed;
  expect(() => buildCollectedFeed([], previous, now, true)).toThrow(
    "No notices",
  );
  expect(() =>
    buildCollectedFeed(
      [{ ...fixture("pickup-1006"), title: "일정 안내", blocks: [] }],
      previous,
      now,
      true,
    ),
  ).toThrow("No fresh recognized events");
});
