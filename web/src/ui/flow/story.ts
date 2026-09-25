// A breakdown's story: a score being made, slowly enough to follow. Each source in turn is analyzed,
// clipped, sliced (or laid onto pads, for a kit of one-shots) and placed into the composition, warped
// to its tempo and transposed to its chords; then the whole piece plays. The timing is computed from
// the data (plan()), so any score works. Everything drawn comes from a bundle baked by
// scripts/breakdown.py: real peaks, beats and placements.

import { type Box, type Layout, beatX, layout, secX } from "./layout";
import { type FlowData, type FlowTile, decodePeaks } from "./model";
import { type Theme, header, pointer, rect, ribbon, tag, tile, wave } from "./paint";
import { easeInOut, easeOut, lerp, pulse, seg } from "./tween";

type Span = [number, number];
interface Phases {
  appear: Span; // title bar and waveform arrive
  listen: Span; // the analysis sweep
  suggest: Span; // automatic markup offers a loop
  point: Span; // the pointer drags out a clip
  name: Span; // the clip gets its name
  lift: Span; // the clip lifts into the kit's row
  cut: Span; // …and is sliced onto pads
  code: Span; // the line of score that did it
  land: Span; // the first bar of notes flies into the composition
  fill: Span; // the rest of the pattern fills in
}

const FLY = 1.1;

export interface Chapter {
  label: string;
  t: number;
}

export interface Session {
  from: number;
  to: number;
  fade: number;
  sources: number[]; // which sources' tracks play
}

/** The story's clock, computed from the data: each source in turn, then the whole piece.
 *  The first source gets the full treatment (listen, clip, slice, warp, and a playback on its own);
 *  each later source is quicker. The listening sweeps last as long as the audio they cross, so the
 *  story can be heard in step: see cues(). */
export interface Plan {
  ph: Phases[];
  compose: Span; // the composition (ruler, chords, lanes) fades in
  collapse: (Span | null)[]; // each source folds to a summary to make room for the next
  sessions: Session[]; // when the playhead runs
  loop: number; // the story's length
  fade: Span; // the end of the loop
  still: number; // the frame shown when motion is reduced: everything in place
  chapters: Chapter[];
}

const KIND_CHAPTER = { loop: "Again", kit: "Kit", clip: "Add" } as const;

export function plan(d: FlowData): Plan {
  const ph: Phases[] = [];
  const collapse: (Span | null)[] = [];
  const chapters: Chapter[] = [];
  const sessions: Session[] = [];
  let compose: Span = [0, 0];
  let base = 0;
  d.sources.forEach((src, n) => {
    const w = src.window[1] - src.window[0];
    const kind = src.kind ?? "loop";
    if (n === 0) {
      const L = 2.5 + w;
      ph.push({ appear: [0, 2.5], listen: [2.5, L], suggest: [L - 0.5, L + 0.3], point: [L + 1.5, L + 4.5], name: [L + 4.7, L + 5.5], lift: [L + 6, L + 8], cut: [L + 8, L + 10.5], code: [L + 10.5, L + 11.5], land: [L + 14, L + 19], fill: [L + 19, L + 21] });
      compose = [L + 12.5, L + 14];
      const first = kind === "kit" ? ["Listen", "Pads", "Steps"] : kind === "clip" ? ["Listen", "Clip", "Warp"] : ["Listen", "Clip", "Slice", "Warp"];
      const at = kind === "loop" ? [0, L + 0.5, L + 6, L + 12.5] : [0, L + 0.5, L + 12.5];
      first.forEach((label, i) => chapters.push({ label, t: at[i] }));
      sessions.push({ from: L + 21, to: L + 26, fade: 2, sources: [0] });
      base = L + 26;
    } else {
      const L = base + 2.5 + w;
      ph.push({ appear: [base, base + 2.5], listen: [base + 2.5, L], suggest: [L - 0.6, L + 0.2], point: [L + 0.6, L + 2.8], name: [L + 3, L + 3.6], lift: [L + 3.8, L + 5], cut: [L + 5, L + 7], code: [L + 7, L + 7.8], land: [L + 8.5, L + 12.5], fill: [L + 12.5, L + 15] });
      const label = KIND_CHAPTER[kind];
      chapters.push({ label: chapters.some((c) => c.label === label) ? shortName(src.title) : label, t: base - 0.5 });
      base = L + 15.5;
    }
  });
  // Each source folds to a summary just before the next one arrives.
  ph.forEach((_, n) => collapse.push(n + 1 < ph.length ? [ph[n + 1].appear[0] - 3.5, ph[n + 1].appear[0] - 0.5] : null));
  const loop = base + 25.5;
  sessions.push({ from: base, to: loop, fade: 2, sources: d.sources.map((_, n) => n) });
  chapters.push({ label: "Play", t: base });
  return { ph, compose, collapse, sessions, loop, fade: [loop - 2, loop], still: base + 11.5, chapters };
}

