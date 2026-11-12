import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import type { FeedEvent } from "./lib/calendar/feed.ts";
import type { EventOverride } from "./lib/admin/overrides.ts";

const events = JSON.parse(
  document.getElementById("events")!.textContent!,
) as FeedEvent[];
const publishedOverrides = JSON.parse(
  document.getElementById("overrides")!.textContent!,
) as EventOverride[];
const root = document.getElementById("root")!;
createRoot(root).render(
  <StrictMode>
    <App
      events={events}
      adminPage={root.dataset.admin === "true"}
      publishedOverrides={publishedOverrides}
    />
  </StrictMode>,
);
