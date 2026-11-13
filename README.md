# MOLU

Unofficial Blue Archive calendar for the KR server, built from Nexon's official notices.

The production address is configured with the GitHub Actions `SITE_URL` variable.

Official banners use a fixed 16:9 frame and preload when the gallery mounts.
Next/previous controls slide in the corresponding direction and restart the
six-second auto-rotation countdown. Hovering or focusing the image pauses
rotation; reduced motion disables animation and auto-rotation.

## Development

Requires Node.js 22.18+ and pnpm 10.11.0. Nix users can run `nix develop`.

```sh
pnpm install
pnpm dev              # http://localhost:4321
pnpm check:static     # Formatting, linting and type checks
pnpm check            # Also run existing tests
pnpm build            # Build to dist/
pnpm preview          # http://127.0.0.1:8787
pnpm scrape           # Refresh schedules; scrape:backfill includes older notices
```

## Deployment

The browser loads the current official feed and immutable published administrator
snapshot together from `/api/calendar`. D1 is authoritative; the Astro build
contains neither calendar JSON nor administrator images. An unavailable calendar
shows a retryable error, never stale bundled data or a successful empty calendar.
Public image URLs are served from R2 only after publication. `/admin/` loads
authenticated private drafts separately; possessing a session never exposes
drafts through public calendar endpoints.

Administrator entry opens a password modal over a blurred, inert workspace.
The workspace unlocks after authentication and stage loading complete. Logout or
session expiry locks it again; closing the login dialog returns to the public
calendar. Each login attempt clears the password and restores masking.

### Stage and hotfix

- **스테이지 올려두기** saves only the selected image, crop, or period. Restoring
  an original also saves a private draft. Saving never publishes automatically.
- **핫픽스** saves that edit, then publishes the entire saved stage immediately.
  **스테이지 전체 핫픽스** publishes already-saved edits/restorations.
- Publication atomically inserts an immutable snapshot, registers its public
  image references, and switches the D1 public pointer. Success means publication
  is complete; there is no Actions dispatch, build, callback, or polling.
- Later saves remain private. Previously published image URLs remain accessible
  even after replacement/restoration, because retained immutable snapshots own
  their image references.
- Every day at **06:00 KST** (`0 21 * * *` UTC), Actions collects official notices
  in Node, uploads validated JSON/precomputed ICS to D1, and atomically activates
  the official version. It never changes the administrator public pointer or
  draft revision and does not deploy code.

Official rotation never rewrites draft/history rows. Missing events are omitted
from display; incompatible saved periods are omitted without losing valid image
or crop edits. An explicit publication rejects an incompatible saved period for a
known event with `409 stage-conflict`, rather than silently dropping the edit.
An outdated editor also receives `409 stage-conflict` using its loaded feed ID;
unsaved input stays intact until the user explicitly reloads the page.

`/data/events.json` and `/feeds/{all,game,category}.ics` remain official-only.
The public calendar and per-event/bookmark downloads use applicable published
periods. Data responses revalidate against the current D1 pointer with ETags.
There is no background official-feed polling that resets editor inputs.

### Production configuration

Keep the custom domain `https://molu.midori-lab.com`, `SITE_BASE` unset, and Bot
Fight Mode enabled. Code deployment and data import do not call the protected
application hostname. No Cron, Durable Object, Queue, Workflow, or paid service
is needed.

| Location         | Required configuration                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub variables | `SITE_URL` HTTPS origin; `CLOUDFLARE_DATABASE_ID` matching Wrangler's `DB` binding                                                     |
| GitHub secrets   | Existing `CLOUDFLARE_API_TOKEN` for code deployment and `CLOUDFLARE_ACCOUNT_ID`; separate `CLOUDFLARE_D1_API_TOKEN` for data ingestion |
| Worker secret    | `ADMIN_PASSWORD_HASH`                                                                                                                  |
| Worker bindings  | Existing `DB` (`molu-admin`), `IMAGES` (`molu-admin-images`), and `ASSETS`                                                             |

Scope the CI data token to **D1 Write on the owning account**. It can access this
database's administrator tables as well as official data: keep it only in
GitHub secrets/operator process memory, never browser/Worker code, files, SQL,
logs, or PRs. Do not reuse a publisher/GitHub token for D1. Legacy remote secrets
are no longer used by code; removing or rotating them is a separate explicit
operator action.

Keep the standard feature PR → `main` → `deploy` release PR flow:

- `ci.yml`: checks/builds PRs and feature pushes.
- `deploy.yml`: deploy-only push or manual code release; checks and builds the
  exact push SHA, then deploys the Worker. It never reads or mutates feed or
  publication data.
- `update-calendar.yml`: scheduled/manual strict collection against the current
  D1 archive; manual runs on non-`deploy` refs skip mutation. No git writes,
  application-domain requests, build, or deployment.

Data and code workflows have separate non-cancelling concurrency groups. An
official activation checks its exported predecessor; a competing update loses
without overwriting the winner. Failed staging leaves public pointers unchanged.
Current and previous official versions are retained; other versions are eligible
for bounded pruning after 48 hours. This never prunes publications or R2 images.

### Explicit initialization and operator commands

Only `calendar:init` bootstraps an empty calendar store. Normal requests never
seed official data; absent active data returns `503 calendar-unavailable`.
Remote commands require `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`,
`CLOUDFLARE_D1_API_TOKEN` in process environment. `init`/`upload` also require
`SITE_URL` (HTTPS production origin; HTTP loopback allowed locally).

