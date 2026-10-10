import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ChatTranscript } from "../lib/chat/transcript.ts";
import { momoSupportsAI } from "../lib/chat/prompt.ts";
import { MODEL, useLocalAI } from "../hooks/useLocalAI.ts";
import { cx } from "../lib/cx.ts";
import type { Student } from "../lib/chat/replies.ts";
import { sitePath } from "../lib/urls.ts";
import { Icon } from "./Icon.tsx";
import {
  ConfirmButton,
  Notice,
  Switch,
  primaryButton,
  quietButton,
  smallButton,
} from "./ui.tsx";

const card = "divide-y divide-line rounded-lg border border-line";
const heading =
  "mb-2.5 flex items-center gap-2 text-md font-semibold text-ink [&_.icon]:size-4 [&_.icon]:text-blue";

const mib = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

function Row({
  title,
  detail,
  children,
  className,
}: {
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-x-4 gap-y-2.5 px-3.5 py-3",
        className,
      )}
    >
      <div className="flex min-w-[min(100%,220px)] flex-1 flex-col gap-0.5">
        <strong className="text-md text-ink">{title}</strong>
        {detail && <span className="text-xs/[1.55] text-muted">{detail}</span>}
      </div>
      {children}
    </div>
  );
}

function Meter({ value, label }: { value: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
        style={{ width: `${Math.min(100, Math.max(2, value * 100))}%` }}
      />
    </div>
  );
}

