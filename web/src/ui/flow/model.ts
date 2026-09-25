// The Flow model: source clips → the slices cut from them → their chops → where each chop lands
// in the composition. Breakdowns (the landing hero, the gallery, docs embeds) are drawn from it, baked by
// scripts/breakdown.py, which also writes their sound into the library; the Score tab's Flow view fills it
// from a live compiled timeline.

export interface FlowChord {
  start: number; // score beats
  end: number;
  numeral: string; // "IV7"
  name: string; // "Bb7"
}

export interface FlowSource {
  id: string;
  kind?: "loop" | "kit" | "clip"; // a sliced recording, a kit of one-shots laid end to end (one pad per chop), or a clip played whole
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

/** One recording a breakdown's source uses (from the library's Recording records). */
export interface FlowRecording {
  title: string;
  part: string | null; // a stem's name ("horns"), or null for the whole recording
  parts?: string[];
  composed: number | null;
  recorded: string | null;
  performer: string | null;
  credit: string | null;
  rights: string | null;
  licence: string;
  source_page: string | null;
}

export interface FlowProvenance {
  source: string; // a source id
  title: string;
  kind: "loop" | "kit" | "clip";
  tracks: string[];
  recordings: FlowRecording[];
}

export interface FlowData {
  score: string; // the score's path, e.g. examples/chop-shop.apr
  slug?: string; // a breakdown bundle's name (web/src/breakdowns/<slug>.json)
  title?: string;
  blurb?: string; // what it shows, from the score's opening comment
  code?: string; // the score's text
  provenance?: FlowProvenance[];
  captions?: Record<string, { title: string; text: string }>;
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
