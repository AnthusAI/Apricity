// The chord harp's model: a score's progression as one slot per bar, its strings (the tracks the harmony solver
// moves) with their jobs, and the suggestions. Read from the wasm `rw_chords` view and written back into the text,
// which stays the score: an edit rewrites only the `chords` lines, the `key` line or one track line.

/** `rw_chords` output (crates/apricity-score/src/chords.rs). Lines are 1-based. */
export interface ChordsView {
  key: string;
  keyLine: number | null;
  tempo: number;
  meter: number;
  barsLine: number | null;
  chordLines: [number, number][];
  progression: { label: string; bars: number }[];
  strings: StringView[];
  palette: PaletteChord[];
  errors?: string[];
}
export interface StringView {
  index: number;
  line: number;
  lastLine: number;
  clip: string;
  name: string;
  role: Role;
  transpose: "auto" | "follow" | number;
  bars: string | null;
  /** Set when the string plays the chord itself (a pitched track): root, power, triad or seventh. */
  voicing?: Voicing | null;
  strum?: number | null;
  octave?: number | null;
}
export type Voicing = "root" | "power" | "triad" | "seventh";
export interface PaletteChord {
  numeral: string;
  name: string;
  degree: number;
  function: "tonic" | "subdominant" | "dominant";
  seventh: boolean;
}
export type Role = "any" | "chord" | "root" | "third" | "fifth" | "seventh" | "bass";

/**
 * A string's job: move with the chord root, take a chord tone (the solver's hint), stay put, or play the chord
 * itself (the clip at each of the chord's tones, strummed).
 */
export type Job = { kind: "follow" } | { kind: "role"; role: Role } | { kind: "fixed"; semitones: number } | { kind: "voiced"; voicing: Voicing; strum: number };

export function jobOf(s: StringView): Job {
  if (s.voicing) return { kind: "voiced", voicing: s.voicing, strum: s.strum ?? 0 };
  if (s.transpose === "follow") return { kind: "follow" };
  if (typeof s.transpose === "number") return { kind: "fixed", semitones: s.transpose };
  return { kind: "role", role: s.role };
}

/** One bar: a chord, two chords (a split bar), or null: the chord before it goes on. */
export type Slot = string[] | null;

export interface Harp {
  slots: Slot[];
  editable: boolean;
  why?: string;
}

const EPS = 1e-6;

/** The progression as bars. Read-only when a chord's length isn't a whole or half bar. */
export function readHarp(v: ChordsView): Harp {
  // Each chord's span in half bars; each half remembers which chord (entry) sounds there.
  const halves: number[] = [];
  for (const [i, c] of v.progression.entries()) {
    const n = c.bars * 2;
    if (Math.abs(n - Math.round(n)) > EPS || n < 1 - EPS) return { slots: [], editable: false, why: `${c.label} lasts ${c.bars} bars; the harp shows whole and half bars` };
    for (let k = 0; k < Math.round(n); k++) halves.push(i);
  }
  if (halves.length % 2) return { slots: [], editable: false, why: "the progression ends in the middle of a bar" };
  const starts = (h: number) => h === 0 || halves[h - 1] !== halves[h];
  const slots: Slot[] = [];
  for (let b = 0; b < halves.length / 2; b++) {
    const [a, c] = [halves[2 * b], halves[2 * b + 1]];
    const la = v.progression[a].label;
    const lc = v.progression[c].label;
    if (a === c) slots.push(starts(2 * b) ? [la] : null);
    else slots.push([la, lc]);
  }
  return { slots, editable: true };
}

/** The chords as text: `I7 IV7 I7 . | IV7 . [V7 IV7] I7`, 8 bars to a line with `|` every 4. */
export function progressionLines(slots: Slot[]): string[] {
  const token = (s: Slot) => (s === null ? "." : s.length === 1 ? s[0] : `[${s.join(" ")}]`);
  const lines: string[] = [];
  for (let i = 0; i < slots.length; i += 8) {
    const eight = slots.slice(i, i + 8).map(token);
    const four = [eight.slice(0, 4).join(" "), eight.slice(4).join(" ")].filter(Boolean);
    lines.push(`chords ${four.join(" | ")}`);
  }
  return lines;
}

