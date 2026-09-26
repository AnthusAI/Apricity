// What one change to a Score, Sample, Clip, Rating or Comment means for the Activity page. Pure, so it is tested
// without AWS (test/activity-events.test.ts); handler.ts writes the result.
//
// The page shows one card per item (`<targetType>#<targetId>`), moved to the top by anything new about it, and a few
// lines per card (made, changed, rated, commented). Every line has an id built from what caused it, so a retried
// stream batch finds its line already there and changes nothing twice.

import { ratingOf } from "../tally/deltas";

export type TargetType = "sample" | "clip" | "score";
export type What = "made" | "changed" | "rated" | "commented" | "forked" | "copied";

/** What the item's own record says about it (to fill in its card). */
export interface CardInfo {
  title?: string;
  kind?: string;
  owner?: string;
  sampleId?: string;
}

export interface Change {
  /** The card: `<targetType>#<targetId>`. */
  key: string;
  targetType: TargetType;
  targetId: string;
  /** The line: `put` writes it (only if new, unless `overwrite`); `remove` deletes it (only if there). A line already
   *  written, or already gone, means this change was applied before: the counts are left alone. */
  line: { id: string; op: "put" | "remove"; overwrite?: boolean; what?: What; at: string; by?: string; stars?: number; commentId?: string; otherId?: string; otherTitle?: string };
  /** Move the card to the top (not for a take-back: an unrated or deleted comment doesn't bump). */
  bump: boolean;
  counts?: { comments?: number; ratings?: number; forks?: number };
  card?: CardInfo;
}

export type Image = Record<string, { S?: string; N?: string; BOOL?: boolean; NULL?: boolean }> | null | undefined;
const str = (img: Image, k: string) => img?.[k]?.S;
const bool = (img: Image, k: string) => img?.[k]?.BOOL === true;

export const cardKey = (targetType: string, targetId: string) => `${targetType}#${targetId}`;
const hour = (iso: string) => iso.slice(0, 13); // 2026-09-26T14

/** The model a stream comes from, by its table name (`Score-<api id>-NONE`). */
export function modelOf(tableArnOrName: string): string {
  const name = tableArnOrName.split("/").find((p) => /^[A-Za-z]+-/.test(p)) ?? tableArnOrName;
  return name.split("-")[0];
}

/** The Activity changes one stream record makes. */
export function changesOf(model: string, event: "INSERT" | "MODIFY" | "REMOVE", before: Image, after: Image, now = new Date().toISOString()): Change[] {
  const img = after ?? before;
  const id = str(img, "id");
  if (!id) return [];
  const at = (k: string) => str(after, k) ?? now;
  switch (model) {
    case "Score": {
      const key = cardKey("score", id);
      const card: CardInfo = { title: str(after, "title"), kind: str(after, "kind") ?? "song", owner: str(after, "owner") };
      if (event === "INSERT") {
        const parent = str(after, "forkOf");
        if (!parent) return [{ key, targetType: "score", targetId: id, bump: true, card, line: { id: `made#${key}`, op: "put", what: "made", at: at("createdAt"), by: card.owner } }];
        // A fork is news twice: a new score, and something that happened to the one it came from.
        return forked("score", key, id, parent, card, at("createdAt"));
      }
      // Only a new text is news: a kind change or an import re-run (the same text) says nothing.
      if (event === "MODIFY" && str(before, "text") !== str(after, "text")) {
        const by = card.owner;
        const when = at("updatedAt");
        return [{ key, targetType: "score", targetId: id, bump: true, card, line: { id: `changed#${key}#${by ?? ""}#${hour(when)}`, op: "put", overwrite: true, what: "changed", at: when, by } }];
      }
      return [];
    }
    case "Sample": {
      if (event !== "INSERT") return [];
      const key = cardKey("sample", id);
      const card: CardInfo = { title: str(after, "title"), kind: "sample", owner: str(after, "owner") };
      return [{ key, targetType: "sample", targetId: id, bump: true, card, line: { id: `made#${key}`, op: "put", what: "made", at: at("createdAt"), by: card.owner } }];
    }
    case "Clip": {
      // Clips people make; automatic markup's (source ml) aren't news.
      if (event !== "INSERT" || str(after, "source") === "ml") return [];
      const key = cardKey("clip", id);
      const card: CardInfo = { title: str(after, "name"), kind: "clip", owner: str(after, "owner"), sampleId: str(after, "sampleId") };
      const parent = str(after, "copyOf");
      if (parent) return forked("clip", key, id, parent, card, at("createdAt"));
      return [{ key, targetType: "clip", targetId: id, bump: true, card, line: { id: `made#${key}`, op: "put", what: "made", at: at("createdAt"), by: card.owner } }];
    }
    case "Rating": {
      const was = ratingOf(before as any);
      const is = ratingOf(after as any);
      const r = is ?? was;
      if (!r || !isTarget(r.targetType)) return [];
      const key = cardKey(r.targetType, r.targetId);
      const by = str(img, "owner");
      const lineId = `rated#${key}#${by}`;
      if (!is) return [{ key, targetType: r.targetType, targetId: r.targetId, bump: false, counts: { ratings: -1 }, line: { id: lineId, op: "remove", at: now } }];
      // A new rating counts; a changed one replaces its line and moves the card up again.
      return [{ key, targetType: is.targetType as TargetType, targetId: is.targetId, bump: true, counts: was ? undefined : { ratings: 1 }, line: { id: lineId, op: "put", overwrite: !!was, what: "rated", at: is.ratedAt, by, stars: is.stars } }];
    }
    case "Comment": {
      const targetType = str(img, "targetType");
      const targetId = str(img, "targetId");
      if (!targetType || !targetId || !isTarget(targetType)) return [];
      const key = cardKey(targetType, targetId);
      const gone = (i: Image) => !i || bool(i, "deleted");
      if (event === "INSERT" && !gone(after))
        return [{ key, targetType, targetId, bump: true, counts: { comments: 1 }, line: { id: `comment#${id}`, op: "put", what: "commented", at: at("createdAt"), by: str(after, "owner"), commentId: id } }];
      // Deleted (flagged, or removed outright): its line goes, and the count drops only if the line was still there.
      if (!gone(before) && gone(after))
        return [{ key, targetType, targetId, bump: false, counts: { comments: -1 }, line: { id: `comment#${id}`, op: "remove", at: now } }];
      return [];
    }
  }
  return [];
}

const isTarget = (t: string): t is TargetType => t === "sample" || t === "clip" || t === "score";

/**
 * A fork of a score (or someone's copy of a clip): a line on its own card ("@bo forked beat-1") and one on the
 * original's ("@bo forked it as beat-1b"), which moves the original up and counts it.
 */
function forked(type: "score" | "clip", key: string, id: string, parent: string, card: CardInfo, at: string): Change[] {
  const what: What = type === "score" ? "forked" : "copied";
  const parentKey = cardKey(type, parent);
  return [
    { key, targetType: type, targetId: id, bump: true, card, line: { id: `${what}#${key}`, op: "put", what, at, by: card.owner, otherId: parent } },
    {
      key: parentKey,
      targetType: type,
      targetId: parent,
      bump: true,
      counts: { forks: 1 },
      line: { id: `${type === "score" ? "fork" : "copy"}#${parentKey}#${id}`, op: "put", what, at, by: card.owner, otherId: id, ...(card.title ? { otherTitle: card.title } : {}) },
    },
  ];
}
