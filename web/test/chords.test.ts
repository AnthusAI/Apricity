import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addString, fill, freshName, jobOf, progressionLines, readHarp, removeString, setJob, setKey, suggest, writeProgression, type ChordsView, type Slot } from "../src/ui/chords/model.ts";
import { TEMPLATES } from "../src/ui/templates.ts";

// The real parser: the wasm module the page uses (build it with `npm run wasm`).
const root = new URL("../../", import.meta.url).pathname;
const { instantiate } = await import(root + "web/src/wasm/shim.js");
const rw = await instantiate(new WebAssembly.Module(readFileSync(root + "target/wasm32-wasip1/release/apricity_web.wasm")));
const view = (text: string): ChordsView => rw.call("rw_chords", text);
const slots = (text: string) => readHarp(view(text)).slots;

const BLUES = readFileSync(root + "examples/march-blues.apr", "utf8");
const IV = readFileSync(root + "examples/iv-of-ab-minor.apr", "utf8");

describe("reading a progression", () => {
  it("march-blues: one slot per bar, holds as null", () => {
    const s = slots(BLUES);
    assert.equal(s.length, 24);
    assert.deepEqual(s.slice(0, 4), [["I7"], ["IV7"], ["I7"], null]);
  });
  it("iv of A♭ minor: long chords become holds", () => {
    const s = slots(IV);
    assert.deepEqual(s.slice(0, 5), [["iv"], null, null, null, ["i"]]);
  });
  it("split bars and a mid-bar end", () => {
    const head = "tempo 90\nkey C major\nclip a = a.wav\n";
    assert.deepEqual(slots(head + "chords [I V] IV*2\ntrack a\n"), [["I", "V"], ["IV"], null]);
    const odd = readHarp(view(head + "chords I*1.5 V\ntrack a\n"));
    assert.equal(odd.editable, false);
    const third = readHarp(view(head + "chords [I IV V] I\ntrack a\n"));
    assert.equal(third.editable, false);
    assert.match(third.why!, /whole and half bars/);
  });
});

describe("writing a progression", () => {
  it("canonical lines: 8 bars a line, | every 4", () => {
    assert.deepEqual(progressionLines([["I7"], ["IV7"], ["I7"], null, ["IV7"], null, ["I7"], null, ["V7"], ["IV7", "I7"]]), [
      "chords I7 IV7 I7 . | IV7 . I7 .",
      "chords V7 [IV7 I7]",
    ]);
  });
  it("round trip on the examples and the template, comments kept", () => {
    for (const text of [BLUES, IV, TEMPLATES.chords]) {
      const v = view(text);
      const out = writeProgression(text, v, readHarp(v).slots);
      assert.deepEqual(slots(out), readHarp(v).slots);
      for (const l of text.split("\n").filter((l) => l.startsWith("#") || l.startsWith("track"))) assert.ok(out.includes(l), l);
      assert.equal(view(out).errors, undefined);
    }
  });
  it("changing bars", () => {
    const v = view(BLUES);
    const s: Slot[] = readHarp(v).slots.slice(0, 4);
    s[3] = ["V7"];
    const out = writeProgression(BLUES, v, s);
    assert.deepEqual(slots(out), [["I7"], ["IV7"], ["I7"], ["V7"]]);
    assert.throws(() => writeProgression(BLUES, v, [null]), /first bar/);
  });
});

