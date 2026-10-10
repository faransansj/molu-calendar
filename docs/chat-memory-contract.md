# Chat storage and memory contract

## Storage

IndexedDB is authoritative. The `molu-chat-memory` database uses schema version 2
with `rooms`, `messages` and `memories`. There is no localStorage transcript
migration or schema-v1 compatibility path.

- Messages have stable IDs, per-room sequence numbers, speaker/source attribution,
  original text, epoch-millisecond timestamps and an optional reply target.
- Sources are `user-input`, `model-output`, `script` or `app`. A model statement
  does not establish a user fact.
- Seed the initial greeting only after the database is ready and the room is empty.
  Script progress uses the persisted room's user-message count, not loaded pages.
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
- Validate the Worker request and reference DTOs. Only built-in personas and
  dataset examples can become system messages.
- The character budget is a heuristic, not an exact tokenizer count. Model quality
  and GPU compatibility require actual browser inference. Python/Qwen probes and
  mock engines do not establish operation of the app's Gemma/LiteRT backend.

## Verification

Use the actual React app for storage, backup/import, paging, memory editing,
cancellation/retry and stale-response checks. Report real GPU measurements
separately from static checks.
