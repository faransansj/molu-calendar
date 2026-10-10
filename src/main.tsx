import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import type { FeedEvent } from "./lib/calendar/feed.ts";

const events = JSON.parse(
  document.getElementById("events")!.textContent!,
) as FeedEvent[];
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App events={events} />
  </StrictMode>,
);