/** "The Thunderer — horns" → "Horns". */
export function shortName(title: string) {
  const s = title.split("—").at(-1)!.trim();
  return s[0].toUpperCase() + s.slice(1);
}

const LANE = 26;
const PITCHED_LANE = 34; // room to show transposition as height
const KIT_LANE = 46; // a row per pad
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");
const prettyKey = (k: string) => k.replace("b", "♭").replace("#", "♯");

/** Something to hear at story time t: a stretch of a source window, or of a track's render. */
export interface Cue {
  t: number;
  kind: "source" | "track";
  index: number; // which source (and its track)
  offset: number; // seconds into the recording
  dur: number;
  fadeOut?: number; // seconds of fade at the end
  loop?: boolean;
}

/** Clicks every `spb` seconds on a grid through `anchor`, from story time 0 up to `until`; every `meter`th is accented. */
export interface Metronome {
  anchor: number;
  until: number;
  spb: number;
  meter: number;
}

interface Timed extends FlowTile {
  t0: number; // when it starts to arrive
  fly: boolean; // flies in from its pad (the first bar), or simply appears (the rest)
  landed: number; // when it's in place
}

export class Story {
  private peaks: Int8Array[];
  private tiles: Timed[];
  private pitchRange: number[]; // per source: the largest transposition, 0 if never moved
  private ph: Phases[];
  readonly plan: Plan;
  /** The story's length, seconds; it loops. */
  readonly loop: number;
  /** The frame shown when motion is reduced. */
  readonly still: number;
  readonly chapters: Chapter[];

  constructor(readonly data: FlowData) {
    this.peaks = data.sources.map((s) => decodePeaks(s.peaks));
    this.plan = plan(data);
    this.ph = this.plan.ph;
    this.loop = this.plan.loop;
    this.still = this.plan.still;
    this.chapters = this.plan.chapters;
    this.tiles = [];
    this.pitchRange = data.sources.map((_, n) => Math.max(0, ...data.tiles.filter((t) => t.source === n).map((t) => Math.abs(t.semitones))));
    data.sources.forEach((_, n) => {
      const ph = this.ph[n];
      const mine = data.tiles.filter((t) => t.source === n).sort((a, b) => a.start - b.start);
      const first = mine[0]?.start ?? 0;
      const bar = data.meter;
      const flying = mine.filter((t) => t.start < first + bar);
      const rest = mine.filter((t) => t.start >= first + bar);
      const gap = (ph.land[1] - ph.land[0] - FLY) / Math.max(1, flying.length - 1);
      flying.forEach((t, i) => this.tiles.push({ ...t, fly: true, t0: ph.land[0] + i * gap, landed: ph.land[0] + i * gap + FLY }));
      const span = Math.max(1, (rest.at(-1)?.start ?? first) - (first + bar));
      rest.forEach((t) => {
        const t0 = ph.fill[0] + ((t.start - first - bar) / span) * (ph.fill[1] - ph.fill[0] - 0.3);
        this.tiles.push({ ...t, fly: false, t0, landed: t0 + 0.3 });
      });
    });
  }

  /** The chapter under way at time t. */
  chapterAt(t: number) {
    return this.chapters.reduce((k, c, i) => (t >= c.t ? i : k), 0);
  }

