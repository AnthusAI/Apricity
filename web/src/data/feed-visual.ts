// What a feed card draws, as plain data (drawn by ui/feed-card.ts; tested in test/feed-visual.test.ts):
// - a score's strip, from its compiled timeline: a lane per track with its events, the chords along the top, bars;
// - a sample's (or a clip's) envelope, from its analysis: loudness per beat, downbeats, and the key over time.
// Neither needs the audio, so a page of cards costs a few small JSON reads, not a download per card.

import type { Manifest, Timeline } from "../apricity";

export const MAX_LANES = 8;

export interface StripModel {
  beats: number;
  meter: number;
  lanes: { name: string; blocks: [number, number][] }[];
  chords: { start: number; end: number; label: string }[];
}

/** A score's strip: its tracks (the first MAX_LANES that play), their events, and its chords (repeats merged). */
export function stripModel(tl: Pick<Timeline, "tracks" | "events" | "harmony" | "length_beats" | "meter">): StripModel {
  const byTrack = new Map<string, [number, number][]>();
  for (const e of tl.events) {
    if (!byTrack.has(e.track)) byTrack.set(e.track, []);
    byTrack.get(e.track)!.push([e.start_beat, e.dur_beats]);
  }
  const lanes = tl.tracks
    .map((t) => ({ name: t.name, blocks: (byTrack.get(t.name) ?? []).sort((a, b) => a[0] - b[0]) }))
    .filter((l) => l.blocks.length)
    .slice(0, MAX_LANES);
  const end = Math.max(tl.length_beats || 0, ...tl.events.map((e) => e.start_beat + e.dur_beats));
  const chords: StripModel["chords"] = [];
  for (const h of tl.harmony) {
    const label = h.fit?.chord ?? h.label;
    if (!label) continue;
    const last = chords[chords.length - 1];
    if (last && last.label === label && Math.abs(last.end - h.start_beat) < 1e-6) last.end = h.end_beat;
    else chords.push({ start: h.start_beat, end: h.end_beat, label });
  }
  return { beats: end || 1, meter: tl.meter || 4, lanes, chords };
}

type Rhythm = Manifest["rhythm"] & { beat_loudness?: number[] };

export interface EnvelopeModel {
  /** The stretch of the recording drawn, in seconds. */
  from: number;
  to: number;
  /** Loudness between consecutive beats, 0–1 (the loudest in view is 1). */
  bars: { t0: number; t1: number; v: number }[];
  downbeats: number[];
  keys: { t0: number; t1: number; label: string }[];
  /** A clip's own stretch, inside [from, to]. */
  highlight: [number, number] | null;
}

const DB_RANGE = 30; // quieter than the loudest by this much draws as nothing

/**
 * A sample's envelope, or a clip's: the clip with a little of the sample either side (a few beats, and at least its own
 * length), the clip itself highlighted. Beats without a loudness (older analyses) draw at half height.
 */
export function envelopeModel(m: Pick<Manifest, "source" | "tonal"> & { rhythm: Rhythm }, clip?: [number, number]): EnvelopeModel {
  const dur = m.source.duration;
  const beats = m.rhythm.beats ?? [];
  const beatLen = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;
  const pad = clip ? Math.max(clip[1] - clip[0], 4 * beatLen) : 0;
  const from = clip ? Math.max(0, clip[0] - pad) : 0;
  const to = clip ? Math.min(dur, clip[1] + pad) : dur;
  const loud = m.rhythm.beat_loudness;
  const raw: { t0: number; t1: number; db: number | null }[] = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const t0 = beats[i];
    const t1 = beats[i + 1];
    if (t1 <= from || t0 >= to) continue;
    raw.push({ t0: Math.max(t0, from), t1: Math.min(t1, to), db: loud?.[i] ?? null });
  }
  const top = Math.max(...raw.map((b) => b.db ?? -Infinity));
  const bars = raw.map((b) => ({ t0: b.t0, t1: b.t1, v: b.db === null || !Number.isFinite(top) ? 0.5 : Math.max(0, Math.min(1, 1 - (top - b.db) / DB_RANGE)) }));
  const keys = (m.tonal.segments ?? [])
    .filter((s) => s.end > from && s.start < to)
    .map((s) => ({ t0: Math.max(s.start, from), t1: Math.min(s.end, to), label: `${s.key.tonic}${s.key.mode === "minor" ? "m" : ""}` }));
  return { from, to, bars, downbeats: (m.rhythm.downbeats ?? []).filter((t) => t >= from && t <= to), keys, highlight: clip ? [clip[0], clip[1]] : null };
}
