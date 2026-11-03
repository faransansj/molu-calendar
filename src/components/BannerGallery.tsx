import { useEffect, useMemo, useState } from "react";
import type { FeedEvent } from "../lib/calendar/feed.ts";
import { cx } from "../lib/cx.ts";
import { Icon } from "./Icon.tsx";
import { iconButton } from "./ui.tsx";

type Direction = "next" | "prev";
type Banner = { src: string; event: FeedEvent };
type Slide = {
  id: string | null;
  leaving: string | null;
  direction: Direction;
};

const ROTATE_MS = 6000;
const slideIn = {
  next: "animate-[banner-in-next_.35s_var(--ease-out)]",
  prev: "animate-[banner-in-prev_.35s_var(--ease-out)]",
} as const;
const slideOut = {
  next: "animate-[banner-out-next_.35s_var(--ease-out)_forwards]",
  prev: "animate-[banner-out-prev_.35s_var(--ease-out)_forwards]",
} as const;

function step(banners: Banner[], slide: Slide, direction: Direction): Slide {
  const at = Math.max(
    0,
    banners.findIndex(({ event }) => event.id === slide.id),
  );
  const offset = direction === "next" ? 1 : -1;
  return {
    id: banners[(at + offset + banners.length) % banners.length]!.event.id,
    // Reduced motion disables the keyframes, so skip the outgoing layer entirely.
    leaving: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? null
      : banners[at]!.event.id,
    direction,
  };
}

export function BannerGallery({
  events,
  onOpen,
}: {
  events: FeedEvent[];
  onOpen: (id: string) => void;
}) {
  const banners = useMemo(
    () =>
      [
        ...new Map(
          events.flatMap((event) => {
            const src = event.images?.[0];
            return src ? [[src, event] as const] : [];
          }),
        ),
      ].map(([src, event]): Banner => ({ src, event })),
    [events],
  );
  const [slide, setSlide] = useState<Slide>({
    id: null,
    leaving: null,
    direction: "next",
  });
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [imageHovered, setImageHovered] = useState(false);
  const [imageFocused, setImageFocused] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const index = Math.max(
    0,
    banners.findIndex(({ event }) => event.id === slide.id),
  );
  const current = banners[index];

  // slide.id restarts the countdown on every change, so a manual move gets a full interval.
  useEffect(() => {
    if (banners.length < 2 || imageHovered || imageFocused) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const timer = window.setInterval(() => {
      if (
        motion.matches ||
        document.hidden ||
        document.querySelector("dialog[open]")
      )
        return;
      setSlide((state) => step(banners, state, "next"));
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [banners, imageHovered, imageFocused, slide.id]);

  if (!current) return null;
  const navButton = `${iconButton} size-7! rounded-sm! [&_.icon]:size-3`;

  return (
    <section
      className="-mx-(--inset-x) -mt-(--inset-t)"
      aria-label="공식 안내 배너"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <button
        type="button"
        className="block w-full"
        onClick={() => onOpen(current.event.id)}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setImageHovered(true);
        }}
        onPointerLeave={() => setImageHovered(false)}
        onFocus={() => setImageFocused(true)}
        onBlur={() => setImageFocused(false)}
        aria-label={`${current.event.title} 자세히 보기`}
        title={`${current.event.title} 자세히 보기`}
      >
        <span
          className="relative block aspect-video overflow-hidden bg-surface-2"
          onAnimationEnd={(event) => {
            if (event.animationName.startsWith("banner-out-"))
              setSlide((state) => ({ ...state, leaving: null }));
          }}
        >
          {banners.map(({ src, event }) => {
            const isCurrent = event.id === current.event.id;
            const isLeaving = !isCurrent && event.id === slide.leaving;
            return (
              <span
                key={src}
                aria-hidden={!isCurrent}
                className={cx(
                  "absolute inset-0",
                  isCurrent && slide.leaving && slideIn[slide.direction],
                  isLeaving && slideOut[slide.direction],
                  !isCurrent && !isLeaving && "invisible",
                )}
              >
                {failed.has(src) ? (
                  <span className="grid size-full place-items-center p-4 text-xs text-muted">
                    이미지를 불러오지 못했어요.
                  </span>
                ) : (
                  <img
                    className="size-full object-contain"
                    src={src}
                    alt={isCurrent ? `${event.title} 공식 안내 배너` : ""}
                    fetchPriority={isCurrent ? "high" : "low"}
                    referrerPolicy="no-referrer"
                    onError={() => setFailed((set) => new Set(set).add(src))}
                  />
                )}
              </span>
            );
          })}
        </span>
      </button>
      {banners.length > 1 && (
        <div className="flex items-center justify-end gap-1 px-(--inset-x) pt-1">
          <span
            className="mr-auto numeric text-2xs/[1.2] text-subtle"
            aria-live={hovered || focused ? "polite" : "off"}
            aria-atomic="true"
          >
            {index + 1}/{banners.length}
          </span>
          <button
            type="button"
            className={navButton}
            aria-label="이전 배너"
            onClick={() => setSlide((state) => step(banners, state, "prev"))}
          >
            <Icon name="chevron" className="rotate-180" />
          </button>
          <button
            type="button"
            className={navButton}
            aria-label="다음 배너"
            onClick={() => setSlide((state) => step(banners, state, "next"))}
          >
            <Icon name="chevron" />
          </button>
        </div>
      )}
    </section>
  );
}
