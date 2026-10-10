import { useEffect, useMemo, useRef } from "react";
import { useCalendar } from "../hooks/calendar.ts";
import {
  WEEKDAYS,
  overlaps,
  phase,
  rangeLabel,
  shiftMonth,
  span,
  weekday,
} from "../lib/calendar/calendar.ts";
import { cx } from "../lib/cx.ts";
import type { FeedEvent } from "../lib/calendar/feed.ts";
import { EventArt } from "./EventArt.tsx";
import { Icon } from "./Icon.tsx";
import { Count, Countdown, TagLine, categoryStyle } from "./ui.tsx";

function DateStrip({
  day,
  today,
  count,
}: {
  day: string;
  today: string;
  count: number;
}) {
  const wd = day === "before" ? -1 : weekday(day);
  return (
    <h3
      className={cx(
        "sticky top-0 z-2 flex items-center gap-2 border-b border-line-soft bg-surface-2 px-5 py-1.5 font-display text-sm/none font-medium text-ink in-[section+section]:border-t max-sm:px-3",
        wd === 0 && "text-sunday",
        wd === 6 && "text-saturday",
      )}
    >
      {day === "before" ? (
        "지난달부터 진행 중"
      ) : (
        <>
          <span
            className={cx(
              "grid h-6 min-w-6 place-items-center rounded-lg px-1 pt-px numeric",
              day === today && "bg-accent-strong text-white",
            )}
          >
            {+day.slice(8)}
          </span>
          <span
            className={cx("text-xs", wd !== 0 && wd !== 6 && "text-subtle")}
          >
            {WEEKDAYS[wd]}요일{day === today ? " · 오늘" : ""}
          </span>
        </>
      )}
      <Count n={count} className="ml-auto" />
    </h3>
  );
}

export function Agenda() {
  const {
    shown: events,
    month,
    today,
    now,
    bookmarks,
    flash,
    open,
  } = useCalendar();
  const list = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const from = `${month}-01`;
    const to = `${shiftMonth(month, 1)}-01`;
    const map = new Map<string, FeedEvent[]>();
    for (const event of events.filter((item) => overlaps(item, from, to))) {
      const first = span(event).first;
      const key = first < from ? "before" : first;
      map.set(key, [...(map.get(key) ?? []), event]);
    }
    return [...map.entries()];
  }, [events, month]);

  useEffect(() => {
    if (!flash) return;
    list.current
      ?.querySelector(`[data-event="${CSS.escape(flash.id)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [flash, month]);

  if (!groups.length) return <Empty />;
  return (
    <div
      className="scroll-thin overflow-y-auto overscroll-contain max-md:overflow-visible max-md:overscroll-auto"
      ref={list}
    >
      {groups.map(([key, items]) => (
        <section key={key}>
          <DateStrip day={key} today={today} count={items.length} />
          <ul>
            {items.map((event) => (
              <li
                key={event.id}
                className="border-b border-line-soft last:border-b-0"
              >
                <button
                  key={flash?.id === event.id ? flash.n : undefined}
                  type="button"
                  data-event={event.id}
                  className={cx(
                    "relative grid w-full grid-cols-[80px_minmax(0,1fr)_auto] items-center gap-3.5 px-5 py-2 text-left transition hover:bg-hover focus-visible:-outline-offset-3 max-sm:grid-cols-[64px_minmax(0,1fr)] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-3",
                    phase(event, now) === "ended" && "is-past",
                    flash?.id === event.id && "is-flash",
                  )}
                  style={categoryStyle(event)}
                  onClick={() => open(event.id)}
                >
                  <EventArt
                    event={event}
                    size="thumb"
                    className="max-sm:row-span-2 max-sm:self-start"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <TagLine event={event}>
                      {bookmarks.has(event.id) && (
                        <Icon
                          name="bookmark"
                          filled
                          className="size-[13px] text-bookmark"
                        />
                      )}
                    </TagLine>
                    <span
                      className={cx(
                        "truncate text-md/[1.45] font-semibold text-ink max-sm:line-clamp-2 max-sm:whitespace-normal",
                        event.status === "cancelled" && "line-through",
                      )}
                    >
                      {event.title}
                    </span>
                    <span className="text-xs text-muted tabular-nums">
                      {rangeLabel(event)}
                    </span>
                  </span>
                  <Countdown
                    event={event}
                    now={now}
                    className="justify-self-end max-sm:col-start-2 max-sm:justify-self-start"
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function Empty() {
  return (
    <p className="px-5 py-[90px] text-center text-md/[1.9] text-muted">
      이 달에 표시할 일정이 없어요.
      <br />
      다른 분류를 고르거나 다른 달을 확인해 주세요.
    </p>
  );
}
