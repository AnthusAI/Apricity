// Narrowing and ordering the Clips list for curating: by stars (yours or everyone's), when it was added, what kind of
// clip it is, who made it, its sample and its length; sorted by stars, date, length or your own rating. The choice
// lives in the URL's query (/clips?kind=loop&stars=unrated-by-me), so a curated view can be linked. Pure (tested in
// test/clip-filter.test.ts).

import { owns, type ClipItem, type Me } from "./catalog";
import type { Standing } from "./rank-window";

export const CLIP_KINDS = ["loop", "break", "phrase", "section", "chop", "hit"] as const;
export type ClipKind = (typeof CLIP_KINDS)[number];
export const KIND_LABEL: Record<ClipKind, string> = { loop: "Loops", break: "Breaks", phrase: "Phrases", section: "Sections", chop: "Chops", hit: "One-shots" };

export type StarsFilter = "any" | "unrated-by-me" | "unrated" | "1" | "2" | "3" | "4" | "5";
export type AddedFilter = "any" | "week" | "month" | "year";
export type OriginFilter = "any" | "auto" | "mine" | "others";
export type LengthFilter = "any" | "short" | "medium" | "long";
export type ClipSort = "top" | "mine" | "newest" | "oldest" | "longest" | "shortest";

export interface ClipFilter {
  stars: StarsFilter;
  added: AddedFilter;
  kind: ClipKind | "any";
  origin: OriginFilter;
  /** A sample's path, or "" for every sample. */
  sample: string;
  length: LengthFilter;
  sort: ClipSort;
}

export const DEFAULT_FILTER: ClipFilter = { stars: "any", added: "any", kind: "any", origin: "any", sample: "", length: "any", sort: "top" };

/** The choices each filter offers, with their labels (the first is the default). */
export const CHOICES = {
  stars: [["any", "Any stars"], ["unrated-by-me", "Not rated by me"], ["unrated", "Nobody rated"], ["1", "★ 1+"], ["2", "★ 2+"], ["3", "★ 3+"], ["4", "★ 4+"], ["5", "★ 5"]],
  added: [["any", "Any time"], ["week", "Added this week"], ["month", "Added this month"], ["year", "Added this year"]],
  kind: [["any", "Any kind"], ...CLIP_KINDS.map((k) => [k, KIND_LABEL[k]] as const)],
  origin: [["any", "Anyone's"], ["auto", "Found automatically"], ["mine", "Mine"], ["others", "Other people's"]],
  length: [["any", "Any length"], ["short", "Under 1 s"], ["medium", "1–8 s"], ["long", "Over 8 s"]],
  sort: [["top", "Top rated"], ["mine", "My stars"], ["newest", "Newest"], ["oldest", "Oldest"], ["longest", "Longest"], ["shortest", "Shortest"]],
} as const satisfies Record<Exclude<keyof ClipFilter, "sample">, readonly (readonly [string, string])[]>;

const DAYS: Record<Exclude<AddedFilter, "any">, number> = { week: 7, month: 30, year: 365 };

/** Read a filter from a URL query ("kind=loop&stars=4"); anything unknown is left at its default. */
export function parseFilter(query: string): ClipFilter {
  const q = new URLSearchParams(query);
  const f: ClipFilter = { ...DEFAULT_FILTER };
  for (const key of Object.keys(CHOICES) as (keyof typeof CHOICES)[]) {
    const v = q.get(key);
    if (v && CHOICES[key].some(([c]) => c === v)) (f as unknown as Record<string, string>)[key] = v;
  }
  f.sample = q.get("sample") ?? "";
  return f;
}

/** The query for a filter, only what differs from the defaults ("" for none). */
export function filterQuery(f: ClipFilter): string {
  const q = new URLSearchParams();
  for (const key of Object.keys(DEFAULT_FILTER) as (keyof ClipFilter)[]) if (f[key] !== DEFAULT_FILTER[key]) q.set(key, f[key]);
  return q.toString();
}

/** A clip's kind: from the record, else its name ("loop-3"). */
export function kindOf(c: Pick<ClipItem, "kind" | "name">): ClipKind | null {
  const k = c.kind ?? c.name.replace(/-\d+$/, "");
  return (CLIP_KINDS as readonly string[]).includes(k) ? (k as ClipKind) : null;
}

export interface FilterContext {
  me: Me | null;
  /** Your stars by clip id. */
  mine: Map<string, number>;
  now: Date;
}

type Row = { item: ClipItem; standing: Standing };

/** Keep the rows the filter allows, in the order it asks for (the rows come ranked, which is "top"). */
export function applyClipFilter<R extends Row>(rows: R[], f: ClipFilter, ctx: FilterContext): R[] {
  const since = f.added === "any" ? null : new Date(ctx.now.getTime() - DAYS[f.added] * 86_400_000).toISOString();
  const len = (c: ClipItem) => c.end - c.start;
  const kept = rows.filter(({ item: c, standing }) => {
    if (f.stars === "unrated-by-me" && ctx.mine.has(c.id)) return false;
    if (f.stars === "unrated" && standing.count > 0) return false;
    if (/^\d$/.test(f.stars) && (standing.average ?? -1) < Number(f.stars)) return false;
    if (since && (c.createdAt ?? "") < since) return false;
    if (f.kind !== "any" && kindOf(c) !== f.kind) return false;
    if (f.origin === "auto" && c.source !== "ml") return false;
    if (f.origin === "mine" && !owns(ctx.me, c.owner)) return false;
    if (f.origin === "others" && (c.source === "ml" || owns(ctx.me, c.owner))) return false;
    if (f.sample && c.samplePath !== f.sample) return false;
    if (f.length === "short" && len(c) >= 1) return false;
    if (f.length === "medium" && (len(c) < 1 || len(c) > 8)) return false;
    if (f.length === "long" && len(c) <= 8) return false;
    return true;
  });
  const by: Record<Exclude<ClipSort, "top">, (a: R, b: R) => number> = {
    mine: (a, b) => (ctx.mine.get(b.item.id) ?? -1) - (ctx.mine.get(a.item.id) ?? -1),
    newest: (a, b) => (b.item.createdAt ?? "").localeCompare(a.item.createdAt ?? ""),
    oldest: (a, b) => (a.item.createdAt ?? "").localeCompare(b.item.createdAt ?? ""),
    longest: (a, b) => len(b.item) - len(a.item),
    shortest: (a, b) => len(a.item) - len(b.item),
  };
  // A stable sort, so ties keep the ranked order.
  return f.sort === "top" ? kept : kept.sort(by[f.sort]);
}
