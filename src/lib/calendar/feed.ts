export const CATEGORY_KEYS = [
  "maintenance",
  "pickup",
  "event",
  "raid",
  "campaign",
  "story",
  "community",
] as const;
export type Category = (typeof CATEGORY_KEYS)[number];

export const STATUS_KEYS = [
  "confirmed",
  "tentative",
  "postponed",
  "cancelled",
] as const;
export type Status = (typeof STATUS_KEYS)[number];

/**
 * - `interval`: runs from `start` until `end` (exclusive). A missing end means "until further notice".
 * - `release`: something opens or becomes available at `start` and stays (story chapters, -상설화-).
 * - `deadline`: only the closing moment is meaningful (coupon expiry); `start` holds that moment.
 */
export const KIND_KEYS = ["interval", "release", "deadline"] as const;
export type Kind = (typeof KIND_KEYS)[number];

/** A secondary period of an event. Plain dates mean all-day, with an exclusive end. */
export interface Period {
  label: string;
  start: string;
  end?: string;
  start_after_maintenance?: boolean;
}

export interface Source {
  url: string;
  title: string;
  board: string;
  published_at: string;
}

export interface FeedEvent {
  id: string;
  title: string;
  /** The notice's own label for the row, such as 특별 픽업 모집 or 대결전. */
  label?: string;
  category: Category;
  kind: Kind;
  all_day: boolean;
  start: string;
  end?: string;
  /** The notice says "점검 후": `start` is the scheduled end of maintenance, which can slip. */
  start_after_maintenance?: boolean;
  /** Free-text ending when the notice gives no time, e.g. 별도 안내 시까지. */
  end_note?: string;
  status: Status;
  tags?: string[];
  students?: string[];
  description?: string;
  notes?: string[];
  periods?: Period[];
  images?: string[];
  source_url: string;
  sources: Source[];
  first_seen: string;
  updated_at: string;
}

export interface Feed {
  schema_version: 2;
  region: "KR";
  timezone: "Asia/Seoul";
  generated_at: string;
  source: { name: string; url: string };
  events: FeedEvent[];
}
