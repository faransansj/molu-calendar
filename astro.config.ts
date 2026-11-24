import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

const toolbarEntry = "astro/runtime/client/dev-toolbar/entrypoint.js";

// Mount React via an external module script because the CSP forbids inline island scripts.
export default defineConfig({
  site: process.env.SITE_URL || undefined,
  base: process.env.SITE_BASE || "/",
  build: { inlineStylesheets: "never" },
  vite: {
    plugins: [
      tailwindcss(),
      {
        name: "molu:astro-toolbar-dep-scan",
        configEnvironment: {
          order: "post",
          handler(name, options) {
            if (name !== "client" || !options.optimizeDeps) return;
            // Astro injects this include; the prebundler can't load its virtual module.
            const deps = options.optimizeDeps;
            deps.include = deps.include?.filter((id) => id !== toolbarEntry);
            return { optimizeDeps: { exclude: [toolbarEntry] } };
          },
        },
      },
    ],
    build: { assetsInlineLimit: 0 },
    server: { watch: { ignored: ["**/.direnv/**"] } },
  },
});
