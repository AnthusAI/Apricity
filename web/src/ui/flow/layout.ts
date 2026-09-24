// Where the Flow rows sit. Sources stack from the top, each a title bar, its waveform and a row of
// its slices; the composition (ruler, chord strip, one lane per track) sits at the bottom. A
// source in focus is detailed; the others shrink to a summary, so many sources stay readable.

import { lerp } from "./tween";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SourceState {
  shown: number; // 0 = not there yet, 1 = in place
  detail: number; // 1 = detailed, 0 = summary
}

export interface SourceRows {
  title: Box;
  wave: Box;
  chops: Box;
  detail: number;
  shown: number;
}

export interface Layout {
  left: number; // the timeline's left edge
  right: number; // its right edge; track names sit to the right of it
  sources: SourceRows[];
  ruler: Box;
  chords: Box;
  lanes: Box[];
}

// Row heights, detailed and summarized. Lane heights are the caller's (`lanes`).
const DETAIL = { title: 16, wave: 56, gap: 24, chops: 36, after: 16 };
const SUMMARY = { title: 12, wave: 0, gap: 4, chops: 8, after: 10 };
const COMP = { ruler: 14, chords: 20, laneGap: 4 };

export function layout(w: number, h: number, sources: SourceState[], lanes: number[], compact = false): Layout {
  const left = compact ? 6 : 10;
  const right = w - (compact ? 46 : 96);
  const width = right - left;
  let y = compact ? 8 : 12;
  const rows: SourceRows[] = sources.map(({ shown, detail }) => {
    const size = (k: keyof typeof DETAIL) => lerp(SUMMARY[k], DETAIL[k], detail) * shown;
    const title = { x: left, y, w: width, h: size("title") };
    y += title.h;
    const wave = { x: left, y, w: width, h: size("wave") };
    y += wave.h + size("gap");
    const chops = { x: left, y, w: width, h: size("chops") };
    y += chops.h + size("after");
    return { title, wave, chops, detail, shown };
  });
  const laneBoxes: Box[] = [];
  let bottom = h - 8;
  for (let i = lanes.length - 1; i >= 0; i--) {
    laneBoxes[i] = { x: left, y: bottom - lanes[i], w: width, h: lanes[i] };
    bottom -= lanes[i] + COMP.laneGap;
  }
  const chords = { x: left, y: bottom - COMP.chords + COMP.laneGap, w: width, h: COMP.chords };
  const ruler = { x: left, y: chords.y - COMP.ruler, w: width, h: COMP.ruler };
  return { left, right, sources: rows, ruler, chords, lanes: laneBoxes };
}

/** Score beats → x across the composition. */
export const beatX = (l: Layout, beats: number, total: number) => l.left + ((l.right - l.left) * beats) / total;

/** Seconds in a source window → x across a row. */
export const secX = (box: Box, win: [number, number], s: number) => box.x + (box.w * (s - win[0])) / (win[1] - win[0]);
