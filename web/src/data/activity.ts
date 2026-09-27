// The Activity page's data: cards (one per item, newest activity first), each card's latest lines, its star tally and
// its newest comment. All of it is written by the activity Lambda (amplify/functions/activity); the page only reads.

import { client } from "./client.js";
import type { CommentRow } from "./comments.js";
import type { DayTally, Standing } from "./rank-window.js";
import { homeRank, KIND_WEIGHT, type HomeKind } from "./home-feed.js";

export type ItemType = "sample" | "clip" | "score";

export interface Card {
  id: string;
  targetType: ItemType;
  targetId: string;
  title?: string | null;
  kind?: string | null;
  owner?: string | null;
  samplePath?: string | null;
  lastAt: string;
  lastWhat?: string | null;
  lastBy?: string | null;
  comments?: number | null;
  ratings?: number | null;
  forks?: number | null;
}

export interface Line {
  id: string;
  targetKey: string;
  at: string;
  what: string;
  by?: string | null;
  stars?: number | null;
  commentId?: string | null;
  otherId?: string | null;
  otherTitle?: string | null;
}

/** The filter chips, and the `kind` each one lists. */
export const FILTERS: { label: string; kind: string | null }[] = [
  { label: "All", kind: null },
  { label: "Scores", kind: "song" },
  { label: "Beats", kind: "beat" },
  { label: "Chords", kind: "chords" },
  { label: "Melodies", kind: "melody" },
  { label: "Samples", kind: "sample" },
  { label: "Clips", kind: "clip" },
];

/** What a card is, as its label says: Score, Beat, Chords, Melody, Sample, Clip. */
export function kindName(card: Pick<Card, "targetType" | "kind">): string {
  const k = card.kind ?? card.targetType;
  return { song: "Score", beat: "Beat", chords: "Chords", melody: "Melody", sample: "Sample", clip: "Clip" }[k] ?? "Score";
}

/**
 * A line as words, after its author: "made it", "added it", "rated it ★★★★☆", "commented", and for forks, on the
 * fork's card "forked “beat-1”", on the original's "forked it as “beat-1b”" (clips: "copied").
 */
export function lineText(line: Pick<Line, "what" | "stars"> & Partial<Pick<Line, "id" | "otherTitle">>, type: ItemType): string {
  if (line.what === "forked" || line.what === "copied") {
    const other = line.otherTitle ? `“${line.otherTitle}”` : type === "clip" ? "a clip" : "a score";
    const onOriginal = /^(fork|copy)#/.test(line.id ?? "");
    return onOriginal ? `${line.what} it as ${other}` : `${line.what} ${other}`;
  }
  switch (line.what) {
    case "made":
      return type === "sample" ? "added it" : "made it";
    case "changed":
      return "changed it";
    case "rated": {
      const n = Math.max(0, Math.min(5, line.stars ?? 0));
      return `rated it ${"★".repeat(n)}${"☆".repeat(5 - n)}`;
    }
    case "commented":
      return "commented";
    default:
      return line.what;
  }
}

/** A page of cards, newest activity first (`kind`: one of FILTERS). */
export async function cards(kind: string | null, nextToken?: string | null): Promise<{ items: Card[]; nextToken: string | null }> {
  const r = await client().models.Activity.activityByFeed(
    { feed: "all" },
    { sortDirection: "DESC", limit: 20, nextToken: nextToken ?? null, ...(kind ? { filter: { kind: { eq: kind } } } : {}) },
  );
  if (r.errors?.length) throw new Error(r.errors[0].message);
  return { items: (r.data ?? []) as Card[], nextToken: r.nextToken ?? null };
}

/** A card's latest lines, newest first. */
export async function linesOf(key: string, limit = 3): Promise<Line[]> {
  const r = await client().models.ActivityEvent.eventsByTarget({ targetKey: key }, { sortDirection: "DESC", limit });
  return (r.data ?? []) as Line[];
}

/** An item's all-time stars: average and count. */
export async function starsOf(type: ItemType, id: string): Promise<{ average: number | null; count: number }> {
  const r = await client().models.Tally.get({ id: `${type}#${id}#all` });
  const t = r.data as { count?: number; sum?: number } | null;
  return t?.count ? { average: (t.sum ?? 0) / t.count, count: t.count } : { average: null, count: 0 };
}

/** An item's newest comment still there (for the card's preview). */
export async function newestComment(targetId: string): Promise<CommentRow | null> {
  const r = await client().models.Comment.commentsByTarget({ targetId }, { sortDirection: "DESC", limit: 5 });
  return ((r.data ?? []) as CommentRow[]).find((c) => !c.deleted) ?? null;
}

/** Every card, newest activity first (all the pages; `max` stops a runaway feed). */
export async function allCards(kind: string | null, max = 1000): Promise<Card[]> {
  const out: Card[] = [];
  let token: string | null = null;
  do {
    const page = await cards(kind, token);
    out.push(...page.items);
    token = page.nextToken;
  } while (token && out.length < max);
  return out;
}

/**
 * The "Top" order: the home page's ranking (data/home-feed.ts): stars in the week (widening when quiet), songs first
 * and everything else weighted far down, fresh activity lifted a little. Unrated cards follow by their latest activity.
 */
export function topCards(list: Card[], tallies: DayTally[], now: Date): { card: Card; standing: Standing }[] {
  const kindOf = (c: Card): HomeKind => {
    const k = c.kind ?? c.targetType;
    return (k in KIND_WEIGHT ? k : c.targetType === "score" ? "song" : c.targetType) as HomeKind;
  };
  const items = list.map((card) => ({ id: card.targetId, createdAt: card.lastAt, modified: Date.parse(card.lastAt) / 1000 || 0, kind: kindOf(card), card }));
  return homeRank(items, tallies, "week", now).rows.map(({ item, standing }) => ({ card: item.card, standing }));
}
