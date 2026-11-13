import type { View } from "../App.tsx";
import { CATEGORIES } from "../lib/calendar/calendar.ts";
import type { Category } from "../lib/calendar/feed.ts";
import { CATEGORY_KEYS } from "../lib/calendar/feed.ts";
import { cx } from "../lib/cx.ts";
import { Icon } from "./Icon.tsx";
import { Switch, field, quietButton, smallButton } from "./ui.tsx";

export function CalendarSettings({
  view,
  onView,
  folded,
  onToggleFolded,
  bookmarksOnly,
  onBookmarksOnly,
  onSubscribe,
  onSources,
}: {
  view: View;
  onView: (view: View) => void;
  folded: Category[];
  onToggleFolded: (category: Category) => void;
  bookmarksOnly: boolean;
  onBookmarksOnly: (enabled: boolean) => void;
  onSubscribe: () => void;
  onSources: () => void;
}) {
  return (
    <section aria-labelledby="calendar-settings">
      <h3
        id="calendar-settings"
        className="mb-2.5 flex items-center gap-2 text-md font-semibold text-ink [&_.icon]:size-4 [&_.icon]:text-blue"
      >
        <Icon name="calendar" />
        달력
      </h3>
      <div className="divide-y divide-line rounded-lg border border-line">
        <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
          <label htmlFor="settings-view" className="flex flex-col gap-0.5">
            <strong className="text-md text-ink">보기 방식</strong>
            <span className="text-xs text-muted">
              변경한 보기를 이 브라우저에 기억해요.
            </span>
          </label>
          <select
            id="settings-view"
            className={field}
            value={view}
            onChange={(event) => onView(event.target.value as View)}
          >
            <option value="timeline">타임라인</option>
            <option value="month">달력</option>
            <option value="list">목록</option>
          </select>
        </div>
        <div className="flex items-center justify-between gap-3 px-3.5 py-3">
          <strong className="text-md text-ink">북마크한 일정만 보기</strong>
          <Switch
            label="북마크한 일정만 보기"
            checked={bookmarksOnly}
            onChange={onBookmarksOnly}
          />
        </div>
        <fieldset className="px-3.5 py-3">
          <legend className="float-left mb-2 w-full text-md font-semibold text-ink">
            타임라인 분류 펼치기
          </legend>
          <p className="clear-both mb-3 text-xs text-muted">
            꺼 둔 분류는 타임라인에서 접어서 표시해요.
          </p>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {CATEGORY_KEYS.map((category) => (
              <div
                key={category}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-sm text-body">
                  {CATEGORIES[category].label}
                </span>
                <Switch
                  label={`${CATEGORIES[category].label} 펼치기`}
                  checked={!folded.includes(category)}
                  onChange={() => onToggleFolded(category)}
                />
              </div>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-2 px-3.5 py-3">
          <button
            type="button"
            className={cx(quietButton, smallButton)}
            onClick={onSubscribe}
          >
            <Icon name="rss" />
            캘린더 구독·내보내기
          </button>
          <button
            type="button"
            className={cx(quietButton, smallButton)}
            onClick={onSources}
          >
            <Icon name="info" />
            개인정보 처리방침
          </button>
        </div>
      </div>
    </section>
  );
}