/** Replace 1-based inclusive line spans with `insert`, placed where the first span was (or before line `at`). */
function splice(text: string, spans: [number, number][], insert: string[], at?: number): string {
  const lines = text.split("\n");
  const drop = new Set<number>();
  for (const [a, b] of spans) for (let i = a; i <= b; i++) drop.add(i - 1);
  const first = spans.length ? Math.min(...spans.map((s) => s[0])) - 1 : (at ?? lines.length + 1) - 1;
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === first) out.push(...insert);
    if (!drop.has(i)) out.push(l);
  });
  if (first >= lines.length) out.push(...insert);
  return out.join("\n");
}

/** The text with the progression rewritten. The first bar can't be a hold. */
export function writeProgression(text: string, v: ChordsView, slots: Slot[]): string {
  if (!slots.length) throw new Error("a progression needs at least one bar");
  if (slots[0] === null) throw new Error("the first bar needs a chord");
  const firstTrack = v.strings.length ? Math.min(...v.strings.map((s) => s.line)) : undefined;
  return splice(text, v.chordLines, progressionLines(slots), firstTrack);
}

/** Split a line into its code and its comment (a `#` outside quotes). */
function codeAndComment(line: string): [string, string] {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === "#" && !q) return [line.slice(0, i).trimEnd(), line.slice(i)];
  }
  return [line.trimEnd(), ""];
}

/** Rewrite a statement on its line, keeping its comment; add it after line `after` if it isn't there. */
function setStatement(text: string, line: number | null, stmt: string, after: number): string {
  const lines = text.split("\n");
  if (line) {
    const [, comment] = codeAndComment(lines[line - 1]);
    lines[line - 1] = comment ? `${stmt}   ${comment}` : stmt;
  } else lines.splice(after, 0, stmt);
  return lines.join("\n");
}

export const setKey = (text: string, v: ChordsView, key: string) => setStatement(text, v.keyLine, `key ${key}`, 0);

/** The text with one string's job changed: `follow`, `role third`, or `transpose 3`, on its track line. */
export function setJob(text: string, s: StringView, job: Job): string {
  const lines = text.split("\n");
  let [code, comment] = codeAndComment(lines[s.line - 1]);
  code = code
    .replace(/\s+follow\b/g, "")
    .replace(/\s+role\s+\S+/g, "")
    .replace(/\s+transpose\s+\S+/g, "")
    .replace(/\s+voicing\s+\S+/g, "")
    .replace(/\s+strum\s+\S+/g, "");
  if (job.kind === "voiced") code += `  voicing ${job.voicing}${job.strum > 0 ? `  strum ${job.strum}ms` : ""}`;
  else if (job.kind === "follow") code += "  follow";
  else if (job.kind === "fixed") code += `  transpose ${job.semitones}`;
  else if (job.role !== "any") code += `  role ${job.role}`;
  lines[s.line - 1] = comment ? `${code}   ${comment}` : code;
  return lines.join("\n");
}

/** Clip names declared in the text (to keep a new one unique). */
export function clipNames(text: string): Set<string> {
  return new Set([...text.matchAll(/^clip\s+([A-Za-z][A-Za-z0-9_-]*)/gm)].map((m) => m[1]));
}

/** A clip name like `name`, not yet used. */
export function freshName(text: string, name: string): string {
  const taken = clipNames(text);
  const base = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[^A-Za-z]+/, "") || "clip";
  let out = base;
  for (let n = 2; taken.has(out) || out === "x"; n++) out = `${base}${n}`;
  return out;
}

