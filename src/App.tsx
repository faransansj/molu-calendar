import { useEffect, useMemo, useRef, useState } from "react";
import { Agenda } from "./components/Agenda.tsx";
import { DayBriefing } from "./components/DayBriefing.tsx";
import { EventDialog } from "./components/EventDialog.tsx";
import { MomoTalk } from "./components/MomoTalk.tsx";
import { MonthGrid } from "./components/MonthGrid.tsx";
import { SourcesDialog } from "./components/SourcesDialog.tsx";
import { SubscribeDialog } from "./components/SubscribeDialog.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { Toolbar } from "./components/Toolbar.tsx";
import {
  CalendarContext,
  useBookmarks,
  useNow,
  usePersistentState,
} from "./hooks/calendar.ts";
import {
  CATEGORIES,
  addDays,
  dateKey,
  endMoment,
  openEndedExpired,
  overlaps,
  span,
  startMoment,
  validDate,
} from "./lib/calendar/calendar.ts";
import { cx } from "./lib/cx.ts";
import type { Category, FeedEvent } from "./lib/calendar/feed.ts";
import { eventMatcher } from "./lib/calendar/search.ts";

export type View = "timeline" | "month" | "list";
export type Filter = "all" | "bookmarks" | Category;

const isView = (value: unknown): value is View =>
  value === "timeline" || value === "month" || value === "list";
const isFilter = (value: unknown): value is Filter =>
  value === "all" ||
  value === "bookmarks" ||
  (typeof value === "string" && Object.hasOwn(CATEGORIES, value));

function initialUrlState() {
  const params = new URLSearchParams(location.search);
  const month = params.get("month");
  const date = params.get("date");
  return {
    month:
      month && /^\d{4}-\d{2}$/.test(month) && validDate(`${month}-01`)
        ? month
        : null,
    date: date && validDate(date) ? date : null,
    view: params.get("view"),
    filter: params.get("filter"),
    event: params.get("event"),
    query: params.get("q") ?? "",
  };
}

