import { useState } from "react";
import type { ChatTranscript, Memory } from "../lib/chat/transcript.ts";
import { filterMemories } from "../lib/chat/memory.ts";
import { cx } from "../lib/cx.ts";
import type { Student } from "../lib/chat/replies.ts";
import { Icon } from "./Icon.tsx";
import {
  Notice,
  Switch,
  dangerButton,
  field,
  iconButton,
  primaryButton,
  quietButton,
  smallButton,
} from "./ui.tsx";

function MemoryCard({
  memory,
  now,
  disabled,
  run,
  store,
}: {
  memory: Memory;
  now: number;
  disabled: boolean;
  run: (task: () => Promise<unknown>) => void;
  store: ChatTranscript;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const expired = memory.expiresAt !== null && memory.expiresAt <= now;
  const active = memory.enabled && !expired;

  return (
    <li
      className={cx(
        "rounded-lg border bg-surface px-3.5 py-3 transition-colors",
        active ? "border-line" : "border-line-soft bg-surface-2",
      )}
    >
      {draft !== null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text) return;
            setDraft(null);
            run(() => store.updateMemory(memory.id, { text }));
          }}
        >
          <textarea
            className={cx(field, "min-h-18 resize-y py-2 text-sm/[1.6]")}
            aria-label="기억 수정"
            maxLength={500}
            value={draft}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- editing starts from an explicit button press
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                event.preventDefault();
                setDraft(null);
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={cx(quietButton, smallButton)}
              onClick={() => setDraft(null)}
            >
              취소
            </button>
            <button
              className={cx(primaryButton, smallButton)}
              disabled={disabled || !draft.trim()}
            >
              저장
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <p
              className={cx(
                "min-w-0 flex-1 text-sm/[1.65] wrap-anywhere whitespace-pre-wrap",
                active
                  ? "text-ink"
                  : "text-muted line-through decoration-subtle/50",
              )}
            >
              {memory.text}
            </p>
            <Switch
              label="이 기억 사용"
              checked={memory.enabled}
              disabled={disabled}
              onChange={(enabled) =>
                run(() => store.updateMemory(memory.id, { enabled }))
              }
            />
          </div>
          <div className="mt-2 flex items-center gap-1 text-xs text-muted">
            <span className="mr-auto inline-flex items-center gap-1.5">
              {memory.sourceMessageId ? "대화에서 기억함" : "직접 작성"}
              {expired && (
                <span className="font-semibold text-warn">· 만료됨</span>
              )}
              {!memory.enabled && <span>· 사용 안 함</span>}
            </span>
            {deleting ? (
              <>
                <span className="mr-1 font-semibold text-danger">
                  지울까요?
                </span>
                <button
                  type="button"
                  className={cx(dangerButton, smallButton, "min-h-7! px-2!")}
                  disabled={disabled}
                  onClick={() => run(() => store.deleteMemory(memory.id))}
                >
                  삭제
                </button>
                <button
                  type="button"
                  className={cx(quietButton, smallButton, "min-h-7! px-2!")}
                  onClick={() => setDeleting(false)}
                >
                  취소
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="rounded-sm px-1.5 py-1 font-semibold transition-colors hover:text-blue"
                  disabled={disabled}
                  onClick={() =>
                    run(() =>
                      store.updateMemory(memory.id, {
                        expiresAt:
                          memory.expiresAt === null ? Date.now() : null,
                      }),
                    )
                  }
                >
                  {memory.expiresAt === null ? "만료" : "만료 해제"}
                </button>
                <button
                  type="button"
                  className={cx(iconButton, "size-7 [&_.icon]:size-4")}
                  aria-label="기억 수정"
                  disabled={disabled}
                  onClick={() => setDraft(memory.text)}
                >
                  <Icon name="pencil" />
                </button>
                <button
                  type="button"
                  className={cx(
                    iconButton,
                    "size-7 hover:text-danger [&_.icon]:size-4",
                  )}
                  aria-label="기억 삭제"
                  disabled={disabled}
                  onClick={() => setDeleting(true)}
                >
                  <Icon name="trash" />
                </button>
              </>
            )}
          </div>
        </>
      )}
    </li>
  );
}

export function MemoryPanel({
  student,
  store,
  memories,
  busy,
  onChange,
}: {
  student: Student;
  store: ChatTranscript | null;
  memories: Memory[];
  busy: boolean;
  onChange: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [now] = useState(() => Date.now());
  const run = (task: () => Promise<unknown>) => {
    setWorking(true);
    setError("");
    void task()
      .then(onChange)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setWorking(false));
  };
  const shown = filterMemories(memories, query);
  const disabled = !store || busy || working;

  return (
    <div className="flex min-h-0 flex-1 scroll-thin flex-col gap-4 overflow-y-auto bg-surface-2 p-4 max-sm:px-3">
      <div>
        <h3 className="font-display text-lg/[1.45] font-medium text-ink">
          {student.short}의 기억
        </h3>
        <p className="mt-1 text-sm/[1.65] text-body">
          AI 답장을 만들 때 여기 있는 내용만 참고해요. 이 대화에서만 쓰이고,
          학생의 답장은 직접 기억하기 전까지 남지 않아요.
        </p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!store || !text.trim()) return;
          const draft = text.trim();
          run(async () => {
            await store.saveMemory({ roomId: student.id, text: draft });
            setText("");
          });
        }}
      >
        <input
          className={cx(field, "flex-1")}
          aria-label="새 기억"
          placeholder={`${student.short}에게 기억시킬 내용`}
          maxLength={500}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button className={primaryButton} disabled={disabled || !text.trim()}>
          추가
        </button>
      </form>
      {error && (
        <Notice tone="danger" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}
      {memories.length > 4 && (
        <div className="flex h-9 items-center gap-2 rounded-lg border border-control bg-surface px-2.5 text-muted focus-within:border-accent focus-within:text-blue focus-within:shadow-ring">
          <Icon name="search" className="size-4" />
          <input
            type="search"
            aria-label="기억 검색"
            maxLength={200}
            placeholder="기억 검색"
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-subtle focus-visible:outline-0"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {store && shown.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="저장된 기억">
          {shown.map((memory) => (
            <MemoryCard
              key={memory.id}
              memory={memory}
              now={now}
              disabled={disabled}
              run={run}
              store={store}
            />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-frame px-6 py-8 text-center">
          <Icon name="book" className="size-6 text-frame" />
          <p className="text-sm text-muted">
            {memories.length
              ? "검색과 일치하는 기억이 없어요."
              : "아직 기억이 없어요. 위에 직접 적거나, 대화 말풍선의 기억하기를 눌러 보세요."}
          </p>
        </div>
      )}
    </div>
  );
}
