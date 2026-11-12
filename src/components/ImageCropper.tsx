import { useRef } from "react";
import type { PointerEvent } from "react";
import type { ImageCrop } from "../lib/admin/overrides.ts";
import { cropStyle } from "./EventArt.tsx";

interface Drag {
  pointerId: number;
  clientX: number;
  clientY: number;
  width: number;
  height: number;
  crop: ImageCrop;
}

export function ImageCropper({
  src,
  crop,
  onChange,
}: {
  src: string;
  crop: ImageCrop;
  onChange: (crop: ImageCrop) => void;
}) {
  const drag = useRef<Drag | null>(null);

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="relative aspect-video cursor-grab touch-none overflow-hidden rounded-sm bg-surface-2 active:cursor-grabbing"
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || drag.current) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            width: rect.width,
            height: rect.height,
            crop: { ...crop },
          };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          onChange({
            x: Math.min(
              100,
              Math.max(
                0,
                start.crop.x -
                  ((event.clientX - start.clientX) / start.width) *
                    (100 / start.crop.zoom),
              ),
            ),
            y: Math.min(
              100,
              Math.max(
                0,
                start.crop.y -
                  ((event.clientY - start.clientY) / start.height) *
                    (100 / start.crop.zoom),
              ),
            ),
            zoom: start.crop.zoom,
          });
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointerId === event.pointerId) drag.current = null;
        }}
      >
        <img
          src={src}
          alt="대표 이미지 자르기 미리보기"
          className="size-full object-cover select-none"
          draggable={false}
          referrerPolicy="no-referrer"
          style={cropStyle(crop)}
        />
      </div>
      <label className="flex flex-col gap-1 text-sm text-muted">
        가로 위치
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={crop.x}
          onChange={(event) =>
            onChange({ ...crop, x: event.currentTarget.valueAsNumber })
          }
          className="m-0 min-h-8 w-full accent-blue"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-muted">
        세로 위치
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={crop.y}
          onChange={(event) =>
            onChange({ ...crop, y: event.currentTarget.valueAsNumber })
          }
          className="m-0 min-h-8 w-full accent-blue"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-muted">
        확대
        <input
          type="range"
          min={1}
          max={4}
          step={0.05}
          value={crop.zoom}
          onChange={(event) =>
            onChange({ ...crop, zoom: event.currentTarget.valueAsNumber })
          }
          className="m-0 min-h-8 w-full accent-blue"
        />
      </label>
    </div>
  );
}
