import { useMemo } from "react";
import { useCalendar } from "../hooks/calendar.ts";
import {
  CATEGORIES,
  DAY_MS,
  addDays,
  dayLabel,
  endMoment,
  overlaps,
  phase,
  remainingLabel,
} from "../lib/calendar/calendar.ts";
import { cx } from "../lib/cx.ts";
import type { FeedEvent } from "../lib/calendar/feed.ts";
import { BannerGallery } from "./BannerGallery.tsx";
import { Icon } from "./Icon.tsx";
import { SectionTitle, categoryStyle } from "./ui.tsx";

function EventCard({
  event,
  closing = false,
}: {
  event: FeedEvent;
  closing?: boolean;
}) {
  const { now, open } = useCalendar();
  const remaining = remainingLabel(event, now);
  const category = event.label ?? CATEGORIES[event.category].label;
  return (
    <li>
      <button
        type="button"
        className={cx(
          "mark day-card relative flex min-h-9 w-full items-center gap-1.5 px-[7px] py-[5px] text-xs",
          phase(event, now) === "ended" && "is-past",
        )}
        style={categoryStyle(event)}
        onClick={() => open(event.id)}
        title={`${category} · ${event.title}`}
        aria-label={[category, event.title, remaining]
          .filter(Boolean)
          .join(" · ")}
      >
        <span className="min-w-0 flex-1 truncate leading-[1.4]">
          {event.title}
        </span>
        {remaining ? (
          <span
            className={cx(
              "shrink-0 pl-0.5 numeric text-2xs/[1.3] whitespace-nowrap",
              closing && "text-danger",
            )}
            aria-label={remaining}
          >
            <strong aria-hidden="true" className="font-medium">
              {remaining.split(" ").at(-1)}
            </strong>
          </span>
        ) : (
          <Icon name="chevron" className="size-3 opacity-80" />
        )}
      </button>
    </li>
  );
}

const list = "mt-2 flex flex-col gap-[5px]";
const sectionHeading = "font-body! font-semibold! text-ink";

export function DayBriefing({
  onSources,
  onSubscribe,
}: {
  onSources: () => void;
  onSubscribe: () => void;
}) {
  const { events, selected, today, now, open } = useCalendar();
  const closing = useMemo(
    () =>
      events
        .filter(
          (event) =>
            event.category !== "maintenance" && phase(event, now) === "ongoing",
        )
        .filter((event) => {
          const end = endMoment(event);
          return end !== null && end - now <= 3 * DAY_MS;
        })
        .sort((a, b) => endMoment(a)! - endMoment(b)!),
    [events, now],
  );
  const { ongoing, hasSelectedEvents } = useMemo(() => {
    const onDay = events.filter((event) =>
      overlaps(event, selected, addDays(selected, 1)),
    );
    // The closing section shows on every selected day, so never repeat its events here.
    const closingIds = new Set(closing.map((event) => event.id));
    return {
      ongoing: onDay.filter((event) => !closingIds.has(event.id)),
      hasSelectedEvents: onDay.length > 0,
    };
  }, [events, selected, closing]);

  const banners = useMemo(
    () =>
      [...closing, ...ongoing]
        .filter((event) => event.images?.[0])
        .sort(
          (a, b) => (endMoment(a) ?? Infinity) - (endMoment(b) ?? Infinity),
        ),
    [closing, ongoing],
  );

  const footerLink =
    "inline-flex min-h-8 items-center gap-[5px] text-blue underline underline-offset-2 transition-colors hover:text-blue-strong [&_.icon]:size-3.5";
  return (
    <aside
      className="flex min-h-0 flex-col border-l border-line [--inset-t:16px] [--inset-x:16px] max-md:border-t max-md:border-l-0"
      aria-label="선택한 날짜의 일정"
    >
      <div className="min-h-0 flex-1 scroll-thin overflow-y-auto overscroll-contain px-(--inset-x) pt-(--inset-t) pb-5 max-md:overflow-visible">
        <BannerGallery key={selected} events={banners} onOpen={open} />
        <header className="mt-4 mb-5">
          <h2 className="font-display text-lg/[1.4] font-medium text-blue">
            {selected === today ? "오늘" : dayLabel(selected)} 일정
          </h2>
        </header>
        {closing.length > 0 && (
          <section aria-labelledby="closing-title">
            <SectionTitle
              id="closing-title"
              count={closing.length}
              className={sectionHeading}
            >
              곧 끝나요
            </SectionTitle>
            <ul className={list}>
              {closing.map((event) => (
                <EventCard
                  key={`${selected}-${event.id}`}
                  event={event}
                  closing
                />
              ))}
            </ul>
          </section>
        )}
        {hasSelectedEvents ? (
          <>
            {ongoing.length > 0 && (
              <section
                className={closing.length ? "mt-5" : undefined}
                aria-labelledby="ongoing-title"
              >
                <SectionTitle
                  id="ongoing-title"
                  count={ongoing.length}
                  className={sectionHeading}
                >
                  계속 진행 중
                </SectionTitle>
                <ul className={list}>
                  {ongoing.map((event) => (
                    <EventCard key={`${selected}-${event.id}`} event={event} />
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <div className="px-1 pt-7 pb-5 text-center">
            <span
              className="mx-auto mb-4 block h-2.5 w-[34px] -rotate-16 rounded-[50%] border-2 border-sky"
              aria-hidden="true"
            />
            <strong className="text-md font-semibold text-ink">
              잠깐, 쉬어 가도 괜찮아요.
            </strong>
            <p className="mt-1 text-sm text-muted">
              이 날짜에는 등록된 일정이 없어요.
            </p>
          </div>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line-soft bg-weekend px-(--inset-x) py-0.5 text-xs whitespace-nowrap text-muted max-md:whitespace-normal">
        <button type="button" className={footerLink} onClick={onSources}>
          데이터와 출처
        </button>
        <button
          type="button"
          className={footerLink}
          onClick={onSubscribe}
          title="Google·Apple 캘린더에서 구독"
        >
          <Icon name="rss" />
          구독
        </button>
      </footer>
    </aside>
  );
}