/** Add a string: `clip <name> = <sample>  <saved clip>` after the last clip line, and a track with its job at the end. */
export function addString(text: string, v: ChordsView, name: string, sample: string, savedClip: string | undefined, job: Job): string {
  const lines = text.split("\n");
  let lastClip = -1;
  lines.forEach((l, i) => /^clip\s/.test(l) && (lastClip = i));
  const clipLine = `clip ${name} = ${sample}${savedClip ? `  ${savedClip}` : ""}`;
  if (lastClip >= 0) lines.splice(lastClip + 1, 0, clipLine);
  else lines.splice(Math.max(0, (v.keyLine ?? 0)), 0, "", clipLine);
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const track = { index: -1, line: lines.length + 1, lastLine: lines.length + 1, clip: name, name, role: "any" as Role, transpose: "auto" as const, bars: null };
  lines.push(`track ${name}`);
  return setJob(lines.join("\n"), track, job) + "\n";
}

/** Take a string out (its track lines; the clip line stays for anything else that uses it). */
export const removeString = (text: string, s: StringView) => splice(text, [[s.line, s.lastLine]], []);

// ------------------------------------------------------------------ suggestions

/**
 * How often one scale degree moves to another in common-practice and popular harmony (a small, hand-set table: the
 * pull of V to I, IV to V, vi to IV…). Row 0 is "the start of the piece".
 */
const MOVES: Record<number, Record<number, number>> = {
  0: { 1: 0.6, 6: 0.15, 4: 0.15, 2: 0.05, 5: 0.05 },
  1: { 4: 0.3, 5: 0.25, 6: 0.2, 2: 0.12, 3: 0.05, 7: 0.03, 1: 0.05 },
  2: { 5: 0.5, 7: 0.15, 4: 0.1, 1: 0.1, 6: 0.1, 3: 0.05 },
  3: { 6: 0.4, 4: 0.3, 2: 0.15, 1: 0.1, 5: 0.05 },
  4: { 5: 0.35, 1: 0.3, 2: 0.15, 7: 0.05, 6: 0.1, 4: 0.05 },
  5: { 1: 0.5, 6: 0.25, 4: 0.15, 3: 0.05, 5: 0.05 },
  6: { 4: 0.3, 2: 0.3, 5: 0.2, 3: 0.1, 1: 0.1 },
  7: { 1: 0.6, 3: 0.2, 6: 0.1, 5: 0.1 },
};

export interface Suggestion {
  chord: PaletteChord;
  /** 0–1: how well your strings fit it (relative to the palette). */
  fit: number;
  /** 0–1: how naturally it follows the chord before. */
  flow: number;
  score: number;
  why: string;
}

const ROMAN: [string, number][] = [["vii", 7], ["iii", 3], ["iv", 4], ["vi", 6], ["ii", 2], ["v", 5], ["i", 1]];

