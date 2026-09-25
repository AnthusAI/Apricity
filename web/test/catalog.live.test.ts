// The Library and Score data against a real `apricity serve` (local mode), through the real
// aws-amplify client, then a score from the library compiled in the wasm.
// Run: APRICITY_SERVE_URL=http://127.0.0.1:5198 npx tsx --test test/catalog.live.test.ts
// (after `apricity migrate --from . --to <lib> --link` and `apricity serve --library <lib> --port 5198`;
// needs target/wasm32-wasip1/release/apricity_web.wasm). Skipped without APRICITY_SERVE_URL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/api";
import { Catalog } from "../src/data/catalog.ts";

const base = process.env.APRICITY_SERVE_URL;
const root = new URL("../../", import.meta.url).pathname;

test("library records -> samples, manifests, scores, and a compiled score", { skip: !base && "set APRICITY_SERVE_URL" }, async () => {
  Amplify.configure(await (await fetch(`${base}/amplify_outputs.json`)).json());
  const c = generateClient();
  const file = (k: string) => `${base}/files/${encodeURIComponent(k)}`;
  const cat = new Catalog({
    client: () => c,
    readText: async (k) => {
      const r = await fetch(file(k));
      if (!r.ok) throw new Error(`${k}: ${r.status}`);
      return r.text();
    },
    url: async (k) => file(k),
  });

  const { samples, jobs } = await cat.samples();
  assert.ok(samples.length >= 40, `${samples.length} samples`);
  assert.deepEqual(jobs, []);
  for (const s of samples) {
    assert.match(s.path, /^samples\//);
    assert.ok(s.title && s.group && s.duration > 0 && typeof s.key === "string", JSON.stringify(s));
  }
  const thunderer = samples.find((s) => s.path === "samples/marine-band/stems/Thunderer/drums.wav")!;
  assert.equal(thunderer.title, "The Thunderer · drums");
  assert.equal(thunderer.group, "marine-band");
  assert.ok(thunderer.clips > 0 && thunderer.bpm, JSON.stringify(thunderer));
  assert.equal(samples[0].group, "marine-band", "modern recordings first");
  const excerpt = samples.find((s) => s.excerpt_start);
  assert.match(excerpt!.excerpt_start!, /^\d\d:\d\d:\d\d$/);

  const { scores } = await cat.scores();
  assert.ok(scores.some((s) => s.path === "examples/chop-shop.apr"), scores.map((s) => s.path).join());
  const text = await cat.score("examples/chop-shop.apr");
  assert.equal(text, readFileSync(root + "examples/chop-shop.apr", "utf8"));

  const { instantiate } = await import("../src/wasm/shim.js");
  const rw = await instantiate(new WebAssembly.Module(readFileSync(root + "target/wasm32-wasip1/release/apricity_web.wasm")));
  const { sources } = rw.call("rw_sources", text, "examples/chop-shop.apr");
  assert.ok(sources.length > 0);
  const manifests: Record<string, unknown> = {};
  for (const p of sources) {
    const m = (await cat.manifest(p))!;
    assert.ok(m.rhythm.beats.length > 0 && m.tonal.pitch_class_profile.length === 12, p);
    assert.ok(m.annotations?.clips?.length, `${p} has its slices`);
    manifests[p] = m;
  }
  const r = rw.call("rw_compile", text, "examples/chop-shop.apr", JSON.stringify(manifests));
  assert.ok(r.timeline, JSON.stringify(r.errors));
  assert.ok(r.timeline.events.length > 0);

  const res = await fetch(await cat.audioUrl(sources[0]), { headers: { Range: "bytes=0-15" } });
  assert.equal(res.status, 206);
  assert.equal((await res.arrayBuffer()).byteLength, 16);
});
