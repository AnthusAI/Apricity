// The Flow model: source clips → the slices cut from them → their chops → where each chop lands
// in the composition. The landing page's hero story is drawn from it (baked by
// scripts/hero-data.py, which also writes its sound into the library); the Score tab's Flow view will fill it from a live compiled timeline.

export interface FlowChord {
  start: number; // score beats
  end: number;
  numeral: string; // "IV7"
  name: string; // "Bb7"
}

export interface FlowSource {
  id: string;
  kind?: "loop" | "kit"; // a sliced recording, or a kit of one-shots laid end to end (one pad per chop)
  title: string;
  credit: string;
  path: string;
  window: [number, number]; // the stretch of the recording shown, in seconds
  peaks: string; // base64 int8 min/max pairs across `window`
  beats: number[]; // seconds, within the window
  downbeats: number[];
  transients: number[];
  bpm: number;
  meter: number;
  key: string | null;
  tuning_cents: number;
  slice: { name: string; from: number; to: number; machine: string };
  chop_beats: number;
  chops: [number, number][]; // seconds
  lane: string; // the score track its chops play on
  pads?: string[]; // a kit's pad names, one per chop
}

export interface FlowTile {
  source: number; // index into sources
  chop: number; // index into that source's chops
  start: number; // score beats
  dur: number;
  semitones: number;
  cont: boolean; // the second half of a chop split at a chord change
}

export interface FlowAudio {
  sources: string[]; // per source: its window as recorded, a library key (files/<key>)
  tracks: { key: string; gain_db: number }[]; // per source: its track rendered alone (a library key), and the gain back to mix level
}

export interface FlowData {
  score: string;
  audio?: FlowAudio;
  tempo: number;
  meter: number;
  key: string;
  beats: number; // length of the piece
  chords: FlowChord[];
  sources: FlowSource[];
  tiles: FlowTile[];
}

/** Min/max peak pairs, −127…127. */
export function decodePeaks(b64: string): Int8Array {
  const bin = atob(b64);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
  return out;
}
