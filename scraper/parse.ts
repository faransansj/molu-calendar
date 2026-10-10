import { addDays } from "../src/lib/calendar/calendar.ts";
import type { Category, Kind, Period } from "../src/lib/calendar/feed.ts";
import { parseRange, toValue } from "./dates.ts";
import type { ParsedRange } from "./dates.ts";
import type { Block } from "./html.ts";
import { shouldExcludeCalendarEvent } from "./eligibility.ts";

export const BOARDS = {
  1018: "공지사항",
  1076: "업데이트",
  1039: "진행 이벤트",
} as const;
export type BoardId = keyof typeof BOARDS;

export interface Post {
  board: BoardId;
  threadId: string;
  title: string;
  url: string;
  publishedAt: string;
  /** Publication date in KST; the reference for year inference. */
  publishedDay: string;
  blocks: Block[];
}

export interface Draft {
  key: string;
  title: string;
  label?: string;
  category: Category;
  kind: Kind;
  all_day: boolean;
  start: string;
  end?: string;
  start_after_maintenance?: boolean;
  end_note?: string;
  tags: string[];
  students: string[];
  notes: string[];
  periods: Period[];
  images: string[];
  description?: string;
  post: Post;
}

const IGNORED_TITLES =
  /게임 이용 제한|확인된 오류|접속 불가|이모티콘|스티커|음원|확률 정보|당첨자|발표|모집 기준|패스트트랙|사과|보상 지급 완료/;

export function isIgnoredTitle(title: string): boolean {
  return IGNORED_TITLES.test(title);
}

