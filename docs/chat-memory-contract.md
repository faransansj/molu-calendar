# Chat storage and memory contract

## Storage

IndexedDB is authoritative. Schema v3 upgrades v2 in place; chat backups remain
v2. Restore generations are local concurrency controls and are never exported.

- Messages have stable IDs, per-room sequence numbers, speaker/source attribution,
  original text, epoch-millisecond timestamps and an optional reply target.
- Sources are `user-input`, `model-output`, `script` or `app`. A model statement
  does not establish a user fact.
- Opening a room never inserts a scripted greeting. New character replies are
  completed LLM outputs only. Preserve historical source attribution and records.
- Model acquisition at send time is cache-only. On a miss keep the draft and
  direct the user to settings. Persist the question before generation and only
  persist a completed reply; never save a partial stream. Retry uses the stored
  question's ID **and its persisted text**, not the visible page's last text.
  Plan before appending the question: a draft that exceeds the model context
  remains editable. “새 질문 작성” starts a new turn without deleting the old
  unanswered question and checks that another tab has not already answered it.
- IndexedDB transaction completion is the write boundary. Request success is
  provisional. Surface storage failures, block sending and expose explicit retry.
- Close connections on version changes and surface blocked opens. Do not silently
  fall back to another storage mechanism.
- Saving the first manual memory creates its room atomically. Room deletion
  removes memories even if an older version did not create a room. Import and
  export enforce the same 32 MiB UTF-8 limit, not a JavaScript character limit.
- A Web Lock serializes sends per room. Before committing a reply check both
  its target question and the generation in which it was started. Restoring a
  backup with identical IDs must not revalidate a stale reply. Broadcasts
  invalidate other tabs' messages and the currently displayed memory list.

## Explicit memory

Memories are private to a room. Only an explicit user action saves or edits a
memory. Model output never becomes a saved fact automatically. Disabled and
expired memories suppress their source messages in both excerpts and prompt
history. This is not transcript erasure: messages remain visible in the room.
The current user question is never silently changed. Retain excerpt attribution.
Use the open room's ID for storage, never a fallback display character's ID.

## Shared settings

The standalone MOLU settings dialog is owned by the calendar app and can open
without opening MomoTalk or a room. It reuses MomoTalk's transcript, notification
sound preference and local AI session for model preparation and backup controls.
Opening settings from a blocked send preserves the current room and draft.

## Model input

Every new character reply, including responses to schedule questions, uses the
local LLM. Do not offer scripted reply choices, seed greetings or fall back to
template/calendar replies. Model preparation is explicit in settings; a missing
model blocks sending with a preparation notice and preserves the draft.

Only students with built-in personas can start conversations. Disable the start
button for unsupported students and reject sends in their historical rooms.
Existing unsupported conversations remain readable, with the composer and retry
disabled. Keep their stored messages and memories intact.

The classic Worker uses the pinned LiteRT-LM 0.17.1 runtime and Gemma 4 E2B
artifact. LiteRT's `maxNumTokens` is 4,096. Retain `importScripts`, pinned assets
and restricted CSP download hosts.

- Conversation messages use user/assistant roles only, with at most four completed
  exchanges plus the current question. Each message is limited to 2,000 characters.
- Assemble persona/card examples, references, recent completed exchanges and the
  current question within the 4,000-character prompt budget. Remove older exchanges
  and references as whole items; do not truncate the current question or persona.
- Select up to five room-scoped memories within 1,200 characters and two transcript
  excerpts within 800 characters. References use at most half the remaining prompt
  budget. Treat them as quoted data, not instructions.
  Excerpt selection shares the Worker's limits: at most two items, 500 characters
  per item and 800 characters total. Skip current/recent messages, duplicate IDs,
  empty text and over-budget candidates before counting selected items; preserve
  candidate order and continue to later candidates when a slot remains.
- Only the built-in persona is a system instruction. Put attributed reference
  data in the user turn, not in a second system message.
