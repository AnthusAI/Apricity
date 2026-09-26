// The Score tab's Flow view: the samples a score uses, the sounds cut from them (a kit's slices
// and pads, or a clip played whole), and where each lands in the composition, with the lineage
// drawn. Hover anything to trace it (a note back to its sample, or a pad out to everywhere it
// plays); click to pin; while playing, whatever sounds is traced as it plays.

import { reportError } from "../notices";
import type { Timeline } from "../../apricity";
import { player } from "../../audio/player";
import { el } from "../dom";
import type { Box } from "./layout";
import { type Lineage, lineage } from "./lineage";
import { type Theme, header, readTheme, rect, ribbon, tile, wave } from "./paint";
import { type Peaks, peaksOf } from "./peaks";

/** Clip colors, Live-style: one per sample, so every pad and note shows where it came from. */
export const PALETTE = ["#f5a36b", "#cf86c1", "#7fc4d8", "#a6cf6f", "#e8c15a", "#8fa3f0", "#e57f8f", "#6fcfb0"];

type Target = { kind: "event" | "piece" | "row" | "lane" | "recording"; i: number };

interface RecGeo {
  title: Box;
  wave: Box;
  islands: { from: number; to: number; x0: number; x1: number }[];
}

interface Geo {
  left: number;
  right: number;
  recs: RecGeo[];
  rows: Box[];
  tiles: Box[]; // per piece
  ruler: Box;
  chords: Box;
  lanes: Box[];
  events: Box[]; // per timeline event
}

const GUTTER = 118; // track headers on the right, as in Live
const BREAK = 14; // the gap drawn between islands of a recording

const time = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

export class FlowView {
  root = el("section", { className: "flow" });
  private host = el("div", { className: "flow-host" });
  private canvas = el("canvas");
  private info = el("div", { className: "flow-info" });
  private tl: Timeline | null = null;
  private lin: Lineage | null = null;
  private peaks = new Map<string, Peaks>();
  private geo: Geo | null = null;
  private hover: Target | null = null;
  private pinned: Target | null = null;
  private beat = -1;
  private queued = 0;
  private waves: number[] = []; // each recording's waveform height now (eased toward its target)

