import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import type { Feed, FeedEvent } from "../src/lib/calendar/feed.ts";
import { buildFeed, eventsFromDrafts, mergeArchive } from "./build.ts";
import { createClient, toPost } from "./nexon.ts";
import type { Thread } from "./nexon.ts";
import { BOARDS, isIgnoredTitle, parsePost } from "./parse.ts";
import type { BoardId, Draft, Post } from "./parse.ts";
import { decodeEntities } from "./html.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "public/data/events.json" },
    pages: { type: "string", default: "1" },
    "page-size": { type: "string", default: "30" },
    "since-days": { type: "string", default: "150" },
    offline: { type: "string" },
    "save-raw": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const now = new Date().toISOString();
const since = Date.now() / 1000 - Number(values["since-days"]) * 86_400;
const boards = Object.keys(BOARDS).map(Number) as BoardId[];

async function onlinePosts(): Promise<Post[]> {
  const client = createClient();
  const posts: Post[] = [];
  for (const board of boards) {
    const threads = await client.threads(board, {
      pages: Number(values.pages),
      pageSize: Number(values["page-size"]),
    });
    const wanted = threads.filter(
      (thread) =>
        thread.createDate >= since &&
        !isIgnoredTitle(decodeEntities(thread.title)),
    );
    console.log(
      `board ${board} (${BOARDS[board]}): ${threads.length} listed, ${wanted.length} to read`,
    );
    for (const summary of wanted) {
      try {
        const thread = await client.thread(String(summary.threadId));
        if (values["save-raw"]) {
          mkdirSync(values["save-raw"], { recursive: true });
          writeFileSync(
            `${values["save-raw"]}/${thread.threadId}.json`,
            JSON.stringify(thread),
          );
        }
        posts.push(toPost(board, thread));
      } catch (error) {
        console.warn(
          `  ! thread ${summary.threadId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  return posts;
}

function offlinePosts(directory: string): Post[] {
  return readdirSync(directory)
    .filter((name) => /^\d+\.json$/.test(name))
    .flatMap((name) => {
      const thread = JSON.parse(
        readFileSync(`${directory}/${name}`, "utf8"),
      ) as Thread;
      const board = Number(thread.boardId) as BoardId;
      if (!(board in BOARDS) || thread.createDate < since) return [];
      return [toPost(board, thread)];
    });
}

function line(event: FeedEvent): string {
  return `${event.start.slice(0, 16).replace("T", " ")}  [${event.category}] ${event.title}`;
}

async function main() {
  const posts = values.offline
    ? offlinePosts(values.offline)
    : await onlinePosts();
  if (!posts.length)
    throw new Error("No notices were read. Keeping the saved feed.");
  const drafts: Draft[] = [];
  const silent: string[] = [];
  const parsedUrls = new Set<string>();
  for (const post of posts) {
    try {
      const found = parsePost(post);
      parsedUrls.add(post.url);
      if (!found.length && !isIgnoredTitle(post.title))
        silent.push(`${post.title} — ${post.url}`);
      drafts.push(...found);
    } catch (error) {
      console.warn(
        `  ! could not parse ${post.url}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  const fresh = eventsFromDrafts(drafts, now);
  const previous: Feed | null = existsSync(values.out!)
    ? JSON.parse(readFileSync(values.out!, "utf8"))
    : null;
  const { events, report } = mergeArchive(
    previous?.events ?? [],
    fresh,
    parsedUrls,
    now,
  );
  const feed = buildFeed(events, previous, now);

  const summary = [
    `## MOLU calendar refresh`,
    ``,
    `Read ${posts.length} notices → ${fresh.length} events. Archive: ${events.length} events (${report.added.length} added, ${report.changed.length} changed, ${report.removed.length} removed, ${report.kept} kept from older notices).`,
    ...(report.added.length
      ? [
          "",
          "### Added",
          "",
          ...report.added.map((event) => `- ${line(event)}`),
        ]
      : []),
    ...(report.changed.length
      ? [
          "",
          "### Changed",
          "",
          ...report.changed.map((event) => `- ${line(event)}`),
        ]
      : []),
    ...(report.removed.length
      ? [
          "",
          "### Removed (no longer in the notice or excluded by calendar rules)",
          "",
          ...report.removed.map((event) => `- ${line(event)}`),
        ]
      : []),
    ...(silent.length
      ? [
          "",
          "### Notices without a recognised schedule",
          "",
          ...silent.map((text) => `- ${text}`),
        ]
      : []),
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (!values["dry-run"])
    writeFileSync(values.out!, `${JSON.stringify(feed, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
