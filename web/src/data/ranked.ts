// Ranked lists as rows (design/scale.md §2.1): for one item, every list it appears in and its place there, as a sort
// key that orders as a plain string (a list is read by its index, descending). The ranking Lambda writes these rows
// when an item's activity, stars or tags change; a local library computes them on the fly with the same functions.
// Pure (test/ranked.test.ts).
//
//   feed|top|<kind or all>      the home page's Top: worth (data/home-feed.ts), stars over all time
//   feed|recent|<kind or all>   the newest activity first
//   tag|<tag>|<window>          a tag's leaderboard: stars in the window (rated first), then the most rated, the newest
//   tags                        every tag, the most used first (one row per tag; its `ratings` is how many scores)
//   hidden                      what only curators see: items using a sample with no documented license (id only)

import { standing, totals, WINDOWS, type DayTally, type Standing, type Window } from "./rank-window";
import { worthOf, type HomeKind } from "./home-feed";

export type TargetType = "score" | "sample" | "clip";

/** Everything about an item its rows need: where it sorts, and what its card shows. */
export interface RankItem {
  targetType: TargetType;
  targetId: string;
  kind: HomeKind;
  title: string;
  owner: string | null;
  /** A score's path, or a sample's audio path ("samples/…"). */
  path: string | null;
  /** A clip: its sample's audio path and its stretch. */
  samplePath?: string | null;
  clipStart?: number | null;
  clipEnd?: number | null;
  tags: string[];
  /** Its latest activity, and what it was (the card's news line). */
  lastAt: string;
  lastWhat?: string | null;
  lastBy?: string | null;
  comments?: number | null;
  /** What it comes from, when its title alone doesn't say (a clip's sample: "Remixing is Okay"). */
  from?: string | null;
}

export interface RankedRow extends RankItem {
  id: string;
  list: string;
  sort: string;
  /** Its stars in the list's window. */
  stars: number | null;
  ratings: number;
}

/** The Bayesian prior the lists use (rank-window.ts `rank`). */
const PRIOR = 3;
const MEAN = 2.5;

/** An item's standing in every window, from its tally rows. */
export function standingsOf(targetId: string, tallies: DayTally[], now: Date): Record<Window, Standing> {
  const out = {} as Record<Window, Standing>;
  for (const w of WINDOWS) out[w] = standing(totals(tallies, w, now).get(targetId), MEAN, PRIOR);
  return out;
}

/** When it was last rated (ms), from its tally rows; 0 when never. */
function lastRated(tallies: DayTally[]): number {
  let day = "";
  for (const t of tallies) if (t.day !== "all" && t.count > 0 && t.day > day) day = t.day;
  return day ? Date.parse(day) : 0;
}

/** Every list an item appears in. A listening-cycle candidate (a fork tagged "candidate": scripts/cycle.py) is in
 *  none — it must stay out of the public feed and tag leaderboards until someone promotes it. */
export function listsOf(item: Pick<RankItem, "targetType" | "kind" | "tags">): string[] {
  if (item.tags.includes("candidate")) return [];
  const out = ["feed|top|all", `feed|top|${item.kind}`, "feed|recent|all", `feed|recent|${item.kind}`];
  if (item.targetType === "score") for (const t of item.tags) for (const w of WINDOWS) out.push(`tag|${t}|${w}`);
  return out;
}

export const rowId = (list: string, item: Pick<RankItem, "targetType" | "targetId">) => `${list}|${item.targetType}#${item.targetId}`;

/** A number as a fixed-width string, so it sorts as text: `places` decimals, `width` digits in all. */
const fixed = (n: number, width: number, places = 0) => String(Math.max(0, Math.round(n * 10 ** places))).padStart(width, "0");

/** Where the item sorts in `list` (higher sorts first). */
export function sortOf(list: string, item: RankItem, st: Record<Window, Standing>, ratedAt: number, now: Date): string {
  const [family, which] = list.split("|");
  if (family === "feed" && which === "top") {
    const touched = Math.max(Date.parse(item.lastAt) || 0, ratedAt);
    return `${fixed(worthOf(item.kind, st.all, touched, now), 9, 6)}|${item.lastAt}`;
  }
  if (family === "feed") return item.lastAt;
  const s = st[list.split("|")[2] as Window] ?? st.all;
  return `${s.count > 0 ? 1 : 0}|${fixed(s.score, 9, 6)}|${fixed(s.count, 7)}|${item.lastAt}`;
}

/** Every row of an item: one per list, with its sort key and its stars in the list's window. */
export function rowsFor(item: RankItem, tallies: DayTally[], now: Date): RankedRow[] {
  const st = standingsOf(item.targetId, tallies, now);
  const ratedAt = lastRated(tallies);
  return listsOf(item).map((list) => {
    const w = (list.startsWith("tag|") ? list.split("|")[2] : "all") as Window;
    return { ...item, id: rowId(list, item), list, sort: sortOf(list, item, st, ratedAt, now), stars: st[w].average, ratings: st[w].count };
  });
}

export const TAGS = "tags";
export const HIDDEN = "hidden";

/** A tag's row in the `tags` list: sorted by how many scores use it, then by name (A first). */
export function tagRow(tag: string, count: number, at: string): RankedRow {
  // Names sort A first while the list reads descending: each letter's code is flipped, and "~" (above any flipped
  // letter) ends it, so "tech" comes before "techno".
  const flipped = [...tag].map((c) => String.fromCharCode(0x7e - (c.charCodeAt(0) - 0x20))).join("") + "~";
  return {
    id: `${TAGS}|${tag}`,
    list: TAGS,
    sort: `${fixed(count, 7)}|${flipped}`,
    targetType: "score",
    targetId: `tag:${tag}`,
    kind: "song",
    title: tag,
    owner: null,
    path: null,
    tags: [],
    lastAt: at,
    stars: null,
    ratings: count,
  };
}

/** An item's row in the `hidden` list: just which item it is (nothing about it shows to those who can't see it). */
export function hiddenRow(item: Pick<RankItem, "targetType" | "targetId">, at: string): RankedRow {
  return {
    id: rowId(HIDDEN, item),
    list: HIDDEN,
    sort: `${item.targetType}#${item.targetId}`,
    targetType: item.targetType,
    targetId: item.targetId,
    kind: item.targetType === "score" ? "song" : item.targetType,
    title: "",
    owner: null,
    path: null,
    tags: [],
    lastAt: at,
    stars: null,
    ratings: 0,
  };
}

/** The tags an item's rows put it under (from its `tag|<tag>|all` rows' ids or lists). */
export function tagsIn(listsOrIds: string[]): Set<string> {
  const out = new Set<string>();
  for (const s of listsOrIds) {
    const [family, tag, window] = s.split("|");
    if (family === "tag" && window === "all" && tag) out.add(tag);
  }
  return out;
}

/** One list's rows, best first, from many items' rows (how a local library answers what the cloud's index does). */
export function listRows(rows: RankedRow[], list: string): RankedRow[] {
  return rows.filter((r) => r.list === list).sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0));
}