  /** The Info View line for time t. */
  caption(t: number): { title: string; text: string } {
    const d = this.data;
    const { ph, compose, collapse, sessions } = this.plan;
    const tuning = (c: number) => (c ? `${Math.abs(c)}¢ ${c > 0 ? "sharp" : "flat"}, so it's retuned to A = 440` : "already at A = 440");
    const custom = (d as FlowData & { captions?: Record<string, { title: string; text: string }> }).captions;
    const final = sessions.at(-1)!;
    if (t >= final.from) return custom?.play ?? { title: "Play.", text: d.blurb ? `${d.blurb[0].toUpperCase()}${d.blurb.slice(1)}` : "Every source, warped and tuned into one piece." };
    // The source whose turn it is: the last one to have appeared.
    const n = ph.reduce((k, p, i) => (t >= p.appear[0] ? i : k), 0);
    const src = d.sources[n];
    const p = ph[n];
    const kind = src.kind ?? "loop";
    const follow = d.chords
      .filter((c) => this.tiles.some((x) => x.source === n && x.start >= c.start && x.start < c.end))
      .map((c) => `${signed(this.tiles.find((x) => x.source === n && x.start >= c.start)!.semitones)} under ${c.numeral}`);
    const moved = this.pitchRange[n] > 0;
    const tuned = moved ? ` and transposed to follow the chords: ${[...new Set(follow)].join(", ")} semitones` : "";
    const pads = src.pads ?? [];
    const next = d.sources[n + 1];
    const fold = collapse[n];
    if (fold && t >= fold[0]) return { title: "Focus.", text: `${shortName(src.title)} folds down to a summary, to make room for ${next ? shortName(next.title).toLowerCase() : "the next sound"}.` };
    if (t < p.appear[1]) return { title: kind === "kit" ? "A drum kit." : n ? "Another sample." : "A sample.", text: `${src.title}: ${src.credit}.` };
    if (kind === "kit") {
      if (t < p.lift[0]) return { title: "One-shots.", text: `${pads.length} single hits. Drums play as recorded: no stretching, no retuning.` };
      if (t < p.land[0] - 0.5) return { title: "Pads.", text: `One pad per drum: ${pads.join(", ")}.` };
      return { title: "Steps.", text: "Step patterns play the pads, a different figure in every bar." };
    }
    if (t < p.point[0] - 1) return { title: "Listen.", text: `Apricity finds the beats (${src.bpm} BPM)${src.key ? `, the key (${prettyKey(src.key)})` : ""} and the tuning (${tuning(src.tuning_cents)}).` };
    if (t < p.lift[0]) return { title: "Clip.", text: kind === "clip" ? `Mark the part you want as a clip: ${src.chop_beats} beats. The selection snaps to the beat.` : "Mark the part you want as a clip. The selection snaps to the beat." };
    if (kind === "loop" && t < (n === 0 ? compose[0] : p.land[0] - 0.5)) {
      const every = src.chop_beats === 0.5 ? "half beat" : src.chop_beats === 1 ? "beat" : `${src.chop_beats} beats`;
      return { title: "Slice.", text: `The clip, sliced every ${every}: ${src.chops.length} slices on ${src.chops.length} pads, ready to play.` };
    }
    const warp = `warped from ${src.bpm} to ${d.tempo} BPM`;
    return kind === "clip"
      ? { title: moved ? "Warp and tune." : "Warp.", text: `The clip plays in the piece, ${warp}${tuned}.` }
      : { title: moved ? "Warp and tune." : "Warp.", text: `A step pattern plays the pads, ${warp}${tuned}.` };
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, t: number, th: Theme, still = false) {
    const d = this.data;
    const compact = w < 560;
    const L = layout(
      w,
      h,
      this.ph.map((p, n) => ({
        shown: n === 0 ? easeOut(seg(t, 0, 0.8)) : easeInOut(seg(t, p.appear[0] - 0.8, p.appear[0] + 0.6)),
        detail: this.plan.collapse[n] ? 1 - easeInOut(seg(t, ...this.plan.collapse[n]!)) : 1,
      })),
      this.pitchRange.map((p, n) => (d.sources[n].kind === "kit" ? KIT_LANE : p ? PITCHED_LANE : LANE)),
      compact,
    );
    g.save();
    g.globalAlpha = 1 - seg(t, ...this.plan.fade);

    // What's playing: tiles under the playhead light their whole lineage.
    const session = still ? undefined : this.plan.sessions.find((p) => t >= p.from && t < p.to);
    const playing = !!session;
    const beat = session ? (((t - session.from) * d.tempo) / 60) % d.beats : -1;
    const active = this.tiles
      .filter((x) => !!session?.sources.includes(x.source) && t >= x.landed && beat >= x.start && beat < x.start + x.dur)
      .map((x) => ({ x, glow: 1 - (0.6 * (beat - x.start)) / x.dur }));

    this.composition(g, L, t, th, beat, compact);
    d.sources.forEach((_, n) => this.source(g, L, n, t, th, active.filter((a) => a.x.source === n)));
    this.placed(g, L, t, th, active);
    if (playing) {
      const x = beatX(L, beat, d.beats);
      const bottom = L.lanes.at(-1)!.y + L.lanes.at(-1)!.h;
      g.save();
      g.globalAlpha *= Math.min(easeOut(seg(t, session!.from, session!.from + 0.6)), 1 - seg(t, session!.to - session!.fade, session!.to));
      g.fillStyle = th.sun;
      g.fillRect(x - 0.75, L.ruler.y + 2, 1.5, bottom - L.ruler.y - 2);
      g.beginPath();
      g.moveTo(x - 4, L.ruler.y);
      g.lineTo(x + 4, L.ruler.y);
      g.lineTo(x, L.ruler.y + 6);
      g.fill();
      g.restore();
    }
    if (!still) this.hand(g, L, t, th);
    g.restore();
  }

  /** A pad's label: its number, or a kit pad's name when there's room. */
  private padLabel(n: number, i: number, w: number) {
    const name = this.data.sources[n].pads?.[i];
    return name && w > 26 ? name : String(i + 1);
  }

  // ---- the composition: ruler, chords, lanes

