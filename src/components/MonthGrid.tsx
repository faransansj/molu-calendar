import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useCalendar, useMediaQuery } from "../hooks/calendar.ts";
import {
  STATUSES,
  WEEKDAYS,
  addDays,
  clockLabel,
  dayFraction,
  dayLabel,
  displayDays,
  endClock,
  endTag,
  phase,
  rangeLabel,
  span,
  startTag,
  weekday,
} from "../lib/calendar/calendar.ts";
import { cx } from "../lib/cx.ts";
import { allocateLanes, layoutWeek, weeks } from "../lib/calendar/layout.ts";
import type { Segment } from "../lib/calendar/layout.ts";
import { Icon } from "./Icon.tsx";
import { categoryStyle } from "./ui.tsx";

function barPrefix(
  segment: Segment,
  week: string[],
  now: number,
): { text: string; soon: boolean } | null {
  const { event } = segment;
  if (event.all_day || segment.continuesBefore) return null;
  if (span(event).first !== week[segment.column]) return null;
  if (event.kind === "deadline")
    return { text: `${clockLabel(event.start)} 마감`, soon: false };
  return startTag(event, now);
}

function barEdges(segment: Segment): CSSProperties {
  const { event } = segment;
  if (event.all_day || event.kind !== "interval" || segment.length < 2)
    return {};
  const edge = (fraction: number) =>
    `max(4px, ${((fraction * 100) / segment.length).toFixed(3)}%)`;
  const style: CSSProperties = {};
  if (!segment.continuesBefore)
    style.marginLeft = edge(dayFraction(event.start));
  if (!segment.continuesAfter && event.end)
    style.marginRight = edge(
      endClock(event) === "24:00" ? 0 : 1 - dayFraction(event.end),
    );
  return style;
}

/** Match `.week` in global.css; base includes headers, gaps and borders. */
const GEOMETRY = {
  wide: { base: 66, focusLane: 26, otherLane: 21, floor: 2 },
  compact: { base: 57, focusLane: 22, otherLane: 18, floor: 1 },
};

