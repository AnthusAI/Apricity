#!/usr/bin/env node
// Make the social preview card (web/public/social-card.png, 1200×630): open a score on the site in headless Chrome,
// capture its Flow panel (the recordings, the clips cut from them, and the tracks that play them), then lay that
// capture into the card (scripts/social-card.html) and capture the card.
//
//   node scripts/social-card.mjs [site] [score]
//   node scripts/social-card.mjs https://apricity.anth.us examples/chop-shop.apr
//
// Needs Google Chrome. Talks to it over the DevTools protocol; no packages to install.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = process.argv[2] ?? "https://apricity.anth.us";
const score = process.argv[3] ?? "examples/chop-shop.apr";
const out = join(root, "web/public/social-card.png");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), "apricity-card-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--mute-audio", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(url = "about:blank") {
  for (let i = 0; i < 50; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${url}`, { method: "PUT" })).json();
      return t.webSocketDebuggerUrl;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chrome did not start");
}

function session(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) events.push(msg.method);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return new Promise((resolve) => (ws.onopen = () => resolve({ send, events, close: () => ws.close() })));
}

/** Evaluate an expression in the page and return its value. */
const evaluate = async (s, expression) => (await s.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

async function waitFor(s, expression, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(s, expression).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${expression}`);
}

async function open(s, url, width, height) {
  await s.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  await s.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await s.send("Page.enable");
  await s.send("Page.navigate", { url });
}

try {
  const s = await session(await page());
  // 1. The Flow panel of the score, as the site draws it.
  await open(s, `${site}/#score=${score}`, 1500, 1000);
  await waitFor(s, `!!document.querySelector("#score .flow canvas") && document.querySelector("#score .flow").getBoundingClientRect().height > 200`);
  await sleep(6000); // waveforms and ribbons finish drawing
  const r = await evaluate(s, `(() => { const b = document.querySelector("#score .flow").getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  // Point at one clip (a slice of Chop Shop's horns) so Flow draws its lineage: the recording it was cut from and
  // every hit it plays, with its transpositions.
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + 217, y: r.y + 245 });
  await sleep(1500);
  const flow = await s.send("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 1 } });
  writeFileSync(join(profile, "flow.png"), Buffer.from(flow.data, "base64"));
  const cardFile = join(profile, "card.html");
  writeFileSync(cardFile, readFileSync(join(root, "scripts/social-card.html"), "utf8").replaceAll("FLOW_PNG", "flow.png"));
  s.close();

  // 2. The card, with that capture beside it, in a tab of its own (a web page can't open a local file).
  const c = await session(await page(pathToFileURL(cardFile).href));
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.reload");
  await waitFor(c, `document.readyState === "complete" && document.images.length > 0 && [...document.images].every((i) => i.complete && i.naturalWidth > 0)`);
  await sleep(500);
  const png = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 } });
  writeFileSync(out, Buffer.from(png.data, "base64"));
  console.log(`wrote ${out}`);
  c.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
