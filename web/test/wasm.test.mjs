// End-to-end check of the apricity_web.wasm surface in Node: compile → render → mix.
// Run: node web/test/wasm.test.mjs   (from the repo root, after building apricity-web for wasm32-wasip1)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const root = new URL("../../", import.meta.url).pathname;
const wasm = readFileSync(root + "target/wasm32-wasip1/release/apricity_web.wasm");
const { instantiate } = await import(root + "web/src/wasm/shim.js");
const rw = await instantiate(new WebAssembly.Module(wasm));

// --- page: compile
const scorePath = "examples/test-wav-only.yaml";
const yaml = `
apricity: 0.1
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
const manifests = Object.fromEntries(sources.map((s) => [s, JSON.parse(readFileSync(root + s + ".apricity.json", "utf8"))]));
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

// --- data layer: ids, rank, markup_merge

// Test rw_ids: clip_id
const clipIdInput = { kind: "clip_id", audio_sha256: "abc123def456789012345678" };
const clipIdResult = rw.call("rw_ids", JSON.stringify(clipIdInput));
assert.ok(clipIdResult.data);
assert.match(clipIdResult.data, /^clp_/);
console.log(`rw_ids ok: ${clipIdResult.data}`);

// Test rw_ids: candidate_id
const candIdInput = { kind: "candidate_id", clip_id: "clp_abc123", start: 10.0, end: 14.0, kind_val: "loop" };
const candIdResult = rw.call("rw_ids", JSON.stringify(candIdInput));
assert.ok(candIdResult.data);
assert.match(candIdResult.data, /^cand_/);
console.log(`rw_ids candidate ok: ${candIdResult.data}`);

// Test rw_ids: curated_slice_id
const curatedSliceIdInput = { kind: "curated_slice_id", candidate_id: "cand_test123" };
const curatedSliceIdResult = rw.call("rw_ids", JSON.stringify(curatedSliceIdInput));
assert.ok(curatedSliceIdResult.data);
assert.match(curatedSliceIdResult.data, /^slc_/);
console.log(`rw_ids curated_slice ok: ${curatedSliceIdResult.data}`);

// Test rw_ids: position_between (fractional indexing)
const positionBetweenInput1 = { kind: "position_between", a: null, b: null };
const positionBetweenResult1 = rw.call("rw_ids", JSON.stringify(positionBetweenInput1));
assert.deepEqual(positionBetweenResult1.data, "a0");
console.log(`rw_ids position_between (null, null) ok: ${positionBetweenResult1.data}`);

const positionBetweenInput2 = { kind: "position_between", a: "a0", b: "a1" };
const positionBetweenResult2 = rw.call("rw_ids", JSON.stringify(positionBetweenInput2));
assert.deepEqual(positionBetweenResult2.data, "a0V");
console.log(`rw_ids position_between (a0, a1) ok: ${positionBetweenResult2.data}`);

const positionBetweenInput3 = { kind: "position_between", a: "a3", b: null };
const positionBetweenResult3 = rw.call("rw_ids", JSON.stringify(positionBetweenInput3));
assert.deepEqual(positionBetweenResult3.data, "a4");
console.log(`rw_ids position_between (a3, null) ok: ${positionBetweenResult3.data}`);

const positionBetweenInput4 = { kind: "position_between", a: "a9", b: null };
const positionBetweenResult4 = rw.call("rw_ids", JSON.stringify(positionBetweenInput4));
assert.deepEqual(positionBetweenResult4.data, "aA");
console.log(`rw_ids position_between (a9, null) ok: ${positionBetweenResult4.data}`);

// Test rw_rank: no candidates
const rankEmptyInput = { candidates: [], verdicts: {} };
const rankEmptyResult = rw.call("rw_rank", JSON.stringify(rankEmptyInput));
assert.ok(Array.isArray(rankEmptyResult.data));
assert.equal(rankEmptyResult.data.length, 0);
console.log(`rw_rank empty ok`);

// Test rw_rank: single candidate, no verdicts
const rankInput = {
  candidates: [
    {
      id: "cand_1",
      kind: "loop",
      recording: "test",
      proposers: [{ by: "analyzer", score: 0.8, why: "test" }],
      context: null,
    },
  ],
  verdicts: {},
};
const rankResult = rw.call("rw_rank", JSON.stringify(rankInput));
assert.ok(Array.isArray(rankResult.data));
assert.equal(rankResult.data.length, 1);
assert.equal(rankResult.data[0].id, "cand_1");
assert.equal(rankResult.data[0].rank, 0.8);
assert.equal(rankResult.data[0].later, false);
console.log(`rw_rank single ok: rank=${rankResult.data[0].rank}`);

// Test rw_markup_merge: empty proposals
const mergeInput = {
  existing: [],
  proposed: [],
  name_counters: {},
  used_by_score: [],
};
const mergeResult = rw.call("rw_markup_merge", JSON.stringify(mergeInput));
assert.ok(mergeResult.data);
assert.equal(mergeResult.data.keep.length, 0);
assert.equal(mergeResult.data.create.length, 0);
console.log(`rw_markup_merge empty ok`);

// Test rw_markup_merge: new proposal creates name
const mergeCreateInput = {
  existing: [],
  proposed: [{ kind: "loop", start: 10.0, end: 14.0, rank: 1 }],
  name_counters: { loop: 0 },
  used_by_score: [],
};
const mergeCreateResult = rw.call("rw_markup_merge", JSON.stringify(mergeCreateInput));
assert.ok(mergeCreateResult.data);
assert.equal(mergeCreateResult.data.create.length, 1);
assert.equal(mergeCreateResult.data.create[0][0], "loop-1");
assert.equal(mergeCreateResult.data.name_counters.loop, 1);
console.log(`rw_markup_merge create ok: ${mergeCreateResult.data.create[0][0]}`);

// Test rw_references: (i) score_refs.feature scenario 1: clip with slice
const referencesInput1 = {
  text: `tempo 90
