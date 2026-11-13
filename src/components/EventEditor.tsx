import { useRef, useState } from "react";
import { useAdminContext } from "../hooks/useAdmin.ts";
import { prepareUpload, type PreparedUpload } from "../lib/admin/image.ts";
import {
  DEFAULT_CROP,
  fromKstInput,
  toKstInput,
  validateSchedule,
} from "../lib/admin/overrides.ts";
import { addDays, validDate } from "../lib/calendar/calendar.ts";
import type { FeedEvent } from "../lib/calendar/feed.ts";
import { Icon } from "./Icon.tsx";
import { ImageCropper } from "./ImageCropper.tsx";
import {
  Notice,
  SectionTitle,
  field,
  primaryButton,
  quietButton,
} from "./ui.tsx";

function scheduleInputs(event: FeedEvent) {
  return {
    start: event.all_day ? event.start : toKstInput(event.start),
    end: event.end
      ? event.all_day
        ? addDays(event.end, -1)
        : toKstInput(event.end)
      : "",
    openEnded: !event.end,
    maintenance: !!event.start_after_maintenance,
  };
}

export function EventEditor({ event }: { event: FeedEvent }) {
  const admin = useAdminContext();
  const override = admin.overrides.get(event.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const [crop, setCrop] = useState(override?.image?.crop ?? DEFAULT_CROP);
  const [pending, setPending] = useState<PreparedUpload | null>(null);
  const [schedule, setSchedule] = useState(() => scheduleInputs(event));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [syncSchedule, setSyncSchedule] = useState(false);
  const [shown, setShown] = useState({
    id: event.id,
    updatedAt: override?.updated_at,
    start: event.start,
    end: event.end,
    maintenance: !!event.start_after_maintenance,
    image: override?.image,
  });

  if (shown.id !== event.id || shown.updatedAt !== override?.updated_at) {
    const changedId = shown.id !== event.id;
    const image = override?.image;
    setShown({
      id: event.id,
      updatedAt: override?.updated_at,
      start: event.start,
      end: event.end,
      maintenance: !!event.start_after_maintenance,
      image,
    });
    // The effective event in this render is authoritative. The event captured
    // before awaiting a save/restore still contains the previous schedule.
    if (
      changedId ||
      syncSchedule ||
      shown.start !== event.start ||
      shown.end !== event.end ||
      shown.maintenance !== !!event.start_after_maintenance
    ) {
      setSchedule(scheduleInputs(event));
      setSyncSchedule(false);
    }
    if (
      changedId ||
      shown.image?.upload !== image?.upload ||
      shown.image?.crop.x !== image?.crop.x ||
      shown.image?.crop.y !== image?.crop.y ||
      shown.image?.crop.zoom !== image?.crop.zoom
    )
      setCrop(image?.crop ?? DEFAULT_CROP);
    if (changedId) {
      setPending(null);
      setError("");
      setMessage("");
    }
  }

  const run = async (action: () => Promise<void>) => {
    if (busy || admin.status !== "ready") return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (cause) {
      setSyncSchedule(false);
      setError(cause instanceof Error ? cause.message : "저장하지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  const finishSave = async (hotfix: boolean) => {
    if (!hotfix) {
      setMessage(
        "스테이지에 저장했어요. 공개 사이트에 반영하려면 핫픽스로 게시해 주세요.",
      );
      return;
    }
    try {
      await admin.publish();
      setMessage(
        "스테이지에 저장하고 핫픽스를 게시했어요. 공개 사이트에 바로 반영됐어요.",
      );
    } catch (cause) {
      throw new Error(
        `스테이지에는 저장됐지만 핫픽스를 게시하지 못했어요. ${cause instanceof Error ? cause.message : "게시 상태를 확인해 주세요."}`,
      );
    }
  };

  const saveImage = (hotfix: boolean) => {
    void run(async () => {
      await admin.saveImage(event.id, crop, pending?.blob ?? null);
      setPending(null);
      await finishSave(hotfix);
    });
  };

  const saveSchedule = (hotfix: boolean) => {
    const end =
      event.kind !== "interval" || schedule.openEnded
        ? null
        : event.all_day
          ? validDate(schedule.end)
            ? addDays(schedule.end, 1)
            : schedule.end
          : (fromKstInput(schedule.end) ?? "");
    const validated = validateSchedule(
      {
        start: event.all_day ? schedule.start : fromKstInput(schedule.start),
        end,
        start_after_maintenance:
          event.kind !== "deadline" && schedule.maintenance,
      },
      event,
    );
    if (!validated.ok) {
      setError(validated.message);
      setMessage("");
      return;
    }
    void run(async () => {
      setSyncSchedule(true);
      await admin.saveSchedule(event.id, validated.value);
      await finishSave(hotfix);
    });
  };

  const src = pending?.preview ?? event.images?.[0];
  const inputType = event.all_day ? "date" : "datetime-local";
  return (
    <div className="mt-4 flex flex-col gap-5" aria-busy={busy}>
      <p className="text-sm text-muted">
        스테이지 올려두기는 저장만 해요. 핫픽스는 이 수정과 다른 저장된 수정
        전체를 바로 게시해요. 되돌리기도 스테이지에 저장되며, 바로 반영하려면
        관리자 페이지 위의 스테이지 전체 핫픽스를 사용해 주세요.
      </p>
      <fieldset disabled={busy || admin.status !== "ready"} className="min-w-0">
        <legend className="mb-2">
          <SectionTitle>이미지</SectionTitle>
        </legend>
        {src ? (
          <ImageCropper
            src={src}
            crop={crop}
            onChange={(value) => {
              if (!busy) setCrop(value);
            }}
          />
        ) : (
          <p className="rounded-sm bg-surface-2 p-4 text-sm text-muted">
            이미지가 없어요. 업로드해 주세요.
          </p>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label="대표 이미지 파일"
          onChange={(change) => {
            const file = change.currentTarget.files?.[0];
            change.currentTarget.value = "";
            if (!file) return;
            void run(async () => {
              const prepared = await prepareUpload(file);
              setPending(prepared);
              setCrop(DEFAULT_CROP);
            });
          }}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className={quietButton}
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="upload" />
            이미지 업로드
          </button>
          <button
            type="button"
            className={quietButton}
            disabled={busy || (!override?.image && !pending)}
            onClick={() => {
              void run(async () => {
                setPending(null);
                if (override?.image) await admin.restoreImage(event.id);
                setCrop(DEFAULT_CROP);
                if (override?.image) await finishSave(false);
              });
            }}
          >
            원래대로 되돌리기
          </button>
          <button
            type="button"
            className={quietButton}
            disabled={busy || !src}
            onClick={() => saveImage(false)}
          >
            스테이지 올려두기
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={busy || !src}
            onClick={() => saveImage(true)}
          >
            핫픽스
          </button>
        </div>
      </fieldset>
      <fieldset disabled={busy || admin.status !== "ready"} className="min-w-0">
        <legend className="mb-2">
          <SectionTitle>기간</SectionTitle>
        </legend>
        {!event.all_day && (
          <p className="mb-2 text-xs text-muted">
            한국 표준시 (KST) 기준이에요.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1 text-sm font-semibold text-ink">
            {event.kind === "deadline" ? "마감" : "시작"}
            <input
              type={inputType}
              step={event.all_day ? undefined : 60}
              className={field}
              value={schedule.start}
              onChange={(change) =>
                setSchedule({ ...schedule, start: change.currentTarget.value })
              }
            />
          </label>
          {event.kind === "interval" && (
            <label className="flex min-w-0 flex-col gap-1 text-sm font-semibold text-ink">
              종료
              <input
                type={inputType}
                step={event.all_day ? undefined : 60}
                className={field}
                value={schedule.end}
                disabled={busy || schedule.openEnded}
                onChange={(change) =>
                  setSchedule({ ...schedule, end: change.currentTarget.value })
                }
              />
            </label>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-body">
          {event.kind === "interval" && (
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={schedule.openEnded}
                onChange={(change) =>
                  setSchedule({
                    ...schedule,
                    openEnded: change.currentTarget.checked,
                  })
                }
              />
              종료 미정
            </label>
          )}
          {event.kind !== "deadline" && (
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={schedule.maintenance}
                onChange={(change) =>
                  setSchedule({
                    ...schedule,
                    maintenance: change.currentTarget.checked,
                  })
                }
              />
              점검 후 시작
            </label>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className={quietButton}
            disabled={busy}
            onClick={() => saveSchedule(false)}
          >
            스테이지 올려두기
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() => saveSchedule(true)}
          >
            핫픽스
          </button>
          <button
            type="button"
            className={quietButton}
            disabled={busy || !override?.schedule}
            onClick={() => {
              void run(async () => {
                setSyncSchedule(true);
                await admin.restoreSchedule(event.id);
                await finishSave(false);
              });
            }}
          >
            원래 기간으로
          </button>
        </div>
      </fieldset>
      {error && <Notice tone="danger">{error}</Notice>}
      {message && <Notice tone="warn">{message}</Notice>}
    </div>
  );
}
