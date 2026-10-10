import { sitePath } from "../lib/urls.ts";
import { useState } from "react";
import {
  clockLabel,
  dateKey,
  dayLabel,
  periodRange,
  span,
} from "../lib/calendar/calendar.ts";
import { cx } from "../lib/cx.ts";
import type { FeedEvent } from "../lib/calendar/feed.ts";
import { downloadICS } from "../lib/calendar/ics.ts";
import { EventArt } from "./EventArt.tsx";
import { Icon } from "./Icon.tsx";
import {
  Countdown,
  Dialog,
  SectionTitle,
  TagLine,
  categoryStyle,
  dialogHeading,
  iconButton,
  primaryButton,
  quietButton,
  smallButton,
} from "./ui.tsx";

interface Props {
  event: FeedEvent | null;
  now: number;
  bookmarked: boolean;
  onBookmark: (id: string) => void;
  onClose: () => void;
  onShowDay: (day: string) => void;
}

const updated = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  dateStyle: "medium",
  timeStyle: "short",
});

function Endpoint({
  label,
  clock,
  date,
  note,
}: {
  label: string;
  clock: string;
  date: string;
  note?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-semibold text-muted">{label}</span>
      <strong className="numeric text-2xl/[1.1] text-blue max-sm:text-[24px]">
        {clock}
      </strong>
      <span className="text-sm text-body">{date}</span>
      {note && <span className="text-xs text-warn">{note}</span>}
    </div>
  );
}

function Times({ event }: { event: FeedEvent }) {
  const { first, last } = span(event);
  const box =
    "mt-4 grid items-center gap-4 rounded-sm border border-line bg-surface-2 px-[18px] py-3.5 max-sm:grid-cols-1 max-sm:gap-[9px] max-sm:p-3.5";
  if (event.kind === "deadline") {
    return (
      <div className={cx(box, "grid-cols-1")}>
        <Endpoint
          label="마감"
          clock={event.all_day ? "종일" : clockLabel(event.start)}
          date={dayLabel(first, true)}
        />
      </div>
    );
  }
  const start = event.start_after_maintenance ? (
    <Endpoint
      label="시작"
      clock="점검 후"
      date={dayLabel(first, true)}
      note={`예정 ${clockLabel(event.start)} · 점검이 길어지면 늦어져요`}
    />
  ) : (
    <Endpoint
      label="시작"
      clock={event.all_day ? "종일" : clockLabel(event.start)}
      date={dayLabel(first, true)}
    />
  );
  let end;
  if (event.kind === "release")
    end = (
      <Endpoint label="종료" clock="상시" date="종료 없이 계속 이용 가능" />
    );
  else if (!event.end)
    end = (
      <Endpoint
        label="종료"
        clock="미정"
        date={event.end_note ?? "종료 시각 미발표"}
      />
    );
  else if (event.all_day)
    end = <Endpoint label="종료" clock="종일" date={dayLabel(last, true)} />;
  else
    end = (
      <Endpoint
        label="종료"
        clock={dateKey(event.end) > last ? "24:00" : clockLabel(event.end)}
        date={dayLabel(last, true)}
      />
    );
  return (
    <div className={cx(box, "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]")}>
      {start}
      <span
        className="text-[19px] text-subtle max-sm:ml-1.5 max-sm:rotate-90 max-sm:justify-self-start"
        aria-hidden="true"
      >
        →
      </span>
      {end}
    </div>
  );
}

const section = "mt-[22px] [&>h3]:mb-2";
const note = "mt-2 text-xs text-muted";

