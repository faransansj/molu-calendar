import { useState } from "react";
import { CATEGORIES } from "../lib/calendar/calendar.ts";
import { cx } from "../lib/cx.ts";
import type { FeedEvent } from "../lib/calendar/feed.ts";
import { categoryStyle } from "./ui.tsx";

export function EventArt({
  event,
  index = 0,
  className,
  eager = false,
  size,
}: {
  event: FeedEvent;
  index?: number;
  className?: string;
  eager?: boolean;
  size?: "thumb" | "large";
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = event.images?.[index];
  const classes = cx(
    "relative aspect-video overflow-hidden rounded-sm bg-surface-2",
    className,
  );
  if (src && failed !== src) {
    return (
      <div className={classes} style={categoryStyle(event)}>
        <img
          src={src}
          alt=""
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailed(src)}
        />
      </div>
    );
  }
  return (
    <div
      className={cx(
        classes,
        "art-fallback flex flex-col justify-end gap-[3px] text-(--event-ink)",
        size !== "thumb" && "px-3.5 py-3",
      )}
      style={categoryStyle(event)}
      aria-hidden="true"
    >
      <span className="absolute top-[18%] right-[14%] aspect-[3/1] w-[30%] -rotate-14 rounded-[50%] border-2 border-[color-mix(in_srgb,var(--event-color)_45%,var(--color-white))]" />
      {size !== "thumb" && (
        <>
          <span className="font-display text-2xs font-medium opacity-85">
            {event.label ?? CATEGORIES[event.category].label}
          </span>
          <span
            className={cx(
              "line-clamp-2 font-display leading-[1.35] font-medium",
              size === "large" ? "text-xl" : "text-lg",
            )}
          >
            {event.title}
          </span>
        </>
      )}
    </div>
  );
}
