import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addPad, readBeat, rowSteps, setBars, setCell, setSwing, setTempo, writeBeat, type Beat, type StepsView } from "../src/ui/beat/model.ts";
import { TEMPLATES } from "../src/ui/templates.ts";

// The real parser: the wasm module the page uses (build it with `npm run wasm`).
const root = new URL("../../", import.meta.url).pathname;
const { instantiate } = await import(root + "web/src/wasm/shim.js");
const rw = await instantiate(new WebAssembly.Module(readFileSync(root + "target/wasm32-wasip1/release/apricity_web.wasm")));
const view = (text: string): StepsView => rw.call("rw_steps", text);
const grid = (b: Beat) => Object.fromEntries(b.rows.map((r) => [r.pad, rowSteps(r, b.stepsPerBar)]));

const SALAMANDER = readFileSync(root + "examples/salamander-beat.apr", "utf8");

describe("reading a beat", () => {
  it("the beat template: pads in written order, whole-kit and single-pad tracks merged", () => {
    const b = readBeat(view(TEMPLATES.beat))!;
    assert.equal(b.kit, "drums");
    assert.deepEqual(b.rows.map((r) => r.pad), ["kick", "snare", "ghost", "hat"]);
    assert.equal(b.length, 32);
    assert.equal(b.editable, true, b.why);
    assert.deepEqual(grid(b), {
      kick: "x . . . . . . . . . x . . . . . | x . . . . . . . . . x . . . x .",
      snare: ". . . . x . . . . . . . x . . . | . . . . x . . . . . . . x . . .",
      ghost: ". . . . . . . x . . . . . . . . | . . . . . . . x . . . . . . . .",
      hat: "x . x . x . x . x . x . x . x . | x . x . x . x . x . x . x . x .",
    });
    assert.equal(b.rows[0].volume, -3);
    assert.equal(b.rows[3].volume, -9);
  });

  it("salamander-beat: a 2-bar pattern repeats over 4 bars", () => {
    const b = readBeat(view(SALAMANDER))!;
    assert.equal(b.length, 64);
    assert.equal(b.editable, true, b.why);
    const kick = b.rows.find((r) => r.pad === "kick")!;
    assert.deepEqual([0, 10, 32, 42].map((i) => kick.cells[i].on), [true, true, true, true]);
  });

  it("ratchets and holds", () => {
    const t = `tempo 90\nkey C major\nclip k = a.wav\nclip h = b.wav\nkit d\n  k = k\n  h = h\ntrack d steps "k _ [h h] . [k k k] . . ."\n`;
    const b = readBeat(view(t))!;
    assert.equal(b.editable, true, b.why);
    assert.deepEqual(b.rows[0].cells[0], { on: true, ratchet: 1, hold: 2 });
    assert.deepEqual(b.rows[1].cells[2], { on: true, ratchet: 2, hold: 1 });
    assert.deepEqual(b.rows[0].cells[4], { on: true, ratchet: 3, hold: 1 });
    assert.equal(rowSteps(b.rows[0], 16), "x _ . . [x x x] . . . x _ . . [x x x] . . .");
  });

  it("read-only when the grid can't show it", () => {
    const head = `tempo 90\nkey C major\nclip k = a.wav\nclip h = b.wav\nkit d\n  k = k\n  h = h\n`;
    for (const [track, why] of [
      [`track d steps "[k h] . . ."`, /can't show/],
      [`track d steps "k . . ."  grid 8`, /grid 8/],
      [`track d steps "k . . ."\n  pan 20`, /options/],
      [`track d.k steps "x . . ." bars 2`, /options/],
    ] as const) {
      const b = readBeat(view(head + track + "\n"))!;
      assert.equal(b.editable, false, track);
      assert.match(b.why!, why);
    }
  });

  it("a sliced kit has one row per slice", () => {
    const b = readBeat(view(`tempo 90\nkey C major\nclip brk = a.wav\nkit b = slice brk by beats 0.5\ntrack b steps "1 . 3 ."\n`), undefined, 8)!;
    assert.equal(b.rows.length, 8);
    assert.equal(b.rows[2].cells[2].on, true);
  });
});

describe("writing a beat", () => {
  it("round trip: read → write → read gives the same grid, one track per pad, comments kept", () => {
    for (const text of [TEMPLATES.beat, SALAMANDER]) {
      const v = view(text);
      const b = readBeat(v)!;
      const out = writeBeat(text, v, b);
      const again = readBeat(view(out))!;
      assert.deepEqual(grid(again), grid(b));
      assert.deepEqual(again.rows.map((r) => r.volume), b.rows.map((r) => r.volume));
      for (const line of text.split("\n").filter((l) => l.startsWith("#") || l.startsWith("clip") || l.startsWith("kit"))) assert.ok(out.includes(line), line);
      assert.equal(view(out).tracks.filter((t) => t.kit === "drums" && !t.pad).length, 0, "no whole-kit track is left");
    }
  });

  it("tracks that play the kit without steps are left alone", () => {
    const text = SALAMANDER;
    const out = writeBeat(text, view(text), readBeat(view(text))!);
    assert.match(out, /^track drums\.crash  at 1  volume -8$/m);
    assert.equal(readBeat(view(text))!.rows.find((r) => r.pad === "crash")!.cells.some((c) => c.on), false);
  });

  it("toggling a cell, swing, and a pad that stops playing", () => {
    const text = TEMPLATES.beat;
    const v = view(text);
    let b = readBeat(v)!;
    b = setCell(b, 2, 7, { on: false, ratchet: 1, hold: 1 }); // ghost off in bar 1
    b = setCell(b, 2, 23, { on: false, ratchet: 1, hold: 1 }); // and bar 2: the ghost pad stops playing
    b = setCell(b, 3, 1, { on: true, ratchet: 2, hold: 1 });
    b = setSwing(b, 58);
    const out = writeBeat(text, v, b);
    assert.doesNotMatch(out, /track drums\.ghost/);
    assert.match(out, /track drums\.hat\s+steps "x \[x x\] x \. /);
    assert.match(out, /swing 58/);
    const again = readBeat(view(out))!;
    assert.equal(again.rows[3].cells[1].ratchet, 2);
    assert.equal(again.rows[2].cells.some((c) => c.on), false);
  });

  it("tempo and bars", () => {
    const text = TEMPLATES.beat;
    const v = view(text);
    assert.equal(view(setTempo(text, v, 104)).tempo, 104);
    const four = setBars(text, v, readBeat(v)!, 4);
    assert.equal(view(four).bars, 4);
    assert.equal(readBeat(view(four))!.length, 64);
    // No bars line yet: one is added under tempo.
    const noBars = text.replace(/^bars 2\n/m, "");
    const nv = view(noBars);
    const one = setBars(noBars, nv, readBeat(nv)!, 1);
    assert.equal(view(one).bars, 1);
    assert.equal(readBeat(view(one))!.length, 16);
    assert.match(one, /^tempo 96\nbars 1$/m);
  });

  it("adding a pad", () => {
    const text = TEMPLATES.beat;
    const out = addPad(text, view(text), "drums", "clap", "salamander-drumkit/OH/snareStick_OH_F_1.wav");
    const b = readBeat(view(out))!;
    assert.deepEqual(b.rows.map((r) => r.pad), ["kick", "snare", "ghost", "hat", "clap"]);
    assert.match(out, /^clip clap = salamander-drumkit\/OH\/snareStick_OH_F_1\.wav  warp repitch\nkit drums$/m);
    assert.throws(() => addPad(text, view(text), "drums", "kick", "x.wav"), /already has/);
    assert.throws(() => addPad(text, view(text), "drums", "9lives", "x.wav"), /pad name/);
  });
});

describe("groove the grid doesn't show yet", () => {
  const withGroove = (line: string) => SALAMANDER.replace(/^track drums  steps .*$/m, line);
  it("velocities keep a beat read-only, so an edit can't drop them", () => {
    const b = readBeat(view(withGroove('track drums  steps "kick . snare@40 . kick! . snare . | kick . snare . . . snare ."')))!;
    assert.equal(b.editable, false);
    assert.match(b.why!, /velocities/);
  });
  it("so do humanize and a track velocity", () => {
    for (const opt of ["humanize 8ms", "velocity 90", "seed 2", "swing 58 1/8"]) {
      const b = readBeat(view(withGroove(`track drums  steps "kick . snare . kick . snare . | kick . snare . . . snare ."  ${opt}`)))!;
      assert.equal(b.editable, false, opt);
    }
  });
});

describe("templates", () => {
  it("every kind's starter score parses", () => {
    for (const [kind, text] of Object.entries(TEMPLATES)) assert.equal(view(text).errors, undefined, `${kind}: ${view(text).errors}`);
  });
});

import { rebaseSamples } from "../src/ui/templates.ts";

describe("rebaseSamples", () => {
  it("a template saved into a person's folder still finds the samples", () => {
    const out = rebaseSamples(TEMPLATES.chords, "scores", "scores/google_123");
    assert.match(out, /^samples \.\.\/\.\.\/samples$/m);
    assert.equal(view(out).errors, undefined);
  });
  it("a copy of an example keeps pointing at the same folder, comments kept", () => {
    assert.equal(rebaseSamples("tempo 90\nsamples ../samples   # the library\n", "examples", "scores/ann"), "tempo 90\nsamples ../../samples   # the library\n");
    assert.equal(rebaseSamples("samples: ../samples\n", "examples", "scores/ann"), "samples: ../../samples\n", "YAML too");
  });
  it("same folder, absolute paths and no samples line are left alone", () => {
    assert.equal(rebaseSamples("samples ../samples\n", "scores", "scores"), "samples ../samples\n");
    assert.equal(rebaseSamples("samples /data/samples\n", "scores", "scores/ann"), "samples /data/samples\n");
    assert.equal(rebaseSamples("tempo 90\n", "scores", "scores/ann"), "tempo 90\n");
  });
  it("moving back up", () => assert.equal(rebaseSamples("samples ../../samples\n", "scores/ann", "scores"), "samples ../samples\n"));
});
