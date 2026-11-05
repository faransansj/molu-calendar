import { cx } from "../lib/cx.ts";

const PATHS = {
  chat: "M4 5h16v11H9l-5 4Z",
  sound: "M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
  muted: "M11 4 6 8H3v8h3l5 4Zm5 5 6 6m0-6-6 6",
  chevron: "m9 5 7 7-7 7",
  calendar:
    "M3 9h18M7 3v4m10-4v4M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  timeline: "M4 6h9M9 12h11M6 18h8",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm5-2 4 4",
  close: "m6 6 12 12M18 6 6 18",
  eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  "eye-off":
    "m3 3 18 18M10.6 5.1A12 12 0 0 1 12 5c7 0 10 7 10 7a18 18 0 0 1-3 4.2M6.5 6.5A19 19 0 0 0 2 12s3 7 10 7a12 12 0 0 0 5.5-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2",
  external:
    "M14 4h6v6m-1-5-8 8M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4",
  bookmark: "M7 4h10a1 1 0 0 1 1 1v15l-6-3.6L6 20V5a1 1 0 0 1 1-1Z",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  download: "M12 4v11m-5-5 5 5 5-5M5 19h14",
  rss: "M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14M6 18h.01",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  wrench:
    "M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z",
  sparkle:
    "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z",
  check: "m5 12 4.5 4.5L19 7",
  ticket:
    "M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4ZM15 5v2m0 3v1m0 3v1m0 3v1",
  target:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 3v3m0 12v3M3 12h3m12 0h3",
  gift: "M4 11h16v9H4ZM3 7h18v4H3ZM12 7v13m0-13H8a2 2 0 1 1 2-2Zm0 0h4a2 2 0 1 0-2-2Z",
  book: "M12 5v15M3 4h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v15h-5a4 4 0 0 0-4 1 4 4 0 0 0-4-1H3Z",
  bag: "M5 8h14l1 12H4ZM8 8V6a4 4 0 0 1 8 0v2",
  info: "M12 11v6M12 7.5v.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  settings:
    "M9.75 3h4.5l.6 2.4 1.4.8 2.4-.7 2.25 3.9-1.8 1.7v1.8l1.8 1.7-2.25 3.9-2.4-.7-1.4.8-.6 2.4h-4.5l-.6-2.4-1.4-.8-2.4.7L3 14.6l1.8-1.7v-1.8L3 9.4l2.25-3.9 2.4.7 1.4-.8ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  trash: "M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3",
  pencil: "m14.5 5.5 4 4M4 20l1-5L15.5 4.5a2.1 2.1 0 0 1 4 4L9 19Z",
  upload: "M12 15V4M7 9l5-5 5 5M5 19h14",
  stop: "M7 7h10v10H7Z",
  send: "M4 12 20 4l-6 16-3-7Z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  className,
  filled = false,
}: {
  name: IconName;
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      className={cx("icon", className)}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} fill={filled ? "currentColor" : "none"} />
    </svg>
  );
}
