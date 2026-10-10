# MOLU

Unofficial Blue Archive calendar for the KR server, built from Nexon's official notices.

[Open the calendar](https://7591yj.github.io/molu-calendar/)

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

GitHub Actions refreshes schedules every Monday at 19:00 KST and deploys to GitHub Pages. Code pushes to `main` also trigger deployment.

## Chat and local AI

MomoTalk saves conversations and memories in your browser, with backup/import controls.
Optional AI runs on your device and requires a roughly 2 GB model download and
WebGPU-capable Chrome or Edge. Enable it in chat settings; scripted chat remains
available without AI. Back up conversations you want to keep.

## Credits

Schedules and banners come from the [official Blue Archive community](https://forum.nexon.com/bluearchive). MomoTalk assets come from [blue-utils.me](https://blue-utils.me), [SchaleDB](https://github.com/SchaleDB/SchaleDB), [closure-talk](https://github.com/ClosureTalk/closure-talk), [Blue Archive Wiki](https://bluearchive.wiki), and [pizza-studio/momotalk](https://github.com/pizza-studio/momotalk). Fonts are [Gyeonggi Millennium Title](https://www.gg.go.kr/contents/contents.do?ciIdx=679&menuId=2457) and [Noto Sans KR](https://fonts.google.com/noto/specimen/Noto+Sans+KR).

This fan project is not affiliated with NEXON or NEXON Games. Game assets belong to their respective owners.
