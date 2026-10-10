// A rendered voice line becomes a sample: the WAV is read, measured, split into phrases and
// described by a minimal speech manifest (no beat grid, no key: it plays as recorded).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSpeechAnalysis,
  loudness,
  parseWav,
  phrases,
} from "../amplify/functions/voice-ingest/speech.ts";

/** Mono 16-bit WAV bytes from [seconds, amplitude] spans of a 220 Hz tone (amplitude 0 = silence). */
function wav(sampleRate: number, spans: [number, number][]): Uint8Array {
  const samples: number[] = [];
  for (const [seconds, amp] of spans) {
    const n = Math.round(seconds * sampleRate);
    for (let i = 0; i < n; i++) samples.push(amp * Math.sin((2 * Math.PI * 220 * samples.length) / sampleRate));
  }
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(data, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));
  return new Uint8Array(buf);
}

test("a WAV is read as mono samples with its rate and duration", () => {
  const audio = parseWav(wav(24000, [[1.5, 0.5]]));
  assert.equal(audio.sampleRate, 24000);
  assert.equal(audio.channels, 1);
  assert.equal(audio.samples.length, 36000);
  assert.equal(audio.duration, 1.5);
});

test("anything but mono 16-bit PCM is refused", () => {
  const bytes = wav(24000, [[0.1, 0.5]]);
  new DataView(bytes.buffer).setUint16(22, 2, true); // two channels
  assert.throws(() => parseWav(bytes), /mono 16-bit/);
});

test("loudness is the dBFS level of each half second, the last one partial", () => {
  const audio = parseWav(wav(24000, [[1.2, 0.5]]));
  const levels = loudness(audio);
  assert.equal(levels.length, 3);
  // A sine of amplitude 0.5 has RMS 0.5/√2: about -9.0 dBFS.
  for (const db of levels) assert.ok(Math.abs(db - -9.0) < 0.3, `${db}`);
});

test("phrases are the spoken spans between pauses; short gaps are bridged", () => {
  const audio = parseWav(
    wav(24000, [
      [0.5, 0], [1.0, 0.5], // phrase 1: 0.5–1.5
      [0.6, 0],             // a real pause
      [0.8, 0.5], [0.1, 0], [0.5, 0.5], // phrase 2: 2.1–3.5, a 0.1 s breath inside
      [0.5, 0],
    ]),
  );
  const found = phrases(audio);
  assert.equal(found.length, 2, JSON.stringify(found));
  const near = (a: number, b: number) => Math.abs(a - b) < 0.1;
  assert.ok(near(found[0][0], 0.5) && near(found[0][1], 1.5), JSON.stringify(found[0]));
  assert.ok(near(found[1][0], 2.1) && near(found[1][1], 3.5), JSON.stringify(found[1]));
});

test("one unbroken phrase is not worth marking", () => {
  assert.deepEqual(phrases(parseWav(wav(24000, [[0.3, 0], [2.0, 0.5], [0.3, 0]]))), []);
});

test("the analysis is a speech manifest the compiler accepts, with how the line was made", () => {
  const bytes = wav(24000, [[0.5, 0], [1.0, 0.5], [0.6, 0], [1.0, 0.5], [0.5, 0]]);
  const { analysis, phraseClips } = buildSpeechAnalysis(bytes, {
    path: "intro.wav",
    sha256: "ab".repeat(32),
    generatedBy: { engine: "auritus", backend: "kokoro", voice: "kokoro:am_adam", text: "Hi. There." },
  });
  assert.equal(analysis.apricity_manifest, 2);
  assert.deepEqual(analysis.source, { path: "intro.wav", sha256: "ab".repeat(32), sample_rate: 24000, channels: 1, duration: 3.6 });
  // No beat grid: the score plays it `warp repitch`, as recorded.
  assert.deepEqual(analysis.rhythm.beats, []);
  assert.deepEqual(analysis.rhythm.warp_markers, []);
  assert.equal(analysis.rhythm.bpm, null);
  assert.equal(analysis.rhythm.loudness.length, 8);
  // Pitch isn't measured for speech: a neutral key and a flat profile.
  assert.equal(analysis.tonal.pitch_class_profile.length, 12);
  assert.equal(typeof analysis.tonal.key.tonic, "string");
  assert.equal(analysis.tonal.tuning_hz, 440);
  assert.equal(analysis.generated_by.engine, "auritus");
  assert.equal("annotations" in analysis, false);
  // Phrases become clips named the way `slice … by phrases` reads them.
  assert.deepEqual(phraseClips.map((c) => c.name), ["phrase-1", "phrase-2"]);
  assert.deepEqual(phraseClips[0].tags, ["phrase", `${(phraseClips[0].end - phraseClips[0].start).toFixed(1)}s`]);
});