describe("key and strings", () => {
  it("a new key keeps the comment and renames the palette", () => {
    const out = setKey(BLUES, view(BLUES), "G mixolydian");
    assert.match(out, /^key G mixolydian   # lets the dominant sevenths/m);
    assert.equal(view(out).palette.find((p) => p.numeral === "IV")!.name, "C");
  });
  it("jobs: follow, a role, a fixed shift, and back to automatic", () => {
    const v = view(IV);
    const cotton = v.strings.find((s) => s.name === "cotton")!;
    assert.deepEqual(jobOf(cotton), { kind: "role", role: "fifth" });
    let out = setJob(IV, cotton, { kind: "follow" });
    assert.match(out, /^track cotton\s+volume -2  follow$/m);
    const c2 = view(out).strings.find((s) => s.name === "cotton")!;
    assert.deepEqual(jobOf(c2), { kind: "follow" });
    out = setJob(out, c2, { kind: "fixed", semitones: -3 });
    assert.deepEqual(jobOf(view(out).strings.find((s) => s.name === "cotton")!), { kind: "fixed", semitones: -3 });
    out = setJob(out, view(out).strings.find((s) => s.name === "cotton")!, { kind: "role", role: "any" });
    assert.match(out, /^track cotton\s+volume -2$/m);
  });
  it("adding and removing a string", () => {
    const v = view(TEMPLATES.chords);
    const name = freshName(TEMPLATES.chords, "horns");
    assert.notEqual(name, "horns", "the template already has horns");
    const out = addString(TEMPLATES.chords, v, name, "marine-band/stems/Thunderer/other.wav", "loop-2", { kind: "role", role: "third" });
    const s = view(out).strings.find((x) => x.name === name)!;
    assert.deepEqual(jobOf(s), { kind: "role", role: "third" });
    assert.match(out, new RegExp(`^clip ${name} = marine-band/stems/Thunderer/other.wav  loop-2$`, "m"));
    const back = removeString(out, s);
    assert.equal(view(back).strings.some((x) => x.name === name), false);
  });
});

describe("suggestions", () => {
  // A voice that is a C major triad, free to move, in C major.
  const pcp = Array(12).fill(0);
  [pcp[0], pcp[4], pcp[7]] = [1, 0.8, 0.9];
  const voices = [{ name: "pad", pcp, tonic: 0, role: "any", transpose: "auto" }]; // tonic: a pitch class, C = 0
  const cMajor = view("tempo 90\nkey C major\nclip a = a.wav\nchords I\ntrack a\n").palette;
  const fits = (labels: string[]) => {
    const r = rw.call("rw_fit", "C major", JSON.stringify(voices), JSON.stringify(labels));
    assert.equal(r.errors, undefined, String(r.errors));
    return new Map<string, number>(r.fits.map((f: any) => [f.label, f.score]));
  };
  const all = fits(cMajor.map((p) => p.numeral));

  it("rw_fit scores every palette chord", () => assert.equal(all.size, cMajor.length));
  it("after V, I comes first", () => {
    const s = suggest(cMajor, all, "V");
    assert.equal(s[0].chord.numeral, "I");
    assert.ok(!s.some((x) => x.chord.numeral === "V"), "not the same chord again");
  });
  it("a string that can't play a chord well pushes it down", () => {
    const skewed = new Map(all);
    skewed.set("IV", Math.min(...all.values()) - 10);
    assert.notEqual(suggest(cMajor, skewed, "I")[0].chord.numeral, "IV");
  });
  it("fill: starts home, ends with a cadence, never holds three bars", () => {
    const p = fill(cMajor, all, 8);
    assert.equal(p.length, 8);
    assert.deepEqual(p[0], ["I"]);
    assert.ok(p[6] === null || p[6]![0] === "V");
    assert.ok(p[7] === null || p[7]![0] === "I");
    for (let i = 2; i < p.length; i++) assert.ok(!(p[i] === null && p[i - 1] === null && p[i - 2] === null));
    assert.notDeepEqual(fill(cMajor, all, 8, { variation: 3 }), undefined);
    const text = writeProgression("tempo 90\nkey C major\nclip a = a.wav\nchords I\ntrack a\n", view("tempo 90\nkey C major\nclip a = a.wav\nchords I\ntrack a\n"), p);
    assert.equal(view(text).errors, undefined);
  });
});

import { degreeOf, inversions, qualities } from "../src/ui/chords/model.ts";

describe("degrees and qualities", () => {
  const pal = view("tempo 90\nkey F mixolydian\nclip a = a.wav\nchords I\ntrack a\n").palette;
  it("reads the degree of chords outside the palette", () => {
    assert.equal(degreeOf(pal, "IV7"), 4);
    assert.equal(degreeOf(pal, "bVII"), 7);
    assert.equal(degreeOf(pal, "v7"), 5);
    assert.equal(degreeOf(pal, "Dbm"), null);
  });
  it("every quality in the menu is a chord the compiler reads", () => {
    for (let d = 1; d <= 7; d++)
      for (const q of qualities(d)) {
        const text = `tempo 90\nkey F mixolydian\nclip a = a.wav\nchords ${q.label}\ntrack a\n`;
        assert.equal(view(text).errors, undefined, `${q.label}: ${view(text).errors}`);
      }
  });
  it("every inversion in the menu is a slash chord the solver reads", () => {
    assert.deepEqual(inversions("IV").map((q) => q.label), ["IV", "IV/3", "IV/5"]);
    assert.deepEqual(inversions("V7/3").map((q) => q.label), ["V7", "V7/3", "V7/5", "V7/7"]);
    const labels = pal.flatMap((p) => inversions(p.numeral).map((q) => q.label));
    const r = rw.call("rw_fit", "F mixolydian", "[]", JSON.stringify(labels));
    assert.equal(r.errors, undefined, String(r.errors));
    const names = new Map(r.fits.map((f: { label: string; name: string }) => [f.label, f.name]));
    assert.equal(names.get("IV/3"), "Bb/D");
    assert.equal(names.get("I7/7"), "F7/Eb");
  });
});

describe("voiced strings", () => {
  const text = TEMPLATES.chords;
  it("the template's stab plays the chord itself", () => {
    const stab = view(text).strings.find((s) => s.name === "stab")!;
    assert.deepEqual(jobOf(stab), { kind: "voiced", voicing: "seventh", strum: 20 });
  });
  it("a job can become voiced and back", () => {
    const horns = view(text).strings.find((s) => s.name === "horns")!;
    let out = setJob(text, horns, { kind: "voiced", voicing: "triad", strum: 15 });
    assert.match(out, /^track horns\s+volume -2  voicing triad  strum 15ms$/m);
    const h2 = view(out).strings.find((s) => s.name === "horns")!;
    assert.deepEqual(jobOf(h2), { kind: "voiced", voicing: "triad", strum: 15 });
    out = setJob(out, h2, { kind: "follow" });
    assert.match(out, /^track horns\s+volume -2  follow$/m);
    assert.equal(view(out).errors, undefined);
  });
  it("a bass with no strum writes none", () => {
    const tuba = view(text).strings.find((s) => s.name === "tuba")!;
    assert.match(setJob(text, tuba, { kind: "voiced", voicing: "root", strum: 0 }), /^track tuba\s+voicing root$/m);
  });
});
