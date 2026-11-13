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
import { collectOnlinePosts, buildCollectedFeed } from "./collect.ts";
import { toPost } from "./nexon.ts";
import type { Thread } from "./nexon.ts";
import { BOARDS } from "./parse.ts";
import type { BoardId, Post } from "./parse.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "public/data/events.json" },
    pages: { type: "string", default: "1" },
    "page-size": { type: "string", default: "30" },
    "since-days": { type: "string", default: "150" },
    offline: { type: "string" },
    "save-raw": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
  },
});

const now = new Date().toISOString();
const since = Date.now() / 1000 - Number(values["since-days"]) * 86_400;

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
    : await collectOnlinePosts({
        pages: Number(values.pages),
        pageSize: Number(values["page-size"]),
        since,
        strict: values.strict!,
        onThread: values["save-raw"]
          ? (thread) => {
              mkdirSync(values["save-raw"]!, { recursive: true });
              writeFileSync(
                `${values["save-raw"]}/${thread.threadId}.json`,
                JSON.stringify(thread),
              );
            }
          : undefined,
      });
  const previous: Feed | null = existsSync(values.out!)
    ? JSON.parse(readFileSync(values.out!, "utf8"))
    : null;
  const { feed, report, silent } = buildCollectedFeed(
    posts,
    previous,
    now,
    values.strict!,
  );

  const summary = [
    `## MOLU calendar refresh`,
    ``,
    `Read ${posts.length} notices. Archive: ${feed.events.length} events (${report.added.length} added, ${report.changed.length} changed, ${report.removed.length} removed, ${report.kept} kept from older notices).`,
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
