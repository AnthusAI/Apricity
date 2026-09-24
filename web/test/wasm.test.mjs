// End-to-end check of the apricitus_web.wasm surface in Node: compile → render → mix.
// Run: node web/test/wasm.test.mjs   (from the repo root, after building apricitus-web for wasm32-wasip1)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const root = new URL("../../", import.meta.url).pathname;
const wasm = readFileSync(root + "target/wasm32-wasip1/release/apricitus_web.wasm");
const { instantiate } = await import(root + "web/src/wasm/shim.js");
const rw = await instantiate(new WebAssembly.Module(wasm));

// --- page: compile
const scorePath = "examples/test-wav-only.yaml";
const yaml = `
apricitus: 0.1
tempo: 120
key: Abm
samples: ../samples
clips:
  edison: { source: citizen-dj/loc-edison/The-stars-and-stripes-forever-march_00694038_002_00-01-55.wav, beats: [4, 12] }
  bugle:  { source: citizen-dj/loc-jukebox-popular/Army-bugle-calls_jukebox-118367_001_00-00-56.wav, beats: [0, 4] }
progression: [ { chord: iv, bars: 2 }, { chord: V, bars: 2 } ]
tracks:
  - { clip: edison, role: root }
  - { clip: bugle, role: third, pattern: { every: 1bar } }
`;
const { sources } = rw.call("rw_sources", yaml, scorePath);
assert.deepEqual(sources.map((s) => s.split("/")[0]), ["samples", "samples"]);
const manifests = Object.fromEntries(sources.map((s) => [s, JSON.parse(readFileSync(root + s + ".apricitus.json", "utf8"))]));
const compiled = rw.call("rw_compile", yaml, scorePath, JSON.stringify(manifests));
assert.ok(compiled.timeline, JSON.stringify(compiled.errors));
assert.match(compiled.explain, /iv \(Dbm\)/);
console.log("compile ok:", compiled.timeline.events.length, "events");

// Errors come back as a list with locations.
const bad = rw.call("rw_compile", yaml.replace("clip: bugle,", "clip: bugel,"), scorePath, JSON.stringify(manifests));
assert.match(bad.errors.join("\n"), /did you mean "bugle"/);

// --- worker: render (decode 16-bit PCM WAV by hand; the browser uses Web Audio)
function readWav(path) {
  const b = readFileSync(path);
  let o = 12, fmt, data;
  while (o < b.length) {
    const id = b.toString("ascii", o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === "fmt ") fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === "data") data = b.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size % 2);
  }
  assert.equal(fmt.bits, 16);
  const frames = data.length / 2 / fmt.ch;
  const planar = new Float32Array(frames * fmt.ch);
  for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.ch; c++) planar[c * frames + i] = data.readInt16LE((i * fmt.ch + c) * 2) / 32768;
  return { planar, frames, ch: fmt.ch, sr: fmt.sr };
}
rw.exports.rw_renderer_new(48000);
for (const s of sources) {
  const a = readWav(root + s);
  rw.withBytes(s, (p, n) => rw.withFloats(a.planar, (fp) => rw.exports.rw_renderer_add_source(p, n, fp, a.frames, a.ch, a.sr)));
  assert.ok(rw.withBytes(s, (p, n) => rw.exports.rw_renderer_has_source(p, n)));
}
const t0 = performance.now();
const loopPtr = rw.withBytes(JSON.stringify(compiled.timeline), (p, n) => rw.exports.rw_arrange(p, n, true));
const info = rw.result();
assert.ok(loopPtr, JSON.stringify(info));
console.log(`render ok: ${info.frames} frames (${(info.frames / 48000).toFixed(2)} s), ${info.rendered} rendered in ${(performance.now() - t0).toFixed(0)} ms`);
assert.equal(info.frames, 16 * 0.5 * 48000);
const loop = new Float32Array(rw.memory().buffer, loopPtr, 2 * info.frames).slice();
rw.exports.rw_free(loopPtr, 2 * info.frames);
const peak = loop.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
assert.ok(peak > 0.2 && peak <= 0.8913, `mastered peak ${peak} (limiter ceiling -1 dB)`);

// --- raw mix + master loudness (what the render workers do)
const rawPtr = rw.withBytes(JSON.stringify(compiled.timeline), (p, n) => rw.exports.rw_arrange(p, n, false));
const raw = new Float32Array(rw.memory().buffer, rawPtr, 2 * info.frames).slice();
rw.exports.rw_free(rawPtr, 2 * info.frames);
const master = JSON.stringify(compiled.timeline.master ?? {});
const gainDb = rw.withFloats(raw, (fp) => rw.withBytes(master, (p, n) => rw.exports.rw_master_gain(fp, info.frames, 48000, p, n)));
assert.ok(Number.isFinite(gainDb) && Math.abs(gainDb) <= 24, `master gain ${gainDb}`);
console.log(`master ok: make-up ${gainDb.toFixed(2)} dB toward ${compiled.timeline.master?.loudness ?? -16} LUFS`);

// --- worklet: mix
rw.exports.rw_engine_new();
const dst = rw.exports.rw_alloc(2 * info.frames);
new Float32Array(rw.memory().buffer, dst, 2 * info.frames).set(raw);
assert.ok(rw.withBytes(master, (p, n) => rw.exports.rw_engine_load_mastered(dst, info.frames, info.frames_per_beat, info.beats_per_bar, 48000, false, p, n, gainDb)));
rw.exports.rw_engine_play(true);
const out = rw.exports.rw_alloc(256);
let energy = 0;
for (let i = 0; i < 400; i++) {
  rw.exports.rw_engine_process(out, 128);
  const block = new Float32Array(rw.memory().buffer, out, 256);
  for (const x of block) {
    energy += x * x;
    assert.ok(Math.abs(x) <= 0.8913, `live master output ${x} over the ceiling`);
  }
}
assert.ok(energy > 1, `mixer output energy ${energy}`);
assert.equal(rw.exports.rw_engine_position(), (400 * 128) % info.frames);
console.log(`mix ok: position ${rw.exports.rw_engine_position()} frames, swaps ${rw.exports.rw_engine_swaps()}`);
console.log("all wasm checks passed");
