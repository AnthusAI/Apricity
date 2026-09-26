// Measures a rendered voice line and describes it as a sample: a speech manifest with no beat grid
// and no key (it plays as recorded, `warp repitch`), its loudness curve, and its phrases. The
// numbers match apricity-analyze (analysis/apricity_analyze/analyze.py time_loudness and
// markup.py phrases), which measure at 44.1 kHz; frames here keep the same durations at the WAV's
// own rate, so nothing is resampled.

/** Mono audio as floats in [-1, 1]. */
export interface Audio {
  sampleRate: number;
  channels: number;
  samples: Float32Array;
  duration: number;
}

/** How a generated sample was made; the manifest's `generated_by`. */
export interface GeneratedBy {
  engine: string;
  backend: string;
  voice: string;
  text: string;
  version?: string;
  model?: string;
  options?: Record<string, unknown>;
  request_key?: string;
  requester?: string;
}

/** A phrase as a saved ML clip, named the way `slice … by phrases` reads it. */
export interface PhraseClip {
  name: string;
  start: number;
  end: number;
  source: "ml";
  kind: "phrase";
  tags: string[];
}

const ANALYSIS_SR = 44100; // the rate apricity-analyze measures at
const LOUDNESS_HOP_S = 0.5;
const PAUSE_S = 0.25; // a gap at least this long ends a phrase
const MIN_PHRASE_S = 0.3;
const MAX_PHRASES = 200;

/** Read a mono 16-bit PCM WAV. */
export function parseWav(bytes: Uint8Array): Audio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let format: { channels: number; sampleRate: number; bits: number; pcm: boolean } | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      format = {
        pcm: view.getUint16(body, true) === 1,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data before its format");
      if (!format.pcm || format.channels !== 1 || format.bits !== 16) {
        throw new Error(`expected mono 16-bit PCM; got ${format.channels} channel(s), ${format.bits}-bit`);
      }
      const count = Math.floor(Math.min(size, bytes.length - body) / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(body + i * 2, true) / 32768;
      return { sampleRate: format.sampleRate, channels: 1, samples, duration: count / format.sampleRate };
    }
    at = body + size + (size % 2);
  }
  throw new Error("WAV has no data");
}

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;

/** RMS level (dBFS) of each half-second window: a level curve that needs no beat grid. */
export function loudness(audio: Audio): number[] {
  const hop = Math.round(LOUDNESS_HOP_S * audio.sampleRate);
  const out: number[] = [];
  for (let i = 0; i < audio.samples.length; i += hop) {
    const end = Math.min(i + hop, audio.samples.length);
    let sum = 0;
    for (let j = i; j < end; j++) sum += audio.samples[j] ** 2;
    out.push(round(20 * Math.log10(Math.sqrt(sum / (end - i)) + 1e-9), 1));
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  const pos = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** (start, end) seconds of each phrase between pauses; empty when there's only one. */
export function phrases(audio: Audio): [number, number][] {
  const scale = audio.sampleRate / ANALYSIS_SR;
  const frame = Math.max(1, Math.round(1024 * scale));
  const hop = Math.max(1, Math.round(256 * scale));
  const x = audio.samples;
  const n = 1 + Math.floor(Math.max(0, x.length - frame) / hop);
  if (n < 4) return [];
  const db = new Array<number>(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let j = f * hop; j < f * hop + frame; j++) sum += (x[j] ?? 0) ** 2;
    db[f] = 20 * Math.log10(Math.sqrt(sum / frame + 1e-12));
  }
  const sorted = [...db].sort((a, b) => a - b);
  const loud = percentile(sorted, 95);
  // Silence: 30 dB under the speaking level, or just above the noise floor if that's higher.
  const thresh = Math.max(loud - 30, percentile(sorted, 5) + 6);
  if (loud - thresh < 10) return []; // no real pauses (dense music, noise)
  const t = (i: number) => (i * hop) / audio.sampleRate;
  const runs: [number, number][] = [];
  for (let i = 0; i < n; ) {
    if (db[i] > thresh) {
      let j = i;
      while (j < n && db[j] > thresh) j++;
      runs.push([i, j]);
      i = j;
    } else i++;
  }
  // Bridge gaps shorter than a pause (breaths between words, stop consonants).
  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && t(r[0]) - t(last[1]) < PAUSE_S) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  const out: [number, number][] = [];
  for (const [a, b] of merged) {
    // Keep the attack and the release.
    const start = Math.max(0, t(a) - 0.03);
    const end = Math.min(audio.duration, t(b) + frame / audio.sampleRate + 0.06);
    if (end - start >= MIN_PHRASE_S) out.push([round(start, 3), round(end, 3)]);
  }
  // Only worth marking when there are several (one "phrase" is just the whole clip).
  return out.length >= 2 ? out.slice(0, MAX_PHRASES) : [];
}

/**
 * The analysis attachment for a generated speech sample (a manifest without annotations, as the
 * library stores it) and its phrase clips.
 */
export function buildSpeechAnalysis(
  wav: Uint8Array,
  opts: { path: string; sha256: string; generatedBy: GeneratedBy },
): { analysis: Record<string, any>; phraseClips: PhraseClip[]; duration: number; sampleRate: number } {
  const audio = parseWav(wav);
  const analysis = {
    apricity_manifest: 2,
    source: {
      path: opts.path,
      sha256: opts.sha256,
      sample_rate: audio.sampleRate,
      channels: audio.channels,
      duration: round(audio.duration, 3),
    },
    // Speech has no beat grid; `warp repitch` plays it as recorded.
    rhythm: { bpm: null, bpm_stability: 0, beats: [], downbeats: [], meter: null, warp_markers: [], loudness: loudness(audio) },
    // Pitch isn't measured for speech: a neutral key and a flat profile keep it out of the harmony.
    tonal: {
      key: { tonic: "C", mode: "major", strength: 0 },
      tuning_hz: 440,
      tuning_cents: 0,
      pitch_class_profile: new Array(12).fill(1),
      beat_chroma: [],
    },
    generated_by: opts.generatedBy,
  };
  const phraseClips = phrases(audio).map(
    ([start, end], i): PhraseClip => ({
      name: `phrase-${i + 1}`,
      start,
      end,
      source: "ml",
      kind: "phrase",
      tags: ["phrase", `${(end - start).toFixed(1)}s`],
    }),
  );
  return { analysis, phraseClips, duration: audio.duration, sampleRate: audio.sampleRate };
}