export function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/★\d\s*,?\s*/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function cleanTitle(title: string): string {
  return title
    .replace(
      /^\s*(?:\((?:완료|수정|추가|재공지|\d{1,2}\/\d{1,2}[^)]*)\)\s*)+/,
      "",
    )
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/gu, "")
    .replace(/\[(?:소멸 임박|마감 임박|중요|안내)\]\s*/g, "")
    .replace(/\s*\((?:~|～)[^)]*\)\s*$/, "")
    .replace(/\s*\((?:\d{1,2}\/\d{1,2}\s*)?(?:추가|수정|업데이트)\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function noticeTitle(title: string): string {
  return cleanTitle(title)
    .replace(/^블루 아카이브(?!\s*(?:X|×)\s)\s*(?:ㅣ|\||:)?\s*/, "")
    .replace(/[‘’'“”]/g, "")
    .replace(/\s*(?:예약\s*)?(?:마감|종료)\s*임박!?$/, "")
    .replace(/\s*(?:상세\s*)?(?:예정\s*)?안내!?$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function student(name: string): string {
  return name
    .replace(/\(\s*★\d\s*,\s*/g, "(")
    .replace(/\(\s*★\d\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitStudents(text: string): string[] {
  return text
    .split(/\n|,(?![^()]*\))|&|＆|·/)
    .map((part) => student(part.replace(/^\s*\[복각\]\s*/, "")))
    .filter((part) => part && !/^모집$/.test(part));
}

function lines(blocks: Block[]): string[] {
  return blocks.flatMap((block) => (block.type === "line" ? [block.text] : []));
}

function usableImage(name: string): boolean {
  return !/^(상단|썸네일)|상단(업데이트|이벤트|공지)|업데이트톡|상호작용|예시|캡처|캡쳐|\.gif$/i.test(
    name,
  );
}

interface Timing {
  all_day: boolean;
  start: string;
  end?: string;
  start_after_maintenance?: boolean;
  end_note?: string;
  kind: Kind;
}

/** Provisional 11:00 maintenance starts are resolved to announced ends in build.ts. */
export function timing(
  range: ParsedRange,
  kindWithoutEnd: Kind = "release",
): Timing {
  const { start, end } = range;
  if (range.endOnly) {
    return start.time
      ? { all_day: false, start: toValue(start), kind: "deadline" }
      : { all_day: true, start: start.day, kind: "deadline" };
  }
  const after = start.afterMaintenance ? { start_after_maintenance: true } : {};
  const timedStart = start.afterMaintenance
    ? `${start.day}T11:00:00+09:00`
    : start.time
      ? toValue(start)
      : `${start.day}T00:00:00+09:00`;
  if (!end) {
    const open = range.openEnd ? { end_note: range.openEnd } : {};
    if (!start.time && !start.afterMaintenance)
      return {
        all_day: true,
        start: start.day,
        kind: range.openEnd ? "interval" : kindWithoutEnd,
        ...open,
      };
    return {
      all_day: false,
      start: timedStart,
      kind: range.openEnd ? "interval" : kindWithoutEnd,
      ...after,
      ...open,
    };
  }
  if (!start.time && !start.afterMaintenance && !end.time) {
    return {
      all_day: true,
      start: start.day,
      end: addDays(end.day, 1),
      kind: "interval",
    };
  }
  const endValue = end.time
    ? toValue(end)
    : `${addDays(end.day, 1)}T00:00:00+09:00`;
  if (Date.parse(endValue) <= Date.parse(timedStart) && !start.afterMaintenance)
    return { all_day: false, start: timedStart, kind: kindWithoutEnd };
  return {
    all_day: false,
    start: timedStart,
    end: endValue,
    kind: "interval",
    ...after,
  };
}

function period(label: string, range: ParsedRange): Period | null {
  if (range.endOnly) return null;
  const value = timing(range, "interval");
  return {
    label: label.replace(/\s+/g, " ").trim(),
    start: value.start,
    ...(value.end ? { end: value.end } : {}),
    ...(value.start_after_maintenance ? { start_after_maintenance: true } : {}),
  };
}

function draft(
  post: Post,
  fields: Omit<
    Draft,
    "post" | "tags" | "students" | "notes" | "periods" | "images"
  > &
    Partial<Draft>,
): Draft {
  return {
    tags: [],
    students: [],
    notes: [],
    periods: [],
    images: [],
    ...fields,
    post,
  };
}

function startDay(value: string): string {
  return value.slice(0, 10);
}

const RAID =
  /총력전|대결전|제약해제결전|종합전술시험|전술 대회|합동화력연습|시험/;

export function rowCategory(label: string): Category {
  if (/점검/.test(label)) return "maintenance";
  if (/모집/.test(label)) return "pickup";
  if (RAID.test(label)) return "raid";
  if (/캠페인/.test(label)) return "campaign";
  if (/스토리/.test(label) && !/이벤트 스토리/.test(label)) return "story";
  return "event";
}

function pickupLabel(label: string): string {
  return label.endsWith("픽업 모집") ? label.replace(/\s*모집$/, "") : label;
}

export function pickupKey(day: string, students: string[]): string {
  return `pickup:${day}:${students.map(norm).sort().join("+")}`;
}

function overviewDrafts(post: Post): Draft[] {
  const drafts: Draft[] = [];
  for (const block of post.blocks) {
    if (block.type !== "table") continue;
    const header = block.rows[0]!.map((cell) => cell.replace(/\s+/g, ""));
    const when = header.indexOf("일시");
    const label = header.indexOf("구분");
    const content = header.indexOf("내용");
    if (when < 0 || label < 0 || content < 0) continue;
    const noteColumn = header.findIndex((cell) => cell.startsWith("참고"));
    for (const row of block.rows.slice(1)) {
      const rowLabel = (row[label] ?? "").replace(/\s+/g, " ").trim();
      const range = parseRange(
        (row[when] ?? "").replace(/\n/g, " "),
        post.publishedDay,
      );
      if (!range || !rowLabel) continue;
      const category = rowCategory(rowLabel);
      if (category === "maintenance") continue; // The 일시 line describes the whole window.
      const parts = (row[content] ?? "")
        .split("\n")
        .map((part) => part.trim())
        .filter(Boolean);
      const tags = parts
        .filter((part) => /^-\s*.+\s*-$/.test(part))
        .map((part) => part.replace(/^-\s*|\s*-$/g, "").replace(/\s+/g, " "));
      const body = parts
        .filter((part) => !/^-\s*.+\s*-$/.test(part))
        .join(" ")
        .replace(/\s+/g, " ")
        .replace(/,\s*$/, "");
      const notes =
        noteColumn >= 0
          ? [
              (row[noteColumn] ?? "")
                .split("\n")
                .filter((part) => !/^\[.*바로가기\]$/.test(part.trim()))
                .join(" ")
                .trim(),
            ].filter(Boolean)
          : [];
      const released = tags.includes("상설화");
      const value = timing(range, "release");
      let title: string;
      let students: string[] = [];
      let key: string;
      if (category === "pickup") {
        students = splitStudents(parts.join(","));
        title = `${students.join(", ")} ${pickupLabel(rowLabel)}`;
        key = pickupKey(startDay(value.start), students);
      } else {
        if (category === "raid")
          title = norm(body).includes(norm(rowLabel))
            ? body
            : `${rowLabel} ${body}`;
        else if (category === "story") title = `${rowLabel} ${body}`;
        else if (rowLabel === "나의 집무실") title = `[나의 집무실] ${body}`;
        else title = body;
        if (released) title = `${title} 상설화`;
        key = `${category}:${startDay(value.start)}:${norm(title)}`;
      }
      drafts.push(
        draft(post, {
          key,
          title: title.slice(0, 160),
          label: rowLabel,
          category,
          ...value,
          kind: released ? "release" : value.kind,
          tags,
          students,
          notes,
        }),
      );
    }
  }
  return drafts;
}

interface Section {
  heading: string;
  lines: string[];
  images: { src: string; name: string; caption: string }[];
  periods: { label: string; range: ParsedRange }[];
}

const PERIOD_LINE =
  /^[-*·∙•]?\s*([^:：]{2,40}?(?:기간|일정|일시|운영|진행)(?:\s*\([^)]*\))?)\s*[:：]\s*(.+)$/;

export function sections(post: Post): Section[] {
  const result: Section[] = [];
  let current: Section | null = null;
  let detail = !post.blocks.some(
    (block) => block.type === "line" && /상세 업데이트 내용/.test(block.text),
  );
  let lastLine = "";
  for (const block of post.blocks) {
    if (block.type === "line") {
      if (/상세 업데이트 내용/.test(block.text)) detail = true;
      const heading = detail ? /^(\d{1,2})\.\s+(.+)$/.exec(block.text) : null;
      if (heading) {
        current = { heading: heading[2]!, lines: [], images: [], periods: [] };
        result.push(current);
      } else if (current) {
        current.lines.push(block.text);
        const match = PERIOD_LINE.exec(block.text);
        const range = match && parseRange(match[2]!, post.publishedDay);
        if (match && range) current.periods.push({ label: match[1]!, range });
      }
      lastLine = block.text;
    } else if (block.type === "image" && current && usableImage(block.name)) {
      current.images.push({
        src: block.src,
        name: block.name,
        caption: lastLine,
      });
    }
  }
  return result;
}

function coreTitle(text: string): string {
  return norm(
    text
      .replace(/\[[^\]]*\]/g, "")
      .replace(/-?(복각|상설화|한국어 더빙)-?/g, "")
      .replace(/총력전|대결전|제약해제결전|이벤트 스토리/g, ""),
  );
}

function compatibleLabels(bracket: string, label: string): boolean {
  const a = norm(bracket);
  const b = norm(label);
  return (
    a.includes(b) ||
    b.includes(a) ||
    (a === "이벤트일람" && b === "이벤트스토리")
  );
}

function sameRange(a: Period, b: Pick<Draft, "start" | "end">): boolean {
  return a.start === b.start && a.end === b.end;
}

function enrich(drafts: Draft[], post: Post) {
  const list = sections(post);
  for (const item of drafts) {
    if (item.category === "pickup") {
      const keys = item.students.map(norm);
      const recruiting = list.filter((section) => /모집/.test(section.heading));
      for (const section of recruiting.length ? recruiting : list) {
        for (const image of section.images) {
          const haystack = norm(`${image.name} ${image.caption}`);
          if (
            keys.some((key) => key.length > 1 && haystack.includes(key)) &&
            !item.images.includes(image.src)
          )
            item.images.push(image.src);
        }
      }
      continue;
    }
    const core = coreTitle(item.title.replace(/\s*상설화$/, ""));
    if (core.length < 2) continue;
    const section = list
      .filter((candidate) => {
        const heading = coreTitle(candidate.heading);
        if (
          heading.length < 2 ||
          !(heading.includes(core) || core.includes(heading))
        )
          return false;
        // "[나의 집무실] 2부 메인 스토리 …" describes a mission, not the story chapter itself.
        const bracket = /^\[([^\]]+)\]/.exec(candidate.heading)?.[1];
        return !bracket || !item.label || compatibleLabels(bracket, item.label);
      })
      .sort(
        (a, b) =>
          Math.abs(coreTitle(a.heading).length - core.length) -
          Math.abs(coreTitle(b.heading).length - core.length),
      )[0];
    // Story chapters are introduced by "[0. 총학생회 편 1장 …]" lines inside a shared section.
    const captioned = list
      .flatMap((candidate) => candidate.images)
      .find((image) => {
        const caption = coreTitle(image.caption);
        return (
          /^\[.+\]$/.test(image.caption) &&
          caption.length >= 6 &&
          core.includes(caption)
        );
      });
    const image = section?.images[0] ?? captioned;
    if (image && !item.images.includes(image.src)) item.images.push(image.src);
    if (!section) continue;
    for (const { label, range } of section.periods) {
      const value = period(label, range);
      if (
        value &&
        !sameRange(value, item) &&
        !item.periods.some((existing) => existing.label === value.label)
      )
        item.periods.push(value);
    }
    for (const line of section.lines) {
      if (
        !/까지/.test(line) ||
        !/(티켓|쿠폰|보상).*(사용|수령|교환)/.test(line)
      )
        continue;
      const deadline = parseRange(
        `~ ${line.replace(/^.*?(\d{1,2}월\s*\d{1,2}일)/, "$1")}`,
        post.publishedDay,
      );
      if (deadline?.endOnly && deadline.start.time) {
        const label = line
          .replace(/^\*\s*/, "")
          .split(/[은는]\s*\d{1,2}월/)[0]!
          .replace(/^순위 보상 중\s*/, "")
          .replace(/[‘’']/g, "")
          .trim();
        item.notes.push(
          `${label.slice(0, 40)} 사용 기한: ${toValue(deadline.start).slice(5, 10).replace("-", "/")} ${deadline.start.time}`,
        );
      }
    }
  }
}

function maintenanceDrafts(post: Post): Draft[] {
  if (!/점검|패치|업데이트/.test(post.title)) return [];
  const all = lines(post.blocks);
  const index = all.findIndex((line) =>
    /^(?:\d\.\s*)?(?:점검\s*)?일시\s*[:：]/.test(line),
  );
  if (index < 0 || index > 20) return [];
  const range = parseRange(
    all[index]!.replace(/^.*?일시\s*[:：]\s*/, ""),
    post.publishedDay,
  );
  if (!range || !range.start.time) return [];
  const value = timing(range, "release");
  const day = startDay(value.start);
  const regular = /정기\s*점검|업데이트 상세/.test(post.title);
  const md = `${+day.slice(5, 7)}/${+day.slice(8, 10)}`;
  const title = regular
    ? `${md} 업데이트 정기점검`
    : /무중단 패치/.test(post.title)
      ? `${md} 무중단 패치`
      : noticeTitle(post.title).replace(
          /^\d{1,2}\/\d{1,2}\([^)]*\)\s*/,
          `${md} `,
        );
  const notes: string[] = [];
  const periods: Period[] = [];
  for (const line of all.slice(index + 1, index + 12)) {
    const reward = /^(?:\d\.\s*)?보상\s*[:：]\s*(.+)$/.exec(line);
    if (reward) notes.push(`점검 보상: ${reward[1]}`);
    const impact = /^(?:\d\.\s*)?영향\s*[:：]\s*(.+)$/.exec(line);
    if (impact) notes.push(impact[1]!);
    if (/점검 보상/.test(line) && /까지/.test(line)) {
      const claim = parseRange(line.replace(/^[*\s]+/, ""), post.publishedDay);
      if (claim?.endOnly && value.end)
        periods.push({
          label: "점검 보상 수령 기간",
          start: value.end,
          end: toValue(claim.start),
        });
    }
  }
  return [
    draft(post, {
      key: regular
        ? `maintenance:${day}`
        : `maintenance:${value.start}:${norm(title)}`,
      title,
      label: regular
        ? "정기점검"
        : /무중단/.test(title)
          ? "무중단 패치"
          : "점검",
      category: "maintenance",
      ...value,
      kind: "interval",
      notes,
      periods,
    }),
  ];
}

function campaignDrafts(post: Post): Draft[] {
  const drafts: Draft[] = [];
  for (const block of post.blocks) {
    if (block.type !== "table") continue;
    const header = block.rows[0]!.map((cell) => cell.replace(/\s+/g, ""));
    const content = header.indexOf("캠페인내용");
    const when = header.indexOf("캠페인기간");
    if (content < 0 || when < 0) continue;
    for (const row of block.rows.slice(1)) {
      const raw = (row[content] ?? "").replace(/\n/g, " ").trim();
      const multiplier = /(\d+)\s*배/.exec(raw)?.[1] ?? "2";
      const names = raw
        .replace(/\s*\d+\s*배\s*$/, "")
        .split(/\s*\/\s*|\s*,\s*/)
        .filter(Boolean);
      for (const phrase of (row[when] ?? "").split("\n")) {
        const range = parseRange(phrase, post.publishedDay);
        if (!range) continue;
        const value = timing(range, "interval");
        for (const name of names) {
          const title = `${name} ${multiplier}배`;
          drafts.push(
            draft(post, {
              key: `campaign:${startDay(value.start)}:${norm(title)}`,
              title,
              label: "보상 2배 캠페인",
              category: "campaign",
              ...value,
            }),
          );
        }
      }
    }
  }
  return drafts;
}

const GROUP_PERIOD =
  /^[*\-\s]*((?:특별\s*)?(?:픽업|앙코르|페스|페스티벌|복각)?\s*모집)\s*기간\s*[:：]\s*(.+)$/;
const CAPTION = /^\d+\)\s*(.+?)\s*((?:특별\s*)?(?:픽업|앙코르|페스)\s*)?모집$/;
const BRACKET = /^\[\s*(.*?모집)\s*[–—-]\s*(.+)\]$/;

function pickupNoticeDrafts(post: Post): Draft[] {
  if (!/모집/.test(post.title) || !/안내/.test(post.title)) return [];
  const groups: {
    label: string;
    range: ParsedRange;
    students: string[];
    images: string[];
  }[] = [];
  let heading: { label: string; students: string[] } | null = null;
  let lastCaption: string[] = [];
  for (const block of post.blocks) {
    if (block.type === "line") {
      const bracket = BRACKET.exec(block.text);
      if (bracket)
        heading = {
          label: bracket[1]!.trim(),
          students: splitStudents(bracket[2]!),
        };
      const group = GROUP_PERIOD.exec(block.text);
      if (group) {
        const range = parseRange(group[2]!, post.publishedDay);
        if (range)
          groups.push({
            label: group[1]!.replace(/\s+/g, " ").trim(),
            range,
            students: [...(heading?.students ?? [])],
            images: [],
          });
        heading = null;
      }
      const caption = CAPTION.exec(block.text);
      if (caption && groups.length) {
        lastCaption = splitStudents(caption[1]!);
        const current = groups.at(-1)!;
        for (const name of lastCaption)
          if (
            !current.students.some((existing) => norm(existing) === norm(name))
          )
            current.students.push(name);
      }
    } else if (block.type === "image" && groups.length && lastCaption.length) {
      groups.at(-1)!.images.push(block.src);
      lastCaption = [];
    }
  }
  return groups
    .filter((group) => group.students.length)
    .map((group) => {
      const value = timing(group.range, "interval");
      return draft(post, {
        key: pickupKey(startDay(value.start), group.students),
        title: `${group.students.join(", ")} ${pickupLabel(group.label)}`.slice(
          0,
          160,
        ),
        label: group.label,
        category: "pickup",
        ...value,
        students: group.students,
        images: group.images,
      });
    });
}

const COMMUNITY =
  /굿즈|판매|예약|제휴|콜라보|\sX\s|×|페스티벌|헌혈|적십자|팝업|커뮤니티 이벤트|인스타그램|팔로워|OST|앨범|단행본|모델|피규어|FigRiq|인형|매일유업|GS25|무신사|교보|키링/i;

function meaningfulLabel(label: string): string | undefined {
  const short = label.replace(/\s*(기간|일정|일시)(\s*\([^)]*\))?$/, "").trim();
  return !short ||
    /^(행사|이벤트|진행|참여|이벤트 참여|행사 진행)$/.test(short) ||
    short.length > 24
    ? undefined
    : short;
}

function genericDrafts(post: Post): Draft[] {
  const title = noticeTitle(post.title);
  const all = lines(post.blocks);
  const category: Category = COMMUNITY.test(post.title) ? "community" : "event";
  const images = post.blocks
    .flatMap((block) =>
      block.type === "image" && usableImage(block.name) ? [block.src] : [],
    )
    .slice(1, 2);

  if (/쿠폰/.test(post.title) && /유효 기간|만료/.test(post.title)) {
    const line = all.find(
      (text) =>
        /쿠폰/.test(text) &&
        /까지/.test(text) &&
        /\d{1,2}월\s*\d{1,2}일/.test(text),
    );
    const range = line
      ? parseRange(
          `~ ${line.slice(line.search(/(?:\d{4}년\s*)?\d{1,2}월\s*\d{1,2}일/))}`,
          post.publishedDay,
        )
      : null;
    if (!range?.endOnly) return [];
    const name = title
      .replace(/\s*(?:유효 기간|만료 예정|일부 오발송).*$/, "")
      .replace(/\s+(?:및|–|-)\s*$/, "")
      .trim();
    const value = timing(range, "deadline");
    return [
      draft(post, {
        key: `event:${startDay(value.start)}:${norm(name)}:deadline`,
        title: `${name} 사용 마감`,
        label: "쿠폰 마감",
        category: "event",
        ...value,
        images,
      }),
    ];
  }

  let main: { label: string; range: ParsedRange } | null = null;
  const extras: { label: string; range: ParsedRange }[] = [];
  all.forEach((line, index) => {
    const labelled = PERIOD_LINE.exec(line.replace(/^\d+\.\s*/, ""));
    let found: { label: string; range: ParsedRange } | null = null;
    if (labelled) {
      const range = parseRange(labelled[2]!, post.publishedDay);
      if (range && !range.endOnly)
        found = {
          label: labelled[1]!.replace(/^[-*·∙\s]+/, "").replace(/[‘’'“”]/g, ""),
          range,
        };
    } else if (
      /^[-*·∙]\s*\d/.test(line) &&
      /기간|일정|일시/.test(all[index - 1] ?? "")
    ) {
      const range = parseRange(
        line.replace(/^[-*·∙]\s*/, ""),
        post.publishedDay,
      );
      if (range && !range.endOnly)
        found = {
          label: (all[index - 1] ?? "")
            .replace(/^[^\p{L}]+/u, "")
            .replace(/[‘’'“”]/g, "")
            .trim(),
          range,
        };
    }
    if (
      !found ||
      /계정.*생성|D\+\d+|최초 접속|배송 완료|오발송|미접속/.test(line)
    )
      return;
    if (!main) main = found;
    else extras.push(found);
  });
  if (!main) return [];
  const { range, label } = main as { label: string; range: ParsedRange };
  const value = timing(range, "interval");
  const periods = extras
    .flatMap((extra) => {
      const item = period(extra.label, extra.range);
      return item && !sameRange(item, value) ? [item] : [];
    })
    .slice(0, 8);
  const summary = all
    .slice(0, 12)
    .find(
      (text) =>
        text.length > 20 && !/^📣|안내드립니다|샬레운영|샬레행정/.test(text),
    );
  return [
    draft(post, {
      key: `${category}:${startDay(value.start)}:${norm(title)}`,
      title,
      label: meaningfulLabel(label),
      category,
      ...value,
      periods,
      images,
      ...(summary ? { description: summary } : {}),
    }),
  ];
}

export function parsePostCandidates(post: Post): Draft[] {
  if (IGNORED_TITLES.test(post.title)) return [];
  const drafts = [...maintenanceDrafts(post), ...campaignDrafts(post)];
  const overview = overviewDrafts(post);
  if (overview.length) {
    enrich(overview, post);
    return [...drafts, ...overview];
  }
  const pickups = pickupNoticeDrafts(post);
  if (pickups.length) return [...drafts, ...pickups];
  if (drafts.length) return drafts;
  // A recruitment notice we could not read is covered by that week's update table.
  if (/모집\s*(?:&|＆|및)?.*안내/.test(post.title)) return [];
  // Update-board posts without a schedule table are patch notes, not calendar entries.
  if (post.board === 1076) return [];
  return genericDrafts(post);
}

export function parsePost(post: Post): Draft[] {
  return parsePostCandidates(post).filter(
    (item) => !shouldExcludeCalendarEvent(item),
  );
}
