// Flow renderer: pure layout and timing, plus the baked hero data's promises.
// Run: npx tsx --test web/test/flow.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { beatX, layout, secX } from "../src/ui/flow/layout.ts";
import { pulse, seg } from "../src/ui/flow/tween.ts";

test("seg and pulse", () => {
  assert.equal(seg(0, 1, 3), 0);
  assert.equal(seg(2, 1, 3), 0.5);
  assert.equal(seg(9, 1, 3), 1);
  assert.equal(seg(5, 4, 4), 1, "an empty window is done once reached");
  assert.equal(pulse(2, 0, 1, 3, 4), 1);
  assert.equal(pulse(3.5, 0, 1, 3, 4), 0.5);
});

test("layout: sources stack from the top, lanes sit at the bottom", () => {
  const l = layout(1000, 380, [{ shown: 1, detail: 1 }, { shown: 1, detail: 0 }], [26, 34]);
  const [a, b] = l.sources;
  assert.ok(a.wave.h > 40 && b.wave.h === 0, "detail shows the waveform, summary hides it");
  assert.ok(b.title.y > a.chops.y + a.chops.h, "the second source is below the first");
  assert.equal(l.lanes[1].y + l.lanes[1].h, 380 - 8, "the last lane ends at the bottom");
  assert.equal(l.lanes[1].h, 34);
  assert.ok(l.ruler.y < l.chords.y && l.chords.y < l.lanes[0].y);
  assert.equal(beatX(l, 0, 32), l.left);
  assert.equal(beatX(l, 32, 32), l.right);
  assert.equal(secX(a.wave, [10, 20], 15), a.wave.x + a.wave.w / 2);
  const hidden = layout(1000, 380, [{ shown: 0, detail: 1 }], [26]);
  assert.equal(hidden.sources[0].chops.h, 0, "a source not shown yet takes no room");
});

test("hero data: two real sources, every tile mapped to a chop", () => {
  const d = JSON.parse(readFileSync(new URL("../src/ui/flow/hero-data.json", import.meta.url), "utf8"));
  assert.equal(d.sources.length, 2);
  assert.deepEqual(d.sources.map((s: { chops: unknown[] }) => s.chops.length), [8, 4]);
  for (const s of d.sources) assert.equal(Buffer.from(s.peaks, "base64").length, 1200);
  for (const t of d.tiles) assert.ok(t.chop >= 0 && t.chop < d.sources[t.source].chops.length);
  const horns = d.tiles.filter((t: { source: number }) => t.source === 1);
  assert.ok(horns.some((t: { semitones: number }) => t.semitones !== 0), "the horns are transposed to the chords");
});

test("hero story cues: each step is heard, in order", async () => {
  const { Story } = await import("../src/ui/flow/story.ts");
  const d = JSON.parse(readFileSync(new URL("../src/ui/flow/hero-data.json", import.meta.url), "utf8"));
  const cues = new Story(d).cues();
  assert.deepEqual(cues.map((c) => c.t), [...cues.map((c) => c.t)].sort((a, b) => a - b), "sorted by time");
  const listen = cues.filter((c) => c.kind === "source" && c.offset === 0);
  assert.deepEqual(listen.map((c) => c.dur), d.sources.map((s: { window: number[] }) => s.window[1] - s.window[0]), "each recording is heard whole while it's analyzed");
  const chops = cues.filter((c) => c.kind === "source" && c.dur < 1);
  assert.equal(chops.length, 8 + 4, "every chop is heard as it's cut");
  const loops = cues.filter((c) => c.loop);
  assert.equal(loops.length, 3, "the drums alone, then both tracks together");
  for (const c of cues.filter((c) => c.kind === "track" && !c.loop)) assert.ok(c.offset + c.dur <= (d.beats * 60) / d.tempo + 1e-6, "landings stay inside the render");
});
