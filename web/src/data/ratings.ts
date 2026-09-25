// Star ratings in the data layer: your own ratings (private Rating records) and everyone's tallies (public Tally
// records, kept by the tally Lambda). Locally (`apricity serve`) there is no Lambda, so tallies are summed from the
// ratings themselves.

import { listAll } from "./catalog";
import type { DayTally } from "./rank-window";
import { tallyDeltas } from "../../amplify/functions/tally/deltas";

export type Target = "sample" | "clip" | "score";

export interface RatingRecord {
  id: string;
  targetType: Target;
  targetId: string;
  stars: number;
  ratedAt: string;
  owner?: string | null;
}

export interface RatingsDeps {
  client: () => any;
  /** Who is rating: the value their rating ids end with (the Cognito username), or null for a guest. */
  who: () => Promise<string | null>;
  /** "local" sums tallies from the ratings (no Lambda there). */
  mode: () => "local" | "cloud";
  now?: () => Date;
}

/** A person's one rating of an item has this id (the tally Lambda counts no other). */
export const ratingId = (type: Target, targetId: string, who: string) => `${type}#${targetId}#${who}`;

/** Tally rows computed from rating records (what the Lambda would have written). */
export function talliesFrom(ratings: Pick<RatingRecord, "targetType" | "targetId" | "stars" | "ratedAt">[]): DayTally[] {
  const rows = new Map<string, DayTally>();
  for (const r of ratings)
    for (const d of tallyDeltas(null, r)) {
      const key = `${d.targetId}\u0000${d.day}`;
      const cur = rows.get(key) ?? { targetId: d.targetId, day: d.day, count: 0, sum: 0 };
      cur.count += d.count;
      cur.sum += d.sum;
      rows.set(key, cur);
    }
  return [...rows.values()];
}

export class Ratings {
  private mine: Promise<Map<string, RatingRecord>> | null = null;
  private tallyCache = new Map<Target, Promise<DayTally[]>>();
  constructor(private deps: RatingsDeps) {}

  /** Forget what was loaded (after sign-in or sign-out). */
  reset() {
    this.mine = null;
    this.tallyCache.clear();
  }

  private get models() {
    return this.deps.client().models;
  }

  /** Everyone's tally rows for one kind of item. */
  tallies(type: Target): Promise<DayTally[]> {
    let p = this.tallyCache.get(type);
    if (!p) {
      p =
        this.deps.mode() === "local"
          ? listAll<RatingRecord>((nextToken) => this.models.Rating.list({ limit: 1000, nextToken })).then((rs) => talliesFrom(rs.filter((r) => r.targetType === type)))
          : listAll<DayTally & { targetType: Target }>((nextToken) => this.models.Tally.talliesByTypeAndDay({ targetType: type }, { limit: 1000, nextToken })).then(
              (rows) => rows.map(({ targetId, day, count, sum }) => ({ targetId, day, count, sum })),
            );
      p.catch(() => this.tallyCache.delete(type));
      this.tallyCache.set(type, p);
    }
    return p;
  }

  /** Your ratings, by `<type>#<targetId>` (empty for a guest). */
  private myRatings(): Promise<Map<string, RatingRecord>> {
    this.mine ??= (async () => {
      const who = await this.deps.who();
      if (!who) return new Map<string, RatingRecord>();
      const rs = await listAll<RatingRecord>((nextToken) => this.models.Rating.list({ limit: 1000, nextToken }));
      return new Map(rs.filter((r) => r.id === ratingId(r.targetType, r.targetId, who)).map((r) => [`${r.targetType}#${r.targetId}`, r]));
    })();
    this.mine.catch(() => (this.mine = null));
    return this.mine;
  }

  /** Your stars for an item, or null. */
  async mineFor(type: Target, targetId: string): Promise<number | null> {
    return (await this.myRatings()).get(`${type}#${targetId}`)?.stars ?? null;
  }

  /** Rate an item 0–5 stars, or take the rating back with null. */
  async rate(type: Target, targetId: string, stars: number | null): Promise<void> {
    const who = await this.deps.who();
    if (!who) throw new Error("Sign in to rate");
    if (stars !== null && !(Number.isInteger(stars) && stars >= 0 && stars <= 5)) throw new Error("A rating is 0 to 5 stars");
    const id = ratingId(type, targetId, who);
    const mine = await this.myRatings();
    const had = mine.get(`${type}#${targetId}`);
    const check = (r: { errors?: { message?: string }[] }) => {
      if (r?.errors?.length) throw new Error(r.errors.map((e) => e.message).join("; "));
    };
    if (stars === null) {
      if (had) check(await this.models.Rating.delete({ id }));
      mine.delete(`${type}#${targetId}`);
    } else {
      const rec = { id, targetType: type, targetId, stars, ratedAt: (this.deps.now?.() ?? new Date()).toISOString() };
      check(had ? await this.models.Rating.update(rec) : await this.models.Rating.create(rec));
      mine.set(`${type}#${targetId}`, rec);
    }
    // The tallies change a moment later (the Lambda); locally they are sums of the ratings, so drop them now.
    this.tallyCache.delete(type);
  }
}
