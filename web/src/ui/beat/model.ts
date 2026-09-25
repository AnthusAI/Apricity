// The Beat editor's model: a kit's step patterns as a grid of pads × sixteenth steps, read from the score text
// (through the wasm `rw_steps` view) and written back into it. The text stays the score: an edit replaces the kit's
// track lines with one line per pad (`track drums.kick steps "x . . . | …"`), which sounds the same as any other way
// of writing it, and leaves every other line, comment and blank line as it was.

/** `rw_steps` output (crates/apricity-score/src/beat.rs). Lines are 1-based. */
export interface StepsView {
  tempo: number;
  tempoLine: number | null;
  meter: number;
  bars: number | null;
  barsLine: number | null;
  kits: KitView[];
  tracks: TrackView[];
  errors?: string[];
}
export interface KitView {
  name: string;
  line: number;
  lastLine: number;
  sliced: boolean;
  pads: { name: string; line: number }[];
}
export interface TrackView {
  index: number;
  line: number;
  lastLine: number;
  sound: string;
  kit: string | null;
  pad: string | null;
  grid: number;
  swing: number;
  volume: number;
  other: boolean;
  steps?: { at: number; len: number; sound: string | number | null }[];
  nSteps?: number;
  error?: string;
}

export interface Cell {
  on: boolean;
  /** Hits within the step: 1, or 2–4 for a ratchet (`[x x]`). */
  ratchet: number;
  /** How many steps the note lasts (`x _ _` is 3). */
  hold: number;
}
export interface Row {
  pad: string;
  cells: Cell[];
  volume: number;
  swing: number;
}
export interface Beat {
  kit: string;
  sliced: boolean;
  rows: Row[];
  stepsPerBar: number;
  /** Steps in the grid (bars × stepsPerBar). */
  length: number;
  editable: boolean;
  /** Why the grid is read-only, when it is. */
  why?: string;
}

const EPS = 1e-6;
export const off = (): Cell => ({ on: false, ratchet: 1, hold: 1 });

/** The kit a Beat editor shows: the first one some track plays with steps (else the first kit). */
export function mainKit(v: StepsView): KitView | undefined {
  return v.kits.find((k) => v.tracks.some((t) => t.kit === k.name && t.steps)) ?? v.kits[0];
}

/**
 * The grid for a kit. `slices` is how many slices a sliced kit has (from the compiled timeline); rows for a drum kit
 * are its pads in written order.
 */