export function EventDialog({
  event,
  now,
  bookmarked,
  onBookmark,
  onClose,
  onShowDay,
}: Props) {
  const [imageIndex, setImageIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(event);
  if (shown !== event) {
    setShown(event);
    setImageIndex(0);
    setCopied(false);
  }

  const copyLink = async () => {
    if (!event) return;
    const url = new URL(
      sitePath(`?event=${encodeURIComponent(event.id)}`),
      location.origin,
    ).href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      window.prompt("이 일정의 링크", url);
    }
  };

  const images = event?.images ?? [];
  return (
    <Dialog
      open={!!event}
      onClose={onClose}
      label="일정 정보"
      labelledBy="event-title"
      className="w-[600px]"
      actions={
        event && (
          <>
            <button
              type="button"
              className={iconButton}
              aria-pressed={bookmarked}
              onClick={() => onBookmark(event.id)}
              aria-label={bookmarked ? "북마크 해제" : "북마크"}
            >
              <Icon name="bookmark" filled={bookmarked} />
            </button>
            <button
              type="button"
              className={iconButton}
              onClick={copyLink}
              aria-label="링크 복사"
            >
              <Icon name={copied ? "check" : "link"} />
            </button>
            <button
              type="button"
              className={iconButton}
              onClick={() =>
                downloadICS([event], event.title, `molu-${event.id}.ics`)
              }
              aria-label="내 캘린더에 추가 (.ics)"
            >
              <Icon name="download" />
            </button>
          </>
        )
      }
    >
      {event && (
        <article style={categoryStyle(event)}>
          <figure className="mb-4">
            <EventArt event={event} index={imageIndex} eager size="large" />
            {images.length > 1 && (
              <div
                className="mt-2 flex gap-1.5 overflow-x-auto"
                role="group"
                aria-label="이미지 선택"
              >
                {images.map((src, index) => (
                  <button
                    key={src}
                    type="button"
                    aria-pressed={index === imageIndex}
                    aria-label={`이미지 ${index + 1}`}
                    onClick={() => setImageIndex(index)}
                    className="aspect-video flex-[0_0_76px] overflow-hidden rounded-sm opacity-50 transition-opacity hover:opacity-80 aria-pressed:opacity-100 aria-pressed:shadow-[0_0_0_2px_var(--color-accent)]"
                  >
                    <img
                      src={src}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="size-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </figure>
          <div className="flex items-baseline justify-between gap-2">
            <TagLine event={event} status />
            <Countdown
              event={event}
              now={now}
              className="ml-auto shrink-0 text-xs!"
            />
          </div>
          <h2 id="event-title" className={cx(dialogHeading, "mt-2")}>
            {event.title}
          </h2>
          <Times event={event} />

          {!!event.periods?.length && (
            <section className={section}>
              <SectionTitle>세부 일정</SectionTitle>
              <dl className="flex flex-col border-t border-line">
                {event.periods.map((period) => (
                  <div
                    key={period.label}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-3 border-b border-line-soft py-[9px] text-md max-sm:grid-cols-1 max-sm:gap-0.5"
                  >
                    <dt className="font-semibold text-ink">{period.label}</dt>
                    <dd className="text-body tabular-nums">
                      {periodRange(period)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {!!event.students?.length && (
            <section className={section}>
              <SectionTitle>모집 학생</SectionTitle>
              <ul className="flex flex-wrap gap-[5px]">
                {event.students.map((name) => (
                  <li
                    key={name}
                    className="border-l-2 border-(--event-color) bg-(--event-tint) px-[9px] py-[3px] text-sm font-semibold text-(--event-ink)"
                  >
                    {name}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(!!event.notes?.length || event.description) && (
            <section className={section}>
              <SectionTitle>참고</SectionTitle>
              <ul className="flex max-w-[70ch] flex-col gap-1 *:relative *:pl-3 *:text-md/[1.7] *:wrap-anywhere *:before:absolute *:before:top-[.72em] *:before:left-px *:before:size-1 *:before:rounded-full *:before:bg-sky">
                {event.description && <li>{event.description}</li>}
                {event.notes?.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          )}
          <section className={section}>
            <SectionTitle>공식 공지</SectionTitle>
            <ul className="flex flex-col gap-1.5">
              {event.sources.map((source, index) => (
                <li key={source.url}>
                  <a
                    className={cx(
                      index === 0 ? primaryButton : quietButton,
                      "w-full justify-start [&_.icon]:size-[15px]",
                    )}
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span
                      className={cx(
                        "shrink-0 rounded-sm px-1.5 py-px text-xs",
                        index === 0
                          ? "bg-(--glass)"
                          : "bg-surface-2 text-muted",
                      )}
                    >
                      {source.board}
                    </span>
                    <span className="flex-1 truncate text-left">
                      {source.title}
                    </span>
                    <Icon name="external" />
                  </a>
                </li>
              ))}
            </ul>
            <p className={note}>
              공지에서 자동으로 정리한 일정이에요. 정확한 내용은 원문을 확인해
              주세요.
            </p>
            {images.length > 0 && (
              <p className={note}>
                이미지 출처: 블루 아카이브 공식 공지 (© NEXON Games)
              </p>
            )}
          </section>
          <footer className="mt-[22px] flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-t border-line pt-3.5 text-xs text-muted">
            <button
              type="button"
              className={cx(quietButton, smallButton)}
              onClick={() => onShowDay(span(event).first)}
            >
              <Icon name="calendar" />
              달력에서 보기
            </button>
            <span>업데이트 {updated.format(new Date(event.updated_at))}</span>
            <code className="ml-auto text-2xs text-subtle">{event.id}</code>
          </footer>
        </article>
      )}
    </Dialog>
  );
}
