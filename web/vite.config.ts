import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The API and files come from the Python server (apricity_analyze.server on :5181, or APRICITY_API_PORT).
// Cross-origin isolation keeps SharedArrayBuffer and precise timers available to the audio code.
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
const api = `http://127.0.0.1:${process.env.APRICITY_API_PORT || 5181}`;

export default defineConfig({
  server: {
    // The launcher may assign a port via PORT (e.g. when another session already has 5173).
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    headers: isolation,
    proxy: { "/api": api, "/files": api, "/apricity_web.wasm": api },
    // The Docs tab bundles ../docs/*.md; let the dev server read that folder (and nothing else outside web/).
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), fileURLToPath(new URL("../docs", import.meta.url))] },
  },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: { target: "es2022" },
});
