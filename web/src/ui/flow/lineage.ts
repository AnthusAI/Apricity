// Lineage for the Score tab's Flow view: from a compiled timeline, which samples are used, which
// sounds (a kit's slices and pads, or clips played whole) are cut from them, and where each plays.
// Pure, so it's tested without a browser. (Internally a sample is a `Recording` and a sound a `Piece`.)

import type { Timeline } from "../../apricity";

/** A stretch of a recording worth showing: the used parts, with a little context around them. */
export interface Island {
  from: number; // seconds
  to: number;
}

export interface Recording {
  path: string;
  title: string; // "Thunderer/drums", "Thunderer"
  clips: string[]; // score clips cut from it
  regions: { clip: string; from: number; to: number }[]; // those clips' regions
  islands: Island[];
}

export interface Piece {
  recording: number;
  from: number; // seconds
  to: number;
  label: string; // a slice's number "3", a pad's name "kick", or the clip name
  clip: string; // the score clip it's cut from
  row: number;
  events: number[]; // indices into timeline.events
}

/** A row of sounds: one kit (its pads: slices or clips), or one clip played whole. */
export interface Row {
  id: string;
  label: string; // "kit b", "clip horns"
  pieces: number[];
}

export interface Lane {
  track: string;
  detail: string; // what it plays
  events: number[];
}

export interface Lineage {
  recordings: Recording[];
  pieces: Piece[];
  rows: Row[];
  lanes: Lane[];
  eventPiece: number[]; // per timeline event: its piece
}

const title = (path: string) => {
  const parts = path.replace(/\.[^.]+$/, "").split("/");
  // Stems live in stems/<piece>/<stem>.wav: "Thunderer/drums" says more than "drums".
  return parts.at(-3) === "stems" ? parts.slice(-2).join("/") : parts.at(-1)!;
};

/** Used spans closer than `join` seconds merge; each island gets `pad` of context either side. */
export function islands(spans: [number, number][], join = 2, pad = 0.6): Island[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Island[] = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a - pad <= last.to + join) last.to = Math.max(last.to, b + pad);
    else out.push({ from: Math.max(0, a - pad), to: b + pad });
  }
  return out;
}

export function lineage(tl: Timeline): Lineage {
  const recordings: Recording[] = [];
  const recOf = new Map<string, number>();
  const recording = (source: number) => {
    const src = tl.sources[source];
    let r = recOf.get(src.path);
    if (r === undefined) {
      r = recordings.length;
      recOf.set(src.path, r);
      recordings.push({ path: src.path, title: title(src.path), clips: [], regions: [], islands: [] });
    }
    const rec = recordings[r];
    if (!rec.clips.includes(src.clip)) {
      rec.clips.push(src.clip);
      if (src.region) rec.regions.push({ clip: src.clip, from: src.region[0], to: src.region[1] });
    }
    return r;
  };

  const pieces: Piece[] = [];
  const pieceOf = new Map<string, number>();
  const rows: Row[] = [];
  const rowOf = new Map<string, number>();
  const kits = new Set(tl.tracks.filter((t) => t.kit).map((t) => t.kit!));
  // Per track: its pieces' global indices.
  const trackPieces = new Map<string, number[]>();
  for (const t of tl.tracks) {
    const own = t.pieces ?? [];
    // Whole kits, then single pads of a kit ("drums.crash" joins kit drums), then clips.
    const prefix = t.clip.includes(".") ? t.clip.slice(0, t.clip.lastIndexOf(".")) : null;
    const rowId = t.kit ?? (prefix && (kits.has(prefix) || own[0]?.name !== undefined || /\.\d+$/.test(t.clip)) ? prefix : t.clip);
    let row = rowOf.get(rowId);
    if (row === undefined) {
      row = rows.length;
      rowOf.set(rowId, row);
      rows.push({ id: rowId, label: rowId === t.clip && !t.kit && !prefix ? `clip ${rowId}` : `kit ${rowId}`, pieces: [] });
    }
    const mine = own.map((p, i) => {
      const r = recording(p.source);
      const key = `${recordings[r].path}|${p.src_start.toFixed(3)}|${p.src_end.toFixed(3)}`;
      let k = pieceOf.get(key);
      if (k === undefined) {
        k = pieces.length;
        pieceOf.set(key, k);
        const label = p.name ?? (t.kit ? String(i + 1) : /\.(\d+)$/.exec(t.clip)?.[1] ?? tl.sources[p.source].clip);
        pieces.push({ recording: r, from: p.src_start, to: p.src_end, label, clip: tl.sources[p.source].clip, row: row!, events: [] });
        rows[row!].pieces.push(k);
      }
      return k;
    });
    trackPieces.set(t.name, mine);
  }

  const eventPiece = tl.events.map((e, i) => {
    let k = trackPieces.get(e.track)?.[e.piece ?? 0];
    if (k === undefined) {
      // An older compiler without lineage: fall back to the event's own span.
      const r = recording(e.source);
      k = pieces.length;
      pieces.push({ recording: r, from: e.src_start, to: e.src_end, label: e.track, clip: tl.sources[e.source].clip, row: 0, events: [] });
    }
    pieces[k].events.push(i);
    return k;
  });

  recordings.forEach((rec, r) => {
    rec.islands = islands(pieces.filter((p) => p.recording === r).map((p) => [p.from, p.to]));
  });

  const lanes: Lane[] = tl.tracks.map((t) => ({
    track: t.name,
    detail: t.kit
      ? `kit ${t.kit}`
      : t.clip.includes(".")
        ? `${t.pieces?.[0]?.name ? "pad" : "slice"} of kit ${t.clip.slice(0, t.clip.lastIndexOf("."))}`
        : `clip ${t.clip}`,
    events: [],
  }));
  const laneOf = new Map(lanes.map((l, i) => [l.track, i]));
  tl.events.forEach((e, i) => lanes[laneOf.get(e.track) ?? 0]?.events.push(i));

  return { recordings, pieces, rows, lanes, eventPiece };
}

/**
 * The recording each pad of a kit plays, as Flow numbers recordings (so a pad has the color of its tiles there): from
 * the events of the pad's track (`track drums.kick`), keyed by the pad's name.
 */
export function padRecordings(tl: Timeline, lin: Lineage, kit: string): Map<string, number> {
  const byTrack = new Map<string, number>();
  tl.events.forEach((e, i) => {
    const pc = lin.pieces[lin.eventPiece[i]];
    if (pc && !byTrack.has(e.track)) byTrack.set(e.track, pc.recording);
  });
  const out = new Map<string, number>();
  for (const t of tl.tracks) {
    const r = byTrack.get(t.name);
    if (r === undefined) continue;
    const pad = t.clip.startsWith(`${kit}.`) ? t.clip.slice(kit.length + 1) : t.clip;
    if (!out.has(pad)) out.set(pad, r);
  }
  return out;
}
