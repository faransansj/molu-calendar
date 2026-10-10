import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePersistentState } from "../hooks/calendar.ts";
import type { FeedEvent } from "../lib/calendar/feed.ts";
import {
  ARONA,
  momoReply,
  momoTopicsFor,
  scheduleReply,
} from "../lib/chat/replies.ts";
import type { Student } from "../lib/chat/replies.ts";
import { sitePath } from "../lib/urls.ts";
import { cx } from "../lib/cx.ts";
import {
  ConfirmButton,
  Dialog,
  Notice,
  field,
  iconButton,
  primaryButton,
  quietButton,
  smallButton,
} from "./ui.tsx";
import { Icon } from "./Icon.tsx";
import { useChat } from "../hooks/useChat.ts";
import { useLocalAI } from "../hooks/useLocalAI.ts";
import { MomoSettings } from "./MomoSettings.tsx";
import { MemoryPanel } from "./MemoryPanel.tsx";
import type { Memory } from "../lib/chat/transcript.ts";
import { localAISession } from "../lib/ai/session.ts";
import { momoCalendarQuery, momoSupportsAI } from "../lib/chat/prompt.ts";
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

function AIBadge({
  enabled,
  onSettings,
}: {
  enabled: boolean;
  onSettings: () => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className={cx(pill, "bg-selected text-blue-strong")}>
        <Icon name="sparkle" />
        AI 대화 지원
      </span>
      {!enabled && (
        <button
          type="button"
          className="text-xs font-semibold text-blue underline-offset-2 hover:underline"
          onClick={onSettings}
        >
          설정에서 켜기
        </button>
      )}
    </div>
  );
}

