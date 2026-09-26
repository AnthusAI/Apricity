import { test } from "node:test";
import assert from "node:assert/strict";

import { envelopeModel, MAX_LANES, stripModel } from "../src/data/feed-visual.ts";

const ev = (track: string, start_beat: number, dur_beats: number) => ({ track, source: 0, start_beat, dur_beats, src_start: 0, src_end: 1, semitones: 0 });

test("a score's strip: a lane per playing track, its blocks in order, chords merged", () => {
  const m = stripModel({
    meter: 4,
    length_beats: 16,
    tracks: [{ name: "drums" }, { name: "silent" }, { name: "bass" }] as never,
    events: [ev("bass", 8, 4), ev("drums", 4, 1), ev("drums", 0, 1), ev("bass", 0, 4)],
    harmony: [
      { start_beat: 0, end_beat: 4, label: "I", fit: { chord: "F", coverage: 1 } },
      { start_beat: 4, end_beat: 8, label: "I", fit: { chord: "F", coverage: 1 } },
      { start_beat: 8, end_beat: 16, label: "V7", fit: null },
    ],
  });
  assert.deepEqual(m.lanes, [
    { name: "drums", blocks: [[0, 1], [4, 1]] },
    { name: "bass", blocks: [[0, 4], [8, 4]] },
  ]);
  assert.deepEqual(m.chords, [
    { start: 0, end: 8, label: "F" },
    { start: 8, end: 16, label: "V7" },
  ]);
  assert.equal(m.beats, 16);
  assert.equal(m.meter, 4);
});

test("a strip keeps the first lanes, and runs to the last event when the length is short", () => {
  const tracks = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}` }));
  const m = stripModel({ meter: 3, length_beats: 0, tracks: tracks as never, events: tracks.map((t, i) => ev(t.name, i, 2)), harmony: [] });
  assert.equal(m.lanes.length, MAX_LANES);
  assert.equal(m.beats, 13);
});

const manifest = {
  source: { path: "a.flac", duration: 10, sample_rate: 48000, channels: 2 },
  rhythm: { bpm: 120, beats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], downbeats: [0, 4, 8], meter: 4, beat_loudness: [-10, -40, -20, -10, -10, -10, -10, -10, -10] },
  tonal: {
    key: { tonic: "F", mode: "major", strength: 1 },
    tuning_hz: 440,
    pitch_class_profile: [],
    segments: [
      { start: 0, end: 5, key: { tonic: "F", mode: "major" } },
      { start: 5, end: 10, key: { tonic: "D", mode: "minor" } },
    ],
  },
};

test("a sample's envelope: loudness per beat against the loudest, downbeats and keys", () => {
  const e = envelopeModel(manifest);
  assert.equal(e.from, 0);
  assert.equal(e.to, 10);
  assert.equal(e.bars.length, 9);
  assert.equal(e.bars[0].v, 1);
  assert.equal(e.bars[1].v, 0); // 30 dB down or more
  assert.ok(Math.abs(e.bars[2].v - 2 / 3) < 1e-9);
  assert.deepEqual(e.downbeats, [0, 4, 8]);
  assert.deepEqual(e.keys.map((k) => k.label), ["F", "Dm"]);
  assert.equal(e.highlight, null);
});

test("a clip's envelope: the clip and some of the sample either side, highlighted", () => {
  const e = envelopeModel(manifest, [5, 6]);
  assert.equal(e.from, 1); // four beats before
  assert.equal(e.to, 10); // clamped to the end
  assert.deepEqual(e.highlight, [5, 6]);
  assert.deepEqual(e.downbeats, [4, 8]);
  assert.equal(e.bars[0].t0, 1);
});

test("an analysis without loudness draws at half height", () => {
  const { beat_loudness: _, ...rhythm } = manifest.rhythm;
  assert.ok(envelopeModel({ ...manifest, rhythm }).bars.every((b) => b.v === 0.5));
});
