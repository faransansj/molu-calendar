import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { useCalendar, usePersistentState } from "../hooks/calendar.ts";
import {
  CATEGORIES,
  STATUSES,
  WEEKDAYS,
  addDays,
  clockLabel,
  dayLabel,
  endTag,
  phase,
  rangeLabel,
  span,
  startTag,
  weekday,
} from "../lib/calendar/calendar.ts";
import { cx } from "../lib/cx.ts";
import type { Category } from "../lib/calendar/feed.ts";
import { CATEGORY_KEYS } from "../lib/calendar/feed.ts";
import { layoutTimeline } from "../lib/calendar/timeline.ts";
import type { TimelineItem } from "../lib/calendar/timeline.ts";
import { Empty } from "./Agenda.tsx";
import { Icon } from "./Icon.tsx";
import { Count, Countdown, Diamond, categoryStyle } from "./ui.tsx";

const isCategoryList = (value: unknown): value is Category[] =>
  Array.isArray(value) &&
  value.every((item) => (CATEGORY_KEYS as readonly unknown[]).includes(item));

function prefix(
  item: TimelineItem,
  now: number,
): { text: string; soon: boolean } | null {
  const { event } = item;
  if (event.all_day || item.continuesBefore) return null;
  if (event.kind === "deadline")
    return { text: `${clockLabel(event.start)} 마감`, soon: false };
  if (event.category === "maintenance")
    return { text: clockLabel(event.start), soon: false };
  return startTag(event, now);
}

function suffix(
  item: TimelineItem,
  now: number,
): { text: string; soon: boolean } | null {
  const { event } = item;
  if (item.point || event.category === "maintenance") return null;
  if (item.continuesAfter) {
    if (!event.end) return { text: "~미정", soon: false };
    const { last } = span(event);
    return { text: `~${+last.slice(5, 7)}/${+last.slice(8)}`, soon: false };
  }
  return endTag(event, now);
}

/** Keep header and row measurements in sync with `.tl` in global.css. */
const HEAD_HEIGHT = 49;
const ROW_PADDING = 11;
const LANE_MIN = 22;
const LANE_MAX = 44;

const pct = (value: number) => `${(value * 100).toFixed(4)}%`;

const dayTone = (day: string, today: string, selected: string) => {
  const wd = weekday(day);
  return cx(
    (wd === 0 || wd === 6) && "bg-weekend",
    day === today && "bg-today!",
    day === selected &&
      "bg-selected! shadow-[inset_1px_0_var(--color-selected-line),inset_-1px_0_var(--color-selected-line)]",
  );
};

