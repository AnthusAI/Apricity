// Canvas painters for Flow, in the spirit of Live's arrangement: flat clip-colored tiles with the
// waveform drawn dark inside, thin rulers, small mono labels. Colors come from CSS custom
// properties on the element that hosts the drawing, so each page can theme it.

import type { Box } from "./layout";

export interface Theme {
  ink: string;
  inkSoft: string;
  card: string;
  line: string;
  night: string;
  sun: string;
  sun2: string;
  clips: string[];
  clipInk: string; // text and waveforms drawn on a clip color
  mono: string;
  sans: string;
}

export function readTheme(el: Element): Theme {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--ink", "#222"),
    inkSoft: v("--ink-soft", "#777"),
    card: v("--card", "rgba(255,255,255,0.7)"),
    line: v("--card-line", "rgba(0,0,0,0.1)"),
    night: v("--night", "#fff"),
    sun: v("--sun", "#f59e5b"),
    sun2: v("--sun-2", "#ffcf8a"),
    clips: [v("--clip-a", "#c46bb4"), v("--clip-b", "#f59e5b"), v("--clip-c", "#6bb6c4")],
    clipInk: v("--clip-ink", "#2a1420"),
    mono: v("--mono", "ui-monospace, Menlo, monospace"),
    sans: css.fontFamily || "system-ui, sans-serif",
  };
}

