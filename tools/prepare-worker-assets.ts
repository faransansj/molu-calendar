import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

// These URLs are D1/R2-authoritative. Never deploy a stale static fallback.
for (const path of [
  "dist/data/events.json",
  "dist/data/published.json",
  "dist/feeds",
  "dist/resource/admin",
]) {
  await rm(path, { recursive: true, force: true });
}

// Workers caps individual assets at 25 MiB. Preserve the original public files
// for Astro dev; only deployment assets need the Worker's gzip response route.
const directory = "dist/vendor/litert-lm/0.17.1";
for (const name of await readdir(directory)) {
  if (!name.endsWith(".wasm")) continue;
  const path = `${directory}/${name}`;
  if ((await stat(path)).size <= 25 * 1024 * 1024) continue;
  const compressed = gzipSync(await readFile(path), { level: 9 });
  if (compressed.byteLength > 25 * 1024 * 1024)
    throw new Error(`Compressed runtime exceeds Workers asset limit: ${name}`);
  await writeFile(`${path}.gz`, compressed);
  await rm(path);
}
