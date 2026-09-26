// Waveform editor for one sample: key bands, beat ruler, saved clips, markers, selection, playhead.
// Everything the user can make here is kept inside the clip by construction (poka-yoke):
// selections and slice edges are clamped to [0, duration] and snapped to beats unless Alt is held.

import type { Manifest, SavedClip } from "../apricity";

export interface WaveState {
  duration: number;
  peaks: Float32Array; // min/max pairs per column at a fixed resolution
  manifest: Manifest;
  clips: SavedClip[];
  selected: number | null; // clip index
  selection: [number, number] | null;
  playhead: number | null;
}

type Drag =
  | { kind: "select"; anchor: number }
  | { kind: "edge"; clip: number; edge: "start" | "end" }
  | { kind: "move"; clip: number; offset: number; len: number };

// The clip lane has three rows: your clips, auto-detected sections, auto loops and one-shots.
const ROW = 17;
const H = { keys: 16, wave: 112, lane: ROW * 3 + 4, ruler: 12 };

/** Which lane row a saved clip lives in. */
export function clipRow(s: SavedClip): 0 | 1 | 2 {
  if (s.source !== "ml") return 0;
  return s.tags?.includes("section") ? 1 : 2;
}
const HEIGHT = H.keys + H.wave + H.lane + H.ruler;
const PEAK_COLUMNS = 2400;