  private composition(g: CanvasRenderingContext2D, L: Layout, t: number, th: Theme, beat: number, compact: boolean) {
    const d = this.data;
    const a = easeOut(seg(t, ...this.plan.compose));
    if (a <= 0) return;
    g.save();
    g.globalAlpha *= a;
    const X = (b: number) => beatX(L, b, d.beats);
    // Ruler: bar numbers, beat ticks.
    g.fillStyle = th.inkSoft;
    g.font = `9px ${th.mono}`;
    g.textBaseline = "top";
    for (let b = 0; b < d.beats; b++) {
      const x = X(b);
      const bar = b % d.meter === 0;
      g.globalAlpha = a * (bar ? 0.8 : 0.35);
      g.fillRect(x, L.ruler.y + (bar ? 0 : 8), 1, bar ? L.ruler.h : L.ruler.h - 8);
      if (bar) g.fillText(String(b / d.meter + 1), x + 3, L.ruler.y);
    }
    g.globalAlpha = a;
    // Chord strip.
    for (const c of d.chords) {
      const box = { x: X(c.start) + 0.5, y: L.chords.y, w: X(c.end) - X(c.start) - 1, h: L.chords.h - 2 };
      const on = beat >= c.start && beat < c.end;
      g.fillStyle = on ? th.sun : th.card;
      g.globalAlpha = a * (on ? 0.32 : 1);
      rect(g, box, 3);
      g.fill();
      g.globalAlpha = a;
      g.fillStyle = th.ink;
      g.font = `600 11px ${th.sans}`;
      g.textBaseline = "middle";
      g.fillText(c.numeral, box.x + 5, box.y + box.h / 2 + 0.5);
      if (!compact || box.w > 60) {
        const nw = g.measureText(c.numeral).width;
        g.fillStyle = th.inkSoft;
        g.font = `10px ${th.sans}`;
        g.fillText(c.name, box.x + 9 + nw, box.y + box.h / 2 + 0.5);
      }
    }
    // Lanes, each appearing just before its chops arrive; track names on the right, as in Live.
    L.lanes.forEach((lane, n) => {
      const la = seg(t, this.ph[n].land[0] - 1.4, this.ph[n].land[0] - 0.3);
      if (la <= 0) return;
      g.globalAlpha = a * la;
      g.fillStyle = th.card;
      rect(g, lane, 3);
      g.fill();
      g.fillStyle = th.line;
      for (let b = d.meter; b < d.beats; b += d.meter) g.fillRect(X(b), lane.y, 1, lane.h);
      const src = d.sources[n];
      header(g, L.right + 8, lane.y + lane.h / 2, this.shortName(n), `track ${src.lane}`, th.clips[n % th.clips.length], th, compact);
      // "120 → 88 BPM": the warp, said out loud while the first chops land.
      const ph = this.ph[n];
      const say = pulse(t, ph.land[0], ph.land[0] + 0.5, ph.land[1] + 1.5, ph.land[1] + 2.5);
      if (say > 0) {
        g.globalAlpha = a * say;
        g.fillStyle = th.ink;
        g.font = `600 10px ${th.mono}`;
        g.textBaseline = "bottom";
        const text = src.kind === "kit" ? "played as recorded: no stretch, no retune" : `${src.bpm} → ${d.tempo} BPM · retuned ${signed(-src.tuning_cents)}¢`;
        g.fillText(text, L.right - g.measureText(text).width, L.ruler.y - 3);
      }
    });
    g.restore();
  }

  /** "The Thunderer — drums" → "Drums". */
  private shortName(n: number) {
    return shortName(this.data.sources[n].title);
  }

  // ---- one source: title bar, waveform + analysis + slice, chop row

  private chopBox(L: Layout, n: number, i: number, cut = 1): Box {
    const box = L.sources[n].chops;
    const count = this.data.sources[n].chops.length;
    const gap = 3 * cut;
    const w = box.w / count;
    return { x: box.x + i * w + gap / 2, y: box.y, w: w - gap, h: box.h };
  }