/** Scale degree of a written chord: from the palette, or read off its numeral (`IV7`, `bVII`, `iv`). */
export function degreeOf(palette: PaletteChord[], label: string | null): number | null {
  if (!label) return null;
  const p = palette.find((x) => x.numeral === label);
  if (p) return p.degree;
  const bare = label.replace(/^[b#♭♯]+/, "").toLowerCase();
  return ROMAN.find(([n]) => bare.startsWith(n))?.[1] ?? null;
}

/** The chords one scale degree can be written as (for the chord bars' quality menu): `IV`, `iv`, `IV7`, `IVmaj7`… */
export function qualities(degree: number): { label: string; what: string }[] {
  const up = ["I", "II", "III", "IV", "V", "VI", "VII"][degree - 1];
  const lo = up.toLowerCase();
  return [
    { label: up, what: "major" },
    { label: lo, what: "minor" },
    { label: `${up}7`, what: "dominant 7th" },
    { label: `${up}maj7`, what: "major 7th" },
    { label: `${lo}7`, what: "minor 7th" },
    { label: `${up}sus2`, what: "sus2" },
    { label: `${up}sus4`, what: "sus4" },
    { label: `${lo}o`, what: "diminished" },
  ];
}

/** A chord with each of its tones in the bass (for the quality menu): `IV`, `IV/3`, `IV/5`, and `IV7/7` for a seventh. */
export function inversions(label: string): { label: string; what: string }[] {
  const base = label.replace(/\/.*$/, "");
  return [
    { label: base, what: "root in the bass" },
    { label: `${base}/3`, what: "1st inversion: 3rd in the bass" },
    { label: `${base}/5`, what: "2nd inversion: 5th in the bass" },
    ...(/7|ø/.test(base) ? [{ label: `${base}/7`, what: "3rd inversion: 7th in the bass" }] : []),
  ];
}

/**
 * Rank the palette as the next chord after `prev`: how well the score's own strings fit each chord (the harmony
 * solver's score, from `rw_fit`), and how naturally it follows. Chords the strings can't play well sink.
 */
export function suggest(palette: PaletteChord[], fits: Map<string, number>, prev: string | null, opts: { sevenths?: boolean; fitWeight?: number } = {}): Suggestion[] {
  const pool = palette.filter((p) => !!p.seventh === !!opts.sevenths);
  const scores = pool.map((p) => fits.get(p.numeral)).filter((x): x is number => x !== undefined);
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const norm = (x: number | undefined) => (x === undefined || hi - lo < EPS ? 0.5 : (x - lo) / (hi - lo));
  const from = degreeOf(palette, prev) ?? 0;
  const w = opts.fitWeight ?? 0.6;
  return pool
    .filter((p) => p.numeral !== prev)
    .map((p) => {
      const fit = norm(fits.get(p.numeral));
      const flow = (MOVES[from]?.[p.degree] ?? 0.02) / 0.6;
      const why =
        fit > 0.75 && flow > 0.4 ? "your sounds fit it, and it follows naturally" : fit > 0.75 ? "your sounds fit it well" : flow > 0.4 ? "it follows naturally" : "a change of colour";
      return { chord: p, fit, flow: Math.min(1, flow), score: w * fit + (1 - w) * Math.min(1, flow), why };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * A whole progression of `bars` bars that suits the strings: start on the tonic, follow the best suggestions, don't
 * sit on one chord more than two bars, and end with a cadence (a dominant, then home). `variation` (0, 1, 2…) takes
 * the runner-up now and then, for "try another".
 */
export function fill(palette: PaletteChord[], fits: Map<string, number>, bars: number, opts: { sevenths?: boolean; variation?: number } = {}): Slot[] {
  const pool = palette.filter((p) => !!p.seventh === !!opts.sevenths);
  const tonic = pool.find((p) => p.degree === 1);
  const dominant = pool.find((p) => p.degree === 5);
  if (!tonic || bars < 1) return [];
  const out: Slot[] = [[tonic.numeral]];
  let prev = tonic.numeral;
  let run = 1;
  let seed = opts.variation ?? 0;
  for (let b = 1; b < bars; b++) {
    const last = b === bars - 1;
    const penultimate = b === bars - 2;
    if (last && bars > 2) {
      out.push(prev === tonic.numeral ? null : [tonic.numeral]);
      break;
    }
    if (penultimate && dominant && bars > 3) {
      out.push(prev === dominant.numeral ? null : [dominant.numeral]);
      prev = dominant.numeral;
      continue;
    }
    const ranked = suggest(palette, fits, prev, opts);
    // Hold now and then (a chord for two bars), never three.
    if (run < 2 && b % 2 === 1 && ranked[0] && ranked[0].score < 0.55) {
      out.push(null);
      run++;
      continue;
    }
    // A pseudo-random runner-up for variations, the same for the same variation number.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const pick = opts.variation && seed % 3 === 0 && ranked[1] ? ranked[1] : ranked[0];
    if (!pick) break;
    out.push([pick.chord.numeral]);
    prev = pick.chord.numeral;
    run = 1;
  }
  return out;
}
