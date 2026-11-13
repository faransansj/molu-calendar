import {
  buildFeed,
  eventsFromDrafts,
  mergeArchive,
  type ArchiveReport,
} from "./build.ts";
import { createClient, toPost, type Thread } from "./nexon.ts";
import {
  BOARDS,
  isIgnoredTitle,
  parsePost,
  type BoardId,
  type Draft,
  type Post,
} from "./parse.ts";
import { decodeEntities } from "./html.ts";
import type { Feed } from "../src/lib/calendar/feed.ts";

export async function collectOnlinePosts(options: {
  pages: number;
  pageSize: number;
  since: number;
  strict: boolean;
  client?: ReturnType<typeof createClient>;
  onThread?: (thread: Thread) => void;
}): Promise<Post[]> {
  const client = options.client ?? createClient();
  const posts: Post[] = [];
  for (const board of Object.keys(BOARDS).map(Number) as BoardId[]) {
    const threads = await client.threads(board, {
      pages: options.pages,
      pageSize: options.pageSize,
    });
    const wanted = threads.filter(
      (thread) =>
        thread.createDate >= options.since &&
        !isIgnoredTitle(decodeEntities(thread.title)),
    );
    console.log(
      `board ${board} (${BOARDS[board]}): ${threads.length} listed, ${wanted.length} to read`,
    );
    for (const summary of wanted) {
      try {
        const thread = await client.thread(String(summary.threadId));
        options.onThread?.(thread);
        posts.push(toPost(board, thread));
      } catch (cause) {
        if (options.strict) throw cause;
        console.warn(
          `  ! thread ${summary.threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }
  if (!posts.length)
    throw new Error("No notices were read. Keeping the saved feed.");
  return posts;
}

export function buildCollectedFeed(
  posts: Post[],
  previous: Feed | null,
  now: string,
  strict: boolean,
): { feed: Feed; report: ArchiveReport; silent: string[] } {
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
    } catch (cause) {
      if (strict) throw cause;
      console.warn(
        `  ! could not parse ${post.url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  const fresh = eventsFromDrafts(drafts, now);
  if (strict && fresh.length === 0)
    throw new Error("No fresh recognized events. Keeping the saved feed.");
  const { events, report } = mergeArchive(
    previous?.events ?? [],
    fresh,
    parsedUrls,
    now,
  );
  const feed = buildFeed(events, previous, now);
  if (!feed.events.length)
    throw new Error("Empty merged feed. Keeping the saved feed.");
  return { feed, report, silent };
}