  private source(g: CanvasRenderingContext2D, L: Layout, n: number, t: number, th: Theme, active: { x: Timed; glow: number }[]) {
    const src = this.data.sources[n];
    const rows = L.sources[n];
    if (rows.shown <= 0.01) return;
    const ph = this.ph[n];
    const color = th.clips[n % th.clips.length];
    const peaks = this.peaks[n];
    const win = src.window;
    const { title, wave: wbox, chops } = rows;
    const detail = rows.detail;
    g.save();
    g.globalAlpha *= rows.shown;

    // Title bar, sliding in.
    const tw = title.w * easeOut(seg(t, ph.appear[0], ph.appear[0] + 1));
    g.fillStyle = color;
    rect(g, { ...title, w: tw }, 3);
    g.fill();
    if (tw > 40) {
      g.save();
      g.beginPath();
      g.rect(title.x, title.y, tw, title.h);
      g.clip();
      g.fillStyle = th.clipInk;
      g.textBaseline = "middle";
      // The analysis readout, typed in as the sweep finishes, at the right end.
      const narrow = compact(L);
      const parts = src.kind === "kit" ? [`${src.chops.length} one-shots`, "as recorded"] : [`${src.bpm} BPM`, ...(narrow ? [] : [`${src.meter}/4`]), ...(src.key ? [src.key] : []), `${signed(src.tuning_cents)}¢`];
      const text = parts.join(narrow ? " · " : "  ·  ");
      const typed = text.slice(0, Math.round(text.length * seg(t, ph.listen[1] - 1.4, ph.listen[1])));
      g.font = `10px ${th.mono}`;
      const rw = g.measureText(text).width;
      g.fillText(typed, title.x + title.w - rw - 6, title.y + title.h / 2 + 0.5);
      // The name, cut short before the readout.
      g.beginPath();
      g.rect(title.x, title.y, Math.min(tw, title.w - rw - 16), title.h);
      g.clip();
      g.font = `600 ${title.h > 13 ? 10.5 : 9}px ${th.sans}`;
      g.fillText(narrow ? this.shortName(n) : src.title, title.x + 6, title.y + title.h / 2 + 0.5);
      g.restore();
    }
    // Row headers on the right: the clip, then its kit.
    const hx = L.right + 8;
    const appear = seg(t, ph.appear[0] + 0.5, ph.appear[0] + 1.5);
    if (appear > 0) {
      g.save();
      g.globalAlpha *= appear;
      if (wbox.h > 20) header(g, hx, wbox.y + wbox.h / 2, this.shortName(n), `clip ${src.id}`, color, th, compact(L));
      else header(g, hx, title.y + title.h / 2, "", `clip ${src.id}`, null, th, true);
      g.restore();
    }
    const kit = seg(t, ...ph.code);
    if (kit > 0 && chops.h > 1) {
      g.save();
      g.globalAlpha *= kit;
      if (chops.h > 20) header(g, hx, chops.y + chops.h / 2, `${src.chops.length} ${src.kind === "kit" ? "pads" : "chops"}`, `kit ${src.lane}`, null, th, compact(L));
      else header(g, hx, chops.y + chops.h / 2, "", `kit ${src.lane}`, null, th, true);
      g.restore();
    }
    // In summary, the slice shows as a mark on the title bar.
    if (detail < 1) {
      g.save();
      g.globalAlpha *= (1 - detail) * 0.45;
      g.fillStyle = th.clipInk;
      g.fillRect(secX(title, win, src.slice.from), title.y + title.h - 3, secX(title, win, src.slice.to) - secX(title, win, src.slice.from), 3);
      g.restore();
    }

    const sx0 = secX(wbox, win, src.slice.from);
    const sx1 = secX(wbox, win, src.slice.to);
    if (wbox.h > 2) {
      g.fillStyle = th.card;
      rect(g, wbox, 3);
      g.fill();
      // The recording, drawn in as it arrives.
      g.fillStyle = color;
      g.save();
      g.globalAlpha *= 0.9;
      wave(g, peaks, win, win[0], win[1], { x: wbox.x, y: wbox.y + 5, w: wbox.w, h: wbox.h - 12 }, easeInOut(seg(t, ph.appear[0] + 0.4, ph.appear[1])));
      g.restore();

      // Listening: a sweep crosses the clip; beats and transients appear behind it.
      const lp = seg(t, ...ph.listen); // steady, in step with the recording as it's heard
      const sweep = lerp(wbox.x, wbox.x + wbox.w, lp);
      if (wbox.h > 18) {
        g.fillStyle = th.ink;
        for (const b of src.beats) {
          const x = secX(wbox, win, b);
          if (x > sweep) continue;
          const down = src.downbeats.some((db) => Math.abs(db - b) < 0.02);
          g.globalAlpha = rows.shown * (down ? 0.75 : 0.4);
          g.fillRect(x, wbox.y + wbox.h - (down ? 7 : 4), 1, down ? 7 : 4);
        }
        g.globalAlpha = rows.shown * 0.55;
        for (const s of src.transients) {
          const x = secX(wbox, win, s);
          if (x > sweep) continue;
          g.beginPath();
          g.moveTo(x - 2.5, wbox.y);
          g.lineTo(x + 2.5, wbox.y);
          g.lineTo(x, wbox.y + 4);
          g.fill();
        }
        g.globalAlpha = rows.shown;
      }
      if (lp > 0 && lp < 1) {
        const grad = g.createLinearGradient(sweep - 60, 0, sweep, 0);
        grad.addColorStop(0, "transparent");
        grad.addColorStop(1, th.sun2);
        g.save();
        g.globalAlpha *= 0.35;
        g.fillStyle = grad;
        g.fillRect(Math.max(wbox.x, sweep - 60), wbox.y, Math.min(60, sweep - wbox.x), wbox.h);
        g.globalAlpha /= 0.35;
        g.fillStyle = th.sun;
        g.fillRect(sweep - 0.75, wbox.y, 1.5, wbox.h);
        g.restore();
      }

      // Automatic markup suggests the loop (dashed); you take it by slicing (solid, named).
      const sug = src.kind === "kit" ? 0 : pulse(t, ph.suggest[0], ph.suggest[1], ph.name[1], ph.name[1] + 0.5);
      if (sug > 0 && wbox.h > 18) {
        g.save();
        g.globalAlpha *= sug * 0.8;
        g.strokeStyle = th.ink;
        g.setLineDash([3, 3]);
        g.strokeRect(sx0 + 0.5, wbox.y + 0.5, sx1 - sx0 - 1, wbox.h - 1);
        g.setLineDash([]);
        g.fillStyle = th.inkSoft;
        g.font = `9px ${th.mono}`;
        g.textBaseline = "top";
        g.fillText(`${src.slice.machine} (suggested)`, sx0 + 4, wbox.y + wbox.h - 13);
        g.restore();
      }
      const sel = this.selection(n, t, wbox);
      if (sel) {
        const heard = pulse(t, ph.point[1], ph.point[1] + 0.05, ph.point[1] + src.slice.to - src.slice.from, ph.point[1] + src.slice.to - src.slice.from + 0.4);
        g.save();
        g.globalAlpha *= 0.26 + 0.3 * heard;
        g.fillStyle = heard > 0 ? th.sun2 : color;
        g.fillRect(sel[0], wbox.y, sel[1] - sel[0], wbox.h);
        g.restore();
        g.fillStyle = color;
        g.fillRect(sel[0], wbox.y, 1.5, wbox.h);
        g.fillRect(sel[1] - 1.5, wbox.y, 1.5, wbox.h);
        const nm = easeOut(seg(t, ...ph.name));
        if (nm > 0 && wbox.h > 18) {
          g.save();
          g.globalAlpha *= nm;
          tag(g, sel[0] + 3, wbox.y + 3 - (1 - nm) * 4, src.slice.name, color, th.clipInk, th);
          g.restore();
        }
      }
    }

    // The slice lifts out of the recording and opens into the chop row, then is cut.
    const lift = easeInOut(seg(t, ...ph.lift));
    if (lift > 0 && chops.h > 1) {
      const top = wbox.y + wbox.h;
      const x0 = lerp(sx0, chops.x, lift);
      const x1 = lerp(sx1, chops.x + chops.w, lift);
      const y = lerp(top - 2, chops.y, lift);
      ribbon(g, { x0: sx0, x1: sx1, y: top }, { x0, x1, y }, color, (0.28 + 0.2 * (1 - lift)) * (0.4 + 0.6 * detail));
      const cut = seg(t, ...ph.cut);
      const count = src.chops.length;
      if (cut <= 0) {
        tile(g, { x: x0, y, w: x1 - x0, h: chops.h }, color, th, { peaks, win, from: src.slice.from, to: src.slice.to });
      } else {
        const glowOf = (i: number) => Math.max(this.soundGlow(n, i, t), ...active.filter((a) => a.x.chop === i).map((a) => a.glow));
        for (let i = 0; i < count; i++) {
          // Each boundary opens in turn, left to right.
          const open = (k: number) => (k <= 0 || k >= count ? 1 : easeOut(seg(cut, ((k - 1) / (count - 1)) * 0.8, ((k - 1) / (count - 1)) * 0.8 + 0.2)));
          const w1 = chops.w / count;
          const bx0 = chops.x + i * w1 + (1.5 * open(i));
          const bx1 = chops.x + (i + 1) * w1 - (1.5 * open(i + 1));
          const labelled = open(i) > 0.5 && open(i + 1) > 0.5 && chops.h > 14;
          tile(g, { x: bx0, y: chops.y, w: bx1 - bx0, h: chops.h }, color, th, {
            peaks,
            win,
            from: src.chops[i][0],
            to: src.chops[i][1],
            label: labelled ? this.padLabel(n, i, bx1 - bx0) : undefined,
            glow: glowOf(i),
          });
        }
      }
      // Lineage: the playing chop's span on the recording, lit, with a curve down to its chop.
      // A folded source shows it too, on its summary strip.
      const span = wbox.h > 2 ? wbox : title;
      for (const { x, glow } of active) {
        const [a, b] = src.chops[x.chop];
        const x0 = secX(span, win, a);
        const x1 = secX(span, win, b);
        g.save();
        g.globalAlpha *= (span === wbox ? 0.45 : 0.85) * glow;
        g.fillStyle = th.sun2;
        rect(g, { x: x0, y: span.y, w: x1 - x0, h: span.h }, 2);
        g.fill();
        g.restore();
        const to = this.chopBox(L, n, x.chop);
        ribbon(g, { x0, x1, y: span.y + span.h }, { x0: to.x, x1: to.x + to.w, y: to.y }, th.sun2, 0.5 * glow, 0.8);
      }
      // The line of score that did it.
      const code = seg(t, ...ph.code) * detail;
      if (code > 0 && !(L.right - L.left < 420)) {
        g.save();
        g.globalAlpha *= code;
        g.fillStyle = th.inkSoft;
        g.font = `10px ${th.mono}`;
        g.textBaseline = "bottom";
        const text = src.kind === "kit" ? `kit ${src.lane}: ${src.pads?.join(", ")}` : `kit ${src.lane} = slice ${src.id} by beats ${src.chop_beats}`;
        g.fillText(text, chops.x + chops.w - g.measureText(text).width, chops.y - 3);
        g.restore();
      }
    }
    g.restore();
  }

