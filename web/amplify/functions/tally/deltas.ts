// What one change to a Rating does to the public tallies. Pure, so it is tested without AWS.
//
// Each rating counts once in the tally row for the UTC day it was last set, and once in the item's `all` row.
// Changing a rating moves it to today's row (the old day loses it) and adjusts the all-time sum; deleting removes it.

export interface RatingImage {
  targetType: string;
  targetId: string;
  stars: number;
  ratedAt: string;
}

export interface TallyDelta {
  targetType: string;
  targetId: string;
  day: string;
  count: number;
  sum: number;
}

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const clamp = (stars: number) => Math.max(0, Math.min(5, Math.round(stars)));

/** The tally changes for a stream record: `before` is absent on insert, `after` on delete. */
export function tallyDeltas(before?: RatingImage | null, after?: RatingImage | null): TallyDelta[] {
  const out = new Map<string, TallyDelta>();
  const add = (r: RatingImage, d: string, count: number, sum: number) => {
    const key = `${r.targetType}\u0000${r.targetId}\u0000${d}`;
    const cur = out.get(key) ?? { targetType: r.targetType, targetId: r.targetId, day: d, count: 0, sum: 0 };
    cur.count += count;
    cur.sum += sum;
    out.set(key, cur);
  };
  if (before) {
    add(before, day(before.ratedAt), -1, -clamp(before.stars));
    add(before, "all", -1, -clamp(before.stars));
  }
  if (after) {
    add(after, day(after.ratedAt), 1, clamp(after.stars));
    add(after, "all", 1, clamp(after.stars));
  }
  return [...out.values()].filter((d) => d.count !== 0 || d.sum !== 0);
}

type Image = Record<string, { S?: string; N?: string }> | null | undefined;

/**
 * A Rating stream image, or null when it isn't one a tally counts. A rating's id must be
 * `<targetType>#<targetId>#<who>`, where `who` is its owner (AppSync sets the owner from the caller's token, as
 * `<username>` or `<sub>::<username>`; either part will do). Any other id would let one person rate an item twice.
 */
export function ratingOf(img: Image): RatingImage | null {
  const s = (k: string) => img?.[k]?.S;
  const n = (k: string) => (img?.[k]?.N === undefined ? undefined : Number(img[k]!.N));
  const id = s("id");
  const owner = s("owner");
  const targetType = s("targetType");
  const targetId = s("targetId");
  const stars = n("stars");
  const ratedAt = s("ratedAt");
  if (!id || !owner || !targetType || !targetId || stars === undefined || Number.isNaN(stars) || !ratedAt) return null;
  const prefix = `${targetType}#${targetId}#`;
  if (!id.startsWith(prefix)) return null;
  const who = id.slice(prefix.length);
  if (who !== owner && !owner.split("::").includes(who)) return null;
  return { targetType, targetId, stars, ratedAt };
}

/** The Tally record id for a row. */
export const tallyId = (d: Pick<TallyDelta, "targetType" | "targetId" | "day">) => `${d.targetType}#${d.targetId}#${d.day}`;