- Count the assembled message content, including quoted references and labels,
  against the character limit. Separately enforce a conservative token bound for
  the pinned Gemma tokenizer and chat template, reserving 256 output tokens.
  This is a capacity check, not a prediction of actual token use or quality.
  Python/Qwen probes do not establish operation of the browser backend.

## Model cache and generation deadlines

- Keep one streamed Cache Storage entry per pinned artifact in
  `molu/litert-model-v1`. Do not buffer the whole model in JavaScript or clone/tee
  the response. The browser may still stage Blobs or temporary disk copies.
- A cache hit requires a response body and the pinned `Content-Length`.
  Inspection is metadata-only, not a complete byte/hash integrity check, and is
  read-only. Cache-only loads must never fetch, including when another tab has
  deleted or invalidated the entry. Only explicit preparation may replace an
  invalid entry or download on a miss. Reject with `storage_low` only when
  finite origin quota/usage estimates leave less than the artifact size plus
  512 MiB. Unavailable estimates
  do not block downloading. Origin quota is not physical free disk space; passing
  this check does not guarantee a successful write.
- Require exact byte count at EOF, completed `Cache.put`, and a valid cache
  re-read before loading the engine. At 100% received, show the saving notice
  until the write commits; received bytes alone do not mean the model is ready.
- Preserve source-read failures as `download_failed` and size failures as
  `model_size_mismatch`, even if `Cache.put` reports another error. Quota failures
  use `storage_low`; other write failures use `cache_write_failed`. Consumer
  cancellation from a failed put must not become a download failure.
- Download and deletion serialize on the same model lock across tabs. Failed
  downloads cancel their own reader, not another writer's committed model.
  Explicit deletion removes current and previous revisions of that model only.
  Successful deletion also clears that model's in-memory readiness; settings must
  not report ready after its cache is gone. Neither path deletes conversations or
  memories.
- Settings expose explicit model deletion after `storage_low` or
  `cache_write_failed`, even when no valid model is cached. Starting preparation
  or successfully deleting the model clears this recovery state.
- MomoTalk allows 60 seconds from the first Worker `started` event to the first
  non-whitespace token and 180 seconds from the generate request to completion.
  Repeated `started` events cannot extend or restart the first-token deadline;
  whitespace does not satisfy it, and the first token does not clear the total
  deadline. Model download/preparation retains its separate 600-second limit.
- Stop, tab hiding and stale request IDs retain the existing immediate
  cancellation/rejection rules. Longer generation deadlines do not change which
  messages are persisted.

## Verification

Use the actual React app for storage, backup/import, paging, memory editing,
cancellation/retry and stale-response checks. Report real GPU measurements
separately from static checks.

Run the cache-stream and client-deadline regressions with
`pnpm exec vitest run src/lib/ai/client.test.ts src/lib/ai/model-cache.test.ts`.
Web Streams/Response fixtures and controlled Worker replies verify boundaries,
not real model/GPU execution.

Before cold GPU checks, use `df -h` and provide at least 8 GiB of physical free
space as a diagnostic condition, not a product support requirement. Download in
Chromium and Firefox sequentially. On each browser's default MomoTalk settings
path, verify committed pinned bytes, a completed Korean answer, completed-answer
IndexedDB persistence, then a revisit with no pinned-model GET. Check interruption,
retry, tab hiding and explicit model deletion separately. If physical space is
insufficient, report GPU/cache-success verification as blocked; an origin quota
estimate or a small Cache API smoke does not establish multi-GB cache success.

Run `uv run tools/test_chat_browser.py http://127.0.0.1:8787` against a local
production preview for a GPU-independent, two-tab memory/backup regression.
For real-model measurements:

```sh
uv run tools/probe_browser_gemma.py http://127.0.0.1:8787 --headed --executable /path/to/chromium
```

Use a Playwright Firefox installation with `--browser firefox` to repeat there.
The probe uses a fresh browser context, downloads through settings, reads back
the committed bytes and reports actual Korean replies, time to first visible
text, transcript persistence, cold/warm network requests, stop/retry and explicit
model deletion. Inspect the answer to the unknown-memory question; a Korean
response or fast completion is not a semantic quality pass.
