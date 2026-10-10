import {
  DAY_MS,
  addDays,
  compareEvents,
  endMoment,
  kstMidnight,
  openEndedLimit,
  shiftMonth,
  startMoment,
} from "./calendar.ts";
import type { Category, FeedEvent } from "./feed.ts";

export const TIMELINE_ORDER: Category[] = [
  "maintenance",
  "pickup",
  "raid",
  "event",
  "story",
  "campaign",
  "community",
];

/** Reserve label space for points and short intervals without extending the drawn bar. */
const POINT_ROOM = 3;
const MIN_ROOM = 1;
const GAP = 0.08;

export interface TimelineItem {
  event: FeedEvent;
  lane: number;
  left: number;
  width: number;
  point: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface TimelineGroup {
  category: Category;
  items: TimelineItem[];
  lanes: number;
}

export interface Timeline {
  days: string[];
  from: number;
  to: number;
  groups: TimelineGroup[];
}

export function monthRange(month: string): {
  days: string[];
  from: number;
  to: number;
} {
  const first = `${month}-01`;
  const next = `${shiftMonth(month, 1)}-01`;
  const days: string[] = [];
  for (let day = first; day < next; day = addDays(day, 1)) days.push(day);
  return { days, from: kstMidnight(first), to: kstMidnight(next) };
}

export function rangeFraction(
  moment: number,
  from: number,
  to: number,
): number | null {
  return moment < from || moment >= to ? null : (moment - from) / (to - from);
}

export function layoutTimeline(events: FeedEvent[], month: string): Timeline {
  const { days, from, to } = monthRange(month);
  const total = to - from;
  const groups = new Map<
    Category,
    { item: TimelineItem; room: [number, number] }[]
  >();

  for (const event of events) {
    const point = event.kind !== "interval";
    const start = startMoment(event);
    const end = point ? start : (endMoment(event) ?? openEndedLimit(event)!);
    if (point ? start < from || start >= to : start >= to || end <= from)
      continue;
    const left = (Math.max(start, from) - from) / total;
    const right = (Math.min(end, to) - from) / total;
    const roomDays = point
      ? POINT_ROOM
      : Math.max(MIN_ROOM, ((right - left) * total) / DAY_MS);
    const item: TimelineItem = {
      event,
      lane: 0,
      left,
      width: point ? 0 : right - left,
      point,
      continuesBefore: !point && start < from,
      continuesAfter: !point && end > to,
    };
    const list = groups.get(event.category) ?? [];
    list.push({
      item,
      room: [left, left + ((roomDays + GAP) * DAY_MS) / total],
    });
    groups.set(event.category, list);
  }

  return {
    days,
    from,
    to,
    groups: TIMELINE_ORDER.flatMap((category) => {
      const list = groups.get(category);
      if (!list) return [];
      list.sort(
        (a, b) =>
          a.room[0] - b.room[0] ||
          b.room[1] - b.room[0] - (a.room[1] - a.room[0]) ||
          compareEvents(a.item.event, b.item.event),
      );
      const ends: number[] = [];
      for (const entry of list) {
        let lane = ends.findIndex((end) => end <= entry.room[0]);
        if (lane < 0) lane = ends.length;
        ends[lane] = entry.room[1];
        entry.item.lane = lane;
      }
      return [
        {
          category,
          items: list.map((entry) => entry.item),
          lanes: ends.length,
        },
      ];
    }),
  };
}