key C
bars 1
clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
track beat`,
  folder: "scores",
  file: "test.apr",
};
const referencesResult1 = rw.call("rw_references", JSON.stringify(referencesInput1));
assert.deepEqual(referencesResult1, {
  data: [
    {
      idSuffix: "beat",
      alias: "beat",
      source: "marine-band/stems/Thunderer/drums.wav",
      catalogPath: "marine-band/stems/Thunderer/drums.wav",
      sliceName: "loop-1",
    },
  ],
  errors: [],
});
console.log(`rw_references scenario (i) ok: clip with slice`);

// Test rw_references: (ii) kit-pad scenario: two refs with distinct suffixes
const referencesInput2 = {
  text: `tempo 90
key C
bars 1
clip band = marine-band/Thunderer.mp3
kit drums
  crash = band  hit-3
track drums  steps "crash . . ."`,
  folder: "scores",
  file: "test.apr",
};
const referencesResult2 = rw.call("rw_references", JSON.stringify(referencesInput2));
assert.deepEqual(referencesResult2, {
  data: [
    {
      idSuffix: "band",
      alias: "band",
      source: "marine-band/Thunderer.mp3",
      catalogPath: "marine-band/Thunderer.mp3",
    },
    {
      idSuffix: "band_drums.crash",
      alias: "band",
      source: "marine-band/Thunderer.mp3",
      catalogPath: "marine-band/Thunderer.mp3",
      sliceName: "hit-3",
      kitPad: "drums.crash",
    },
  ],
  errors: [],
});
console.log(`rw_references scenario (ii) ok: kit-pad with distinct suffixes`);

// Test rw_references: (iii) @clp_ and @slc_ id forms
const referencesInput3 = {
  text: `tempo 90
key C
bars 1
clip source = @clp_abc123def45678901234  @slc_xyz789
track source`,
  folder: "scores",
  file: "idref.apr",
};
const referencesResult3 = rw.call("rw_references", JSON.stringify(referencesInput3));
assert.deepEqual(referencesResult3, {
  data: [
    {
      idSuffix: "source",
      alias: "source",
      source: "@clp_abc123def45678901234",
      clipId: "clp_abc123def45678901234",
      sliceId: "slc_xyz789",
    },
  ],
  errors: [],
});
console.log(`rw_references scenario (iii) ok: @clp_ and @slc_ id forms`);

// Test rw_references: (iv) samples ../samples score in folder examples
const referencesInput4 = {
  text: `tempo 90
key C
samples ../samples
bars 1
clip beat = marine-band/x.wav
track beat`,
  folder: "examples",
  file: "test.apr",
};
const referencesResult4 = rw.call("rw_references", JSON.stringify(referencesInput4));
assert.deepEqual(referencesResult4, {
  data: [
    {
      idSuffix: "beat",
      alias: "beat",
      source: "marine-band/x.wav",
      catalogPath: "marine-band/x.wav",
    },
  ],
  errors: [],
});
console.log(`rw_references scenario (iv) ok: samples ../samples from examples`);

// Test rw_references: (v) parse error case
const referencesInput5 = {
  text: "not valid apr",
  folder: "scores",
  file: "bad.apr",
};
const referencesResult5 = rw.call("rw_references", JSON.stringify(referencesInput5));
assert.ok(!referencesResult5.data, "Parse error should not have data");
assert.ok(Array.isArray(referencesResult5.errors), "Parse error should have errors array");
assert.ok(referencesResult5.errors.length > 0, "Parse error should have at least one error message");
console.log(`rw_references scenario (v) ok: parse error`);

console.log("all wasm checks passed");
