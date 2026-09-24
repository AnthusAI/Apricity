// The Flow model: source clips → the slices cut from them → their chops → where each chop lands
// in the composition. The landing page's hero story is drawn from it (baked by
// scripts/hero-data.py); the Score tab's Flow view will fill it from a live compiled timeline.

export interface FlowChord {
  start: number; // score beats
  end: number;
  numeral: string; // "IV7"
  name: string; // "Bb7"
}

export interface FlowSource {
  id: string;
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
}

export interface FlowTile {
  source: number; // index into sources
  chop: number; // index into that source's chops
  start: number; // score beats
  dur: number;
  semitones: number;
  cont: boolean; // the second half of a chop split at a chord change
}

export interface FlowData {
  score: string;
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
