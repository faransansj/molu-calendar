import { useEffect, useRef } from "react";
import type { Filter, View } from "../App.tsx";
import { useCalendar } from "../hooks/calendar.ts";
import { CATEGORIES, shiftMonth } from "../lib/calendar/calendar.ts";
import { cx } from "../lib/cx.ts";
import type { Category, FeedEvent } from "../lib/calendar/feed.ts";
import { Icon } from "./Icon.tsx";
import { KstClock } from "./KstClock.tsx";
import { Diamond, categoryStyle } from "./ui.tsx";

interface Props {
  view: View;
  filter: Filter;
  query: string;
  found: FeedEvent[] | null;
  onView: (view: View) => void;
  onFilter: (filter: Filter) => void;
  onQuery: (query: string) => void;
  onFind: (step: number) => void;
  unread: number;
  onMomoTalk: () => void;
}

const VIEWS = [
  { key: "timeline", label: "타임라인 보기", icon: "timeline" },
  { key: "month", label: "달력 보기", icon: "calendar" },
  { key: "list", label: "목록 보기", icon: "list" },
] as const;

const control = "rounded-lg border border-control bg-surface transition-colors";

export function Toolbar({
  view,
  filter,
  query,
  found,
  onView,
  onFilter,
  onQuery,
  onFind,
  unread,
  onMomoTalk,
}: Props) {
  const { month, today, select } = useCalendar();
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (
        target.closest('input, textarea, select, [contenteditable="true"]') ||
        document.querySelector("dialog[open]")
      )
        return;
      event.preventDefault();
      search.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const currentView = VIEWS.find((item) => item.key === view)!;
  const [year, monthNumber] = month.split("-");
  const go = (step: number) => {
    const next = shiftMonth(month, step);
    select(next === today.slice(0, 7) ? today : `${next}-01`);
  };
  const navButton =
    "grid h-8 place-items-center text-blue transition-colors first:rounded-l-lg last:rounded-r-lg hover:bg-hover-strong";

  return (
    <>
      <div className="grid shrink-0 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3 max-sm:grid-cols-[auto_minmax(0,1fr)] max-sm:gap-2 max-sm:p-2.5">
        <div className="col-start-1 row-start-1 flex w-max flex-col gap-1.5 max-sm:contents">
          <KstClock className="max-sm:col-start-1 max-sm:row-start-1" />
          <h1
            id="month-heading"
            className="flex items-baseline justify-end gap-px numeric text-3xl/none whitespace-nowrap text-blue max-sm:col-start-1 max-sm:row-start-2"
            aria-live="polite"
            aria-label={`${year}년 ${+monthNumber!}월 블루 아카이브 일정`}
          >
            <span className="font-light text-muted">{year}.</span>
            <span>{monthNumber}</span>
          </h1>
        </div>
        <div
          className={cx(
            control,
            "col-start-2 row-start-1 flex items-center divide-x divide-control max-sm:row-start-2 max-sm:justify-self-end",
          )}
          role="group"
          aria-label="월 이동"
        >
          <button
            className={cx(navButton, "w-7")}
            type="button"
            onClick={() => go(-1)}
            aria-label="이전 달"
          >
            <Icon name="chevron" className="size-3.5 rotate-180" />
          </button>
          <button
            className={cx(navButton, "w-12 text-xs font-semibold")}
            type="button"
            onClick={() => select(today)}
          >
            오늘
          </button>
          <button
            className={cx(navButton, "w-7")}
            type="button"
            onClick={() => go(1)}
            aria-label="다음 달"
          >
            <Icon name="chevron" className="size-3.5" />
          </button>
        </div>
        <div className="col-start-3 row-start-1 flex w-[min(100%,460px)] min-w-0 items-center gap-2 justify-self-center max-sm:col-span-full max-sm:row-start-3 max-sm:w-full">
          <div
            className={cx(
              control,
              "flex h-[34px] min-w-0 flex-1 items-center gap-[7px] pr-2 pl-2.5 text-muted focus-within:border-accent focus-within:text-blue focus-within:shadow-ring max-sm:h-8",
            )}
            role="search"
          >
            <Icon name="search" className="size-4" />
            <input
              ref={search}
              type="search"
              value={query}
              placeholder="일정 찾기 · 초성도 돼요"
              aria-label="일정 찾기"
              aria-describedby="search-hint"
              enterKeyHint="search"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-subtle focus-visible:outline-0 [&::-webkit-search-cancel-button]:appearance-none"
              onChange={(event) => onQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onFind(event.shiftKey ? -1 : 1);
                }
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  onQuery("");
                }
              }}
            />
            {found ? (
              <span
                className="numeric text-xs/none whitespace-nowrap text-blue"
                aria-live="polite"
              >
                {found.length ? `${found.length}건` : "없음"}
              </span>
            ) : (
              <kbd
                className="rounded-sm border border-line bg-surface-2 px-1.5 py-px numeric text-2xs/[1.4] text-muted max-sm:hidden"
                aria-hidden="true"
              >
                /
              </kbd>
            )}
            <span id="search-hint" hidden>
              Enter로 다음 결과, Shift+Enter로 이전 결과로 이동해요.
            </span>
          </div>
          <button
            className={cx(
              control,
              "grid size-[34px] shrink-0 place-items-center text-muted hover:bg-hover-strong hover:text-blue aria-pressed:border-warn-line aria-pressed:bg-warn-soft aria-pressed:text-warn max-sm:h-8",
            )}
            type="button"
            aria-label="북마크한 일정만 보기"
            title="북마크한 일정만 보기"
            aria-pressed={filter === "bookmarks"}
            onClick={() =>
              onFilter(filter === "bookmarks" ? "all" : "bookmarks")
            }
          >
            <Icon
              name="bookmark"
              filled={filter === "bookmarks"}
              className="size-4"
            />
          </button>
        </div>
        <div className="col-start-4 row-start-1 flex items-center gap-2 justify-self-end max-sm:col-start-2 max-sm:row-start-1">
          <button
            className={cx(
              control,
              "relative grid size-[34px] shrink-0 place-items-center text-blue hover:bg-hover-strong max-sm:size-8",
            )}
            type="button"
            title="MomoTalk"
            aria-label={`모모톡 열기${unread ? `, 읽지 않은 메시지 ${unread}건` : ""}`}
            onClick={onMomoTalk}
          >
            <Icon name="chat" className="size-[17px]" />
            {unread > 0 && (
              <span
                className="absolute -top-1.5 -right-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-blue px-1 numeric text-2xs/none text-white"
                aria-hidden="true"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
          <div
            className={cx(
              control,
              "relative flex h-[34px] w-14 shrink-0 items-center justify-center gap-1.5 text-blue hover:bg-hover-strong has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus max-sm:h-8",
            )}
            title={currentView.label}
          >
            <Icon name={currentView.icon} className="size-[17px]" />
            <Icon name="chevron" className="size-3 rotate-90" />
            <select
              aria-label="보기 방식"
              value={view}
              onChange={(event) => onView(event.target.value as View)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {VIEWS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      {view !== "timeline" && (
        <div
          className="flex shrink-0 [scrollbar-width:none] gap-[22px] overflow-x-auto border-b border-line px-5 max-sm:gap-4 max-sm:px-3"
          role="group"
          aria-label="일정 분류"
        >
          {(["all", ...Object.keys(CATEGORIES)] as ("all" | Category)[]).map(
            (key) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                style={
                  key === "all" ? undefined : categoryStyle({ category: key })
                }
                onClick={() => onFilter(key)}
                className="relative inline-flex shrink-0 items-center gap-[7px] pt-[11px] pb-2.5 text-sm font-semibold text-muted transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:origin-bottom after:scale-y-0 after:bg-(--event-color,var(--color-accent)) after:transition-transform hover:text-ink hover:after:scale-y-[.34] focus-visible:rounded-none focus-visible:-outline-offset-3 aria-pressed:text-ink aria-pressed:after:scale-y-100 max-sm:pt-2.5 max-sm:pb-[9px]"
              >
                {key !== "all" && <Diamond />}
                {key === "all" ? "전체" : CATEGORIES[key].label}
              </button>
            ),
          )}
        </div>
      )}
    </>
  );
}
