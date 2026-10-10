import { build } from "esbuild";
import { mkdir, cp } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
await build({
  entryPoints: ["src/workers/local-ai.worker.ts"],
  bundle: true,
  // LiteRT uses importScripts; LocalAIClient must load this as a classic Worker.
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "linked",
  outfile: "public/local-ai-worker.bundle.js",
  define: { "import.meta.env.BASE_URL": '"/"' },
});
const runtime = dirname(fileURLToPath(import.meta.resolve("@litert-lm/core")));
await mkdir("public/vendor/litert-lm/0.17.1", { recursive: true });
await cp(`${runtime}/../wasm`, "public/vendor/litert-lm/0.17.1", {
  recursive: true,
});
