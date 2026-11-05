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

The public calendar is static: it reads embedded published overrides and local
`/resource/admin/` images, with **no administrator API calls**. `/admin/` is the
authenticated staging preview. It shares the calendar UI but never exposes
unpublished edits through the public calendar or public API.
Administrator entry opens a password modal over a blurred, inert workspace.
The workspace unlocks only after authentication and stage loading complete;
logout or session expiry locks it again. Closing the authentication popup
returns to the public calendar instead of bypassing the gate.
The password field has an inline eye-icon toggle on its right edge; each login
attempt clears the input and restores password masking.

### Stage and hotfix

- **스테이지 올려두기** saves the selected image or period to the stage. It does
  not change the public calendar. Restoring an original image/period also stages
  that restoration.
- **핫픽스** saves that edit and requests immediate publication of the **entire
  saved stage**, including other saved edits. The global **스테이지 전체 핫픽스**
  publishes already-saved edits/restorations.
- Every day at **06:00 KST** (`0 21 * * *` UTC), GitHub Actions refreshes official
  notices and publishes the stage, even when the official feed did not change.
  This is the scheduled start time, not a guaranteed completion time; GitHub can
  delay scheduled runs, and building/deploying takes additional time.
- Code pushes deploy code with the **currently deployed** snapshot, not pending
  stage changes. Manual workflow runs without a publication ID publish the stage.

Each publication fixes an immutable revision and its image references. Later
edits remain staged for the next publication. The admin page shows staged/public
revisions and queued, building, published, or failed state. A dispatch failure
does not discard staged edits or change the public site. Deployments use one
workflow concurrency group and never cancel an in-progress deployment.
Abandoned queued requests expire after 30 minutes; delayed expired jobs cannot
start. Building releases are not expired automatically. After a successful
deployment, its static publication marker is authoritative: status/export reads
recover a missed completion callback without rolling back to an older release.

The official `public/data/events.json` and static `/feeds/*.ics` remain original.
The public calendar and its per-event `.ics` download use the published schedule.
Published JSON and images are bundled into `dist/`, so the same build can be
distributed to other deployment targets without a live management API.

### Production configuration

Deploy at the domain root; leave `SITE_BASE` unset. Wrangler auto-provisions
`molu-admin` (D1) and `molu-admin-images` (R2); enable R2 on the Cloudflare account.

| Location                    | Required configuration                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| GitHub repository variables | `SITE_URL`, `ADMIN_ORIGIN` — full HTTPS origins; normally the same Worker origin                    |
| GitHub repository secrets   | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `PUBLISH_TOKEN`                                    |
| Worker secrets              | `ADMIN_PASSWORD_HASH`, matching `PUBLISH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY` (`owner/repo`) |
| Optional Worker secret      | `GITHUB_REF` — dispatch branch; defaults to `main`                                                  |

Use a random high-entropy `PUBLISH_TOKEN`. This authenticates build/export and
completion callbacks; it is never sent to the browser. The Worker's fine-grained
`GITHUB_TOKEN` needs Actions write permission on only the target repository.
Do not confuse it with GitHub Actions' automatic token.

The first deployment must bootstrap the API before Actions can export it:

1. On a fresh checkout without `.publication/snapshot.json`, run `pnpm build`
   then `pnpm exec wrangler deploy` after authenticating Cloudflare.
2. Register Worker secrets with `pnpm exec wrangler secret put <NAME>` and set
   the matching GitHub configuration above.
3. Enable/run the Update calendar workflow. Subsequent `pnpm deploy` commands
   require `ADMIN_ORIGIN` and `PUBLISH_TOKEN` and export the deployed snapshot
   first, so code deployments cannot silently erase published changes.

Generate the administrator password hash without putting plaintext in argv:

```sh
read -rs -p 'Admin password: ' ADMIN_PASSWORD; printf '\n'
printf '%s' "$ADMIN_PASSWORD" | node tools/admin-password-hash.ts | pnpm exec wrangler secret put ADMIN_PASSWORD_HASH
unset ADMIN_PASSWORD
```