export function Timeline() {
  const {
    events,
    month,
    selected,
    today,
    now,
    bookmarks,
    matches,
    flash,
    select,
    open,
  } = useCalendar();
  const { days, groups } = useMemo(
    () => layoutTimeline(events, month),
    [events, month],
  );
  const [folded, setFolded] = usePersistentState<Category[]>(
    "molu.timeline.folded.v1",
    [],
    isCategoryList,
  );
  const [hover, setHover] = useState<{
    item: TimelineItem;
    x: number;
    y: number;
    above: boolean;
  } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const [height, setHeight] = useState(0);
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) =>
      setHeight(Math.floor(entry!.contentRect.height)),
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const counts = useMemo(
    () =>
      new Map(
        groups.map((group) => [
          group.category,
          matches
            ? group.items.filter((item) => matches.has(item.event.id)).length
            : null,
        ]),
      ),
    [groups, matches],
  );
  const isFolded = (category: Category) =>
    folded.includes(category) || counts.get(category) === 0;
  const laneHeight = useMemo(() => {
    let fixed = HEAD_HEIGHT;
    let lanes = 0;
    for (const group of groups) {
      if (folded.includes(group.category) || counts.get(group.category) === 0)
        fixed += Math.max(24, group.lanes * 6 + 10) + 1;
      else {
        fixed += ROW_PADDING;
        lanes += group.lanes;
      }
    }
    return lanes && height
      ? Math.max(
          LANE_MIN,
          Math.min(LANE_MAX, Math.floor((height - fixed) / lanes)),
        )
      : LANE_MIN;
  }, [groups, counts, folded, height]);

  useEffect(() => {
    const box = scroller.current;
    const cell = box?.querySelector<HTMLElement>(`[data-date="${selected}"]`);
    if (!box || !cell || box.scrollWidth <= box.clientWidth) return;
    // offsetLeft is measured from the day header, which already starts after the labels.
    box.scrollLeft = Math.max(0, cell.offsetLeft - cell.offsetWidth);
    // Only on month changes: following every selection would fight the user's own scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  useEffect(() => {
    if (!flash) return;
    scroller.current
      ?.querySelector(`[data-event="${CSS.escape(flash.id)}"]`)
      ?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "smooth",
      });
  }, [flash, month]);

  const hovered = hover ? span(hover.item.event) : null;
  const toggle = (category: Category) =>
    setFolded((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category],
    );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const day = (event.target as HTMLElement).dataset.date;
    const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!day || move === undefined) return;
    event.preventDefault();
    const next = addDays(day, move);
    select(next);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`.tl [data-date="${next}"]`)?.focus(),
    );
  };

  const showCard =
    (item: TimelineItem) => (event: PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType !== "mouse") return;
      const rect = event.currentTarget.getBoundingClientRect();
      const above = rect.bottom + 150 > innerHeight;
      setHover({
        item,
        x: Math.min(Math.max(event.clientX - 24, 8), innerWidth - 308),
        y: above ? rect.top - 8 : rect.bottom + 8,
        above,
      });
    };

  if (!groups.length) return <Empty />;

  return (
    <div
      className="tl relative flex min-h-0 flex-col"
      style={
        {
          "--days": days.length,
          "--lane-h": `${laneHeight}px`,
        } as CSSProperties
      }
    >
      <div
        className="min-h-0 flex-1 scroll-thin overflow-auto overscroll-contain"
        ref={scroller}
        onScroll={() => setHover(null)}
      >
        <div
          className="tl__canvas"
          style={{
            gridTemplateRows: [
              "max-content",
              ...groups.map((group) =>
                isFolded(group.category) ? "max-content" : "auto",
              ),
            ].join(" "),
          }}
        >
          <div
            className="sticky top-0 left-0 z-6 col-start-1 row-start-1 flex items-center border-r border-b border-r-line border-b-line-soft bg-surface-2 px-3 font-display text-xs font-medium text-muted max-sm:px-1.5 max-sm:text-2xs"
            aria-hidden="true"
          >
            {matches ? (
              <span className="text-blue">{matches.size}건</span>
            ) : (
              <span>{+month.slice(5)}월</span>
            )}
          </div>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys move between the day buttons inside */}
          <div
            className="tl__days sticky top-0 z-5 col-start-2 row-start-1 border-b border-line-soft bg-surface-2"
            role="group"
            aria-label={`${+month.slice(5)}월 날짜. 방향키로 이동할 수 있어요.`}
            onKeyDown={onKeyDown}
          >
            {days.map((day) => {
              const wd = weekday(day);
              const tone =
                wd === 0 ? "text-sunday" : wd === 6 ? "text-saturday" : "";
              return (
                <button
                  key={day}
                  type="button"
                  data-date={day}
                  tabIndex={day === selected ? 0 : -1}
                  aria-pressed={day === selected}
                  aria-current={day === today ? "date" : undefined}
                  aria-label={`${dayLabel(day, true)}${day === today ? ", 오늘" : ""}`}
                  onClick={() => select(day)}
                  className={cx(
                    "flex flex-col items-center gap-0.5 pt-1.5 pb-[5px] text-ink transition-colors hover:bg-hover-strong",
                    tone,
                    day === selected &&
                      "shadow-[inset_0_-2px_0_var(--color-blue)]",
                    hovered &&
                      day >= hovered.first &&
                      day <= hovered.last &&
                      "bg-span",
                  )}
                >
                  <b
                    className={cx(
                      "grid size-6 place-items-center rounded-full pt-px numeric text-sm/none",
                      day === today && "bg-accent-strong text-white",
                    )}
                  >
                    {+day.slice(8)}
                  </b>
                  <small className={cx("text-2xs/none", tone || "text-subtle")}>
                    {WEEKDAYS[wd]}
                  </small>
                </button>
              );
            })}
          </div>

          <div
            className="tl__days relative col-start-2"
            style={{ gridRow: `2 / ${groups.length + 2}` }}
            aria-hidden="true"
          >
            {days.map((day) => (
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the day header is the keyboard target
              <div
                key={day}
                className={cx(
                  "cursor-pointer border-r border-line-soft transition-colors last-of-type:border-r-0 hover:bg-hover",
                  dayTone(day, today, selected),
                )}
                onClick={() => select(day)}
              />
            ))}
            {hover && !hover.item.point && (
              <div
                className="tl__band pointer-events-none absolute inset-y-0"
                style={{
                  left: pct(hover.item.left),
                  width: pct(hover.item.width),
                  ...categoryStyle(hover.item.event),
                }}
              />
            )}
          </div>

          {groups.map((group, index) => {
            const info = CATEGORIES[group.category];
            const found = counts.get(group.category) ?? null;
            const rowFolded = isFolded(group.category);
            return (
              <div
                key={group.category}
                className={cx("tl__row", rowFolded && "is-folded")}
                style={
                  {
                    ...categoryStyle(group),
                    "--lanes": group.lanes,
                    "--row": index + 2,
                  } as CSSProperties
                }
              >
                <button
                  type="button"
                  className="tl__label"
                  aria-expanded={!rowFolded}
                  onClick={() => toggle(group.category)}
                  title={rowFolded ? "펼치기" : "접기"}
                >
                  <Icon name="chevron" className="tl__fold" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 whitespace-nowrap">
                    <span className="max-sm:hidden">{info.label}</span>
                    <span className="sm:hidden">{info.short}</span>
                    {!rowFolded && <Count n={found ?? group.items.length} />}
                  </span>
                </button>
                <div
                  className="tl__track"
                  role="group"
                  aria-label={`${info.label} ${group.items.length}건`}
                >
                  {group.items.map((item) => {
                    const { event } = item;
                    const lead = prefix(item, now);
                    const tail = suffix(item, now);
                    const work = event.category === "maintenance";
                    return (
                      <button
                        key={`${event.id}${flash?.id === event.id ? flash.n : ""}`}
                        type="button"
                        data-event={event.id}
                        className={cx(
                          "mark",
                          item.point ? "tl-pin" : "tl-bar",
                          `tl--${event.kind}`,
                          work && "work-chip",
                          item.continuesBefore && "is-cut-start",
                          item.continuesAfter && "is-cut-end",
                          phase(event, now) === "ended" && "is-past",
                          event.status === "cancelled" && "is-cancelled",
                          bookmarks.has(event.id) && "is-bookmarked",
                          matches &&
                            (matches.has(event.id) ? "is-match" : "is-dim"),
                          flash?.id === event.id && "is-flash",
                        )}
                        style={
                          {
                            ...categoryStyle(event),
                            left: pct(item.left),
                            width: item.point ? undefined : pct(item.width),
                            "--lane": item.lane,
                          } as CSSProperties
                        }
                        aria-label={`${event.title}, ${rangeLabel(event)}${event.status !== "confirmed" ? `, ${STATUSES[event.status]}` : ""}`}
                        onClick={() => open(event.id)}
                        onPointerEnter={showCard(item)}
                        onPointerLeave={() => setHover(null)}
                      >
                        <span className="tl__text">
                          {work && <Icon name="wrench" className="size-3" />}
                          {lead && (
                            <span
                              className={cx("time", lead.soon && "is-soon")}
                            >
                              {lead.text}
                            </span>
                          )}
                          {!work && (
                            <span className="title truncate">
                              {event.title}
                            </span>
                          )}
                        </span>
                        {tail && (
                          <span
                            className={cx(
                              "time time--end",
                              tail.soon && "is-soon",
                            )}
                          >
                            {tail.text}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {hover && (
        <div
          className={cx(
            "straight-top pointer-events-none fixed z-50 flex w-[300px] animate-[fade-in_.12s_ease-out] flex-col gap-[5px] overflow-hidden rounded-lg border border-frame bg-surface px-3 pt-2.5 pb-[11px] shadow-pop [--top-rule-color:var(--event-color)] [--top-rule-height:3px] *:relative max-sm:hidden",
            hover.above && "-translate-y-full",
          )}
          style={{
            left: hover.x,
            top: hover.y,
            ...categoryStyle(hover.item.event),
          }}
          aria-hidden="true"
        >
          {hover.item.event.images?.[0] && (
            <img
              key={hover.item.event.images[0]}
              className="absolute! inset-0 size-full rounded-[inherit] object-cover opacity-10"
              src={hover.item.event.images[0]}
              alt=""
              decoding="async"
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          )}
          <span className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs/[1.45] font-semibold text-(--event-ink)">
              <Diamond />
              {hover.item.event.label ??
                CATEGORIES[hover.item.event.category].label}
            </span>
            <Countdown
              event={hover.item.event}
              now={now}
              compact
              className="shrink-0"
            />
          </span>
          <strong className="text-md/[1.45] font-semibold wrap-anywhere text-ink">
            {hover.item.event.title}
          </strong>
          <span className="text-xs text-muted tabular-nums">
            {rangeLabel(hover.item.event)}
          </span>
        </div>
      )}
    </div>
  );
}
