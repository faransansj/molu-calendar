import { compareEvents, span } from "./calendar.ts";
import type { Category, FeedEvent } from "./feed.ts";

export interface Segment {
  event: FeedEvent;
  column: number;
  length: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface WeekLayout {
  segments: Segment[];
  /** Events per column that did not fit in the visible lanes. */
  hidden: number[];
  lanes: number;
}

/** Keep long goods pre-orders from crowding out pickups. */
const PRIORITY: Category[] = [
  "pickup",
  "event",
  "raid",
  "story",
  "maintenance",
  "campaign",
  "community",
];

export function layoutWeek(
  events: FeedEvent[],
  week: string[],
  maxLanes: number,
): WeekLayout {
  const first = week[0]!;
  const last = week.at(-1)!;
  const pieces = events.flatMap((event) => {
    const range = span(event);
    if (range.last < first || range.first > last) return [];
    const from = range.first < first ? first : range.first;
    const to = range.last > last ? last : range.last;
    const column = week.indexOf(from);
    return [
      {
        event,
        column,
        length: week.indexOf(to) - column + 1,
        continuesBefore: range.first < first,
        continuesAfter: range.last > last,
      },
    ];
  });
  pieces.sort(
    (a, b) =>
      PRIORITY.indexOf(a.event.category) - PRIORITY.indexOf(b.event.category) ||
      a.column - b.column ||
      b.length - a.length ||
      compareEvents(a.event, b.event),
  );
  const lanes: boolean[][] = [];
  const hidden = Array<number>(week.length).fill(0);
  const segments: Segment[] = [];
  for (const piece of pieces) {
    const columns = Array.from(
      { length: piece.length },
      (_, index) => piece.column + index,
    );
    let lane = lanes.findIndex((used) =>
      columns.every((column) => !used[column]),
    );
    if (lane < 0) lane = lanes.length;
    if (lane >= maxLanes) {
      for (const column of columns) hidden[column]! += 1;
      continue;
    }
    lanes[lane] ??= [];
    for (const column of columns) lanes[lane]![column] = true;
    segments.push({ ...piece, lane });
  }
  segments.sort((a, b) => a.lane - b.lane || a.column - b.column);
  return { segments, hidden, lanes: lanes.length };
}

export function weeks(days: string[]): string[][] {
  return Array.from({ length: Math.ceil(days.length / 7) }, (_, index) =>
    days.slice(index * 7, index * 7 + 7),
  );
}

export interface LaneBudget {
  height: number;
  /** Fixed height of every week: date header, "+N" strip, gaps and border. */
  base: number;
  focusLane: number;
  otherLane: number;
  floor: number;
}

const LENS_MINIMUM = 5;

export function allocateLanes(
  needed: number[],
  focus: number,
  budget: LaneBudget,
): number[] {
  const count = needed.length;
  const { height, base, focusLane, otherLane } = budget;
  const lanes = needed.map(() => 0);
  let free = height - count * base;
  const others = needed
    .map((_, index) => index)
    .filter((index) => index !== focus)
    .sort((a, b) => Math.abs(a - focus) - Math.abs(b - focus) || b - a);
  const give = (index: number, size: number) => {
    if (lanes[index]! >= needed[index]! || free < size) return false;
    lanes[index]! += 1;
    free -= size;
    return true;
  };
  // The lens is never smaller than its neighbours: others only grow while the focus is satisfied.
  const hasFocus = focus >= 0 && focus < count;
  const focusDone = () => !hasFocus || lanes[focus]! >= needed[focus]!;
  const fillFocus = (limit: number) => {
    while (hasFocus && lanes[focus]! < limit && give(focus, focusLane));
  };
  for (let level = 0; level < budget.floor; level++) {
    fillFocus(level + 1);
    if (hasFocus && lanes[focus]! < Math.min(level + 1, needed[focus]!)) break;
    for (const index of others) give(index, otherLane);
    if (level === 0) fillFocus(LENS_MINIMUM);
  }
  if (hasFocus) while (give(focus, focusLane));
  for (let grew = focusDone(); grew;) {
    grew = false;
    for (const index of others) grew = give(index, otherLane) || grew;
  }
  return lanes;
}
