import { useEffect, useMemo, useRef, useState } from "react";
import type { FeedEvent } from "../lib/calendar/feed.ts";
import { Icon } from "./Icon.tsx";
import { iconButton } from "./ui.tsx";

export function BannerGallery({
  events,
  onOpen,
}: {
  events: FeedEvent[];
  onOpen: (id: string) => void;
}) {
  const banners = useMemo(
    () => [
      ...new Map(events.map((event) => [event.images?.[0], event])).values(),
    ],
    [events],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const gallery = useRef<HTMLElement>(null);
  const index = Math.max(
    0,
    banners.findIndex((event) => event.id === selectedId),
  );
  const current = banners[index];

  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    if (banners.length < 2 || hovered || focused) return;
    const timer = window.setInterval(() => {
      if (
        motion.matches ||
        document.hidden ||
        gallery.current?.contains(document.activeElement) ||
        document.querySelector("dialog[open]")
      )
        return;
      setSelectedId((id) => {
        const at = Math.max(
          0,
          banners.findIndex((event) => event.id === id),
        );
        return banners[(at + 1) % banners.length]!.id;
      });
    }, 6000);
    return () => window.clearInterval(timer);
  }, [banners, hovered, focused]);

  const src = current?.images?.[0];
  if (!current || !src) return null;
  const move = (offset: number) =>
    setSelectedId(
      banners[(index + offset + banners.length) % banners.length]!.id,
    );
  const navButton = `${iconButton} size-7! rounded-sm! [&_.icon]:size-3`;

  return (
    <section
      ref={gallery}
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
        onClick={() => onOpen(current.id)}
        aria-label={`${current.title} 자세히 보기`}
        title={`${current.title} 자세히 보기`}
      >
        {failed === src ? (
          <span className="grid h-[170px] place-items-center bg-surface-2 p-4 text-xs text-muted">
            이미지를 불러오지 못했어요.
          </span>
        ) : (
          <img
            key={src}
            className="block h-auto w-full"
            src={src}
            alt={`${current.title} 공식 안내 배너`}
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailed(src)}
          />
        )}
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
            onClick={() => move(-1)}
          >
            <Icon name="chevron" className="rotate-180" />
          </button>
          <button
            type="button"
            className={navButton}
            aria-label="다음 배너"
            onClick={() => move(1)}
          >
            <Icon name="chevron" />
          </button>
        </div>
      )}
    </section>
  );
}