export function readBeat(v: StepsView, kitName?: string, slices = 0): Beat | null {
  const kit = kitName ? v.kits.find((k) => k.name === kitName) : mainKit(v);
  if (!kit) return null;
  const stepsPerBar = v.meter * 4;
  // Tracks that play the kit with steps are the grid; others (`drums.crash at 1`) are left alone.
  const tracks = v.tracks.filter((t) => t.kit === kit.name && (t.steps || t.error));
  const problems: string[] = [];
  for (const t of tracks) {
    if (t.error) problems.push(t.error);
    else if (t.other) problems.push(`track ${t.sound} uses options the grid doesn't show`);
    else if (t.grid !== 16) problems.push(`track ${t.sound} uses grid ${t.grid}`);
  }
  const longest = Math.max(0, ...tracks.map((t) => t.nSteps ?? 0));
  const length = v.bars ? v.bars * stepsPerBar : Math.max(1, Math.ceil(longest / stepsPerBar)) * stepsPerBar;

  // Rows: pads in written order; a sliced kit's slices 1…N (at least as many as the tracks use).
  const used = tracks.flatMap((t) => (t.steps ?? []).map((s) => (t.pad ?? (typeof s.sound === "number" ? String(s.sound) : null)))).filter(Boolean) as string[];
  const names = kit.sliced
    ? Array.from({ length: Math.max(slices, ...used.map(Number).filter((n) => n > 0)) }, (_, i) => String(i + 1))
    : kit.pads.map((p) => p.name);
  const rows: Row[] = names.map((pad) => ({ pad, cells: Array.from({ length }, off), volume: 0, swing: 50 }));
  const rowOf = new Map(rows.map((r) => [r.pad, r]));
  const claimed = new Set<Row>();

  for (const t of tracks) {
    if (!t.steps || !t.nSteps) continue;
    // Hits per pad per whole step (the pattern repeats over the grid).
    const hits = new Map<string, { at: number; len: number }[]>();
    for (const s of t.steps) {
      if (s.sound === null) continue;
      const pad = t.pad ?? String(s.sound);
      if (t.pad && s.sound !== "x") {
        problems.push(`track ${t.sound} names ${s.sound}; a single-pad track plays x`);
        continue;
      }
      const row = rowOf.get(pad);
      if (!row) {
        problems.push(`no pad ${pad} in kit ${kit.name}`);
        continue;
      }
      if (!claimed.has(row)) {
        claimed.add(row);
        row.volume = t.volume;
        row.swing = t.swing;
      }
      hits.set(pad, [...(hits.get(pad) ?? []), { at: s.at, len: s.len }]);
    }
    if (length % t.nSteps > EPS && t.nSteps < length) problems.push(`track ${t.sound} is ${t.nSteps} steps long, which doesn't divide ${length}`);
    for (const [pad, hs] of hits) {
      const row = rowOf.get(pad)!;
      const byStep = new Map<number, { at: number; len: number }[]>();
      for (const h of hs) {
        const i = Math.floor(h.at + EPS);
        byStep.set(i, [...(byStep.get(i) ?? []), h]);
      }
      for (const [i, group] of byStep) {
        let cell: Cell;
        if (group.length === 1 && Math.abs(group[0].at - i) < EPS && Math.abs(group[0].len - Math.round(group[0].len)) < EPS && group[0].len >= 1 - EPS) {
          cell = { on: true, ratchet: 1, hold: Math.round(group[0].len) };
        } else {
          const n = group.length;
          const even = n >= 2 && n <= 4 && group.every((h, k) => Math.abs(h.at - (i + k / n)) < EPS && Math.abs(h.len - 1 / n) < EPS);
          if (!even) {
            problems.push(`track ${t.sound} splits step ${i + 1} in a way the grid can't show`);
            continue;
          }
          cell = { on: true, ratchet: n, hold: 1 };
        }
        // The pattern repeats from the start to fill the grid.
        for (let at = i; at < length; at += t.nSteps) row.cells[at] = { ...cell };
      }
    }
  }
  return { kit: kit.name, sliced: kit.sliced, rows, stepsPerBar, length, editable: problems.length === 0, ...(problems.length ? { why: problems[0] } : {}) };
}

/** One row as a steps string: `x`, `[x x]`, `x _`, `.`, with `|` between bars. A hold stops at the next hit. */
export function rowSteps(row: Row, stepsPerBar: number): string {
  const out: string[] = [];
  const emit = (i: number, tok: string) => {
    if (i > 0 && i % stepsPerBar === 0) out.push("|");
    out.push(tok);
  };
  const cells = row.cells;
  let i = 0;
  while (i < cells.length) {
    const c = cells[i];
    if (!c.on) {
      emit(i++, ".");
      continue;
    }
    emit(i, c.ratchet > 1 ? `[${Array(c.ratchet).fill("x").join(" ")}]` : "x");
    let h = 1;
    while (h < c.hold && i + h < cells.length && !cells[i + h].on) emit(i + h++, "_");
    i += h;
  }
  return out.join(" ");
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** The canonical track lines for a beat: one per pad that plays. */
export function beatLines(b: Beat): string[] {
  const playing = b.rows.filter((r) => r.cells.some((c) => c.on));
  const heads = playing.map((r) => `track ${b.kit}.${r.pad}`);
  const w = Math.max(0, ...heads.map((h) => h.length));
  return playing.map((r, i) => {
    let line = `${heads[i].padEnd(w)}  steps "${rowSteps(r, b.stepsPerBar)}"`;
    if (Math.abs(r.swing - 50) > EPS) line += `  swing ${num(r.swing)}`;
    if (Math.abs(r.volume) > EPS) line += `  volume ${num(r.volume)}`;
    return line;
  });
}

/** Replace some 1-based inclusive line spans with `insert`, placed where the first span was (or at `at`). */
function splice(text: string, spans: [number, number][], insert: string[], at?: number): string {
  const lines = text.split("\n");
  const drop = new Set<number>();
  for (const [a, b] of spans) for (let i = a; i <= b; i++) drop.add(i - 1);
  const first = spans.length ? Math.min(...spans.map((s) => s[0])) - 1 : (at ?? lines.length);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === first) out.push(...insert);
    if (!drop.has(i)) out.push(l);
  });
  if (first >= lines.length) out.push(...insert);
  return out.join("\n");
}

