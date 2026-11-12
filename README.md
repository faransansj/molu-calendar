# MOLU

Unofficial Blue Archive calendar for the KR server, built from Nexon's official notices.

[Open the calendar](https://7591yj.github.io/molu-calendar/)

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

GitHub Actions refreshes schedules every Monday at 19:00 KST and deploys to GitHub Pages. Code pushes to `main` also trigger deployment.

## Chat and local AI

MomoTalk saves conversations and memories in your browser, with backup/import controls.
All chat replies use the on-device LLM, including schedule questions. Download the
roughly 2 GB model in chat settings; a WebGPU-capable browser is required. Students
without a built-in AI persona cannot start conversations. There are no scripted
fallback replies. Back up conversations you want to keep.

## Credits

Schedules and banners come from the [official Blue Archive community](https://forum.nexon.com/bluearchive). MomoTalk assets come from [blue-utils.me](https://blue-utils.me), [SchaleDB](https://github.com/SchaleDB/SchaleDB), [closure-talk](https://github.com/ClosureTalk/closure-talk), [Blue Archive Wiki](https://bluearchive.wiki), and [pizza-studio/momotalk](https://github.com/pizza-studio/momotalk). Fonts are [Gyeonggi Millennium Title](https://www.gg.go.kr/contents/contents.do?ciIdx=679&menuId=2457) and [Noto Sans KR](https://fonts.google.com/noto/specimen/Noto+Sans+KR).

This fan project is not affiliated with NEXON or NEXON Games. Game assets belong to their respective owners.
