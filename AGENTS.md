# Repository guidelines

MOLU is an unofficial Blue Archive KR schedule calendar built with Astro, React,
TypeScript and Tailwind. Use Node 22.18+ and pnpm 10.11.0 through `nix develop`.

## Architecture

- `src/App.tsx` and `src/components/` own the React UI.
- `public/data/events.json` is the official Nexon KR schema-v2 feed. `scraper/`
  refreshes it; keep it authoritative.
- `src/lib/` contains typed calendar, search, feed and export logic.
- `src/hooks/useChat.ts` connects React to `src/lib/chat/` typed storage,
  transcript, memory and prompt modules. IndexedDB is authoritative. Storage
  failures block sending and expose retry.
- `src/lib/ai/` owns the pinned model catalogue, persona assembler, typed Worker
  protocol, client and session. Implementations define their own TypeScript
  contracts; do not add parallel handwritten declarations for these modules.
- `src/workers/local-ai.worker.ts` retains upstream's domain/AI behavior.
- `tools/build-ai.ts` bundles a classic IIFE Worker and copies pinned LiteRT
  runtime assets into `public/`. Generated files are ignored. LiteRT requires
  `importScripts`; do not switch to a module Worker.
- `public/resource/` holds the portraits, UI assets and persona corpora used by
  the current app. `tools/vendor/` refreshes those assets and corpora.
- `training/lora/` is an isolated Python/uv experiment, not a runtime dependency.

## Checks

`pnpm check:static` runs formatting, ESLint, CSS lint and TypeScript checks
for the app, Worker and tooling. `pnpm check` additionally runs the existing
TypeScript app/scraper tests. `pnpm build` builds the Worker then the static Astro
site. Use the collaborative browser for actual React flows, including paging,
backup/import, memory editing, cancellation/retry and storage failures.
Never count mock storage or fake Worker checks as real GPU/model validation.

## Contracts

Read `docs/chat-memory-contract.md` before changing persistence. Preserve
speaker/source attribution. Persist user messages before generation
and completed answers only. Reject stale responses after cancellation/deletion.
Use IndexedDB transaction completion, not request success, as the write boundary.
Keep memory selection room-scoped and budgeted. AI output must never become a
saved memory without an explicit user action. Maintain pinned model artifacts,
restricted CSP download hosts, and the classic Worker runtime.

Use existing UI components and tokens. Keep KST date arithmetic in UTC-based
helpers. Match Prettier formatting. Edit sources, never generated bundles.