export function MomoTalk({
  events,
  open,
  onClose,
  onUnread,
}: {
  events: FeedEvent[];
  open: boolean;
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
  const [memoryVersion, setMemoryVersion] = useState(0);
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
  const [settings, setSettings] = useState(false);
  const [pane, setPane] = useState<"friends" | "chat">("friends");
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("Arona");
  const [room, setRoom] = useState<string | null>(null);
  const [profile, setProfile] = useState(false);
  const [panel, setPanel] = useState<"chat" | "profile" | "memory">("chat");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const active = useRef({ open, room });
  const audio = useRef<HTMLAudioElement | null>(null);
  const sending = useRef(false);
  const paging = useRef(false);
  const epoch = useRef(0);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const total = Object.values(unread).reduce((sum, n) => sum + n, 0);
  const student = students.find((s) => s.id === (room ?? selected)) ?? ARONA;
  const messages = room ? (rooms[room] ?? []) : [];
  const topics = momoTopicsFor(room ?? selected);
  const topic =
    topics[
      (chat.summaries.find((entry) => entry.roomId === room)
        ?.userMessageCount ?? 0) % topics.length
    ]!;
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
  useEffect(
    () => () => {
      epoch.current++;
      localAISession.cancel("momotalk");
      audio.current?.pause();
    },
    [],
  );
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
      .catch((cause: unknown) =>
        setNote({ tone: "danger", text: messageOf(cause) }),
      );
    return () => {
      disposed = true;
    };
  }, [room, chat.store, memoryVersion]);
  useEffect(() => {
    if (!open) return;
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
  }, [open, attempt]);

  const changed = useCallback(async () => {
    chat.notify();
    await chat.refresh();
    setMemoryVersion((version) => version + 1);
  }, [chat]);
  const openRoom = async (id: string) => {
    if (!chat.ready || chat.error) return;
    setRoom(id);
    setSelected(id);
    setProfile(false);
    setPanel("chat");
    setSettings(false);
    setNote(null);
    setInput("");
    setUnread((current) => ({ ...current, [id]: 0 }));
    try {
      await chat.load(id);
      if (!chat.transcript.current?.cached(id)?.messages.length) {
        await chat.append(id, { me: false, text: momoTopicsFor(id)[0]!.ask });
      }
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
  const stop = () => {
    epoch.current++;
    ai.cancel();
  };
  const send = async (text: string, reply?: string, retry = false) => {
    if (!room || sending.current || !text.trim() || !chat.ready || chat.error)
      return;
    const id = room;
    const store = chat.transcript.current;
    if (!store) return;
    const calendar = momoCalendarQuery(text.trim());
    const useAI =
      !reply && !calendar && localAISession.momoEnabled && momoSupportsAI(id);
    // Never start a 2 GB download from the composer; send people to settings.
    if (useAI && !localAISession.ready && ai.cached !== true) {
      setNote({
        tone: "warn",
        text: `${student.short}의 AI 답장을 받으려면 먼저 모델을 받아 주세요.`,
        settings: true,
      });
      return;
    }
    sending.current = true;
    setBusy(id);
    setNote(null);
    setContext("");
    const generation = epoch.current;
    try {
      await navigator.locks.request(
        `molu-chat:${id}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error("다른 탭에서 이 대화에 답장하는 중이에요.");
          await chat.load(id);
          if (!retry && store.retryTarget(id))
            throw new Error(
              "답장을 기다리는 메시지가 있어요. 다시 시도를 눌러 주세요.",
            );
          const history = [...(store.cached(id)?.messages ?? [])];
          const question = text.trim();
          const questionRecord = retry
            ? store.retryTarget(id)
            : await chat.append(id, { me: true, text: question });
          if (!questionRecord) throw new Error("답장할 메시지가 없어요.");
          if (!retry) setInput("");
          let answer: string;
          if (useAI) {
            if (!localAISession.ready) await ai.prepare();
            if (generation !== epoch.current) return;
            const plan = await planChatPrompt(
              store,
              id,
              question,
              retry ? history.slice(0, -1) : history,
            );
            setContext(
              [
                plan.memories.length && `기억 ${plan.memories.length}개`,
                plan.excerpts.length && `지난 대화 ${plan.excerpts.length}개`,
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
                  firstMs: 5000,
                  timeoutMs: 60000,
                  onEvent: (event) => {
                    if (event.event === "token" && generation === epoch.current)
                      setStream(event.text ?? "");
                  },
                },
              ),
            );
            answer = result.text;
          } else
            answer = scheduleReply(
              reply ?? calendar ?? momoReply(question, student),
              events,
            );
          if (generation !== epoch.current) return;
          await chat.append(id, {
            me: false,
            text: answer,
            sourceKind: useAI ? "model-output" : "script",
            expectedLastMessageId: questionRecord.id,
          });
          chime();
          if (!active.current.open || active.current.room !== id)
            setUnread((current) => ({
              ...current,
              [id]: (current[id] ?? 0) + 1,
            }));
        },
      );
    } catch (cause) {
      // stop() advances epoch, so a cancelled generation cannot replace the current notice.
      if (generation === epoch.current)
        setNote({ tone: "danger", text: messageOf(cause) });
    } finally {
      sending.current = false;
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
        setMemoryVersion((version) => version + 1);
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
  const retryable = !!messages.at(-1)?.me && !busy && !chat.error;
  const retryButton = (
    <button
      type="button"
      className={cx(quietButton, smallButton, "min-h-8!")}
      disabled={!!chat.error}
      onClick={() => void send(messages.at(-1)!.text, undefined, true)}
    >
      다시 시도
    </button>
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

  return (
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
            aria-label="모모톡 설정"
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
        {chat.error && (
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
        )}
        {settings ? (
          <>
            <header className="flex shrink-0 items-center gap-3 border-b border-line pb-3">
              <button
                type="button"
                className={iconButton}
                aria-label="모모톡으로 돌아가기"
                onClick={() => setSettings(false)}
              >
                <Icon name="chevron" className="rotate-180" />
              </button>
              <strong className="font-display text-lg font-medium text-ink">
                모모톡 설정
              </strong>
            </header>
            <div className="min-h-0 flex-1 scroll-thin overflow-y-auto">
              <MomoSettings
                store={chat.store}
                students={students}
                busy={!!busy}
                onChange={changed}
              />
            </div>
          </>
        ) : room ? (
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
                    {[student.school, student.club].filter(Boolean).join(" · ")}
                  </small>
                </span>
              </button>
              {roomAI && ai.enabled && (
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
              {roomAI && (ai.enabled || memories.length > 0) && (
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
                  {roomAI && (
                    <AIBadge
                      enabled={ai.enabled}
                      onSettings={() => setSettings(true)}
                    />
                  )}
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
                        <span className="mt-1 text-2xs text-muted">
                          {ai.loading
                            ? `모델 준비 중 ${Math.round(ai.progress * 100)}%`
                            : context && `${context} 참고 중`}
                        </span>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEnd} />
                </div>
                {messages.length > 0 &&
                  messages.at(-1)?.id !==
                    chat.summaries.find((entry) => entry.roomId === room)?.last
                      .id && (
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
                    {note?.text ?? `${student.short}의 답장을 받지 못했어요.`}
                  </Notice>
                )}
                <div
                  className="flex shrink-0 flex-wrap justify-end gap-2 pt-3"
                  aria-label="답장 선택"
                >
                  {topic.options.map((option) => (
                    <button
                      key={option.text}
                      type="button"
                      className={cx(quietButton, smallButton, "rounded-full")}
                      disabled={blocked || !!messages.at(-1)?.me}
                      onClick={() => send(option.text, option.reply)}
                    >
                      {option.text}
                    </button>
                  ))}
                </div>
                <form
                  className="mt-3 flex shrink-0 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    send(input);
                  }}
                >
                  <input
                    className={cx(field, "flex-1")}
                    aria-label="메시지 입력"
                    placeholder={`${student.short}에게 메시지 보내기`}
                    maxLength={2000}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
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
                        blocked || !!messages.at(-1)?.me || !input.trim()
                      }
                    >
                      전송
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
                                {ai.enabled && momoSupportsAI(s.id) && (
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
                        <AIBadge
                          enabled={ai.enabled}
                          onSettings={() => setSettings(true)}
                        />
                      )}
                    </Profile>
                    <div className="px-5 pb-5">
                      <button
                        type="button"
                        className={primaryButton}
                        disabled={!chat.ready || !!chat.error}
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
                            <strong className="block text-sm">{s.short}</strong>
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
  );
}