  constructor() {
    this.host.append(this.canvas);
    this.root.append(this.host, this.info);
    this.root.tabIndex = 0;
    this.canvas.addEventListener("pointermove", (e) => this.pointer(e));
    this.canvas.addEventListener("pointerleave", () => this.setHover(null));
    this.canvas.addEventListener("click", (e) => this.click(e));
    this.root.addEventListener("keydown", (e) => e.key === "Escape" && ((this.pinned = null), this.redraw()));
    new ResizeObserver(() => this.redraw()).observe(this.host);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.redraw());
    player.onTransport((t) => {
      const beat = t.playing && this.tl ? (t.position / t.framesPerBeat) % this.tl.length_beats : -1;
      if (beat !== this.beat) {
        this.beat = beat;
        this.redraw();
      }
    });
    this.say();
  }

  /** Show a newly compiled score. */
  update(tl: Timeline) {
    this.tl = tl;
    this.lin = lineage(tl);
    if (this.pinned && !this.valid(this.pinned)) this.pinned = null;
    this.hover = null;
    for (const r of this.lin.recordings) {
      if (!this.peaks.has(r.path))
        peaksOf(r.path)
          .then((p) => {
            this.peaks.set(r.path, p);
            this.redraw();
          })
          .catch((e) => reportError("draw a waveform", e));
    }
    this.say();
    this.redraw();
  }

  private valid(t: Target) {
    const l = this.lin!;
    const n = { event: this.tl!.events.length, piece: l.pieces.length, row: l.rows.length, lane: l.lanes.length, recording: l.recordings.length }[t.kind];
    return t.i < n;
  }

  redraw() {
    if (this.queued) return;
    this.queued = requestAnimationFrame(() => {
      this.queued = 0;
      if (this.root.offsetParent !== null) this.draw();
    });
  }

  // ---- geometry

  private layout(w: number, h: number): { geo: Geo; height: number } {
    const tl = this.tl!;
    const l = this.lin!;
    const left = 10;
    const right = w - GUTTER;
    const R = l.recordings.length, K = l.rows.length, L = l.lanes.length;
    // Room is shared out: the recordings get a reserved block (at least one open waveform), and
    // the pieces and lanes fit the rest. Opening a recording only moves room inside its block, so
    // nothing below shifts under the pointer.
    const gap = h < 460 ? 12 : 20;
    const pool = R ? Math.min(R * 44, Math.max(56, h * 0.22)) : 0;
    const rest = h - (8 + R * 19 + pool + 2 * gap + 36 + 6 + K * 4 + L * 3);
    const rowH = Math.min(32, Math.max(16, (rest * 0.45) / Math.max(1, K)));
    const laneH = Math.min(24, Math.max(12, (rest - K * rowH) / Math.max(1, L)));
    const even = pool / R < 14 ? 0 : pool / R;
    const wanted = this.openRecordings();
    const target = l.recordings.map(() => even);
    if (wanted.size && wanted.size < R) {
      const each = Math.min(56, pool / wanted.size);
      const rest = (pool - each * wanted.size) / (R - wanted.size);
      const other = rest < 14 ? 0 : rest;
      l.recordings.forEach((_, r) => (target[r] = wanted.has(r) ? each : other));
    }
    if (this.waves.length !== R) this.waves = target.slice();
    let moving = false;
    this.waves = this.waves.map((cur, r) => {
      const next = cur + (target[r] - cur) * 0.3;
      if (Math.abs(next - target[r]) > 0.5) moving = true;
      return Math.abs(next - target[r]) > 0.5 ? next : target[r];
    });
    if (moving) this.redraw();
    let y = 8;
    const recs: RecGeo[] = l.recordings.map((r, ri) => {
      const title = { x: left, y, w: right - left, h: 13 };
      const wbox = { x: left, y: y + 13, w: right - left, h: this.waves[ri] };
      y += 13 + this.waves[ri] + 6;
      // Islands share the width by length, each at least a little.
      const total = r.islands.reduce((a, i) => a + i.to - i.from, 0);
      const avail = right - left - BREAK * (r.islands.length - 1);
      const weights = r.islands.map((i) => Math.max(i.to - i.from, total * 0.08));
      const sum = weights.reduce((a, b) => a + b, 0);
      let x = left;
      const islands = r.islands.map((i, n) => {
        const x0 = x;
        x += (avail * weights[n]) / sum;
        const x1 = x;
        x += BREAK;
        return { ...i, x0, x1 };
      });
      return { title, wave: wbox, islands };
    });
    y = 8 + R * 19 + pool + gap - 6;
    const tiles: Box[] = [];
    const rows = l.rows.map((row) => {
      const box = { x: left, y, w: right - left, h: rowH };
      const n = row.pieces.length;
      const tw = Math.min(120, (box.w - 3 * (n - 1)) / n);
      row.pieces.forEach((p, i) => (tiles[p] = { x: left + i * (tw + 3), y, w: tw, h: rowH }));
      y += rowH + 4;
      return box;
    });
    y += gap - 4;
    const ruler = { x: left, y, w: right - left, h: 14 };
    const chords = { x: left, y: y + 14, w: right - left, h: 18 };
    y += 36;
    const beatX = (b: number) => left + ((right - left) * b) / tl.length_beats;
    const lanes = l.lanes.map(() => {
      const box = { x: left, y, w: right - left, h: laneH };
      y += laneH + 3;
      return box;
    });
    const laneOf = new Map(l.lanes.map((ln, i) => [ln.track, i]));
    const events = tl.events.map((e) => {
      const lane = lanes[laneOf.get(e.track) ?? 0];
      const x0 = beatX(e.start_beat);
      return { x: x0, y: lane.y + 2, w: Math.max(1.5, beatX(e.start_beat + e.dur_beats) - x0 - 0.6), h: lane.h - 4 };
    });
    return { geo: { left, right, recs, rows, tiles, ruler, chords, lanes, events }, height: y + 6 };
  }

  /** Recordings to open: those behind what's pinned, or hovered below them (not a recording itself). */
  private openRecordings() {
    const l = this.lin!;
    const t = this.pinned ?? (this.hover?.kind === "recording" ? null : this.hover);
    const out = new Set<number>();
    if (!t) return out;
    const f = this.focusOf(t);
    f.pieces.forEach((p) => out.add(l.pieces[p].recording));
    return out;
  }

  /** Seconds in a recording → x on its row (null if it's between islands). */
  private recX(r: number, s: number) {
    for (const i of this.geo!.recs[r].islands) if (s >= i.from - 1e-6 && s <= i.to + 1e-6) return i.x0 + ((s - i.from) / (i.to - i.from)) * (i.x1 - i.x0);
    return null;
  }

  private span(p: number) {
    const pc = this.lin!.pieces[p];
    const a = this.recX(pc.recording, pc.from);
    const b = this.recX(pc.recording, pc.to);
    return a === null || b === null ? null : { x0: a, x1: Math.max(a + 1.5, b) };
  }

  // ---- focus: what's traced

  private focus() {
    const t = this.pinned ?? this.hover;
    return t ? this.focusOf(t) : null;
  }

  private focusOf(t: Target) {
    const l = this.lin!;
    const pieces = new Set<number>();
    const events = new Set<number>();
    let strong = -1;
    const addPiece = (p: number) => {
      pieces.add(p);
      l.pieces[p].events.forEach((e) => events.add(e));
    };
    if (t.kind === "event") {
      strong = t.i;
      addPiece(l.eventPiece[t.i]);
    } else if (t.kind === "piece") addPiece(t.i);
    else if (t.kind === "row") l.rows[t.i].pieces.forEach(addPiece);
    else if (t.kind === "lane")
      l.lanes[t.i].events.forEach((e) => {
        events.add(e);
        pieces.add(l.eventPiece[e]);
      });
    else l.pieces.forEach((pc, p) => pc.recording === t.i && addPiece(p));
    return { pieces, events, strong };
  }

  // ---- drawing

  private draw() {
    const tl = this.tl;
    const c = this.canvas;
    const w = this.host.clientWidth;
    if (!tl || !this.lin || !w) return;
    const { geo, height } = this.layout(w, this.host.clientHeight);
    this.geo = geo;
    const h = Math.max(this.host.clientHeight, height);
    const dpr = Math.min(2, devicePixelRatio || 1);
    c.style.height = `${h}px`;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) (c.width = Math.round(w * dpr)), (c.height = Math.round(h * dpr));
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const th = readTheme(this.root);
    const l = this.lin;
    const color = (rec: number) => PALETTE[rec % PALETTE.length];
    const f = this.focus();
    const playing = this.beat >= 0;
    const active = playing ? tl.events.map((e, i) => (this.beat >= e.start_beat && this.beat < e.start_beat + e.dur_beats ? i : -1)).filter((i) => i >= 0) : [];
    const glowOf = (i: number) => (active.includes(i) ? 1 - (0.6 * (this.beat - tl.events[i].start_beat)) / tl.events[i].dur_beats : 0);
    const activePieces = new Set(active.map((i) => l.eventPiece[i]));
    const dim = (inFocus: boolean) => (f && !inFocus ? 0.3 : 1);

    // Recordings: the used stretches, with every piece marked.
    l.recordings.forEach((rec, r) => {
      const { title, wave: wbox, islands } = geo.recs[r];
      const pk = this.peaks.get(rec.path);
      const lit = f ? [...f.pieces].some((p) => l.pieces[p].recording === r) : true;
      g.save();
      g.globalAlpha = dim(lit);
      for (const is of islands) {
        g.fillStyle = color(r);
        rect(g, { x: is.x0, y: title.y, w: is.x1 - is.x0, h: title.h }, 2);
        g.fill();
        g.fillStyle = th.card;
        g.fillRect(is.x0, wbox.y, is.x1 - is.x0, wbox.h);
        const box = { x: is.x0, y: wbox.y + 2, w: is.x1 - is.x0, h: wbox.h - 4 };
        if (pk) {
          g.fillStyle = color(r);
          wave(g, pk.peaks, pk.win, is.from, is.to, box);
        }
        g.save();
        g.beginPath();
        g.rect(is.x0, title.y, is.x1 - is.x0 - 2, title.h);
        g.clip();
        g.fillStyle = th.clipInk;
        g.textBaseline = "middle";
        let tx = is.x0 + 4;
        if (is === islands[0]) {
          g.font = `600 10px ${th.sans}`;
          g.fillText(rec.title, tx, title.y + title.h / 2 + 0.5);
          tx += g.measureText(rec.title).width + 8;
        }
        g.font = `9px ${th.mono}`;
        g.fillText(time(is.from), tx, title.y + title.h / 2 + 0.5);
        g.restore();
      }
      // Breaks between islands: time left out.
      g.strokeStyle = th.inkSoft;
      g.lineWidth = 1;
      for (const is of islands.slice(1)) {
        const x = is.x0 - BREAK / 2;
        const y = wbox.y + wbox.h / 2;
        g.beginPath();
        g.moveTo(x - 4, y + 5);
        g.lineTo(x - 1, y - 5);
        g.moveTo(x + 1, y + 5);
        g.lineTo(x + 4, y - 5);
        g.stroke();
      }
      // Clip regions (the slices the score cut), as brackets under the waveform.
      g.fillStyle = color(r);
      for (const reg of rec.regions) {
        const a = this.recX(r, Math.max(reg.from, islands[0]?.from ?? 0));
        const b = this.recX(r, Math.min(reg.to, islands.at(-1)?.to ?? 0));
        if (a !== null && b !== null && b - a > 2) g.fillRect(a, wbox.y + wbox.h - 2, b - a, 2);
      }
      // Piece boundaries.
      g.fillStyle = th.ink;
      g.globalAlpha = dim(lit) * 0.25;
      for (const [p, pc] of l.pieces.entries()) {
        if (pc.recording !== r) continue;
        const s = this.span(p);
        if (s) g.fillRect(s.x0, wbox.y, 1, wbox.h);
      }
      g.globalAlpha = dim(lit);
      const mid = wbox.h > 16 ? wbox.y + wbox.h / 2 - 2 : title.y + (title.h + wbox.h) / 2;
      header(g, geo.right + 8, mid, wbox.h > 16 ? rec.title.split("/").at(-1)! : "", `clip ${rec.clips.join(" · ")}`, color(r), th, wbox.h <= 16, 95);
      g.restore();
    });

    // Rows of pieces: kits (chops, pads) and clips played whole.
    l.rows.forEach((row, ri) => {
      const box = geo.rows[ri];
      const lit = f ? row.pieces.some((p) => f.pieces.has(p)) : true;
      g.save();
      g.globalAlpha = dim(lit);
      header(g, geo.right + 8, box.y + box.h / 2, row.label, row.label.startsWith("clip") ? "played whole" : `${row.pieces.length} ${l.pieces[row.pieces[0]]?.label.match(/^\d+$/) ? "slice" : "pad"}${row.pieces.length === 1 ? "" : "s"}`, null, th);
      g.restore();
      for (const p of row.pieces) {
        const pc = l.pieces[p];
        const pk = this.peaks.get(l.recordings[pc.recording].path);
        g.save();
        g.globalAlpha = dim(!f || f.pieces.has(p));
        tile(g, geo.tiles[p], color(pc.recording), th, { peaks: pk?.peaks, win: pk?.win, from: pc.from, to: pc.to, label: pc.label, glow: activePieces.has(p) ? 0.8 : f?.pieces.has(p) && f.strong < 0 ? 0.5 : 0 });
        g.restore();
      }
    });

    // The composition: ruler, chords, lanes.
    const X = (b: number) => geo.left + ((geo.right - geo.left) * b) / tl.length_beats;
    g.fillStyle = th.inkSoft;
    g.font = `9px ${th.mono}`;
    g.textBaseline = "top";
    for (let b = 0; b < tl.length_beats; b += tl.meter) {
      g.globalAlpha = 0.8;
      g.fillRect(X(b), geo.ruler.y, 1, geo.ruler.h);
      if (X(b + tl.meter) - X(b) > 14 || (b / tl.meter) % 4 === 0) g.fillText(String(b / tl.meter + 1), X(b) + 3, geo.ruler.y + 1);
    }
    g.globalAlpha = 1;
    for (const hs of tl.harmony) {
      const box = { x: X(hs.start_beat) + 0.5, y: geo.chords.y, w: X(hs.end_beat) - X(hs.start_beat) - 1, h: geo.chords.h - 2 };
      const on = this.beat >= hs.start_beat && this.beat < hs.end_beat;
      g.fillStyle = on ? th.sun : th.card;
      g.globalAlpha = on ? 0.35 : 1;
      rect(g, box, 3);
      g.fill();
      g.globalAlpha = 1;
      const [numeral] = /^(\S+)/.exec(hs.label) ?? [""];
      if (box.w > 16) {
        g.fillStyle = th.ink;
        g.font = `600 10.5px ${th.sans}`;
        g.textBaseline = "middle";
        g.fillText(numeral, box.x + 4, box.y + box.h / 2 + 0.5);
      }
    }
    l.lanes.forEach((ln, li) => {
      const box = geo.lanes[li];
      g.fillStyle = th.card;
      rect(g, box, 3);
      g.fill();
      g.fillStyle = th.line;
      for (let b = tl.meter; b < tl.length_beats; b += tl.meter) g.fillRect(X(b), box.y, 1, box.h);
      const lit = f ? ln.events.some((e) => f.events.has(e)) : true;
      g.save();
      g.globalAlpha = dim(lit);
      header(g, geo.right + 8, box.y + box.h / 2, ln.track, box.h >= 20 ? ln.detail : "", null, th);
      g.restore();
      let last: number | null = null;
      for (const e of ln.events) {
        const ev = tl.events[e];
        const pc = l.pieces[l.eventPiece[e]];
        const pk = this.peaks.get(l.recordings[pc.recording].path);
        const on = f?.events.has(e);
        g.save();
        g.globalAlpha = dim(!!on || !f);
        tile(g, geo.events[e], color(pc.recording), th, { peaks: pk?.peaks, win: pk?.win, from: ev.src_start, to: ev.src_end, glow: Math.max(glowOf(e), f?.strong === e ? 1 : on ? 0.35 : 0) });
        g.restore();
        // Transpositions, labelled where they change.
        if (ev.semitones !== last && ev.semitones !== 0 && box.h >= 18) {
          g.fillStyle = th.ink;
          g.font = `600 9px ${th.mono}`;
          g.textBaseline = "top";
          g.fillText(`${signed(ev.semitones)}`, geo.events[e].x + 2, box.y + 1);
        }
        last = ev.semitones;
      }
    });

    // Lineage: recording span → piece → where it plays.
    const trace = (p: number, events: Iterable<number>, strength: number) => {
      const pc = l.pieces[p];
      const s = this.span(p);
      const t = geo.tiles[p];
      const wbox = geo.recs[pc.recording].wave;
      if (s) {
        g.save();
        g.globalAlpha = 0.5 * strength;
        g.fillStyle = th.sun2;
        g.fillRect(s.x0, wbox.y, s.x1 - s.x0, wbox.h);
        g.restore();
        ribbon(g, { x0: s.x0, x1: s.x1, y: wbox.y + wbox.h }, { x0: t.x, x1: t.x + t.w, y: t.y }, th.sun2, 0.5 * strength, 0.8);
      }
      const list = [...events];
      for (const e of list) {
        const b = geo.events[e];
        ribbon(g, { x0: t.x, x1: t.x + t.w, y: t.y + t.h }, { x0: b.x, x1: b.x + b.w, y: b.y }, color(pc.recording), (list.length > 24 ? 0.16 : 0.34) * strength, 0.7);
      }
    };
    if (f) {
      for (const p of f.pieces) trace(p, f.strong >= 0 ? [f.strong] : [...l.pieces[p].events].filter((e) => f.events.has(e)), 1);
    } else {
      for (const e of active) trace(l.eventPiece[e], [e], glowOf(e));
    }

    if (playing) {
      const x = X(this.beat);
      const bottom = geo.lanes.at(-1)!.y + geo.lanes.at(-1)!.h;
      g.fillStyle = th.sun;
      g.fillRect(x - 0.75, geo.ruler.y, 1.5, bottom - geo.ruler.y);
    }
  }

  // ---- pointing

  private at(e: MouseEvent): Target | null {
    const geo = this.geo;
    if (!geo || !this.lin) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const inside = (b: Box) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    const ev = geo.events.findIndex(inside);
    if (ev >= 0) return { kind: "event", i: ev };
    const pc = geo.tiles.findIndex((b) => b && inside(b));
    if (pc >= 0) return { kind: "piece", i: pc };
    const l = this.lin;
    // On a recording: the smallest piece under the pointer, else the recording.
    for (const [ri, rg] of geo.recs.entries()) {
      if (!inside({ ...rg.wave, y: rg.title.y, h: rg.title.h + rg.wave.h }) && !(x > geo.right && y >= rg.title.y && y <= rg.wave.y + rg.wave.h)) continue;
      let best = -1;
      l.pieces.forEach((p, i) => {
        if (p.recording !== ri) return;
        const s = this.span(i);
        if (s && x >= s.x0 - 2 && x <= s.x1 + 2 && (best < 0 || p.to - p.from < l.pieces[best].to - l.pieces[best].from)) best = i;
      });
      return best >= 0 && x <= geo.right ? { kind: "piece", i: best } : { kind: "recording", i: ri };
    }
    const row = geo.rows.findIndex((b) => y >= b.y && y <= b.y + b.h);
    if (row >= 0) return { kind: "row", i: row };
    const lane = geo.lanes.findIndex((b) => y >= b.y && y <= b.y + b.h);
    if (lane >= 0) return { kind: "lane", i: lane };
    return null;
  }

  private setHover(t: Target | null) {
    if (t?.kind === this.hover?.kind && t?.i === this.hover?.i) return;
    this.hover = t;
    this.canvas.style.cursor = t ? "pointer" : "";
    this.say();
    this.redraw();
  }

  private pointer(e: PointerEvent) {
    this.setHover(this.at(e));
  }

  private click(e: MouseEvent) {
    const geo = this.geo;
    if (!geo || !this.tl) return;
    const r = this.canvas.getBoundingClientRect();
    const y = e.clientY - r.top, x = e.clientX - r.left;
    // The ruler and chords: jump there (to the start of the bar).
    if (y >= geo.ruler.y && y <= geo.chords.y + geo.chords.h && x <= geo.right) {
      const beat = ((x - geo.left) / (geo.right - geo.left)) * this.tl.length_beats;
      player.seekBeat(Math.max(0, Math.floor(beat / this.tl.meter) * this.tl.meter));
      return;
    }
    const t = this.at(e);
    this.pinned = t && !(t.kind === this.pinned?.kind && t.i === this.pinned?.i) ? t : null;
    this.say();
    this.redraw();
  }

  // ---- the info line (Live's Info View): what's under the pointer, in words

  private say() {
    const tl = this.tl, l = this.lin;
    const t = this.hover ?? this.pinned;
    const hint = "Hover a note or pad to trace it back to its sample; click to pin it (Esc to let go).";
    if (!tl || !l || !t) {
      this.info.replaceChildren(el("span", { className: "muted" }, tl ? hint : "Compile a score to see where its sounds come from."));
      return;
    }
    const pieceName = (p: number) => {
      const pc = l.pieces[p];
      const row = l.rows[pc.row];
      if (row.label.startsWith("clip")) return `clip ${pc.clip}`;
      // A sliced kit's pads are numbered: pad b.3 holds slice 3.
      return /^\d+$/.test(pc.label) ? `slice ${pc.label} (pad ${row.id}.${pc.label})` : `pad ${row.id}.${pc.label}`;
    };
    const where = (p: number) => {
      const pc = l.pieces[p];
      return `${l.recordings[pc.recording].title} at ${time(pc.from)}–${time(pc.to)}`;
    };
    let text: string;
    if (t.kind === "event") {
      const e = tl.events[t.i];
      const bar = Math.floor(e.start_beat / tl.meter) + 1;
      const beat = +((e.start_beat % tl.meter) + 1).toFixed(2);
      text = `Track ${e.track}, bar ${bar} beat ${beat}: ${pieceName(l.eventPiece[t.i])}, from ${where(l.eventPiece[t.i])}${e.semitones ? `, transposed ${signed(e.semitones)}` : ""}.`;
    } else if (t.kind === "piece") {
      const pc = l.pieces[t.i];
      const tracks = [...new Set(pc.events.map((e) => tl.events[e].track))];
      text = `${pieceName(t.i)}: ${where(t.i)} (${(pc.to - pc.from).toFixed(2)} s). ${pc.events.length ? `Plays ${pc.events.length}× on ${tracks.join(", ")}.` : "Not played."}`;
    } else if (t.kind === "row") {
      const row = l.rows[t.i];
      const recs = [...new Set(row.pieces.map((p) => l.recordings[l.pieces[p].recording].title))];
      text = row.label.startsWith("clip") ? `${row.label}, played whole, from ${recs.join(", ")}.` : `${row.label}: ${row.pieces.length} pad${row.pieces.length === 1 ? "" : "s"}, from ${recs.join(", ")}.`;
    } else if (t.kind === "lane") {
      const ln = l.lanes[t.i];
      text = `Track ${ln.track} (${ln.detail}): ${ln.events.length} note${ln.events.length === 1 ? "" : "s"}.`;
    } else {
      const rec = l.recordings[t.i];
      const used = l.pieces.filter((p) => p.recording === t.i).length;
      text = `Sample ${rec.title} (${rec.path}): ${rec.clips.map((c) => `clip ${c}`).join(", ")}; ${used} sound${used === 1 ? "" : "s"} cut from it.`;
    }
    this.info.replaceChildren(...(this.pinned ? [el("b", {}, "Pinned "), " "] : []), text);
  }
}