export function App({ events: feedEvents }: { events: FeedEvent[] }) {
  const now = useNow(30_000);
  // The weekly scrape drops expired open-ended events; hide them between scrapes too.
  const events = useMemo(
    () => feedEvents.filter((event) => !openEndedExpired(event, now)),
    [feedEvents, now],
  );
  const today = dateKey(now);
  const [initial] = useState(initialUrlState);
  const [storedView, setStoredView] = usePersistentState<View>(
    "molu.view.v3",
    "timeline",
    isView,
  );
  const [view, setView] = useState<View>(
    isView(initial.view) ? initial.view : storedView,
  );
  const [filter, setFilter] = useState<Filter>(
    isFilter(initial.filter) ? initial.filter : "all",
  );
  const [selected, setSelected] = useState(
    initial.date ?? (initial.month ? `${initial.month}-01` : today),
  );
  const [month, setMonth] = useState(initial.month ?? selected.slice(0, 7));
  const [detailId, setDetailId] = useState<string | null>(initial.event);
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [momoOpen, setMomoOpen] = useState(false);
  const [momoUnread, setMomoUnread] = useState(0);
  const [query, setQuery] = useState(initial.query);
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  const jump = useRef(-1);
  const { bookmarks, toggle } = useBookmarks();

  // Timeline rows already group every category; only the bookmark filter applies there.
  const activeFilter =
    view === "timeline" && filter !== "bookmarks" ? "all" : filter;
  const visible = useMemo(
    () =>
      events.filter(
        (event) =>
          activeFilter === "all" ||
          (activeFilter === "bookmarks"
            ? bookmarks.has(event.id)
            : event.category === activeFilter),
      ),
    [events, activeFilter, bookmarks],
  );
  const found = useMemo(() => {
    const match = eventMatcher(query);
    if (!match) return null;
    const live = (event: FeedEvent) =>
      (endMoment(event) ?? Infinity) > now ? 0 : 1;
    return visible
      .filter(match)
      .sort((a, b) => live(a) - live(b) || startMoment(a) - startMoment(b));
  }, [visible, query, now]);
  const matches = useMemo(
    () => (found ? new Set(found.map((event) => event.id)) : null),
    [found],
  );
  const detail = detailId
    ? (events.find((event) => event.id === detailId) ?? null)
    : null;

  useEffect(() => {
    const params = new URLSearchParams();
    if (month !== today.slice(0, 7)) params.set("month", month);
    if (selected !== today && selected.startsWith(month))
      params.set("date", selected);
    // Include the default view too, overriding the recipient's stored preference.
    params.set("view", view);
    if (activeFilter !== "all") params.set("filter", activeFilter);
    if (detailId) params.set("event", detailId);
    if (query.trim()) params.set("q", query.trim());
    const search = params.toString();
    const next = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
    if (next !== `${location.pathname}${location.search}${location.hash}`)
      history.replaceState(null, "", next);
  }, [month, selected, view, activeFilter, detailId, today, query]);

  const select = (day: string) => {
    setSelected(day);
    setMonth(day.slice(0, 7));
  };

  const [lastToday, setLastToday] = useState(today);
  if (lastToday !== today) {
    setLastToday(today);
    if (selected === lastToday) select(today);
  }

  const findNext = (step: number) => {
    if (!found?.length) return;
    jump.current = (jump.current + step + found.length) % found.length;
    const event = found[jump.current]!;
    select(
      overlaps(event, today, addDays(today, 1)) ? today : span(event).first,
    );
    setFlash((current) => ({ id: event.id, n: (current?.n ?? 0) + 1 }));
  };

  const calendar = {
    events: visible,
    shown: matches ? visible.filter((event) => matches.has(event.id)) : visible,
    matches,
    flash,
    month,
    selected,
    today,
    now,
    bookmarks,
    select,
    open: setDetailId,
  };
  return (
    <CalendarContext value={calendar}>
      <a
        className="fixed -top-25 left-4 z-100 rounded-lg bg-ink px-4 py-3 text-white focus:top-3"
        href="#board"
      >
        캘린더로 바로 가기
      </a>
      <main className="mx-auto flex h-dvh min-h-[620px] max-w-[1520px] flex-col px-5 py-3.5 max-md:h-auto max-md:min-h-0 max-md:px-3 max-md:pt-2.5 max-md:pb-6 max-sm:px-2 max-sm:pt-2">
        <section
          id="board"
          aria-labelledby="month-heading"
          className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_310px] grid-rows-[minmax(0,1fr)] overflow-clip border border-t-4 border-frame border-t-accent bg-surface shadow-paper max-lg:grid-cols-[minmax(0,1fr)_270px] max-md:block max-md:flex-none max-sm:shadow-paper-sm"
        >
          <div className="flex min-h-0 min-w-0 flex-col">
            <Toolbar
              view={view}
              filter={activeFilter}
              query={query}
              found={found}
              onView={(next) => {
                setView(next);
                setStoredView(next);
              }}
              onFilter={setFilter}
              onQuery={(next) => {
                setQuery(next);
                setFlash(null);
                jump.current = -1;
              }}
              onFind={findNext}
              unread={momoUnread}
              onMomoTalk={() => setMomoOpen(true)}
            />
            <div
              className={cx(
                "flex min-h-0 min-w-0 flex-1 flex-col *:min-h-0 *:flex-1 max-md:flex-none",
                view === "list"
                  ? "max-md:*:flex-none"
                  : "max-md:h-[calc(100dvh-var(--chrome))] max-md:min-h-[460px] max-sm:min-h-[440px] max-xs:h-[calc(100dvh-200px)]",
                view === "timeline"
                  ? "[--chrome:130px] max-sm:[--chrome:180px]"
                  : "[--chrome:180px] max-sm:[--chrome:230px]",
              )}
            >
              {view === "timeline" ? (
                <Timeline />
              ) : view === "month" ? (
                <MonthGrid />
              ) : (
                <Agenda />
              )}
            </div>
          </div>
          <DayBriefing
            onSources={() => setSourcesOpen(true)}
            onSubscribe={() => setSubscribeOpen(true)}
          />
        </section>
      </main>
      <EventDialog
        event={detail}
        now={now}
        bookmarked={!!detail && bookmarks.has(detail.id)}
        onBookmark={toggle}
        onClose={() => setDetailId(null)}
        onShowDay={(day) => {
          select(day);
          setDetailId(null);
          document.getElementById("board")?.scrollIntoView({ block: "start" });
        }}
      />
      <MomoTalk
        events={events}
        open={momoOpen}
        onClose={() => setMomoOpen(false)}
        onUnread={setMomoUnread}
      />
      <SourcesDialog open={sourcesOpen} onClose={() => setSourcesOpen(false)} />
      <SubscribeDialog
        open={subscribeOpen}
        onClose={() => setSubscribeOpen(false)}
        bookmarked={events.filter((event) => bookmarks.has(event.id))}
      />
    </CalendarContext>
  );
}
