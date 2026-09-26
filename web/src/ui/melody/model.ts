// The piano roll's model: a `notes` melody as notes on a grid of steps × pitches, read from the wasm `rw_melody`
// view and written back into the text, which stays the score. An edit rewrites only the quoted melody on the
// track's line (and `grid` on it, or the `bars` statement, when those change). A melody plays one note at a time:
// placing a note where another sounds replaces it.

/** `rw_melody` output (crates/apricity-score/src/melody.rs). Lines are 1-based. */
export interface MelodyView {
  key: string;
  tempo: number;
  meter: number;
  bars: number | null;
  barsLine: number | null;
  tempoLine: number | null;
  scale: { degree: number; semitones: number; name: string }[];
  tracks: MelodyTrack[];
  errors?: string[];
}
export interface MelodyTrack {
  index: number;
  line: number;
  lastLine: number;
  name: string;
  clip: string;
  grid: number;
  octave: number | null;
  steps?: { at: number; len: number; degree: number; accidental: number; octave: number; vel: number | null }[];
  nSteps?: number;
  error?: string;
}

/** A note as the language writes it: a scale degree, raised or lowered, in an octave (`b3`, `5'`, `7,`). */
export interface Pitch {
  degree: number;
  accidental: number;
  octave: number;
}
export interface RollNote {
  step: number;
  len: number;
  pitch: Pitch;
  vel?: number | null;
}
export interface Roll {
  track: MelodyTrack;
  grid: number;
  stepsPerBar: number;
  /** Steps in the roll (whole bars). */
  length: number;
  notes: RollNote[];
  editable: boolean;
  why?: string;
}

const EPS = 1e-6;
const whole = (x: number) => Math.abs(x - Math.round(x)) < EPS;

/** The melody of one `notes` track as a roll. */
export function readRoll(v: MelodyView, t: MelodyTrack): Roll {
  const stepsPerBar = (v.meter * t.grid) / 4;
  const problems: string[] = [];
  if (t.error) problems.push(t.error);
  if (![4, 8, 16, 32].includes(t.grid) || !whole(stepsPerBar)) problems.push(`grid ${t.grid} isn't one the roll shows (4, 8, 16 or 32)`);
  // The roll is the melody's own length (it repeats over the piece, as the compiler plays it), in whole bars.
  const n = t.nSteps ?? 0;
  const spb = Math.max(1, Math.round(stepsPerBar));
  const length = Math.max(1, Math.ceil(n / spb)) * spb;
  if (n > 0 && n % spb !== 0) problems.push(`the melody is ${n} steps long, not whole bars of ${spb}`);
  const notes: RollNote[] = [];
  for (const s of t.steps ?? []) {
    if (!whole(s.at) || !whole(s.len)) {
      problems.push(`a note at step ${Math.floor(s.at) + 1} is split inside a step; the roll shows whole steps`);
      break;
    }
    notes.push({ step: Math.round(s.at), len: Math.round(s.len), pitch: { degree: s.degree, accidental: s.accidental, octave: s.octave }, ...(s.vel ? { vel: s.vel } : {}) });
  }
  return { track: t, grid: t.grid, stepsPerBar: spb, length, notes: notes.sort((a, b) => a.step - b.step), editable: problems.length === 0, ...(problems.length ? { why: problems[0] } : {}) };
}

// ------------------------------------------------------------------ pitches and rows

/** A pitch's semitones above the key's tonic (in the tonic's own octave). */
export function semitones(v: Pick<MelodyView, "scale">, p: Pitch): number {
  const s = v.scale[p.degree - 1]?.semitones ?? 0;
  return s + p.accidental + 12 * p.octave;
}

/** The pitch written for a semitone: a degree of the key when it is one, otherwise the note between (b3, #4, b7…). */
export function pitchAt(v: Pick<MelodyView, "scale">, semis: number): Pitch {
  const octave = Math.floor(semis / 12);
  const within = semis - 12 * octave;
  const d = v.scale.findIndex((x) => x.semitones === within);
  if (d >= 0) return { degree: d + 1, accidental: 0, octave };
  // Between two degrees: the one above, lowered (b2, b3, b6, b7), except the note between 4 and 5, which is #4.
  const above = v.scale.findIndex((x) => x.semitones > within);
  if (above === 4) return { degree: 4, accidental: 1, octave };
  if (above < 0) return { degree: 7, accidental: within - v.scale[6].semitones, octave }; // above the 7th: #7
  return { degree: above + 1, accidental: within - v.scale[above].semitones, octave };
}

/** The rows of the roll, high to low: the key's degrees over two octaves (1, to 1''), or every semitone. */
export function rows(v: Pick<MelodyView, "scale">, allNotes: boolean, extra: number[] = []): number[] {
  const lo = -5; // down to the fifth below (5,)
  const hi = 14; // up to the third above the next octave's root (3')
  const set = new Set<number>(extra);
  for (let s = lo; s <= hi; s++) if (allNotes || v.scale.some((x) => ((s % 12) + 12) % 12 === x.semitones)) set.add(s);
  return [...set].sort((a, b) => b - a);
}

/** How the language writes a pitch: `b3`, `5'`, `7,`. */
export function pitchText(p: Pitch): string {
  const acc = p.accidental > 0 ? "#".repeat(p.accidental) : "b".repeat(-p.accidental);
  const oct = p.octave > 0 ? "'".repeat(p.octave) : ",".repeat(-p.octave);
  return `${acc}${p.degree}${oct}`;
}

