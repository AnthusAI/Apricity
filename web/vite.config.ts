import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

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
    proxy: Object.fromEntries(["/api", "/files", "/graphql", "/amplify_outputs.json", "/apricity_web.wasm"].map((p) => [p, { target: api, changeOrigin: false }])),
    // The Docs tab bundles ../docs/*.md; let the dev server read that folder (and nothing else outside web/).
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), fileURLToPath(new URL("../docs", import.meta.url))] },
  },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: { target: "es2022" },
});
