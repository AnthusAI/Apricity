// Ranking by star ratings inside a time window (reddit-style "top of the week").
//
// Ratings are private; what is public is a tally per item per UTC day (plus one all-time row), kept by the
// Rating stream Lambda (amplify/functions/tally). A window sums the day rows since its start. Items are ordered by a
// Bayesian average, so one 5-star vote cannot top a list of well-rated work: score = (C·m + sum) / (C + n), where every
// item starts from C imaginary middle-of-the-road votes (m = 2.5 stars). A neutral prior, not the site's mean: with few
// ratings the mean is itself noise, and a high mean would let a single 5-star vote win.
//
// A quiet window widens by itself (week → month → year → all time) until enough items are rated, and says so.
// Unrated items always follow the rated ones, newest first, so a list is never empty.

export type Window = "week" | "month" | "year" | "all";
export const WINDOWS: Window[] = ["week", "month", "year", "all"];
export const WINDOW_LABEL: Record<Window, string> = { week: "Week", month: "Month", year: "Year", all: "All" };

/** One tally row: `day` is `YYYY-MM-DD` (UTC) or `all`. */
export interface DayTally {
  targetId: string;
  day: string;
  count: number;
  sum: number;
}

export interface Standing {
  count: number;
  sum: number;
  /** The plain average in the window, or null when nobody rated it there. */
  average: number | null;
  /** The Bayesian score used for ordering (0 when unrated). */
  score: number;
}

export interface Rankable {
  id: string;
  createdAt?: string | null;
}

export interface Ranked<T> {
  /** The window actually shown (wider than asked when the asked one was quiet). */
  window: Window;
  asked: Window;
  widened: boolean;
  rows: Array<{ item: T; standing: Standing }>;
}

export interface RankOptions {
  /** Weight of the prior, in votes. */
  prior?: number;
  /** The prior's star rating. */
  mean?: number;
  /** A window counts as busy once this many items are rated in it (or every rated item, if fewer). */
  enough?: number;
}

const DAYS: Record<Exclude<Window, "all">, number> = { week: 7, month: 30, year: 365 };

/** The UTC day a timestamp falls on: the tally key. */
export const dayOf = (iso: string | Date): string => new Date(iso).toISOString().slice(0, 10);

/** The first day inside a window (inclusive), or null for all time. A week is today and the six days before it. */
export function windowStart(w: Window, now: Date): string | null {
  if (w === "all") return null;
  return dayOf(new Date(now.getTime() - (DAYS[w] - 1) * 86_400_000));
}

/** Count and star sum per item inside a window. */
export function totals(tallies: DayTally[], w: Window, now: Date): Map<string, { count: number; sum: number }> {
  const start = windowStart(w, now);
  const out = new Map<string, { count: number; sum: number }>();
  for (const t of tallies) {
    const inside = start === null ? t.day === "all" : t.day !== "all" && t.day >= start;
    if (!inside || t.count <= 0) continue;
    const cur = out.get(t.targetId) ?? { count: 0, sum: 0 };
    cur.count += t.count;
    cur.sum += t.sum;
    out.set(t.targetId, cur);
  }
  return out;
}

export function standing(t: { count: number; sum: number } | undefined, mean: number, prior: number): Standing {
  if (!t || t.count <= 0) return { count: 0, sum: 0, average: null, score: 0 };
  return { count: t.count, sum: t.sum, average: t.sum / t.count, score: (prior * mean + t.sum) / (prior + t.count) };
}

const newest = (a: Rankable, b: Rankable) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "");

/** Order items for a window, widening it when it is quiet. */
export function rank<T extends Rankable>(items: T[], tallies: DayTally[], asked: Window, now: Date, opts: RankOptions = {}): Ranked<T> {
  const prior = opts.prior ?? 3;
  const ids = new Set(items.map((i) => i.id));
  const mine = tallies.filter((t) => ids.has(t.targetId));
  const mean = opts.mean ?? 2.5;
  const ratedEver = totals(mine, "all", now).size;
  const enough = Math.min(opts.enough ?? 5, ratedEver);

  let window = asked;
  let sums = totals(mine, window, now);
  while (enough > 0 && sums.size < enough && window !== "all") {
    window = WINDOWS[WINDOWS.indexOf(window) + 1];
    sums = totals(mine, window, now);
  }

  const rows = items.map((item) => ({ item, standing: standing(sums.get(item.id), mean, prior) }));
  rows.sort((a, b) => {
    const ra = a.standing.count > 0 ? 1 : 0;
    const rb = b.standing.count > 0 ? 1 : 0;
    if (ra !== rb) return rb - ra;
    if (ra) {
      if (b.standing.score !== a.standing.score) return b.standing.score - a.standing.score;
      if (b.standing.count !== a.standing.count) return b.standing.count - a.standing.count;
    }
    return newest(a.item, b.item);
  });
  return { window, asked, widened: window !== asked, rows };
}

/** The note shown above a widened list, e.g. "Quiet week — showing top of the month". */
export function widenedNote(r: Pick<Ranked<unknown>, "asked" | "window" | "widened">): string | null {
  if (!r.widened) return null;
  const top = r.window === "all" ? "all time" : `the ${r.window}`;
  return `Quiet ${r.asked} — showing top of ${top}`;
}