/** The text with the kit's tracks rewritten from the grid. New tracks go after the kit when it had none. */
export function writeBeat(text: string, v: StepsView, b: Beat): string {
  const spans = v.tracks.filter((t) => t.kit === b.kit && t.steps).map((t) => [t.line, t.lastLine] as [number, number]);
  const kit = v.kits.find((k) => k.name === b.kit);
  const lines = beatLines(b);
  if (!spans.length) return splice(text, [], ["", ...lines], kit ? kit.lastLine : undefined);
  return splice(text, spans, lines);
}

/** A copy of the beat with one cell changed. */
export function setCell(b: Beat, row: number, step: number, cell: Cell): Beat {
  const rows = b.rows.map((r, i) => (i === row ? { ...r, cells: r.cells.map((c, j) => (j === step ? cell : c)) } : r));
  return { ...b, rows };
}

/** The same beat over a different number of bars: new bars repeat the pattern, fewer bars cut it. */
export function resize(b: Beat, bars: number): Beat {
  const length = bars * b.stepsPerBar;
  const rows = b.rows.map((r) => ({ ...r, cells: Array.from({ length }, (_, i) => ({ ...r.cells[i % b.length] })) }));
  return { ...b, rows, length };
}

/** Rewrite a statement's value on its line, keeping any comment. */
function setStatement(text: string, line: number | null, word: string, value: string, after: number | null): string {
  const lines = text.split("\n");
  if (line) {
    const l = lines[line - 1];
    const hash = l.indexOf("#");
    const comment = hash >= 0 ? "   " + l.slice(hash) : "";
    lines[line - 1] = `${word} ${value}${comment}`;
  } else lines.splice(after ?? 0, 0, `${word} ${value}`);
  return lines.join("\n");
}

export const setTempo = (text: string, v: StepsView, bpm: number) => setStatement(text, v.tempoLine, "tempo", num(bpm), 0);

/** The text with the beat resized to `bars` bars: the `bars` statement and the kit's tracks. */
export function setBars(text: string, v: StepsView, b: Beat, bars: number): string {
  const r = resize(b, bars);
  // Rewriting the bars line in place keeps every line number, so the tracks can be rewritten after it.
  if (v.barsLine) return writeBeat(setStatement(text, v.barsLine, "bars", String(bars), null), v, r);
  // No bars line yet: rewrite the tracks, then add one under tempo (which comes before the tracks).
  const firstTrack = Math.min(...v.tracks.filter((t) => t.kit === b.kit && t.steps).map((t) => t.line));
  const after = v.tempoLine && v.tempoLine < firstTrack ? v.tempoLine : 0;
  return setStatement(writeBeat(text, v, r), null, "bars", String(bars), after);
}

/** Set every row's swing (the grid has one swing knob). */
export const setSwing = (b: Beat, swing: number): Beat => ({ ...b, rows: b.rows.map((r) => ({ ...r, swing })) });

/**
 * Add a pad to a drum kit: a clip line (`clip <pad> = <sample>  <saved clip>  warp repitch`) before the kit, and
 * `<pad> = <pad>` at the end of its pads.
 */
export function addPad(text: string, v: StepsView, kitName: string, pad: string, sample: string, savedClip?: string): string {
  const kit = v.kits.find((k) => k.name === kitName);
  if (!kit || kit.sliced) throw new Error(`${kitName} isn't a drum kit`);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(pad) || pad === "x") throw new Error(`${pad}: a pad name is letters, digits, - and _`);
  if (kit.pads.some((p) => p.name === pad)) throw new Error(`${kitName} already has a pad ${pad}`);
  const lines = text.split("\n");
  const lastPad = kit.pads.length ? kit.pads[kit.pads.length - 1].line : kit.line;
  const indent = kit.pads.length ? /^\s*/.exec(lines[kit.pads[0].line - 1])![0] : "  ";
  lines.splice(lastPad, 0, `${indent}${pad} = ${pad}`);
  lines.splice(kit.line - 1, 0, `clip ${pad} = ${sample}${savedClip ? `  ${savedClip}` : ""}  warp repitch`);
  return lines.join("\n");
}
