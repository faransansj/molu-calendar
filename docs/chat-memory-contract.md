# Chat storage and memory contract

## Storage

IndexedDB is authoritative. The `molu-chat-memory` database uses schema version 2
with `rooms`, `messages` and `memories`. There is no localStorage transcript
migration or schema-v1 compatibility path.

- Messages have stable IDs, per-room sequence numbers, speaker/source attribution,
  original text, epoch-millisecond timestamps and an optional reply target.
- Sources are `user-input`, `model-output`, `script` or `app`. A model statement
  does not establish a user fact.
- Opening a room never inserts a scripted greeting. New character replies are
  completed LLM outputs only. Preserve historical source attribution and records.
- Persist user questions before generation and completed replies only. Partial
  streaming output is temporary. Cancellation, failure and retry retain the same
  question ID. Reject stale replies after deletion or replacement.
- IndexedDB transaction completion is the write boundary. Request success is
  provisional. Surface storage failures, block sending and expose explicit retry.
- Close connections on version changes and surface blocked opens. Do not silently
  fall back to another storage mechanism.
- Room/whole-transcript deletion also removes associated memories. Current-format
  version-2 backups validate fields, identifiers, order and references before an
  atomic replacement. Unsupported formats are rejected.
- A browser Web Lock serializes sends per room. BroadcastChannel notifications
  refresh other tabs. Replies atomically check their target question ID.

## Explicit memory

Memories are private to a room. Only an explicit user action saves or edits a
memory. Model output never becomes a saved memory automatically. Disabled or
expired memories are excluded from model input. Keep source message IDs and
source text when saving from a transcript.

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
- Validate the Worker request and reference DTOs. Only built-in personas and
  dataset examples can become system messages.
- The character budget is a heuristic, not an exact tokenizer count. Model quality
  and GPU compatibility require actual browser inference. Python/Qwen probes and
  mock engines do not establish operation of the app's Gemma/LiteRT backend.

## Model cache and generation deadlines

- Keep one streamed Cache Storage entry per pinned artifact in
  `molu/litert-model-v1`. Do not buffer the whole model in JavaScript or clone/tee
  the response. The browser may still stage Blobs or temporary disk copies.
- A cache hit requires a response body and the pinned `Content-Length`.
  Inspection is metadata-only, not a complete byte/hash integrity check, and is
  read-only. Loading deletes invalid metadata before downloading again.
- On a miss, reject with `storage_low` only when finite origin quota/usage
  estimates leave less than the artifact size plus 512 MiB. Unavailable estimates
  do not block downloading. Origin quota is not physical free disk space; passing
  this check does not guarantee a successful write.
- Require exact byte count at EOF, completed `Cache.put`, and a valid cache
  re-read before loading the engine. At 100% received, show the saving notice
  until the write commits; received bytes alone do not mean the model is ready.
- Preserve source-read failures as `download_failed` and size failures as
  `model_size_mismatch`, even if `Cache.put` reports another error. Quota failures
  use `storage_low`; other write failures use `cache_write_failed`. Consumer
  cancellation from a failed put must not become a download failure.
- Failed downloads cancel the reader and delete only the failed artifact, with
  cleanup errors never replacing the original failure. Explicit model deletion
  removes current and previous revisions of the same repository/model only.
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
