import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePersistentState } from "../hooks/calendar.ts";
import { ARONA } from "../lib/chat/students.ts";
import type { Student } from "../lib/chat/students.ts";
import { sitePath } from "../lib/urls.ts";
import { cx } from "../lib/cx.ts";
import {
  ConfirmButton,
  Dialog,
  Notice,
  Switch,
  field,
  iconButton,
  primaryButton,
  quietButton,
  smallButton,
} from "./ui.tsx";
import { Icon } from "./Icon.tsx";
import { useChat } from "../hooks/useChat.ts";
import { useLocalAI } from "../hooks/useLocalAI.ts";
import { sendChatTurn, unanswered } from "../hooks/chat-turn.ts";
import type { TurnInput } from "../hooks/chat-turn.ts";
import { MomoSettings } from "./MomoSettings.tsx";
import { MemoryPanel } from "./MemoryPanel.tsx";
import type { Memory } from "../lib/chat/transcript.ts";
import { localAISession } from "../lib/ai/session.ts";
import { errorCode } from "../lib/ai/protocol.ts";
import { momoSupportsAI } from "../lib/chat/prompt.ts";
import { planChatPrompt } from "../lib/chat/plan.ts";

const isIds = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((id) => typeof id === "string");
const isCounts = (v: unknown): v is Record<string, number> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v).every(
    (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
  );
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");
const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
const pill =
  "inline-flex h-6 items-center gap-1 rounded-full px-2 text-2xs font-semibold whitespace-nowrap [&_.icon]:size-3";

type Note = {
  tone: "info" | "warn" | "danger";
  text: string;
  settings?: boolean;
};

function Avatar({
  student,
  large = false,
}: {
  student: Student;
  large?: boolean;
}) {
  return (
    <img
      src={sitePath(`resource/momotalk/${student.img}`)}
      alt=""
      loading="lazy"
      className={cx(
        "shrink-0 rounded-full border border-line bg-surface-2 object-cover",
        large ? "size-20" : "size-11",
      )}
    />
  );
}
function Profile({
  student,
  children,
}: {
  student: Student;
  children?: ReactNode;
}) {
  const facts = [
    [
      "소속",
      [student.school, student.year, student.club].filter(Boolean).join(" · "),
    ],
    ["생일", student.birthday],
    ["나이", student.age],
    ["키", student.height],
    ["취미", student.hobby],
    ["성우", student.voice],
    ["일러스트", student.illust],
  ].filter(([, value]) => value);
  return (
    <div className="p-5">
      <Avatar student={student} large />
      <h3 className="mt-3 text-lg font-semibold">{student.name}</h3>
      <p className="mt-1 text-sm text-muted">{student.status}</p>
      {children}
      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {student.intro && <p className="mt-5 text-sm/relaxed">{student.intro}</p>}
    </div>
  );
}

function AIBadge({ onSettings }: { onSettings: () => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className={cx(pill, "bg-selected text-blue-strong")}>
        <Icon name="sparkle" />
        AI 대화 지원
      </span>
      <button
        type="button"
        className="text-xs font-semibold text-blue underline-offset-2 hover:underline"
        onClick={onSettings}
      >
        모델 설정
      </button>
    </div>
  );
}

export function MomoTalk({
  open,
  settings,
  setSettings,
  settingsContent,
  settingsFooter,
  onClose,
  onUnread,
}: {
  open: boolean;
  settings: boolean;
  setSettings: (settings: boolean) => void;
  settingsContent: ReactNode;
  settingsFooter: ReactNode;
  onClose: () => void;
  onUnread: (total: number) => void;
}) {
  const [students, setStudents] = useState<Student[]>([ARONA]);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const chat = useChat();
  const ai = useLocalAI();
  const rooms = chat.rooms;
  const [note, setNote] = useState<Note | null>(null);
  const [stream, setStream] = useState("");
  const [context, setContext] = useState("");
  const [loadedMemories, setLoadedMemories] = useState<{
    room: string;
    rows: Memory[];
  } | null>(null);
  const [unread, setUnread] = usePersistentState(
    "molu.momotalk.unread.v1",
    {},
    isCounts,
  );
  const [favorites, setFavorites] = usePersistentState(
    "molu.momo.fav.v1",
    [],
    isIds,
  );
  const [sound, setSound] = usePersistentState(
    "molu.momo.sound.v1",
    true,
    isBoolean,
  );
  const [pane, setPane] = useState<"friends" | "chat">("friends");
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("Arona");
  const [room, setRoom] = useState<string | null>(null);
  const [profile, setProfile] = useState(false);
  const [panel, setPanel] = useState<"chat" | "profile" | "memory">("chat");
  const [drafts, setDrafts] = useState(
    () => new Map<string, { text: string }>(),
  );
  const input = (room && drafts.get(room)?.text) || "";
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const active = useRef({ open, room });
  const audio = useRef<HTMLAudioElement | null>(null);
  const sending = useRef<AbortController | null>(null);
  const paging = useRef(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const total = Object.values(unread).reduce((sum, n) => sum + n, 0);
  const studentId = room ?? selected;
  const student = students.find((s) => s.id === studentId) ?? {
    ...ARONA,
    id: studentId,
    name: studentId,
    short: studentId,
    school: "",
    status: "",
  };
  const messages = room ? (rooms[room] ?? []) : [];
  const roomAI = !!room && momoSupportsAI(room);
  const memories =
    roomAI && loadedMemories?.room === room ? loadedMemories.rows : [];
  const remembered = new Set(memories.map((m) => m.sourceMessageId));
  const blocked = !!busy || !chat.ready || !!chat.error;

  useEffect(() => {
    active.current = { open, room };
    // Replies that landed while the window was closed are read once it reopens.
    if (open && room)
      setUnread((current) =>
        current[room] ? { ...current, [room]: 0 } : current,
      );
  }, [open, room, setUnread]);
  useEffect(() => onUnread(total), [total, onUnread]);
  useEffect(() => {
    if (note?.tone !== "info") return;
    const timer = window.setTimeout(() => setNote(null), 3000);
    return () => window.clearTimeout(timer);
  }, [note]);
  const stop = useCallback(() => {
    if (!sending.current) return;
    sending.current.abort();
    localAISession.cancel("momotalk");
  }, []);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", stop);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", stop);
      stop();
      audio.current?.pause();
    };
  }, [stop]);
  useEffect(() => {
    if (paging.current) {
      paging.current = false;
      return;
    }
    if (open && room && panel === "chat")
      messagesEnd.current?.scrollIntoView({ block: "nearest" });
  }, [open, room, rooms, busy, stream, panel]);
  useEffect(() => {
    let disposed = false;
    const store = chat.store;
    if (!room || !store || !momoSupportsAI(room)) return;
    void store
      .memories(room)
      .then((rows) => {
        if (!disposed) setLoadedMemories({ room, rows });
      })
      .catch((cause: unknown) => {
        if (!disposed) setNote({ tone: "danger", text: messageOf(cause) });
      });
    return () => {
      disposed = true;
    };
  }, [room, chat.store, chat.memoryVersion]);
  useEffect(() => {
    if (!open && !settings) return;
    const controller = new AbortController();
    fetch(sitePath("resource/momotalk/students.json"), {
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error("Student data unavailable");
        return r.json();
      })
      .then((data: unknown) => {
        if (
          !Array.isArray(data) ||
          !data.every(
            (s) =>
              s &&
              typeof s.id === "string" &&
              typeof s.name === "string" &&
              typeof s.img === "string",
          )
        )
          throw new Error("Invalid student data");
        setStudents([ARONA, ...data.filter((s) => s.id !== "Arona")]);
        setLoadError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, [open, settings, attempt]);

  const changed = useCallback(async () => {
    chat.notify();
    await chat.refresh();
  }, [chat]);
  const openRoom = async (id: string) => {
    if (!chat.ready || chat.error) return;
    setRoom(id);
    setSelected(id);
    setProfile(false);
    setPanel("chat");
    setSettings(false);
    setNote(null);
    setReplacingId(null);
    setUnread((current) => ({ ...current, [id]: 0 }));
    try {
      await chat.load(id);
    } catch {
      /* Storage error is displayed by the chat hook. */
    }
  };
  const leaveRoom = () => {
    setRoom(null);
    setProfile(false);
    setPanel("chat");
    setNote(null);
    setPane("chat");
  };
  const chime = () => {
    if (!sound) return;
    audio.current ??= new Audio(
      sitePath("resource/momotalk/ui/SE_MomoTalk_01.wav"),
    );
    audio.current.volume = 0.5;
    audio.current.currentTime = 0;
    void audio.current.play().catch(() => {});
  };
  const send = async (submission: TurnInput) => {
    if (
      !room ||
      !momoSupportsAI(room) ||
      sending.current ||
      ("text" in submission && !submission.text.trim()) ||
      !chat.ready ||
      chat.error
    )
      return;
    const id = room;
    const controller = new AbortController();
    const { signal } = controller;
    sending.current = controller;
    const submittedDraft = drafts.get(id);
    setBusy(id);
    setNote(null);
    setContext("");
    try {
      await navigator.locks.request(
        `molu-chat:${id}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error("다른 탭에서 이 대화에 답장하는 중이에요.");
          await sendChatTurn({
            input: submission,
            signal,
            head: () => chat.read((store) => store.writeHead(id), signal),
            prepare: async () => {
              if (!localAISession.ready) await ai.prepare("cache-only", signal);
            },
            history: async () => (await chat.load(id, signal)).messages,
            append: (message, onCommit) => chat.append(id, message, onCommit),
            onQuestionSaved: () => {
              setDrafts((current) => {
                if (!submittedDraft || current.get(id) !== submittedDraft)
                  return current;
                const next = new Map(current);
                next.delete(id);
                return next;
              });
            },
            plan: (question, history) =>
              planChatPrompt(
                {
                  memories: (roomId) =>
                    chat.read((store) => store.memories(roomId), signal),
                  sourceMessage: (roomId, messageId) =>
                    chat.read(
                      (store) => store.sourceMessage(roomId, messageId),
                      signal,
                    ),
                  searchRoom: (roomId, options) =>
                    chat.read(
                      (store) => store.searchRoom(roomId, options),
                      signal,
                    ),
                },
                id,
                question.text,
                history,
                question.id,
                signal,
              ),
            generate: async (plan) => {
              const turns = (plan.messages.length - 1) / 2;
              setContext(
                [
                  plan.memories.length &&
                    `저장된 기억 ${plan.memories.length}개`,
                  turns && `최근 대화 ${turns}회`,
                  plan.excerpts.length &&
                    `지난 대화 발췌 ${plan.excerpts.length}개`,
                ]
                  .filter(Boolean)
                  .join(" · "),
              );
              const result = await localAISession.run("momotalk", (client) =>
                client.request(
                  "generate",
                  {
                    characterId: id,
                    messages: plan.messages,
                    memories: plan.memories,
                    excerpts: plan.excerpts,
                    maxTokens: 256,
                  },
                  {
                    firstMs: 60000,
                    timeoutMs: 180000,
                    onEvent: (event) => {
                      if (event.event === "token" && !signal.aborted)
                        setStream(event.text ?? "");
                    },
                  },
                ),
              );
              return result.text;
            },
          });
          if (signal.aborted) return;
          chime();
          if (!active.current.open || active.current.room !== id)
            setUnread((current) => ({
              ...current,
              [id]: (current[id] ?? 0) + 1,
            }));
        },
      );
    } catch (cause) {
      if (signal.aborted) return;
      if (cause instanceof Error && cause.name === "ChatStorageConflict") {
        await chat.read(() => chat.refresh(), signal).catch(() => {});
      }
      if (active.current.room !== id || signal.aborted) return;
      if (errorCode(cause) === "model_not_cached")
        setNote({
          tone: "warn",
          text: `${student.short}의 AI 답장을 받으려면 먼저 모델을 받아 주세요.`,
          settings: true,
        });
      else setNote({ tone: "danger", text: messageOf(cause) });
    } finally {
      sending.current = null;
      setBusy(null);
      setStream("");
      setContext("");
    }
  };
  const remember = (messageId: string, text: string) => {
    const store = chat.transcript.current;
    if (!store || !room) return;
    void store
      .saveMemory({
        roomId: room,
        text: text.slice(0, 500),
        sourceMessageId: messageId,
        sourceText: text.slice(0, 2000),
      })
      .then(() => {
        chat.notify();
        setNote({ tone: "info", text: `${student.short}의 기억에 담았어요.` });
      })
      .catch((cause: unknown) =>
        setNote({ tone: "danger", text: messageOf(cause) }),
      );
  };
  const hits = students
    .filter((s) =>
      normalize(
        [s.name, s.short, s.school, s.club, s.status].join(" "),
      ).includes(normalize(query)),
    )
    .sort(
      (a, b) =>
        Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)),
    );
  const chatIds = chat.summaries
    .map((entry) => entry.roomId)
    .filter((id) => !onlyUnread || unread[id]);
  const latest = chat.summaries.find((entry) => entry.roomId === room)?.last;
  const retryTarget = unanswered(latest);
  const retryable = !!retryTarget && !busy && !chat.error;
  const replacing = !!retryTarget && retryTarget.id === replacingId;
  const retryButton = (
    <div className="flex flex-wrap gap-1">
      <button
        type="button"
        className={cx(quietButton, smallButton, "min-h-8!")}
        disabled={!roomAI || !!chat.error}
        onClick={() => retryTarget && void send({ retryId: retryTarget.id })}
      >
        다시 시도
      </button>
      <button
        type="button"
        className={cx(quietButton, smallButton, "min-h-8!")}
        disabled={!roomAI || !!chat.error}
        onClick={() => {
          setNote(null);
          setReplacingId(replacing ? null : (retryTarget?.id ?? null));
        }}
      >
        {replacing ? "새 질문 취소" : "새 질문 작성"}
      </button>
    </div>
  );
  const settingsButton = (
    <button
      type="button"
      className={cx(quietButton, smallButton, "min-h-8!")}
      onClick={() => setSettings(true)}
    >
      설정 열기
    </button>
  );
  const activeMemories = memories.filter((m) => m.enabled).length;
  const storageNotice = chat.error && (
    <Notice
      tone="warn"
      className="mb-3 shrink-0"
      action={
        <button
          type="button"
          className={cx(quietButton, smallButton, "min-h-8!")}
          onClick={() => void chat.retry()}
        >
          다시 시도
        </button>
      }
    >
      대화를 저장하지 못했어요. {chat.error}
    </Notice>
  );

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        label="MomoTalk"
        labelledBy="momotalk-title"
        icon="chat"
        className="w-[min(900px,calc(100vw-24px))]"
        actions={
          <>
            <button
              type="button"
              className={iconButton}
              aria-label="모모톡 알림음"
              aria-pressed={sound}
              onClick={() => setSound(!sound)}
            >
              <Icon name={sound ? "sound" : "muted"} />
            </button>
            <button
              type="button"
              className={cx(
                iconButton,
                "aria-pressed:bg-selected aria-pressed:text-blue",
              )}
              aria-label="MOLU 설정"
              aria-pressed={settings}
              onClick={() => setSettings(!settings)}
            >
              <Icon name="settings" />
            </button>
          </>
        }
      >
        <h2 id="momotalk-title" className="sr-only">
          MomoTalk
        </h2>
        <div className="flex h-[min(650px,calc(100dvh-160px))] min-h-[300px] flex-col">
          {storageNotice}
          {room ? (
            <>
              <header className="flex shrink-0 items-center gap-3 border-b border-line pb-3">
                <button
                  type="button"
                  className={iconButton}
                  aria-label="대화 목록으로"
                  onClick={leaveRoom}
                >
                  <Icon name="chevron" className="rotate-180" />
                </button>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
                  onClick={() =>
                    setPanel(panel === "profile" ? "chat" : "profile")
                  }
                  aria-expanded={panel === "profile"}
                  aria-label={`${student.short} 프로필`}
                >
                  <Avatar student={student} />
                  <span className="min-w-0">
                    <strong className="flex items-center gap-2">
                      {student.short}
                    </strong>
                    <small className="block truncate text-xs text-muted">
                      {[student.school, student.club]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                </button>
                {roomAI && (
                  <button
                    type="button"
                    className={cx(
                      pill,
                      "transition-colors",
                      ai.ready
                        ? "bg-selected text-blue-strong hover:bg-hover-strong"
                        : "border border-dashed border-frame text-muted hover:text-blue",
                    )}
                    title={
                      ai.ready
                        ? "기기 안 AI가 답장해요"
                        : ai.loading
                          ? "모델을 준비하고 있어요"
                          : "첫 답장 때 모델을 불러와요"
                    }
                    onClick={() => setSettings(true)}
                  >
                    <Icon name="sparkle" />
                    {ai.ready
                      ? "AI"
                      : ai.loading
                        ? `AI ${Math.round(ai.progress * 100)}%`
                        : "AI 대기"}
                  </button>
                )}
                {roomAI && (
                  <button
                    type="button"
                    className={cx(
                      iconButton,
                      "relative aria-pressed:bg-selected aria-pressed:text-blue",
                    )}
                    aria-label={`${student.short}의 기억 ${activeMemories}개`}
                    title="기억"
                    aria-pressed={panel === "memory"}
                    onClick={() =>
                      setPanel(panel === "memory" ? "chat" : "memory")
                    }
                  >
                    <Icon name="book" />
                    {activeMemories > 0 && (
                      <span
                        className="absolute top-0.5 right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-blue px-0.5 numeric text-[9px]/none text-white"
                        aria-hidden="true"
                      >
                        {activeMemories}
                      </span>
                    )}
                  </button>
                )}
              </header>
              {panel === "profile" ? (
                <div className="flex-1 scroll-thin overflow-y-auto">
                  <Profile student={student}>
                    {roomAI && <AIBadge onSettings={() => setSettings(true)} />}
                  </Profile>
                  <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-5 pt-4 pb-5">
                    <button
                      type="button"
                      className={quietButton}
                      onClick={() => setPanel("chat")}
                    >
                      대화로 돌아가기
                    </button>
                    <ConfirmButton
                      className="ml-auto"
                      confirm="이 대화와 기억을 지울까요?"
                      disabled={!chat.store || !!busy}
                      onConfirm={() => {
                        const store = chat.store;
                        if (!store) return;
                        void store
                          .deleteRoom(room)
                          .then(() => {
                            setDrafts((current) => {
                              const next = new Map(current);
                              next.delete(room);
                              return next;
                            });
                          })
                          .then(changed)
                          .then(leaveRoom)
                          .catch((cause: unknown) =>
                            setNote({ tone: "danger", text: messageOf(cause) }),
                          );
                      }}
                    >
                      <Icon name="trash" />
                      대화 지우기
                    </ConfirmButton>
                  </div>
                </div>
              ) : panel === "memory" ? (
                <MemoryPanel
                  key={room}
                  roomId={room}
                  student={student}
                  store={chat.store}
                  memories={memories}
                  busy={!!busy}
                  onChange={changed}
                />
              ) : (
                <>
                  <div
                    role="log"
                    aria-label={`${student.short}와의 대화`}
                    aria-live="polite"
                    className="flex min-h-0 flex-1 scroll-thin flex-col gap-4 overflow-y-auto bg-surface-2 p-4 max-sm:px-2"
                  >
                    {messages.length === 0 && (
                      <p className="m-auto text-center text-sm text-muted">
                        메시지를 보내 대화를 시작해 보세요.
                      </p>
                    )}
                    {!chat.ready && !chat.error && (
                      <p role="status" className="m-auto text-sm text-muted">
                        대화를 불러오는 중이에요…
                      </p>
                    )}
                    {chat.store?.cached(room)?.hasMore && (
                      <button
                        type="button"
                        className={cx(
                          quietButton,
                          smallButton,
                          "self-center rounded-full",
                        )}
                        onClick={() => {
                          const store = chat.transcript.current;
                          if (store) {
                            paging.current = true;
                            void store
                              .loadOlder(room)
                              .then(chat.update)
                              .catch((cause: unknown) =>
                                setNote({
                                  tone: "danger",
                                  text: messageOf(cause),
                                }),
                              );
                          }
                        }}
                      >
                        이전 대화 더 보기
                      </button>
                    )}
                    {messages.map((message) => (
                      <div
                        key={message.id}
                        className={cx(
                          "group flex items-start gap-2",
                          message.me && "flex-row-reverse",
                        )}
                      >
                        {!message.me && <Avatar student={student} />}
                        <div
                          className={cx(
                            "flex max-w-[80%] flex-col",
                            message.me && "items-end",
                          )}
                        >
                          {!message.me && (
                            <p className="mb-1 text-xs font-semibold">
                              {student.short}
                            </p>
                          )}
                          <p
                            className={cx(
                              "rounded-lg px-3 py-2 text-sm/relaxed wrap-anywhere whitespace-pre-wrap",
                              message.me
                                ? "bg-blue text-white"
                                : "border border-line bg-surface",
                            )}
                          >
                            {message.text}
                          </p>
                          <div
                            className={cx(
                              "mt-1 flex min-h-5 items-center gap-2 text-2xs text-muted",
                              message.me && "flex-row-reverse",
                            )}
                          >
                            <time>{message.time}</time>
                            {message.sourceKind === "model-output" && (
                              <span
                                className="inline-flex items-center gap-0.5 font-semibold text-blue [&_.icon]:size-3"
                                title="기기 안 AI가 만든 답장"
                              >
                                <Icon name="sparkle" />
                                AI
                              </span>
                            )}
                            {roomAI &&
                              (remembered.has(message.id) ? (
                                <span className="inline-flex items-center gap-0.5 font-semibold text-bookmark [&_.icon]:size-3">
                                  <Icon name="check" />
                                  기억함
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="rounded-sm px-1 font-semibold opacity-0 transition-opacity group-hover:opacity-100 hover:text-blue focus-visible:opacity-100 pointer-coarse:opacity-100"
                                  disabled={blocked}
                                  onClick={() =>
                                    remember(message.id, message.text)
                                  }
                                >
                                  기억하기
                                </button>
                              ))}
                          </div>
                        </div>
                      </div>
                    ))}
                    {busy === room && (
                      <div className="flex items-start gap-2" role="status">
                        <Avatar student={student} />
                        <div className="flex max-w-[80%] flex-col">
                          <p className="mb-1 text-xs font-semibold">
                            {student.short}
                          </p>
                          <p className="rounded-lg border border-line bg-surface px-3 py-2 text-sm/relaxed wrap-anywhere whitespace-pre-wrap">
                            {stream || (
                              <span
                                className="typing inline-flex h-[1lh] items-center gap-1"
                                aria-label={`${student.short} 입력 중`}
                              >
                                <span />
                                <span />
                                <span />
                              </span>
                            )}
                          </p>
                          {ai.loading ? (
                            <span className="mt-1 text-2xs text-muted">
                              모델 준비 중 {Math.round(ai.progress * 100)}%
                            </span>
                          ) : (
                            <>
                              {!stream && (
                                <span className="mt-1 text-2xs text-muted">
                                  첫 답변을 준비하고 있어요. 최대 60초 정도 걸릴
                                  수 있어요.
                                </span>
                              )}
                              {context && (
                                <span className="mt-1 text-2xs text-muted">
                                  {context} 참고 중
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    <div ref={messagesEnd} />
                  </div>
                  {messages.length > 0 &&
                    messages.at(-1)?.id !== latest?.id && (
                      <button
                        type="button"
                        className={cx(
                          primaryButton,
                          smallButton,
                          "relative z-10 -mt-12 mb-3 self-center rounded-full shadow-pop",
                        )}
                        onClick={() => void chat.load(room)}
                      >
                        <Icon name="chevron" className="rotate-90" />
                        최신 대화로
                      </button>
                    )}
                  {!roomAI && (
                    <Notice tone="info" className="mt-3 shrink-0">
                      AI 대화를 지원하지 않는 학생이에요. 기존 대화만 볼 수
                      있어요.
                    </Notice>
                  )}
                  {(note || retryable) && (
                    <Notice
                      tone={note?.tone ?? "warn"}
                      icon={note?.tone === "info" ? "check" : "info"}
                      className="mt-3 shrink-0"
                      action={
                        note?.settings
                          ? settingsButton
                          : retryable && note?.tone !== "info"
                            ? retryButton
                            : undefined
                      }
                      onDismiss={note ? () => setNote(null) : undefined}
                    >
                      {note?.text ??
                        (replacing
                          ? "이전 질문은 답장 없이 기록에 남겨 두고, 새 질문에 답장해요."
                          : `${student.short}의 답장을 받지 못했어요.`)}
                    </Notice>
                  )}
                  <form
                    className="mt-3 flex shrink-0 gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!retryTarget || replacing)
                        void send({
                          text: input,
                          replaceId: replacing ? retryTarget?.id : undefined,
                        });
                    }}
                  >
                    <input
                      className={cx(field, "flex-1")}
                      aria-label="메시지 입력"
                      placeholder={`${student.short}에게 메시지 보내기`}
                      disabled={!roomAI}
                      maxLength={2000}
                      value={input}
                      onChange={(e) => {
                        const text = e.target.value;
                        setDrafts((current) => {
                          const next = new Map(current);
                          if (text) next.set(room, { text });
                          else next.delete(room);
                          return next;
                        });
                      }}
                    />
                    {busy === room ? (
                      <button
                        type="button"
                        className={quietButton}
                        onClick={stop}
                      >
                        <Icon name="stop" />
                        중단
                      </button>
                    ) : (
                      <button
                        className={primaryButton}
                        type="submit"
                        disabled={
                          !roomAI ||
                          blocked ||
                          (!!retryTarget && !replacing) ||
                          !input.trim()
                        }
                      >
                        {replacing ? "새 질문 전송" : "전송"}
                      </button>
                    )}
                  </form>
                </>
              )}
            </>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-3 border-b border-line pb-3 max-xs:flex-wrap">
                <nav
                  className="flex shrink-0 gap-2"
                  aria-label="모모톡 보기 전환"
                >
                  <button
                    type="button"
                    className={pane === "friends" ? primaryButton : quietButton}
                    aria-pressed={pane === "friends"}
                    onClick={() => setPane("friends")}
                  >
                    친구
                  </button>
                  <button
                    type="button"
                    className={pane === "chat" ? primaryButton : quietButton}
                    aria-pressed={pane === "chat"}
                    onClick={() => setPane("chat")}
                  >
                    채팅{total > 0 ? ` · ${total}` : ""}
                  </button>
                </nav>
                {pane === "friends" ? (
                  <div
                    className="ml-auto flex h-10 w-[min(100%,320px)] min-w-0 items-center gap-[7px] rounded-lg border border-control bg-surface pr-2 pl-2.5 text-muted transition-colors focus-within:border-accent focus-within:text-blue focus-within:shadow-ring max-sm:w-auto max-sm:flex-1"
                    role="search"
                  >
                    <Icon name="search" className="size-4" />
                    <input
                      type="search"
                      aria-label="학생 검색"
                      placeholder="이름·학교·동아리"
                      className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-subtle focus-visible:outline-0"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                ) : (
                  <div
                    className="ml-auto flex gap-1 rounded-lg bg-surface-2 p-1"
                    role="group"
                    aria-label="대화 목록 필터"
                  >
                    {[false, true].map((value) => (
                      <button
                        key={String(value)}
                        type="button"
                        aria-pressed={onlyUnread === value}
                        onClick={() => setOnlyUnread(value)}
                        className="rounded-[8px] border border-transparent px-3 py-1 text-sm font-semibold whitespace-nowrap text-muted transition-colors hover:text-ink aria-pressed:border-control aria-pressed:bg-surface aria-pressed:text-ink"
                      >
                        {value
                          ? `읽지 않음${total > 0 ? ` · ${total}` : ""}`
                          : "전체"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {pane === "friends" ? (
                <>
                  {loadError && (
                    <Notice
                      tone="danger"
                      className="mt-3 shrink-0"
                      action={
                        <button
                          type="button"
                          className={cx(quietButton, smallButton, "min-h-8!")}
                          onClick={() => setAttempt(attempt + 1)}
                        >
                          다시 시도
                        </button>
                      }
                    >
                      학생 목록을 불러오지 못했어요.
                    </Notice>
                  )}
                  <div className="mt-2 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-sm:grid-cols-1">
                    <div
                      className={cx(
                        "scroll-thin overflow-y-auto",
                        profile && "max-sm:hidden",
                      )}
                      aria-label="학생 목록"
                    >
                      {hits.length ? (
                        hits.map((s) => (
                          <div
                            key={s.id}
                            className={cx(
                              "flex items-center border-b border-line-soft transition-colors hover:bg-hover",
                              selected === s.id &&
                                "bg-selected hover:bg-selected",
                            )}
                          >
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left"
                              onClick={() => {
                                setSelected(s.id);
                                setProfile(true);
                              }}
                              aria-pressed={selected === s.id}
                            >
                              <Avatar student={s} />
                              <span className="min-w-0">
                                <strong className="flex items-center gap-1.5 text-sm">
                                  {s.short}
                                  {momoSupportsAI(s.id) && (
                                    <Icon
                                      name="sparkle"
                                      className="size-3.5 text-accent"
                                    />
                                  )}
                                </strong>
                                <small className="block truncate text-xs text-muted">
                                  {s.school} · {s.club || s.status}
                                </small>
                              </span>
                            </button>
                            <button
                              type="button"
                              className={iconButton}
                              aria-label={`${s.short} 즐겨찾기`}
                              aria-pressed={favorites.includes(s.id)}
                              onClick={() =>
                                setFavorites((current) =>
                                  current.includes(s.id)
                                    ? current.filter((id) => id !== s.id)
                                    : [...current, s.id],
                                )
                              }
                            >
                              <Icon
                                name="bookmark"
                                filled={favorites.includes(s.id)}
                              />
                            </button>
                          </div>
                        ))
                      ) : (
                        <p className="p-5 text-sm text-muted">
                          검색 결과가 없어요.
                        </p>
                      )}
                    </div>
                    <aside
                      className={cx(
                        "scroll-thin overflow-y-auto border-l border-line max-sm:border-l-0",
                        !profile && "max-sm:hidden",
                      )}
                      aria-label="선택한 학생 프로필"
                    >
                      <Profile student={student}>
                        {momoSupportsAI(student.id) && (
                          <AIBadge onSettings={() => setSettings(true)} />
                        )}
                      </Profile>
                      <div className="px-5 pb-5">
                        <button
                          type="button"
                          className={primaryButton}
                          disabled={
                            !momoSupportsAI(student.id) ||
                            !chat.ready ||
                            !!chat.error
                          }
                          onClick={() => openRoom(student.id)}
                        >
                          대화 시작
                        </button>
                        <button
                          type="button"
                          className={cx(quietButton, "mt-2 ml-2 sm:hidden")}
                          onClick={() => setProfile(false)}
                        >
                          목록으로
                        </button>
                        {!momoSupportsAI(student.id) && (
                          <p className="mt-2 text-xs text-muted">
                            아직 AI 대화를 지원하지 않는 학생이에요.
                          </p>
                        )}
                      </div>
                    </aside>
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-1 min-h-0 flex-1 scroll-thin overflow-y-auto">
                    {chatIds.length ? (
                      chatIds.map((id) => {
                        const s = students.find((s) => s.id === id) ?? {
                          ...ARONA,
                          id,
                          short: id,
                        };
                        const last = chat.summaries.find(
                          (entry) => entry.roomId === id,
                        )!.last;
                        return (
                          <button
                            key={id}
                            type="button"
                            className="flex w-full items-center gap-3 border-b border-line-soft py-3 text-left hover:bg-hover"
                            onClick={() => openRoom(id)}
                          >
                            <Avatar student={s} />
                            <span className="min-w-0 flex-1">
                              <strong className="block text-sm">
                                {s.short}
                              </strong>
                              <span className="block truncate text-xs text-muted">
                                {last.text}
                              </span>
                            </span>
                            <span className="text-xs text-muted">
                              {last.time}
                              {!!unread[id] && (
                                <span className="ml-2 rounded-full bg-blue px-2 text-white">
                                  {unread[id]}
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <p className="py-8 text-center text-sm text-muted">
                        {!chat.ready && !chat.error
                          ? "대화를 불러오는 중이에요…"
                          : onlyUnread
                            ? "읽지 않은 대화가 없어요."
                            : "친구 탭에서 학생을 골라 대화를 시작해 보세요."}
                      </p>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Dialog>
      <Dialog
        open={settings}
        onClose={() => setSettings(false)}
        label="MOLU 설정"
        labelledBy="settings-title"
        icon="settings"
        className="w-[min(720px,calc(100vw-24px))]"
      >
        <h2 id="settings-title" className="sr-only">
          MOLU 설정
        </h2>
        {storageNotice}
        <p className="mb-5 text-sm text-muted">
          달력, 모모톡, AI와 저장 데이터를 한곳에서 관리해요.
        </p>
        <div className="flex flex-col gap-7">
          {settingsContent}
          <section aria-labelledby="momotalk-settings">
            <h3
              id="momotalk-settings"
              className="mb-2.5 flex items-center gap-2 text-md font-semibold text-ink [&_.icon]:size-4 [&_.icon]:text-blue"
            >
              <Icon name="chat" />
              모모톡
            </h3>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3.5 py-3">
              <strong className="text-md text-ink">알림음</strong>
              <Switch
                label="모모톡 알림음"
                checked={sound}
                onChange={setSound}
              />
            </div>
          </section>
          <MomoSettings
            store={chat.store}
            students={students}
            busy={!!busy}
            onChange={async () => {
              setDrafts(new Map());
              await changed();
            }}
          />
          {settingsFooter}
        </div>
      </Dialog>
    </>
  );
}
