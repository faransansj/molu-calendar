import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Mount React via an external module script because the CSP forbids inline island scripts.
export default defineConfig({
  site: process.env.SITE_URL || undefined,
  base: process.env.SITE_BASE || "/",
  build: { inlineStylesheets: "never" },
  vite: {
    plugins: [tailwindcss()],
    build: { assetsInlineLimit: 0 },
    server: { watch: { ignored: ["**/.direnv/**"] } },
  },
});