```sh
pnpm calendar:init --feed <official.json> --published <live-manifest.json> --remote
pnpm calendar:export --out .calendar/feed.json --remote
pnpm scrape --out .calendar/feed.json --strict
pnpm calendar:upload --feed .calendar/feed.json --base .calendar/base.json --remote
```

Before the first runtime cutover, wait for old deployment jobs, export a D1
backup, and capture the currently served official JSON and publication marker.
Initialize from those exact live inputs, not a git seed or the latest draft.
A null marker stays null regardless of draft revisions. A non-null marker must
match D1's exact immutable ID/revision and legacy filtered overrides, and all
retained published images must be readable with authorized R2 access. Conflicts
abort rather than publishing a draft or fabricating empty content. Initialization
is idempotent only for matching active inputs.

The importer validates schema-v2 input and rejects empty data. Version IDs are
SHA-256 of compact validated JSON. JSON/ICS artifacts are immutable, manifest-
verified, limited to 16 MiB each, and stored in Unicode-safe 32 KiB chunks.
Publication snapshots are limited to 1,800,000 UTF-8 bytes.
Remote failures report only sanitized HTTP/status metadata, never SQL bindings,
credentials, or response data. `.calendar/` is ignored operational output.

After new runtime publications or official activations, do not roll back to the
old static-publication application without an explicit data-preserving rollback
plan. Roll forward fixes instead.

Generate the administrator password hash without plaintext in argv:

```sh
read -rs -p 'Admin password: ' ADMIN_PASSWORD; printf '\n'
printf '%s' "$ADMIN_PASSWORD" | node tools/admin-password-hash.ts | pnpm exec wrangler secret put ADMIN_PASSWORD_HASH
unset ADMIN_PASSWORD
```

If Free login exceeds its CPU limit (1102), regenerate with
`ITERATIONS=10000 node tools/admin-password-hash.ts`. Sessions remain secure,
HTTP-only, same-site, and expire after eight hours. Measure deployed endpoint
CPU/resource outcomes; local wall-clock timings do not establish Free viability.

### Local runtime verification

Use a disposable checkout with its own ignored `.dev.vars`/`.wrangler`. Put a
test-only `ADMIN_PASSWORD_HASH` in `.dev.vars`; no publisher credentials are
needed. Create an explicit null bootstrap marker:

```sh
mkdir -p .calendar
printf '%s\n' '{"publication":null,"overrides":[]}' > .calendar/null.json
pnpm install --frozen-lockfile
SITE_URL=http://localhost:8811 pnpm build
SITE_URL=http://localhost:8811 pnpm calendar:init --local --feed public/data/events.json --published .calendar/null.json
pnpm preview --port 8811
```

The checked-in official JSON is only an explicit bootstrap/fixture seed.
Real data flows require local Wrangler, not Astro-only API stubs. `pnpm dev`
is an Astro presentation server and cannot serve D1/admin routes.
Stop preview before rebuilding: Astro temporarily copies oversized raw LiteRT
assets before the asset-preparation tool replaces them with gzip files.

Exercise export → strict scrape → upload with `--local`; normal browser reloads
must see activated data without a rebuild/restart. Save drafts in `/admin/`,
confirm the public calendar is unchanged, then explicitly publish and reload
the public tab. Per-event ICS includes displayed edits; subscription ICS does not.

PNG/JPEG/WebP uploads are re-encoded in the browser, signature/dimension-checked
on the server, and limited to 5 MiB after encoding. Classic AI Worker behavior
and pinned LiteRT bytes are unchanged. Its two oversized asyncify WASM files
are gzip assets in `dist/`, served at their original URLs. These calendar checks
are not GPU/model validation.

## Chat and local AI

MomoTalk saves conversations and memories in your browser, with backup/import controls.
All chat replies use the on-device LLM, including schedule questions. Download the
roughly 2 GB model in chat settings; a WebGPU-capable browser is required. Students
without a built-in AI persona cannot start conversations. There are no scripted
fallback replies. Back up conversations you want to keep.
The gear-shaped settings button left of MomoTalk opens the app-wide **MOLU settings**
popup without opening a conversation. It brings together calendar view preferences,
bookmark filtering, saved timeline folding, MomoTalk notification sound, local AI/model
management, and chat backup/import/deletion. Calendar subscription/export and the
privacy policy are also accessible there. The policy explains on-device AI and
storage, deletion, external downloads, and email inquiries; it retains schedule
source links. Bug reports, security reports, suggestions, and privacy requests go
to `molu-calendar.obstinate562@passinbox.com`.
View, folding, and sound changes reuse the existing browser preferences; bookmark
filtering applies to the current calendar.
The administrator-mode section appears last, below chat data management.
On the administrator page, staging instructions and publication details are
collapsed by default under a disclosure that retains the latest publication status.
The administrator heading stays left and the return link, disclosure toggle,
hotfix, and logout controls align right in one compact toolbar row, wrapping only
on narrow screens; expanded details appear below it.

## Credits

Schedules and banners come from the [official Blue Archive community](https://forum.nexon.com/bluearchive). MomoTalk assets come from [blue-utils.me](https://blue-utils.me), [SchaleDB](https://github.com/SchaleDB/SchaleDB), [closure-talk](https://github.com/ClosureTalk/closure-talk), [Blue Archive Wiki](https://bluearchive.wiki), and [pizza-studio/momotalk](https://github.com/pizza-studio/momotalk). Fonts are [Gyeonggi Millennium Title](https://www.gg.go.kr/contents/contents.do?ciIdx=679&menuId=2457) and [Noto Sans KR](https://fonts.google.com/noto/specimen/Noto+Sans+KR).

This fan project is not affiliated with NEXON or NEXON Games. Game assets belong to their respective owners.
