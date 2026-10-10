export interface Endpoint {
  day: string;
  /** HH:MM, absent for a date-only endpoint. */
  time?: string;
  afterMaintenance?: boolean;
  yearInferred?: boolean;
}

export interface ParsedRange {
  start: Endpoint;
  end?: Endpoint;
  openEnd?: string;
  /** Without a concrete start, `start` holds the deadline for timing() in parse.ts. */
  endOnly?: boolean;
}

const WEEKDAY = String.raw`(?:\s*\(\s*[월화수목금토일](?:요일)?\s*\))?`;
const DATE_SOURCE = String.raw`(?:(?<y1>\d{4})\s*년\s*)?(?<m1>\d{1,2})\s*월\s*(?<d1>\d{1,2})\s*일${WEEKDAY}|(?<y2>\d{4})\s*[.\-]\s*(?<m2>\d{1,2})\s*[.\-]\s*(?<d2>\d{1,2})\.?${WEEKDAY}|(?<![\d.])(?<m3>\d{1,2})\s*\/\s*(?<d3>\d{1,2})(?![\d/])${WEEKDAY}`;
const TIME_SOURCE = String.raw`(?<maint>점검\s*(?:종료\s*)?(?:후|이후))|(?:(?<period>오전|오후|낮|밤|새벽|저녁|아침)\s*)?(?<h1>\d{1,2})\s*시(?!간|즌|리즈|험)(?:\s*(?<min1>\d{1,2})\s*분)?(?<half>\s*반)?|(?<![\d:])(?<h2>\d{1,2}):(?<min2>\d{2})(?![\d:])`;
const OPEN_END =
  /(별도\s*(?:안내|공지)[^~]*?시?\s*까지|별도\s*안내\s*시|소진\s*시(?:\s*까지)?|다음[^~]*?변경\s*시\s*까지|추후\s*공지)/;

const pad = (n: number) => String(n).padStart(2, "0");

function validDay(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function nearestYear(
  month: number,
  day: number,
  reference: string,
): string | null {
  const year = +reference.slice(0, 4);
  const choices = [year - 1, year, year + 1]
    .map((y) => validDay(y, month, day))
    .filter((value): value is string => !!value)
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a) - Date.parse(reference)) -
        Math.abs(Date.parse(b) - Date.parse(reference)),
    );
  return choices[0] ?? null;
}

export function findDate(
  text: string,
  reference: string,
): {
  day: string;
  index: number;
  length: number;
  yearInferred: boolean;
} | null {
  const match = new RegExp(DATE_SOURCE).exec(text);
  if (!match?.groups) return null;
  const g = match.groups;
  const month = +(g.m1 ?? g.m2 ?? g.m3)!;
  const date = +(g.d1 ?? g.d2 ?? g.d3)!;
  const year = g.y1 ?? g.y2;
  const day = year
    ? validDay(+year, month, date)
    : nearestYear(month, date, reference);
  if (!day) return null;
  return {
    day,
    index: match.index,
    length: match[0].length,
    yearInferred: !year,
  };
}

export function findTime(
  text: string,
): { time?: string; afterMaintenance?: boolean; index: number } | null {
  const match = new RegExp(TIME_SOURCE).exec(text);
  if (!match?.groups) return null;
  const g = match.groups;
  if (g.maint) return { afterMaintenance: true, index: match.index };
  let hour = +(g.h1 ?? g.h2)!;
  const minute = +(g.min1 ?? g.min2 ?? (g.half ? 30 : 0));
  const period = g.period;
  if (period) {
    if (hour < 1 || hour > 12) return null;
    if (period === "오전" || period === "새벽" || period === "아침") hour %= 12;
    else if (period === "오후" || period === "저녁") hour = (hour % 12) + 12;
    else if (period === "밤") hour = hour === 12 ? 24 : hour + 12;
    else if (period === "낮")
      hour = hour === 12 || hour >= 6 ? hour : hour + 12;
  }
  if (hour === 24 && minute === 0) return { time: "24:00", index: match.index };
  if (hour > 23 || minute > 59) return null;
  return { time: `${pad(hour)}:${pad(minute)}`, index: match.index };
}

function endpoint(
  text: string,
  reference: string,
  fallbackDay?: string,
): Endpoint | null {
  const date = findDate(text, reference);
  const rest = date ? text.slice(date.index + date.length) : text;
  const clock = findTime(rest);
  const day = date?.day ?? fallbackDay;
  if (!day) return null;
  if (!date && !clock) return null;
  const result: Endpoint = { day };
  if (date?.yearInferred) result.yearInferred = true;
  if (clock?.afterMaintenance) result.afterMaintenance = true;
  else if (clock?.time) {
    if (clock.time === "24:00") {
      const next = new Date(`${day}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      result.day = next.toISOString().slice(0, 10);
      result.time = "00:00";
    } else result.time = clock.time;
  }
  return result;
}

function orderEnd(start: Endpoint, end: Endpoint): Endpoint {
  if (end.yearInferred && end.day < start.day) {
    const bumped = `${+end.day.slice(0, 4) + 1}${end.day.slice(4)}`;
    return { ...end, day: bumped };
  }
  return end;
}

const RANGE_SEPARATOR = /\s*[~～∼〜]\s*/;

/** `reference` is the KST publication date used to infer omitted years. */
export function parseRange(
  phrase: string,
  reference: string,
): ParsedRange | null {
  const text = phrase.replace(/\s+/g, " ").trim();
  let left: string;
  let right: string | undefined;
  const separator = RANGE_SEPARATOR.exec(text);
  if (separator) {
    left = text.slice(0, separator.index);
    right = text.slice(separator.index + separator[0].length);
  } else if (/부터/.test(text)) {
    [left, right] = text.split(/부터/, 2) as [string, string];
  } else {
    left = text;
  }
  const start = endpoint(left, reference);
  if (!start) {
    if (!left.trim() && right) {
      const end = endpoint(right.split(/\s\/\s|[~～∼〜]/)[0]!, reference);
      return end ? { start: end, endOnly: true } : null;
    }
    if (right && findTime(left)?.afterMaintenance) {
      const end = endpoint(right.split(/\s\/\s|[~～∼〜]/)[0]!, reference);
      return end ? { start: end, endOnly: true } : null;
    }
    return null;
  }
  if (right === undefined) return { start };
  // Stop at a second range ("/ 오전 10시 ~ 오후 6시" daily hours) so it is not read as the end.
  const head = right.replace(/^\s*\/\s*/, "").split(/\s\/\s|[~～∼〜]/)[0]!;
  const open = OPEN_END.exec(head);
  const end = endpoint(head, reference, start.day);
  if (
    open &&
    (!end || open.index < (findDate(head, reference)?.index ?? Infinity))
  ) {
    return {
      start,
      openEnd: open[0]
        .replace(/\s+/g, " ")
        .replace(/\s*시$/, " 시까지")
        .trim(),
    };
  }
  if (!end) return { start };
  return { start, end: orderEnd(start, end) };
}

export function toValue(point: Endpoint): string {
  return point.time ? `${point.day}T${point.time}:00+09:00` : point.day;
}

export function publicationDay(createDate: number): string {
  return new Date(createDate * 1000 + 9 * 3_600_000).toISOString().slice(0, 10);
}
