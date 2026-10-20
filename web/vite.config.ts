import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PAGES } from "./src/route.ts";
import { robotsTxt, routeFile, routeHtml, sitemapXml } from "./scripts/static-routes.ts";

// After the build, give every client route its own document (<route>/index.html) and write the crawler files,
// so a deep link answers 200 from the static host instead of redirecting to a directory that is not there.
const staticRoutes = (): Plugin => {
  let outDir = "dist";
  return {
    name: "static-routes",
    apply: "build",
    configResolved: (config) => void (outDir = config.build.outDir),
    closeBundle() {
      const index = readFileSync(join(outDir, "index.html"), "utf8");
      for (const page of PAGES.filter((p) => p !== "home")) {
        const file = join(outDir, routeFile(page));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, routeHtml(index, page));
      }
      writeFileSync(join(outDir, "robots.txt"), robotsTxt());
      writeFileSync(join(outDir, "sitemap.xml"), sitemapXml());
    },
  };
};

// The data, files and engine come from the local backend: `apricity serve --library` (or the older
// Python server) on :5181, or on APRICITY_API_PORT. It answers amplify_outputs.json with this dev
// server's own address, so every request stays same-origin.
// Cross-origin isolation keeps SharedArrayBuffer and precise timers available to the audio code.
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
const api = `http://127.0.0.1:${process.env.APRICITY_API_PORT || 5181}`;

export default defineConfig({
  server: {
    // The launcher may assign a port via PORT (e.g. when another session already has 5173).
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    headers: isolation,
    // changeOrigin off: the backend sees this server's Host, so its amplify_outputs.json names this server.
    proxy: Object.fromEntries(["/api", "/files", "/graphql", "/semantic", "/amplify_outputs.json", "/apricity_web.wasm"].map((p) => [p, { target: api, changeOrigin: false }])),
    // The Docs tab bundles ../docs/*.md; let the dev server read that folder (and nothing else outside web/).
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), fileURLToPath(new URL("../docs", import.meta.url))] },
  },
  preview: { headers: isolation },
  plugins: [staticRoutes()],
  worker: { format: "es" },
  build: { target: "es2022" },
});