  /** The hand-made selection on source n at time t, in x: [start, end] snapped to beats. */
  private selection(n: number, t: number, wbox: Box): [number, number] | null {
    const src = this.data.sources[n];
    const ph = this.ph[n];
    if (t < ph.point[0]) return null;
    const x0 = secX(wbox, src.window, src.slice.from);
    const x1 = secX(wbox, src.window, src.slice.to);
    if (src.kind === "kit") return [x0, x1];
    const hand = lerp(x0, x1, easeInOut(seg(t, ...ph.point)));
    // Snap to the last beat the pointer has passed.
    const beats = src.beats.map((b) => secX(wbox, src.window, b)).filter((x) => x > x0 + 1 && x <= hand + 0.5);
    const end = seg(t, ...ph.point) >= 1 ? x1 : Math.max(x0 + 2, beats.at(-1) ?? x0 + 2);
    return [x0, end];
  }

  // ---- chops placed in the composition

  private slot(L: Layout, x: Timed, nudge: number): Box {
    const lane = L.lanes[x.source];
    const x0 = beatX(L, x.start, this.data.beats);
    const x1 = beatX(L, x.start + x.dur, this.data.beats);
    const w = Math.max(1.5, x1 - x0 - 0.8);
    const pads = this.data.sources[x.source].kind === "kit" ? this.data.sources[x.source].chops.length : 0;
    if (pads) {
      const row = (lane.h - 4) / pads;
      return { x: x0, y: lane.y + 2 + x.chop * row, w, h: Math.max(1.5, row - 0.8) };
    }
    const range = this.pitchRange[x.source];
    if (!range) return { x: x0, y: lane.y + 4, w, h: lane.h - 8 };
    // A pitched lane: a label row on top, then tiles that sit higher or lower with their transposition.
    const k = Math.min(1.3, 5 / range);
    return { x: x0, y: lane.y + 13 - x.semitones * k * nudge, w, h: 14 };
  }