function AISection({ students }: { students: Student[] }) {
  const ai = useLocalAI();
  const [error, setError] = useState("");
  const supported = students.filter((s) => momoSupportsAI(s.id));
  const run = (task: () => Promise<unknown>) => {
    setError("");
    void task().catch((cause: unknown) => {
      // Stopping a download on purpose is not a failure worth flagging.
      if ((cause as { code?: string }).code !== "cancelled")
        setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const status = ai.ready
    ? "준비됨 · 이 탭에서 바로 답장해요"
    : ai.loading
      ? ai.notice || "준비 중…"
      : ai.cached
        ? "받아 둔 모델이 있어요 · 첫 답장 때 자동으로 불러와요"
        : `${mib(MODEL.bytes)} · 한 번만 받으면 돼요`;

  return (
    <section aria-labelledby="ai-settings">
      <h4 id="ai-settings" className={heading}>
        <Icon name="sparkle" />
        AI 답장
      </h4>
      <div className={card}>
        <Row
          title="학생이 직접 답장하기"
          detail="지원하는 학생은 기기 안의 AI로 대화해요. 일정 질문에는 계속 정확한 일정으로 답해요."
        >
          <Switch
            label="AI 답장 사용"
            checked={ai.enabled}
            onChange={(next) => {
              if (!ai.setEnabled(next)) setError("설정을 저장하지 못했어요.");
            }}
          />
        </Row>
        {supported.length > 0 && (
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="flex shrink-0 -space-x-2" aria-hidden="true">
              {supported.slice(0, 7).map((s, index) => (
                <img
                  key={s.id}
                  src={sitePath(`resource/momotalk/${s.img}`)}
                  alt=""
                  loading="lazy"
                  className={cx(
                    "size-7 rounded-full border-2 border-surface bg-surface-2 object-cover",
                    index >= 4 && "max-sm:hidden",
                  )}
                />
              ))}
            </span>
            <span className="min-w-0 text-xs text-muted">
              {supported
                .slice(0, 3)
                .map((s) => s.short)
                .join(", ")}{" "}
              외 {supported.length - 3}명 지원
            </span>
          </div>
        )}
        {ai.enabled && (
          <div className="flex flex-col gap-2.5 px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-blue [&_.icon]:size-[18px]">
                <Icon name={ai.ready ? "check" : "download"} />
              </span>
              <div className="flex min-w-[min(100%,200px)] flex-1 flex-col gap-0.5">
                <strong className="text-md text-ink">{MODEL.name}</strong>
                <span
                  className={cx(
                    "text-xs/[1.55] wrap-anywhere",
                    ai.ready ? "text-blue-strong" : "text-muted",
                  )}
                  aria-live="polite"
                >
                  {status}
                </span>
              </div>
              {ai.loading ? (
                <button
                  type="button"
                  className={cx(quietButton, smallButton)}
                  onClick={ai.cancel}
                >
                  <Icon name="stop" />
                  중단
                </button>
              ) : (
                !ai.ready && (
                  <button
                    type="button"
                    className={cx(primaryButton, smallButton)}
                    disabled={ai.busy}
                    onClick={() => run(ai.prepare)}
                  >
                    <Icon name={ai.cached ? "sparkle" : "download"} />
                    {ai.cached ? "지금 불러오기" : "모델 받기"}
                  </button>
                )
              )}
            </div>
            {ai.loading && (
              <Meter value={ai.progress} label={`${MODEL.name} 준비`} />
            )}
          </div>
        )}
      </div>
      {error && (
        <Notice tone="danger" className="mt-2.5" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}
      <p className="mt-2.5 text-xs/[1.65] text-muted">
        대화는 서버로 보내지 않고 이 기기에서 처리돼요. WebGPU를 지원하는 최신
        Chrome·Edge가 필요하고, 탭을 숨기면 메모리를 비우기 위해 모델을 내려
        놓아요. AI 답장은 직접 기억하기를 누르기 전까지 기억에 남지 않아요.
      </p>
      {ai.cached && !ai.loading && (
        <ConfirmButton
          className="mt-2.5"
          confirm={`받아 둔 ${MODEL.name}를 지울까요?`}
          disabled={ai.busy}
          onConfirm={() => run(ai.remove)}
        >
          <Icon name="trash" />
          모델 파일 삭제
        </ConfirmButton>
      )}
    </section>
  );
}

async function readUsage() {
  if (!navigator.storage?.estimate) return null;
  const result = await navigator.storage.estimate();
  return {
    usage: Number(result.usage ?? 0),
    quota: Number(result.quota ?? 0),
    persisted: (await navigator.storage.persisted?.()) ?? false,
  };
}

function DataSection({
  store,
  busy,
  onChange,
}: {
  store: ChatTranscript | null;
  busy: boolean;
  onChange: () => Promise<void>;
}) {
  const [usage, setUsage] = useState<{
    usage: number;
    quota: number;
    persisted: boolean;
  } | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "info" | "danger";
    text: string;
  } | null>(null);
  const estimate = () => readUsage().then(setUsage, () => setUsage(null));
  useEffect(() => {
    void estimate();
  }, []);
  const action = async (task: () => Promise<unknown>, done: string) => {
    setWorking(true);
    setNotice(null);
    try {
      await task();
      await onChange();
      setNotice({ tone: "info", text: done });
      await estimate();
    } catch (cause) {
      setNotice({
        tone: "danger",
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setWorking(false);
    }
  };
  const exportBackup = async () => {
    if (!store) return;
    const url = URL.createObjectURL(
      new Blob([await store.exportBundle()], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "molu-chat-backup.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const locked = !store || busy || working;

  return (
    <section aria-labelledby="data-settings">
      <h4 id="data-settings" className={heading}>
        <Icon name="book" />
        대화 기록
      </h4>
      <div className={card}>
        <Row
          title="이 브라우저에 저장돼요"
          detail={
            usage
              ? `${mib(usage.usage)} 사용 · ${usage.persisted ? "브라우저가 지우지 않도록 보존 중" : "저장 공간이 부족하면 브라우저가 정리할 수 있어요"}`
              : "대화와 기억은 서버에 올라가지 않아요."
          }
        >
          {usage && !usage.persisted && navigator.storage?.persist && (
            <button
              type="button"
              className={cx(quietButton, smallButton)}
              disabled={working}
              onClick={() =>
                void action(async () => {
                  if (!(await navigator.storage.persist()))
                    throw new Error(
                      "브라우저가 보존 요청을 거절했어요. 백업 파일을 보관해 주세요.",
                    );
                }, "이제 브라우저가 기록을 임의로 지우지 않아요.")
              }
            >
              보존 요청
            </button>
          )}
          {usage && usage.quota > 0 && (
            <div className="w-full">
              <Meter
                value={usage.usage / usage.quota}
                label="브라우저 저장소 사용량"
              />
            </div>
          )}
        </Row>
        <Row
          title="백업"
          detail="대화와 기억을 파일로 저장하거나, 저장한 파일로 되돌려요."
        >
          <div className="flex gap-2">
            <button
              type="button"
              className={cx(quietButton, smallButton)}
              disabled={!store || working}
              onClick={() =>
                void action(exportBackup, "백업 파일을 내려받았어요.")
              }
            >
              <Icon name="download" />
              내보내기
            </button>
            <label
              className={cx(
                quietButton,
                smallButton,
                "has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus",
                locked ? "cursor-not-allowed opacity-45" : "cursor-pointer",
              )}
            >
              <Icon name="upload" />
              가져오기
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                disabled={locked}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > 32 * 1024 * 1024)
                    setNotice({
                      tone: "danger",
                      text: "백업 파일은 32 MiB 이하여야 해요.",
                    });
                  else setPending(file);
                }}
              />
            </label>
          </div>
        </Row>
        {pending && (
          <div className="flex flex-col gap-2.5 bg-warn-soft px-3.5 py-3 text-sm">
            <p className="text-warn">
              <b className="font-semibold wrap-anywhere">{pending.name}</b>
              으로 바꾸면 지금 있는 대화와 기억은 모두 사라져요.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className={cx(primaryButton, smallButton)}
                disabled={locked}
                onClick={() => {
                  const file = pending;
                  setPending(null);
                  void action(
                    async () =>
                      store!.importBundle(await file.text(), { replace: true }),
                    "백업을 복원했어요.",
                  );
                }}
              >
                백업으로 바꾸기
              </button>
              <button
                type="button"
                className={cx(quietButton, smallButton)}
                onClick={() => setPending(null)}
              >
                취소
              </button>
            </div>
          </div>
        )}
        <Row
          title="모든 대화 지우기"
          detail="모든 학생과의 대화와 기억을 삭제해요. 되돌릴 수 없어요."
        >
          <ConfirmButton
            confirm="정말 모두 지울까요?"
            disabled={locked}
            onConfirm={() =>
              void action(() => store!.deleteAll(), "모든 대화를 지웠어요.")
            }
          >
            <Icon name="trash" />
            전체 삭제
          </ConfirmButton>
        </Row>
      </div>
      {notice && (
        <Notice
          tone={notice.tone}
          icon={notice.tone === "info" ? "check" : "info"}
          className="mt-2.5"
          onDismiss={() => setNotice(null)}
        >
          {notice.text}
        </Notice>
      )}
    </section>
  );
}

export function MomoSettings({
  store,
  students,
  busy,
  onChange,
}: {
  store: ChatTranscript | null;
  students: Student[];
  busy: boolean;
  onChange: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-7 px-1 pt-4 pb-2">
      <AISection students={students} />
      <DataSection store={store} busy={busy} onChange={onChange} />
    </div>
  );
}