/** `#rrggbb` at some opacity (other colors pass through unchanged). */
export function fade(color: string, a: number) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})` : color;
}

/** A row's name at the right, as Live puts track headers: a color chip, a name, a mono detail. */
export function header(g: CanvasRenderingContext2D, x: number, y: number, name: string, detail: string, color: string | null, t: Theme, compact = false, maxWidth = 0) {
  let tx = x;
  if (color) {
    g.fillStyle = color;
    rect(g, { x, y: y - 5, w: 10, h: 10 }, 2);
    g.fill();
    tx += 15;
  }
  g.textBaseline = "middle";
  if (compact) {
    // Narrow: the chip, and the detail only if it fits beside it.
    g.fillStyle = t.inkSoft;
    g.font = `10px ${t.mono}`;
    const short = detail.split(" ").at(-1)!;
    if (g.measureText(detail).width <= maxWidth) g.fillText(detail, tx, y);
    else if (g.measureText(short).width <= Math.max(24, maxWidth)) g.fillText(short, tx, y);
    return;
  }
  g.fillStyle = t.ink;
  g.font = `600 11px ${t.sans}`;
  g.fillText(name, tx, detail ? y - 5 : y);
  if (detail) {
    g.fillStyle = t.inkSoft;
    g.font = `10px ${t.mono}`;
    g.fillText(detail, tx, y + 7);
  }
}

export function rect(g: CanvasRenderingContext2D, b: Box, r = 3) {
  g.beginPath();
  g.roundRect(b.x, b.y, Math.max(0, b.w), Math.max(0, b.h), Math.min(r, b.w / 2, b.h / 2));
}

/**
 * A waveform: the peaks for seconds [from, to] of a source whose peaks cover `win`, drawn into
 * `box` as one bar per pixel. `reveal` draws only the first part (0–1), for a left-to-right wipe.
 */
export function wave(g: CanvasRenderingContext2D, peaks: Int8Array, win: [number, number], from: number, to: number, box: Box, reveal = 1) {
  const n = peaks.length / 2;
  const c0 = ((from - win[0]) / (win[1] - win[0])) * n;
  const c1 = ((to - win[0]) / (win[1] - win[0])) * n;
  const cols = Math.max(1, Math.floor(box.w));
  const shown = Math.floor(cols * reveal);
  const mid = box.y + box.h / 2;
  const amp = box.h / 2 / 127;
  for (let x = 0; x < shown; x++) {
    const a = Math.max(0, Math.floor(c0 + ((c1 - c0) * x) / cols));
    const b = Math.min(n, Math.max(a + 1, Math.floor(c0 + ((c1 - c0) * (x + 1)) / cols)));
    let lo = 127, hi = -128;
    for (let i = a; i < b; i++) {
      if (peaks[2 * i] < lo) lo = peaks[2 * i];
      if (peaks[2 * i + 1] > hi) hi = peaks[2 * i + 1];
    }
    if (hi < lo) continue;
    g.fillRect(box.x + x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
  }
}

/**
 * A band joining span `a` (on one row) to span `b` (on a row below): "this came from there".
 * `far` is how much color is left at the lower end (a lineage being traced stays bright).
 */
export function ribbon(g: CanvasRenderingContext2D, a: { x0: number; x1: number; y: number }, b: { x0: number; x1: number; y: number }, color: string, alpha: number, far = 0.25) {
  if (alpha <= 0.002) return;
  const my = (a.y + b.y) / 2;
  g.save();
  g.globalAlpha *= alpha;
  const grad = g.createLinearGradient(0, a.y, 0, b.y);
  grad.addColorStop(0, color);
  grad.addColorStop(1, fade(color, far));
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(a.x0, a.y);
  g.bezierCurveTo(a.x0, my, b.x0, my, b.x0, b.y);
  g.lineTo(b.x1, b.y);
  g.bezierCurveTo(b.x1, my, a.x1, my, a.x1, a.y);
  g.closePath();
  g.fill();
  g.restore();
}

export interface TileOpts {
  peaks?: Int8Array;
  win?: [number, number];
  from?: number;
  to?: number;
  label?: string;
  glow?: number; // 0–1: playing right now
}

/** A clip tile, as in Live's arrangement: clip-colored body, the waveform dark inside. */
export function tile(g: CanvasRenderingContext2D, b: Box, color: string, t: Theme, o: TileOpts = {}) {
  if (b.w < 0.5 || b.h < 0.5) return;
  const glow = o.glow ?? 0;
  if (glow > 0) {
    g.save();
    g.shadowColor = t.sun2;
    g.shadowBlur = 14 * glow;
    g.fillStyle = color;
    rect(g, b, 2);
    g.fill();
    g.restore();
  }
  g.fillStyle = color;
  rect(g, b, 2);
  g.fill();
  if (o.peaks && o.win && b.h >= 8 && b.w >= 3) {
    g.save();
    g.globalAlpha *= 0.6;
    g.fillStyle = t.clipInk;
    wave(g, o.peaks, o.win, o.from!, o.to!, { x: b.x + 1, y: b.y + (o.label ? 9 : 2), w: b.w - 2, h: b.h - (o.label ? 11 : 4) });
    g.restore();
  }
  if (o.label && b.w > 12 && b.h > 14) {
    g.fillStyle = t.clipInk;
    g.globalAlpha *= 0.85;
    g.font = `600 9px ${t.mono}`;
    g.textBaseline = "top";
    g.fillText(o.label, b.x + 3, b.y + 1.5);
    g.globalAlpha /= 0.85;
  }
  if (glow > 0) {
    g.save();
    g.globalAlpha *= 0.45 * glow;
    g.fillStyle = "#fff";
    rect(g, b, 2);
    g.fill();
    g.restore();
  }
}

/** A mouse pointer, for the "you do this part" moments. */
export function pointer(g: CanvasRenderingContext2D, x: number, y: number, t: Theme) {
  g.save();
  g.translate(x, y);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, 15);
  g.lineTo(4, 11.5);
  g.lineTo(6.8, 17.5);
  g.lineTo(9, 16.5);
  g.lineTo(6.3, 10.6);
  g.lineTo(11, 10.6);
  g.closePath();
  g.fillStyle = t.ink;
  g.strokeStyle = t.night;
  g.lineWidth = 1.3;
  g.fill();
  g.stroke();
  g.restore();
}

/** A small label in a filled tag, like a slice name. */
export function tag(g: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, t: Theme) {
  g.font = `600 10px ${t.mono}`;
  const w = g.measureText(text).width + 8;
  g.fillStyle = bg;
  rect(g, { x, y, w, h: 14 }, 3);
  g.fill();
  g.fillStyle = fg;
  g.textBaseline = "middle";
  g.fillText(text, x + 4, y + 7.5);
  return w;
}