// ------------------------------------------------------------------ writing

/** The melody as a `notes` pattern: a token per step (`5`, `_` held, `.` rest), `|` between bars. */
export function rollNotes(r: Roll): string {
  const out: string[] = [];
  const at = new Map(r.notes.map((x) => [x.step, x]));
  let held = 0;
  for (let i = 0; i < r.length; i++) {
    if (i > 0 && i % r.stepsPerBar === 0) out.push("|");
    const x = at.get(i);
    if (x) {
      out.push(pitchText(x.pitch) + (x.vel ? (x.vel === 127 ? "!" : `@${x.vel}`) : ""));
      held = x.len - 1;
    } else if (held > 0) {
      out.push("_");
      held--;
    } else out.push(".");
  }
  return out.join(" ");
}

/** Replace the quoted melody on the track's line (everything else on the line stays). */
export function writeRoll(text: string, r: Roll): string {
  const lines = text.split("\n");
  const i = r.track.line - 1;
  const melody = rollNotes(r);
  if (!/\bnotes\s+"[^"]*"/.test(lines[i])) throw new Error(`line ${r.track.line} has no notes "…" to rewrite`);
  lines[i] = lines[i].replace(/\bnotes\s+"[^"]*"/, `notes "${melody}"`);
  return lines.join("\n");
}

/** Set (or add) `grid N` on the track's line, rescaling the notes; refuses when notes wouldn't land on the new grid. */
export function setGrid(text: string, r: Roll, grid: number): string {
  const f = grid / r.grid;
  const notes = r.notes.map((x) => ({ ...x, step: x.step * f, len: x.len * f }));
  if (notes.some((x) => !whole(x.step) || !whole(x.len))) throw new Error(`some notes fall between the steps of a 1/${grid} grid`);
  const next: Roll = { ...r, grid, stepsPerBar: r.stepsPerBar * f, length: r.length * f, notes };
  const lines = writeRoll(text, next).split("\n");
  const i = r.track.line - 1;
  lines[i] = /\bgrid\s+\S+/.test(lines[i]) ? lines[i].replace(/\bgrid\s+\S+/, `grid ${grid}`) : lines[i].replace(/(\bnotes\s+"[^"]*")/, `$1  grid ${grid}`);
  return lines.join("\n");
}

/** The roll over a different number of bars (the melody repeats to fill new bars, or is cut). */
export function resizeRoll(r: Roll, bars: number): Roll {
  const length = bars * r.stepsPerBar;
  const notes: RollNote[] = [];
  for (let rep = 0; rep < length; rep += r.length) for (const x of r.notes) if (rep + x.step < length) notes.push({ ...x, step: rep + x.step, len: Math.min(x.len, length - rep - x.step) });
  return { ...r, length, notes };
}

/** The melody over `bars` bars: cut, or repeated to fill. Only the melody changes; it repeats over the piece. */
export function setLength(text: string, r: Roll, bars: number): string {
  return writeRoll(text, resizeRoll(r, bars));
}

// ------------------------------------------------------------------ edits (each returns a new roll)

const sorted = (notes: RollNote[]) => notes.sort((a, b) => a.step - b.step);

/** The note sounding at a step (started there or held through it), if any. */
export const noteAt = (r: Roll, step: number) => r.notes.findIndex((x) => x.step <= step && step < x.step + x.len);

/** Place a note: whatever sounded from that step on is replaced, a note held across it ends there. */
export function place(r: Roll, step: number, pitch: Pitch, len = 1, vel?: number | null): Roll {
  if (step < 0 || step >= r.length) return r;
  const notes: RollNote[] = [];
  for (const x of r.notes) {
    if (x.step === step) continue;
    if (x.step < step && step < x.step + x.len) notes.push({ ...x, len: step - x.step });
    else notes.push(x);
  }
  const next = notes.filter((x) => x.step > step).reduce((m, x) => Math.min(m, x.step), r.length);
  notes.push({ step, len: Math.max(1, Math.min(len, next - step)), pitch, ...(vel ? { vel } : {}) });
  return { ...r, notes: sorted(notes) };
}

export function remove(r: Roll, i: number): Roll {
  return { ...r, notes: r.notes.filter((_, k) => k !== i) };
}

/** Change a note's length: at least a step, and never over the next note or past the end. */
export function resize(r: Roll, i: number, len: number): Roll {
  const x = r.notes[i];
  if (!x) return r;
  const next = r.notes.filter((y) => y.step > x.step).reduce((m, y) => Math.min(m, y.step), r.length);
  return { ...r, notes: r.notes.map((y, k) => (k === i ? { ...y, len: Math.max(1, Math.min(len, next - x.step)) } : y)) };
}

/** Move a note in time and to another pitch (monophonic: it replaces what it lands on). */
export function move(r: Roll, i: number, step: number, pitch: Pitch): Roll {
  const x = r.notes[i];
  if (!x) return r;
  return place(remove(r, i), Math.max(0, Math.min(r.length - 1, step)), pitch, x.len, x.vel);
}

/** A pitch moved by scale degrees (in key), keeping its accidental. */
export function stepDegree(p: Pitch, by: number): Pitch {
  const i = p.degree - 1 + by;
  return { degree: (((i % 7) + 7) % 7) + 1, accidental: p.accidental, octave: p.octave + Math.floor(i / 7) };
}
