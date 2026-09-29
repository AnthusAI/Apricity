// The home page's "Top" order: the best-rated songs first, fresh ones lifted a little, and everything that isn't a song
// (beats, chords, melodies, samples, clips) weighted far down so it only shows below the songs people liked. Pure
// (test/home-feed.test.ts).
//
//   worth = quality × kind weight × freshness
//   quality    its Bayesian stars in the window shown (rank-window.ts; the window widens when it's quiet), or a bit
//              under the middle when nobody has rated it yet
//   freshness  1 + FRESH_BOOST, fading by half every FRESH_HALF_LIFE days since it was last made, changed or rated

import type { ScoreKind } from "./catalog";
import { rank, type DayTally, type Rankable, type Ranked, type Standing, type Window } from "./rank-window";

export type HomeKind = ScoreKind | "sample" | "clip";
export const KIND_WEIGHT: Record<HomeKind, number> = { song: 1, beat: 0.3, chords: 0.2, melody: 0.2, sample: 0.2, clip: 0.2 };
export const UNRATED_STARS = 2;
export const FRESH_BOOST = 0.6;
export const FRESH_HALF_LIFE = 5;

export interface HomeItem extends Rankable {
  kind: HomeKind;
  /** Last changed, in seconds (0 when unknown). */
  modified: number;
}

export interface HomeRow<T> {
  item: T;
  standing: Standing;
  worth: number;
}

/**
 * What an item is worth on the home page: its stars (or a bit under the middle, unrated) × its kind's weight × how
 * fresh it is (`touched`: when it was last made, changed or rated, in ms; 0 when unknown).
 */
export function worthOf(kind: HomeKind, standing: Pick<Standing, "count" | "score">, touched: number, now: Date): number {
  const quality = (standing.count > 0 ? standing.score : UNRATED_STARS) / 5;
  const ageDays = touched ? Math.max(0, (now.getTime() - touched) / 86_400_000) : Infinity;
  const freshness = 1 + FRESH_BOOST * Math.pow(0.5, ageDays / FRESH_HALF_LIFE);
  return quality * KIND_WEIGHT[kind] * freshness;
}

/** The day each item was last rated ("YYYY-MM-DD"), from the tally rows. */
function lastRated(tallies: DayTally[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tallies) if (t.day !== "all" && t.count > 0 && t.day > (out.get(t.targetId) ?? "")) out.set(t.targetId, t.day);
  return out;
}

/** Order scores for the home page (window: where the stars are counted; it widens when quiet, as the lists do). */
export function homeRank<T extends HomeItem>(items: T[], tallies: DayTally[], asked: Window, now: Date): Pick<Ranked<T>, "window" | "asked" | "widened"> & { rows: HomeRow<T>[] } {
  const ranked = rank(items, tallies, asked, now);
  const rated = lastRated(tallies);
  const rows = ranked.rows.map(({ item, standing }) => {
    const touched = Math.max(item.modified * 1000, Date.parse(item.createdAt ?? "") || 0, Date.parse(rated.get(item.id) ?? "") || 0);
    return { item, standing, worth: worthOf(item.kind, standing, touched, now) };
  });
  rows.sort((a, b) => b.worth - a.worth);
  return { window: ranked.window, asked: ranked.asked, widened: ranked.widened, rows };
}
