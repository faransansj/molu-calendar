import type { APIRoute, GetStaticPaths } from "astro";
import { CATEGORIES } from "../../lib/calendar/calendar.ts";
import { feed } from "../../lib/calendar/data.ts";
import type { Category, FeedEvent } from "../../lib/calendar/feed.ts";
import { toICS } from "../../lib/calendar/ics.ts";
import { sitePath } from "../../lib/urls.ts";

export const getStaticPaths = (() => [
  {
    params: { name: "all" },
    props: { title: "MOLU · 블루 아카이브 전체 일정", events: feed.events },
  },
  {
    params: { name: "game" },
    props: {
      title: "MOLU · 블루 아카이브 게임 일정",
      events: feed.events.filter(
        (event) =>
          event.category !== "community" && event.category !== "maintenance",
      ),
    },
  },
  ...(Object.keys(CATEGORIES) as Category[]).map((category) => ({
    params: { name: category },
    props: {
      title: `MOLU · ${CATEGORIES[category].label}`,
      events: feed.events.filter((event) => event.category === category),
    },
  })),
]) satisfies GetStaticPaths;

export const GET: APIRoute<{ title: string; events: FeedEvent[] }> = ({
  props,
  site,
}) =>
  new Response(
    toICS(props.events, {
      name: props.title,
      siteUrl: site ? new URL(sitePath(), site).href : undefined,
      now: feed.generated_at,
    }),
    {
      headers: { "Content-Type": "text/calendar; charset=utf-8" },
    },
  );