  private placed(g: CanvasRenderingContext2D, L: Layout, t: number, th: Theme, active: { x: Timed; glow: number }[]) {
    const d = this.data;
    for (const x of this.tiles) {
      if (t < x.t0) continue;
      const color = th.clips[x.source % th.clips.length];
      const src = d.sources[x.source];
      const nudge = easeOut(seg(t, x.landed, x.landed + 0.5));
      const to = this.slot(L, x, nudge);
      const on = active.find((a) => a.x === x);
      const glow = Math.max(on?.glow ?? 0, x.fly ? this.landGlow(x, t) : 0);
      const opts = { peaks: this.peaks[x.source], win: src.window, from: src.chops[x.chop][0], to: src.chops[x.chop][1], glow };
      const from = this.chopBox(L, x.source, x.chop);
      if (x.fly && t < x.landed) {
        const u = easeInOut(seg(t, x.t0, x.landed));
        const b = { x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u), w: lerp(from.w, to.w, u), h: lerp(from.h, to.h, u) };
        ribbon(g, { x0: from.x, x1: from.x + from.w, y: from.y + from.h }, { x0: b.x, x1: b.x + b.w, y: b.y }, color, 0.3 * (1 - u * 0.5));
        tile(g, b, color, th, { ...opts, label: b.w > 14 ? this.padLabel(x.source, x.chop, b.w) : undefined });
        continue;
      }
      const a = x.fly ? 1 : seg(t, x.t0, x.landed);
      g.save();
      g.globalAlpha *= a;
      if (on) ribbon(g, { x0: from.x, x1: from.x + from.w, y: from.y + from.h }, { x0: to.x, x1: to.x + to.w, y: to.y }, color, 0.42 * on.glow, 0.7);
      tile(g, { ...to, y: to.y - (1 - a) * 4 }, color, th, opts);
      g.restore();
    }
    // Transpositions, labelled where they change: the tune step.
    d.sources.forEach((_, n) => {
      let last: number | null = null;
      for (const x of this.tiles.filter((y) => y.source === n).sort((p, q) => p.start - q.start)) {
        if (x.semitones !== last && x.semitones !== 0 && t >= x.landed) {
          const box = this.slot(L, x, 1);
          g.save();
          g.globalAlpha *= easeOut(seg(t, x.landed, x.landed + 0.5));
          g.fillStyle = th.ink;
          g.font = `600 9px ${th.mono}`;
          g.textBaseline = "top";
          g.fillText(`${signed(x.semitones)} st`, box.x + 1, L.lanes[n].y + 1.5);
          g.restore();
        }
        last = x.semitones;
      }
    });
  }

  // ---- sound: what to hear when, and the glow that goes with it

  private secs = (beats: number) => (beats * 60) / this.data.tempo;

  /** When chop i of source n is heard as it's cut: as the boundary to its right opens. */
  private cutTime(n: number, i: number) {
    const [a, b] = this.ph[n].cut;
    const count = this.data.sources[n].chops.length;
    const step = (0.8 * (b - a)) / Math.max(1, count - 1);
    return a + Math.min(i, count - 2) * step + (i === count - 1 ? step : 0);
  }

  private landGlow(x: Timed, t: number) {
    const d = this.secs(x.dur);
    return pulse(t, x.landed, x.landed + 0.04, x.landed + d, x.landed + d + 0.35);
  }

  /** A chop row tile lights while it's heard: being cut, or landing in the composition. */
  private soundGlow(n: number, i: number, t: number) {
    const [a, b] = this.data.sources[n].chops[i];
    const ct = this.cutTime(n, i);
    let glow = pulse(t, ct, ct + 0.04, ct + b - a, ct + b - a + 0.35);
    for (const x of this.tiles) if (x.fly && x.source === n && x.chop === i) glow = Math.max(glow, this.landGlow(x, t));
    return glow;
  }

  /** The metronome: clicks on the score's beat, lined up with the horns' first playback, from the
   *  start of the story until the drums are first heard (then they keep time). */
  metronome(): Metronome {
    const kit = this.data.sources.findIndex((s) => s.kind === "kit");
    const until = kit < 0 ? this.plan.sessions.at(-1)!.from : this.ph[kit].listen[0];
    return { anchor: this.plan.sessions[0].from, until, spb: 60 / this.data.tempo, meter: this.data.meter };
  }

  /** Everything to hear, in story time. */
  cues(): Cue[] {
    const d = this.data;
    const out: Cue[] = [];
    d.sources.forEach((src, n) => {
      const ph = this.ph[n];
      const w0 = src.window[0];
      // Listening: the recording, in step with the sweep.
      out.push({ t: ph.listen[0], kind: "source", index: n, offset: 0, dur: src.window[1] - w0 });
      // The slice, heard once the selection is made.
      out.push({ t: ph.point[1], kind: "source", index: n, offset: src.slice.from - w0, dur: src.slice.to - src.slice.from });
      // Each chop, as it's cut.
      src.chops.forEach(([a, b], i) => out.push({ t: this.cutTime(n, i), kind: "source", index: n, offset: a - w0, dur: b - a }));
    });
    // Each chop landing in the composition: warped and tuned, from the track's render.
    for (const x of this.tiles) if (x.fly) out.push({ t: x.landed, kind: "track", index: x.source, offset: this.secs(x.start), dur: this.secs(x.dur) });
    // The playhead: the first source alone, then the whole piece.
    for (const p of this.plan.sessions) for (const n of p.sources) out.push({ t: p.from, kind: "track", index: n, offset: 0, dur: p.to - p.from, fadeOut: p.fade, loop: true });
    return out.sort((p, q) => p.t - q.t);
  }

  // ---- the pointer: the one part a person does

  private hand(g: CanvasRenderingContext2D, L: Layout, t: number, th: Theme) {
    this.data.sources.forEach((src, n) => {
      const ph = this.ph[n];
      const wbox = L.sources[n].wave;
      if (src.kind === "kit" || t < ph.point[0] - 1 || t > ph.name[1] + 0.8 || wbox.h < 18) return;
      const x0 = secX(wbox, src.window, src.slice.from);
      const x1 = secX(wbox, src.window, src.slice.to);
      const y = wbox.y + wbox.h * 0.55;
      let x: number;
      let yy = y;
      if (t < ph.point[0]) {
        const u = easeOut(seg(t, ph.point[0] - 1, ph.point[0]));
        x = lerp(wbox.x + wbox.w + 10, x0, u);
        yy = lerp(y + 40, y, u);
      } else x = lerp(x0, x1, easeInOut(seg(t, ...ph.point)));
      g.save();
      g.globalAlpha *= pulse(t, ph.point[0] - 1, ph.point[0] - 0.6, ph.name[1], ph.name[1] + 0.8);
      pointer(g, x, yy, th);
      g.restore();
    });
  }
}

const compact = (L: Layout) => L.right - L.left < 480;
