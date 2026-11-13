import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CalendarLoader } from "./components/CalendarLoader.tsx";
const root = document.getElementById("root")!;
createRoot(root).render(
  <StrictMode>
    <CalendarLoader adminPage={root.dataset.admin === "true"} />
  </StrictMode>,
);
