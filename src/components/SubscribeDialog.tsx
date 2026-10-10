import { sitePath } from "../lib/urls.ts";
import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { CATEGORIES } from "../lib/calendar/calendar.ts";
import { cx } from "../lib/cx.ts";
import type { Category, FeedEvent } from "../lib/calendar/feed.ts";
import { downloadICS } from "../lib/calendar/ics.ts";
import { Icon } from "./Icon.tsx";
import {
  Count,
  Dialog,
  dialogHeading,
  dialogLead,
  primaryButton,
  quietButton,
  smallButton,
} from "./ui.tsx";

const CALENDARS = ["Google", "Apple", "Outlook", "기타"] as const;
type Calendar = (typeof CALENDARS)[number];
type Scope = "all" | "game" | "category";
const SCOPES = [
  ["game", "게임 일정", "픽업 · 이벤트 · 총력전 · 캠페인 · 스토리"],
  ["all", "전체 일정", "게임 일정에 점검 · 제휴 소식까지"],
  ["category", "한 종류만", "관심 있는 일정 분류를 선택"],
] as const;
const HOW_TO: Record<Calendar, ReactNode> = {
  Google: (
    <>
      컴퓨터에서 <b>다른 캘린더 + → URL로 추가</b>에 주소를 붙여 넣어 주세요.
    </>
  ),
  Apple: "아래 버튼으로 캘린더를 열고 구독을 확인해 주세요.",
  Outlook: (
    <>
      <b>캘린더 추가 → 웹에서 구독</b>에 주소를 붙여 넣어 주세요.
    </>
  ),
  기타: (
    <>
      <b>URL로 추가</b> 또는 <b>캘린더 구독</b> 메뉴에 주소를 붙여 넣어 주세요.
    </>
  ),
};

const fieldset =
  "mt-[22px] min-w-0 [&>legend]:mb-2.5 [&>legend]:text-md [&>legend]:font-semibold [&>legend]:text-ink";
const input = "w-full min-w-0 rounded-lg border px-3 py-[9px]";

