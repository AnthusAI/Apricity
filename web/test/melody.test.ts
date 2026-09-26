import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { move, noteAt, pitchAt, pitchText, place, readRoll, remove, resize, rollNotes, rows, semitones, setGrid, setLength, stepDegree, writeRoll, type MelodyView } from "../src/ui/melody/model.ts";
import { TEMPLATES } from "../src/ui/templates.ts";

// The real parser: the wasm module the page uses (build it with `npm run wasm`).
const root = new URL("../../", import.meta.url).pathname;
const { instantiate } = await import(root + "web/src/wasm/shim.js");
const rw = await instantiate(new WebAssembly.Module(readFileSync(root + "target/wasm32-wasip1/release/apricity_web.wasm")));
const view = (text: string): MelodyView => rw.call("rw_melody", text);
const roll = (text: string, i = 0) => {
  const v = view(text);
  return readRoll(v, v.tracks[i]);
};
const TUNE = TEMPLATES.melody;

describe("reading a melody", () => {
  it("the template: 4 bars of eighths, holds become lengths", () => {
    const r = roll(TUNE);
    assert.equal(r.editable, true, r.why);
    assert.equal((r.grid, r.stepsPerBar), 8);
    assert.equal(r.length, 32);
    assert.deepEqual(r.notes.slice(0, 3), [
      { step: 0, len: 2, pitch: { degree: 5, accidental: 0, octave: 0 } },
      { step: 2, len: 2, pitch: { degree: 3, accidental: 0, octave: 0 } },
      { step: 4, len: 2, pitch: { degree: 1, accidental: 0, octave: 0 } },
    ]);
    assert.ok(r.notes.some((x) => x.pitch.degree === 7 && x.pitch.octave === -1), "the 7, below");
  });
  it("round trip: read → write → read gives the same notes, the rest of the line kept", () => {
    const text = TUNE.replace('grid 8', 'grid 8  volume -2   # the tune');
    const r = roll(text);
    const out = writeRoll(text, r);
    assert.deepEqual(roll(out).notes, r.notes);
    assert.match(out, /notes "5 _ 3 _ 1 _ 3 5 \| 6 _ 4 _ 1 _ \. \. \| 5 _ 4 3 2 _ 7, _ \| 1 _ _ _ \. \. \. \."  grid 8  volume -2   # the tune/);
    assert.equal(view(out).errors, undefined);
  });
  it("accidentals, octave marks and velocities survive", () => {
    const text = 'tempo 90\nkey F\nbars 1\nclip a = a.wav\ntrack a  notes "b3 _ #4 . 5\' 1,@80 7! ."  grid 8\n';
    const r = roll(text);
    assert.equal(rollNotes(r), "b3 _ #4 . 5' 1,@80 7! .");
  });
  it("the roll is the melody's own length, in whole bars", () => {
    const r = roll('tempo 90\nkey C\nbars 4\nclip a = a.wav\ntrack a  notes "1 . 3 . 5 . 3 ."  grid 8\n');
    assert.equal(r.length, 8, "one bar, however long the piece");
    const odd = roll('tempo 90\nkey C\nclip a = a.wav\ntrack a  notes "1 . 3"  grid 8\n');
    assert.equal(odd.editable, false);
    assert.match(odd.why!, /not whole bars/);
  });
  it("read-only when the roll can't show it", () => {
    const head = "tempo 90\nkey C\nclip a = a.wav\n";
    for (const [track, why] of [
      ['track a  notes "[1 2] 3 . . . . . ."  grid 8', /split inside a step/],
      ['track a  notes "1 . 3 . . . . . . . . ."  grid 12', /grid 12/],
    ] as const) {
      const r = roll(head + track + "\n");
      assert.equal(r.editable, false, track);
      assert.match(r.why!, why);
    }
  });
});

describe("pitches and rows", () => {
  const v = view(TUNE); // F major
  it("semitones above the tonic", () => {
    assert.equal(semitones(v, { degree: 5, accidental: 0, octave: 0 }), 7);
    assert.equal(semitones(v, { degree: 3, accidental: -1, octave: 0 }), 3);
    assert.equal(semitones(v, { degree: 7, accidental: 0, octave: -1 }), -1);
  });
  it("the in-between notes are spelled b2 b3 #4 b6 b7", () => {
    assert.deepEqual([1, 3, 6, 8, 10].map((s) => pitchText(pitchAt(v, s))), ["b2", "b3", "#4", "b6", "b7"]);
    assert.deepEqual(pitchAt(v, 7), { degree: 5, accidental: 0, octave: 0 });
    assert.deepEqual(pitchAt(v, -1), { degree: 7, accidental: 0, octave: -1 });
    assert.equal(pitchText(pitchAt(v, 14)), "2'");
  });
  it("rows: the key's notes, or all twelve", () => {
    const inKey = rows(v, false);
    assert.equal(inKey[0], 14);
    assert.ok(inKey.every((s) => [0, 2, 4, 5, 7, 9, 11].includes(((s % 12) + 12) % 12)));
    assert.equal(rows(v, true).length, 20);
  });
  it("moving by degrees wraps into the next octave", () => {
    assert.deepEqual(stepDegree({ degree: 7, accidental: 0, octave: 0 }, 1), { degree: 1, accidental: 0, octave: 1 });
    assert.deepEqual(stepDegree({ degree: 1, accidental: 0, octave: 0 }, -1), { degree: 7, accidental: 0, octave: -1 });
    assert.deepEqual(stepDegree({ degree: 3, accidental: 0, octave: 0 }, 7), { degree: 3, accidental: 0, octave: 1 });
  });
});

describe("editing", () => {
  const base = roll('tempo 90\nkey C\nbars 1\nclip a = a.wav\ntrack a  notes "1 _ _ _ 5 . . ."  grid 8\n');
  const p = (degree: number) => ({ degree, accidental: 0, octave: 0 });
  it("placing inside a held note ends it there (one note at a time)", () => {
    const r = place(base, 2, p(3));
    assert.equal(rollNotes(r), "1 _ 3 . 5 . . .");
  });
  it("placing on a note replaces it; a new note stops at the next one", () => {
    assert.equal(rollNotes(place(base, 4, p(6), 3)), "1 _ _ _ 6 _ _ .");
    assert.equal(rollNotes(place(base, 2, p(2), 4)), "1 _ 2 _ 5 . . .");
  });
  it("resize stops at the next note and the end", () => {
    assert.equal(rollNotes(resize(base, 0, 9)), "1 _ _ _ 5 . . .");
    assert.equal(rollNotes(resize(base, 1, 9)), "1 _ _ _ 5 _ _ _");
    assert.equal(rollNotes(resize(base, 0, 1)), "1 . . . 5 . . .");
  });
  it("move and remove", () => {
    assert.equal(rollNotes(move(base, 1, 6, p(4))), "1 _ _ _ . . 4 .");
    assert.equal(rollNotes(remove(base, 0)), ". . . . 5 . . .");
    assert.equal(noteAt(base, 2), 0);
    assert.equal(noteAt(base, 5), -1);
  });
  it("grid and bars", () => {
    const text = 'tempo 90\nkey C\nbars 1\nclip a = a.wav\ntrack a  notes "1 _ _ _ 5 . . ."  grid 8\n';
    const sixteenths = setGrid(text, base, 16);
    assert.match(sixteenths, /notes "1 _ _ _ _ _ _ _ 5 _ \. \. \. \. \. \."  grid 16/);
    assert.deepEqual(roll(sixteenths).notes.map((x) => [x.step, x.len]), [[0, 8], [8, 2]]);
    assert.throws(() => setGrid(text, place(base, 1, p(2)), 4), /between the steps/);
    const two = setLength(text, base, 2);
    assert.match(two, /notes "1 _ _ _ 5 \. \. \. \| 1 _ _ _ 5 \. \. \."/, "repeated to fill");
    assert.match(two, /^bars 1$/m, "the piece's own bars are left alone");
    assert.equal(roll(two).length, 16);
    assert.equal(rollNotes(readRoll(view(two), view(two).tracks[0])).split("|").length, 2);
  });
});