export function MonthGrid() {
  const {
    shown: events,
    month,
    selected,
    today,
    now,
    bookmarks,
    flash,
    select,
    open,
  } = useCalendar();
  const compact = useMediaQuery("(max-width: 720px)");
  const geometry = compact ? GEOMETRY.compact : GEOMETRY.wide;
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setHeight(Math.floor(entry!.contentRect.height)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Keep maintenance beside the date so it does not consume event lanes.
  const { lanes, maintenance } = useMemo(
    () => ({
      lanes: events.filter((event) => event.category !== "maintenance"),
      maintenance: events.filter((event) => event.category === "maintenance"),
    }),
    [events],
  );
  const grid = useMemo(() => weeks(displayDays(month)), [month]);
  const needed = useMemo(
    () => grid.map((week) => Math.max(1, layoutWeek(lanes, week, 99).lanes)),
    [grid, lanes],
  );
  const focus = Math.max(
    0,
    [selected, today]
      .map((day) => grid.findIndex((week) => week.includes(day)))
      .find((index) => index >= 0) ?? 0,
  );
  const allocation = useMemo(() => {
    if (!height) return needed.map((need) => Math.min(need, 2));
    return allocateLanes(needed, focus, { ...geometry, height });
  }, [height, needed, focus, geometry]);
  const rows = useMemo(
    () =>
      grid.map((week, index) => ({
        week,
        layout: layoutWeek(lanes, week, allocation[index]!),
      })),
    [grid, lanes, allocation],
  );

  useEffect(() => {
    if (!flash) return;
    box.current
      ?.querySelector(`[data-event="${CSS.escape(flash.id)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [flash, month]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const day = (event.target as HTMLElement).dataset.date;
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[
      event.key
    ];
    if (!day || move === undefined) return;
    event.preventDefault();
    const next = addDays(day, move);
    select(next);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus(),
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className="grid shrink-0 grid-cols-7 border-b border-line-soft bg-surface-2"
        aria-hidden="true"
      >
        {WEEKDAYS.map((label) => (
          <span
            key={label}
            className="pt-[7px] pb-1.5 text-center numeric text-xs/none text-subtle first:text-sunday last:text-saturday"
          >
            {label}
          </span>
        ))}
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className="flex min-h-0 flex-1 [scrollbar-width:none] flex-col overflow-y-auto"
        ref={box}
        role="group"
        aria-label={`${+month.slice(5)}월 일정. 날짜에서 방향키로 이동할 수 있어요.`}
        onKeyDown={onKeyDown}
      >
        {rows.map(({ week, layout }, index) => (
          <div
            key={week[0]}
            className={cx("week", index === focus && "is-focus")}
            role="group"
            aria-label={`${dayLabel(week[0]!)} 주`}
            style={
              { "--lanes": Math.max(1, allocation[index]!) } as CSSProperties
            }
          >
            {week.map((day, column) => {
              const works = maintenance.filter(
                (event) => span(event).first === day,
              );
              const wd = weekday(day);
              return (
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the date button is the keyboard target
                <div
                  key={day}
                  style={{ gridColumn: column + 1 }}
                  onClick={() => select(day)}
                  className={cx(
                    "relative row-span-full cursor-pointer border-r border-line-soft transition-colors hover:bg-hover nth-7:border-r-0",
                    (wd === 0 || wd === 6) && "bg-weekend",
                    day === today && "bg-today!",
                    day === selected &&
                      "bg-selected! shadow-[inset_1px_0_var(--color-selected-line),inset_-1px_0_var(--color-selected-line)]",
                  )}
                >
                  <button
                    type="button"
                    data-date={day}
                    tabIndex={day === selected ? 0 : -1}
                    aria-pressed={day === selected}
                    aria-current={day === today ? "date" : undefined}
                    aria-label={`${dayLabel(day, true)}${day === today ? ", 오늘" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      select(day);
                    }}
                    className={cx(
                      "absolute top-1.5 left-1.5 grid size-[26px] place-items-center rounded-full pt-px numeric text-sm/none transition-colors max-sm:top-1 max-sm:left-[3px] max-sm:size-6",
                      day === today
                        ? "bg-accent-strong text-white"
                        : [
                            "hover:bg-hover-strong",
                            wd === 0
                              ? "text-sunday"
                              : wd === 6
                                ? "text-saturday"
                                : "text-ink",
                            !day.startsWith(month) && "opacity-45",
                          ],
                    )}
                  >
                    {+day.slice(8)}
                  </button>
                  {works[0] && (
                    <span className="absolute top-2 right-1.5 left-10 z-1 flex flex-col items-end max-sm:top-1.5 max-sm:right-0.5 max-sm:left-auto">
                      <button
                        type="button"
                        className={cx(
                          "work-chip inline-flex h-[22px] max-w-full items-center gap-1 overflow-hidden pr-1.5 pl-[5px] text-xs/none font-semibold whitespace-nowrap max-sm:h-5 max-sm:px-[3px] [&_.icon]:size-3",
                          phase(works[0], now) === "ended" && "is-past",
                        )}
                        style={categoryStyle(works[0])}
                        title={`${works[0].title} · ${rangeLabel(works[0])}`}
                        aria-label={`${works[0].title}, ${rangeLabel(works[0])}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          open(works[0]!.id);
                        }}
                      >
                        <Icon name="wrench" />
                        <span className="pt-px numeric text-2xs/none max-sm:hidden">
                          {works[0].all_day
                            ? "점검"
                            : clockLabel(works[0].start)}
                        </span>
                        <span className="max-md:hidden">
                          {works[0].label === "정기점검"
                            ? "점검"
                            : (works[0].label ?? "점검")}
                        </span>
                      </button>
                    </span>
                  )}
                  {layout.hidden[column]! > 0 && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        select(day);
                      }}
                      className="absolute bottom-[3px] left-1.5 rounded-sm px-[5px] py-0.5 numeric text-2xs/[1.2] text-subtle transition-colors hover:bg-hover-strong hover:text-blue max-sm:left-1/2 max-sm:-translate-x-1/2"
                    >
                      +{layout.hidden[column]}
                    </button>
                  )}
                </div>
              );
            })}
            {layout.segments.map((segment) => {
              const { event } = segment;
              const prefix = barPrefix(segment, week, now);
              const suffix = segment.continuesAfter ? null : endTag(event, now);
              return (
                <button
                  key={`${event.id}-${week[0]}${flash?.id === event.id ? flash.n : ""}`}
                  type="button"
                  data-event={event.id}
                  className={cx(
                    "mark bar",
                    `bar--${event.kind}`,
                    segment.continuesBefore && "is-cut-start",
                    segment.continuesAfter && "is-cut-end",
                    event.status === "cancelled" && "is-cancelled",
                    phase(event, now) === "ended" && "is-past",
                    bookmarks.has(event.id) && "is-bookmarked",
                    flash?.id === event.id && "is-flash",
                  )}
                  style={{
                    ...categoryStyle(event),
                    ...barEdges(segment),
                    gridColumn: `${segment.column + 1} / span ${segment.length}`,
                    gridRow: segment.lane + 2,
                  }}
                  title={`${event.title} · ${rangeLabel(event)}`}
                  aria-label={`${event.title}, ${rangeLabel(event)}${event.status !== "confirmed" ? `, ${STATUSES[event.status]}` : ""}`}
                  onClick={() => open(event.id)}
                >
                  {prefix && (
                    <span className={cx("time", prefix.soon && "is-soon")}>
                      {prefix.text}
                    </span>
                  )}
                  <span className="title truncate">{event.title}</span>
                  {suffix && (
                    <span
                      className={cx("time time--end", suffix.soon && "is-soon")}
                    >
                      {suffix.text}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