export function SubscribeDialog({
  open,
  onClose,
  bookmarked,
}: {
  open: boolean;
  onClose: () => void;
  bookmarked: FeedEvent[];
}) {
  const [scope, setScope] = useState<Scope>("game");
  const [category, setCategory] = useState<Category>("pickup");
  const [calendar, setCalendar] = useState<Calendar>("Google");
  const [copyStatus, setCopyStatus] = useState("");
  const key = `${open}${scope}${category}${calendar}`;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setCopyStatus("");
  }

  const url = new URL(
    sitePath(`feeds/${scope === "category" ? category : scope}.ics`),
    location.origin,
  ).href;
  const label =
    scope === "all"
      ? "전체 일정"
      : scope === "game"
        ? "게임 일정"
        : CATEGORIES[category].label;
  const copied = copyStatus.startsWith("주소를");
  const copy = async (event: MouseEvent<HTMLButtonElement>) => {
    // React clears currentTarget once the handler yields, so grab it before awaiting.
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("주소를 복사했어요. 캘린더에 붙여 넣어 주세요.");
    } catch {
      const address = button.closest("section")?.querySelector("input");
      address?.focus();
      address?.select();
      setCopyStatus(
        "자동 복사를 사용할 수 없어요. 선택된 주소를 직접 복사해 주세요.",
      );
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="캘린더 구독"
      icon="rss"
      labelledBy="subscribe-title"
      className="w-[560px]"
    >
      <h2 id="subscribe-title" className={dialogHeading}>
        필요한 일정만, 내 캘린더에
      </h2>
      <p className={dialogLead}>
        한 번 추가하면 새 일정과 변경 사항을 캘린더에서 받아볼 수 있어요.
      </p>

      <fieldset className={fieldset}>
        <legend>어떤 일정을 받아볼까요?</legend>
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {SCOPES.map(([value, title, detail]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-3 px-3.5 py-[11px] transition-colors hover:bg-hover has-checked:bg-selected"
            >
              <input
                type="radio"
                name="subscription-scope"
                value={value}
                checked={scope === value}
                onChange={() => setScope(value)}
                className="m-0 size-[17px] shrink-0 accent-blue"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <strong className="text-md text-ink">{title}</strong>
                <small className="text-xs text-muted">{detail}</small>
              </span>
            </label>
          ))}
        </div>
        {scope === "category" && (
          <label className="mt-2.5 flex items-center gap-3 text-sm">
            일정 분류
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as Category)}
              className={cx(input, "flex-1 border-control bg-surface text-ink")}
            >
              {(
                Object.entries(CATEGORIES) as [
                  Category,
                  (typeof CATEGORIES)[Category],
                ][]
              ).map(([key, info]) => (
                <option key={key} value={key}>
                  {info.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </fieldset>

      <fieldset className={fieldset}>
        <legend>어느 캘린더를 사용하세요?</legend>
        <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
          {CALENDARS.map((value) => (
            <label
              key={value}
              className="group relative min-w-0 flex-1 cursor-pointer"
            >
              <input
                type="radio"
                name="subscription-calendar"
                checked={calendar === value}
                onChange={() => setCalendar(value)}
                className="peer absolute m-0 size-full opacity-0"
              />
              <span className="flex flex-col items-center justify-center gap-1.5 rounded-[8px] border border-transparent px-1 py-2.5 text-center text-sm font-semibold text-muted transition-colors group-hover:text-ink peer-checked:border-control peer-checked:bg-surface peer-checked:text-ink peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus [&>*]:size-[22px] [&>*]:shrink-0 [&>*]:object-contain">
                {value === "기타" ? (
                  <Icon name="calendar" />
                ) : (
                  <img
                    src={sitePath(`brands/${value.toLowerCase()}.svg`)}
                    alt=""
                    width="22"
                    height="22"
                  />
                )}
                {value}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <section
        className="mt-5 border-t border-line pt-[18px] text-sm/[1.7]"
        aria-label={`${calendar}에 ${label} 추가`}
      >
        <div className="flex items-center gap-2 text-md text-ink">
          <Icon name="calendar" className="size-[17px] text-blue" />
          <strong>{label}</strong>
          <span className="ml-auto text-xs font-semibold text-blue">
            자동 업데이트
          </span>
        </div>
        <p className="mt-2.5">{HOW_TO[calendar]}</p>
        <label className="mt-3 flex flex-col gap-[5px] text-xs text-muted">
          구독 주소
          <input
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
            className={cx(
              input,
              "border-line bg-surface-2 px-2.5 text-xs text-body focus-visible:border-accent focus-visible:shadow-ring focus-visible:outline-0",
            )}
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2 *:flex-1">
          {calendar === "Apple" && (
            <a
              className={primaryButton}
              href={url.replace(/^https?:/, "webcal:")}
            >
              <Icon name="external" />
              Apple 캘린더에서 열기
            </a>
          )}
          <button
            type="button"
            className={calendar === "Apple" ? quietButton : primaryButton}
            onClick={copy}
          >
            <Icon name={copied ? "check" : "link"} />
            {calendar === "Apple"
              ? "주소 복사"
              : copied
                ? "주소 복사됨"
                : "구독 주소 복사"}
          </button>
        </div>
        <p className="mt-2.5 text-blue-strong empty:hidden" role="status">
          {copyStatus}
        </p>
        <p className="mt-2.5 text-xs text-muted">
          변경 사항이 표시되는 시점은 캘린더 앱의 갱신 주기에 따라 달라요.
        </p>
      </section>

      <details className="group mt-5 border-t border-line pt-3.5 text-xs/[1.65] text-muted [&_p]:mt-2.5">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-[7px] text-sm text-body [&_.icon]:size-[15px] [&::-webkit-details-marker]:hidden">
          <Icon name="bookmark" className="text-bookmark" />
          북마크한 일정만 내보내기
          <Count n={bookmarked.length} className="ml-auto" />
          <Icon
            name="chevron"
            className="text-subtle transition-transform group-open:rotate-90"
          />
        </summary>
        <p>
          북마크는 이 브라우저에 저장돼요. 파일을 캘린더에 가져올 수 있지만,
          이후 변경 사항은 자동으로 반영되지 않아요.
        </p>
        <button
          type="button"
          className={cx(quietButton, smallButton, "mt-2.5")}
          disabled={!bookmarked.length}
          onClick={() =>
            downloadICS(
              bookmarked,
              "MOLU · 북마크한 일정",
              "molu-bookmarks.ics",
            )
          }
        >
          <Icon name="download" />
          북마크 .ics 다운로드
        </button>
        {!bookmarked.length && <p>일정에서 북마크를 누르면 여기에 모여요.</p>}
      </details>
    </Dialog>
  );
}
