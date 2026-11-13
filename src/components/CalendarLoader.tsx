import { useEffect, useRef, useState } from "react";
import { App } from "../App.tsx";
import { validateFeed } from "../../scraper/schema.ts";
import { validateManifest } from "../lib/admin/publication.ts";
import { compareEvents } from "../lib/calendar/calendar.ts";
import type { CalendarPayload } from "../lib/calendar/runtime.ts";
import { sitePath } from "../lib/urls.ts";
import { Notice, quietButton, smallButton } from "./ui.tsx";
import { OfficialFeedContext } from "../hooks/calendar.ts";

type LoadState =
  { status: "loading" | "error" } | { status: "ready"; data: CalendarPayload };

export function CalendarLoader({ adminPage }: { adminPage: boolean }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    let current = true;
    void (async () => {
      try {
        const response = await fetch(sitePath("api/calendar"), {
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-cache",
        });
        if (
          !response.ok ||
          response.headers
            .get("Content-Type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase() !== "application/json"
        )
          throw new Error("Calendar response unavailable");
        const value: unknown = await response.json();
        if (
          !value ||
          typeof value !== "object" ||
          Object.keys(value).length !== 3 ||
          !("feed_id" in value) ||
          typeof value.feed_id !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.feed_id) ||
          !("feed" in value) ||
          !("published" in value)
        )
          throw new Error("Invalid calendar payload");
        const feed = validateFeed(value.feed);
        if (!feed.events.length) throw new Error("Empty calendar payload");
        feed.events.sort(compareEvents);
        const published = validateManifest(value.published);
        if (current)
          setState({
            status: "ready",
            data: { feed_id: value.feed_id, feed, published },
          });
      } catch {
        if (current && !controller.signal.aborted)
          setState({ status: "error" });
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [attempt]);

  if (state.status === "ready")
    return (
      <OfficialFeedContext value={state.data.feed_id}>
        <App
          events={state.data.feed.events}
          adminPage={adminPage}
          publishedOverrides={state.data.published.overrides}
        />
      </OfficialFeedContext>
    );
  return (
    <main className="mx-auto max-w-xl p-6">
      {state.status === "loading" ? (
        <Notice>일정을 불러오고 있어요.</Notice>
      ) : (
        <Notice
          tone="warn"
          action={
            <button
              type="button"
              className={`${quietButton} ${smallButton}`}
              onClick={() => {
                pending.current?.abort();
                setState({ status: "loading" });
                setAttempt((previous) => previous + 1);
              }}
            >
              다시 시도
            </button>
          }
        >
          일정을 불러오지 못했어요.
        </Notice>
      )}
    </main>
  );
}