If Workers Free login exceeds its CPU limit (error 1102), regenerate with
`ITERATIONS=10000 node tools/admin-password-hash.ts`. Administrator sessions use
secure, HTTP-only, same-site cookies and expire after eight hours.

### Local publication verification

Put `ADMIN_PASSWORD_HASH=<hash>` and a random `PUBLISH_TOKEN` in ignored
`.dev.vars`. Run `pnpm build`, then `pnpm preview`; open `/admin/` to edit.
Missing hotfix dispatch configuration returns `503 publishing-disabled` without
claiming that anything was deployed. `409 publish-busy` means a publication is
already active; `502 publish-failed` means GitHub did not accept the request.
`409 stage-conflict` rejects an overlapping image edit instead of resurrecting
a replaced upload. `409 not-deployed` rejects a premature completion callback;
`503 deployed-unavailable` refuses exports when the live marker is inconsistent.

`tools/publish.ts prepare` exports an immutable stage snapshot and its images;
set `ADMIN_ORIGIN=http://localhost:8787` and the same `PUBLISH_TOKEN`. Build and
serve/deploy that snapshot before running `tools/publish.ts complete`.
`PUBLICATION_SOURCE=deployed` exports only the live revision for code-only builds.
Downloaded inputs remain in ignored `.publication/`; normal local builds never
contact the management API. Do not commit generated `public/data/published.json`
or `public/resource/admin/` assets. D1/R2 state stays in ignored `.wrangler/`.

`pnpm dev` serves the published snapshot already downloaded locally, or the
official feed on a fresh checkout. Public settings link to `/admin/`; without a
Worker, its authentication popup stays accessible and reports management
connectivity failures while keeping the administrator workspace locked.

PNG/JPEG/WebP uploads are re-encoded in the browser, independently signature-
and dimension-checked on the server, and limited to 5 MiB after encoding.
Image objects referenced by retained publication snapshots are not deleted by
stage restoration/replacement; this preserves reproducible releases and uses R2
storage for retained publication history.

LiteRT's pinned asyncify WASM files exceed Workers' 25 MiB asset limit.
`pnpm build` stores those two files as gzip assets in `dist/`; the Worker serves
their original URLs with gzip encoding. Development retains the original files.
Runtime bytes and classic Worker behavior are unchanged. This is asset-delivery
verification, not GPU/model validation.

## Chat and local AI

MomoTalk saves conversations and memories in your browser, with backup/import controls.
Optional AI runs on your device and requires a roughly 2 GB model download and
WebGPU-capable Chrome or Edge. Enable it in chat settings; scripted chat remains
available without AI. Back up conversations you want to keep.
The gear-shaped settings button left of MomoTalk opens the app-wide **MOLU settings**
popup without opening a conversation. It brings together calendar view preferences,
bookmark filtering, saved timeline folding, MomoTalk notification sound, local AI/model
management, and chat backup/import/deletion. Calendar subscription/export and data
sources are also accessible there. View, folding, and sound changes reuse the existing
browser preferences; bookmark filtering applies to the current calendar.

## Credits

Schedules and banners come from the [official Blue Archive community](https://forum.nexon.com/bluearchive). MomoTalk assets come from [blue-utils.me](https://blue-utils.me), [SchaleDB](https://github.com/SchaleDB/SchaleDB), [closure-talk](https://github.com/ClosureTalk/closure-talk), [Blue Archive Wiki](https://bluearchive.wiki), and [pizza-studio/momotalk](https://github.com/pizza-studio/momotalk). Fonts are [Gyeonggi Millennium Title](https://www.gg.go.kr/contents/contents.do?ciIdx=679&menuId=2457) and [Noto Sans KR](https://fonts.google.com/noto/specimen/Noto+Sans+KR).

This fan project is not affiliated with NEXON or NEXON Games. Game assets belong to their respective owners.