export function computePeaks(channels: Float32Array[]): Float32Array {
  const n = channels[0].length;
  const out = new Float32Array(PEAK_COLUMNS * 2);
  const per = Math.max(1, Math.floor(n / PEAK_COLUMNS));
  for (let col = 0; col < PEAK_COLUMNS; col++) {
    let lo = 0, hi = 0;
    for (let i = col * per, e = Math.min(n, i + per); i < e; i++) {
      for (const c of channels) {
        const v = c[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    out[col * 2] = lo;
    out[col * 2 + 1] = hi;
  }
  return out;
}

export class Waveform {
  canvas = document.createElement("canvas");
  state: WaveState;
  private drag: Drag | null = null;
  onChange: (s: WaveState, why: "clips" | "selection" | "select") => void = () => {};
  onSeek: (seconds: number) => void = () => {};

  constructor(state: WaveState) {
    this.state = state;
    this.canvas.className = "wave";
    this.canvas.style.height = `${HEIGHT}px`;
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "Sample waveform: drag to select a region, drag a clip's edges to adjust it, Delete removes the selected clip");
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("dblclick", (e) => this.onSeek(this.timeAt(e)));
    this.canvas.addEventListener("keydown", (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && this.state.selected !== null) {
        this.state.clips.splice(this.state.selected, 1);
        this.state.selected = null;
        this.onChange(this.state, "clips");
        this.draw();
        e.preventDefault();
      }
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  // ---- geometry
  private x(t: number) {
    return (t / this.state.duration) * this.canvas.clientWidth;
  }
  private timeAt(e: PointerEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return Math.min(this.state.duration, Math.max(0, ((e.clientX - r.left) / r.width) * this.state.duration));
  }
  private snap(t: number, e: PointerEvent) {
    if (e.altKey) return t;
    const beats = this.state.manifest.rhythm.beats;
    if (!beats.length) return t;
    let best = t, d = Infinity;
    for (const b of beats) {
      if (Math.abs(b - t) < d) (d = Math.abs(b - t)), (best = b);
    }
    // Only snap when close (within 6 px).
    return Math.abs(this.x(best) - this.x(t)) < 6 ? best : t;
  }
  private clampClip(s: SavedClip) {
    const dur = this.state.duration;
    s.start = Math.max(0, Math.min(s.start, dur - 0.05));
    s.end = Math.max(s.start + 0.05, Math.min(s.end, dur));
  }
  private hit(e: PointerEvent): Exclude<Drag, { kind: "select" }> | null {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const laneY = H.keys + H.wave;
    const row = py >= laneY && py < laneY + H.lane ? Math.floor((py - laneY - 2) / ROW) : -1;
    for (let i = this.state.clips.length - 1; i >= 0; i--) {
      const s = this.state.clips[i];
      const a = this.x(s.start), b = this.x(s.end);
      const inRow = row === clipRow(s);
      // Edges are grabbable in the clip's own row, or anywhere for the selected clip.
      if ((inRow || i === this.state.selected) && Math.abs(px - a) < 5) return { kind: "edge", clip: i, edge: "start" };
      if ((inRow || i === this.state.selected) && Math.abs(px - b) < 5) return { kind: "edge", clip: i, edge: "end" };
      if (inRow && px > a && px < b) return { kind: "move", clip: i, offset: this.timeAt(e) - s.start, len: s.end - s.start };
    }
    return null;
  }

  // ---- pointer
  private down(e: PointerEvent) {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {} // not every pointer can be captured (e.g. synthetic events)
    const h = this.hit(e);
    if (h) {
      this.drag = h;
      this.state.selected = h.clip;
      this.state.selection = null;
      this.onChange(this.state, "select");
    } else {
      const t = this.snap(this.timeAt(e), e);
      this.drag = { kind: "select", anchor: t };
      this.state.selected = null;
      this.state.selection = [t, t];
      this.onChange(this.state, "select");
    }
    this.draw();
  }
  private move(e: PointerEvent) {
    if (!this.drag) {
      const h = this.hit(e);
      this.canvas.style.cursor = h?.kind === "edge" ? "ew-resize" : h?.kind === "move" ? "grab" : "crosshair";
      return;
    }
    const t = this.snap(this.timeAt(e), e);
    const d = this.drag;
    if (d.kind === "select") {
      this.state.selection = [Math.min(d.anchor, t), Math.max(d.anchor, t)];
    } else if (d.kind === "edge") {
      const s = this.state.clips[d.clip];
      if (d.edge === "start") s.start = Math.min(t, s.end - 0.05);
      else s.end = Math.max(t, s.start + 0.05);
      this.clampClip(s);
    } else {
      const s = this.state.clips[d.clip];
      const start = Math.max(0, Math.min(this.snap(this.timeAt(e) - d.offset, e), this.state.duration - d.len));
      s.start = start;
      s.end = start + d.len;
    }
    this.draw();
  }
  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {} // the pointer may not have been captured
    if (!d) return;
    if (d.kind === "select") {
      const sel = this.state.selection;
      // A click (no drag) just clears the selection; double-click plays from a point.
      if (sel && sel[1] - sel[0] < 0.05) this.state.selection = null;
      this.onChange(this.state, "selection");
    } else {
      const sl = this.state.clips[d.clip];
      if (sl.source === "ml") sl.source = "user"; // you changed it, so it's yours now
      this.onChange(this.state, "clips");
    }
    this.draw();
  }

  // ---- drawing
  draw() {
    const c = this.canvas, dpr = devicePixelRatio || 1;
    const w = c.clientWidth;
    if (!w) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(HEIGHT * dpr);
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const col = (v: string) => css.getPropertyValue(v).trim();
    const fg = col("--fg"), accent = col("--accent"), clipCol = col("--slice"), line = col("--line"), muted = col("--muted");
    const { manifest: m, peaks, duration } = this.state;

    // key bands
    g.font = "11px system-ui, sans-serif";
    g.textBaseline = "middle";
    (m.tonal.segments ?? []).forEach((s, i) => {
      const a = this.x(s.start), b = this.x(Math.min(s.end, duration));
      g.fillStyle = i % 2 ? accent : fg;
      g.globalAlpha = 0.08;
      g.fillRect(a, 0, b - a, H.keys - 2);
      g.globalAlpha = 0.85;
      g.fillStyle = fg;
      const label = s.key.tonic.replace("b", "♭") + (s.key.mode === "minor" ? "m" : "");
      if (g.measureText(label).width < b - a - 6) g.fillText(label, a + 4, (H.keys - 2) / 2);
    });
    g.globalAlpha = 1;

    // selection
    const y0 = H.keys, mid = H.keys + H.wave / 2;
    if (this.state.selection) {
      const [a, b] = this.state.selection;
      g.fillStyle = accent;
      g.globalAlpha = 0.14;
      g.fillRect(this.x(a), y0, Math.max(1, this.x(b) - this.x(a)), H.wave + H.lane);
      g.globalAlpha = 1;
    }

    // waveform
    const cols = peaks.length / 2;
    for (let px = 0; px < w; px++) {
      const i = Math.min(cols - 1, Math.floor((px / w) * cols));
      const lo = peaks[i * 2], hi = peaks[i * 2 + 1];
      const t = (px / w) * duration;
      const inSel = this.state.selection && t >= this.state.selection[0] && t <= this.state.selection[1];
      g.fillStyle = inSel ? accent : fg;
      g.globalAlpha = inSel ? 0.9 : 0.42;
      g.fillRect(px, mid - (hi * H.wave) / 2, 1, Math.max(1, ((hi - lo) * H.wave) / 2));
    }
    g.globalAlpha = 1;

    // clips: three lane rows (yours / sections / loops+hits); auto markup drawn outlined
    const laneY = H.keys + H.wave;
    g.fillStyle = line;
    g.fillRect(0, laneY, w, 1);
    this.state.clips.forEach((s, i) => {
      const a = this.x(s.start), b = Math.max(this.x(s.end), this.x(s.start) + 2), sel = i === this.state.selected;
      const ml = s.source === "ml";
      const y = laneY + 2 + clipRow(s) * ROW;
      if (sel || !ml) {
        g.fillStyle = clipCol;
        g.globalAlpha = sel ? 0.16 : 0.06;
        g.fillRect(a, y0, b - a, H.wave);
      }
      g.globalAlpha = sel ? 0.95 : ml ? 0.85 : 0.6;
      if (ml) {
        g.strokeStyle = s.tags?.includes("section") ? accent : clipCol;
        g.lineWidth = sel ? 2 : 1;
        g.setLineDash(s.tags?.includes("shot") ? [] : [3, 2]);
        g.strokeRect(a + 0.5, y + 1.5, b - a - 1, ROW - 4);
        g.setLineDash([]);
      } else {
        g.fillStyle = clipCol;
        g.fillRect(a, y + 1, b - a, ROW - 3);
      }
      g.globalAlpha = 1;
      g.fillStyle = ml ? fg : "white";
      g.save();
      g.beginPath();
      g.rect(a, y, b - a, ROW);
      g.clip();
      g.font = "10.5px system-ui, sans-serif";
      if (!s.tags?.includes("shot")) g.fillText(s.name, a + 4, y + ROW / 2);
      g.restore();
      if (sel) {
        g.fillStyle = clipCol;
        g.fillRect(a - 1, y0, 2, H.wave + H.lane);
        g.fillRect(b - 1, y0, 2, H.wave + H.lane);
      }
    });

    // markers: section starts as faint lines through the waveform (transients already show as one-shot clips)
    for (const mk of m.annotations?.markers ?? []) {
      if (mk.name === "transient") continue;
      g.fillStyle = mk.source === "ml" ? accent : col("--warn");
      g.globalAlpha = mk.source === "ml" ? 0.35 : 0.9;
      g.fillRect(this.x(mk.seconds), y0, 1, H.wave);
      g.globalAlpha = 1;
    }

    // beat ruler (downbeats long)
    const rulerY = laneY + H.lane;
    const downs = new Set(m.rhythm.downbeats.map((d) => d.toFixed(2)));
    g.fillStyle = muted;
    for (const b of m.rhythm.beats) {
      const isDown = downs.has(b.toFixed(2));
      g.globalAlpha = isDown ? 0.9 : 0.45;
      g.fillRect(Math.round(this.x(b)), rulerY + (isDown ? 0 : 6), 1, isDown ? H.ruler : H.ruler - 6);
    }
    g.globalAlpha = 1;

    // playhead
    if (this.state.playhead !== null) {
      g.fillStyle = accent;
      g.fillRect(this.x(this.state.playhead) - 1, 0, 2, HEIGHT);
    }
  }
}
