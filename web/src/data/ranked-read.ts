// Reading a ranked list a page at a time (design/scale.md): in the cloud, one indexed query of the Ranked table (kept
// by the ranking Lambda); locally, the same rows computed from the library's scores and ratings with the same
// functions (ranked.ts), paged the same way.

import { client, mode } from "./client.js";
import { rowsFor, listRows, type RankedRow } from "./ranked.js";
import type { ScoreItem } from "./catalog.js";

export interface RankedPage {
  rows: RankedRow[];
  /** Where the next page starts; null at the end. */
  next: string | null;
}

export const PAGE = 24;

/** One page of `list`, best first. */
export async function rankedPage(list: string, next: string | null = null, limit = PAGE): Promise<RankedPage> {
  if (mode() === "local") return localPage(list, next, limit);
  const r = await client().models.Ranked.rankedByList({ list }, { sortDirection: "DESC", limit, nextToken: next });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  return { rows: ((r.data ?? []) as unknown as RankedRow[]).map((x) => ({ ...x, tags: (x.tags ?? []).filter(Boolean) })), next: r.nextToken ?? null };
}

/**
 * Locally: every score's rows (a library has no Activity cards: a score's news is its last change), computed afresh
 * when they're a few seconds old (a score saved, retitled or tagged since), else reused while pages are read.
 */
let local: Promise<RankedRow[]> | null = null;
let localAt = 0;
async function localRows(): Promise<RankedRow[]> {
  if (Date.now() - localAt > 5_000) local = null;
  localAt = local ? localAt : Date.now();
  local ??= (async () => {
    const [{ api, ratings }] = await Promise.all([import("../apricity.js")]);
    const [{ scores }, tallies] = await Promise.all([api.scores(), ratings().then((r) => r.tallies("score")).catch(() => [])]);
    const now = new Date();
    return scores.flatMap((s: ScoreItem) =>
      rowsFor(
        {
          targetType: "score",
          targetId: s.id,
          kind: s.kind,
          title: s.title,
          owner: s.owner,
          path: s.path,
          tags: s.tags,
          lastAt: new Date((s.modified || Date.parse(s.createdAt ?? "") / 1000 || 0) * 1000).toISOString(),
          lastWhat: "changed",
        },
        tallies.filter((t) => t.targetId === s.id),
        now,
      ),
    );
  })();
  local.catch(() => (local = null));
  return local;
}

async function localPage(list: string, next: string | null, limit: number): Promise<RankedPage> {
  const rows = listRows(await localRows(), list);
  const at = Number(next ?? 0);
  return { rows: rows.slice(at, at + limit), next: at + limit < rows.length ? String(at + limit) : null };
}

/** Forget the local rows (a score or a rating changed). */
export function forgetRanked() {
  local = null;
}
if (typeof document !== "undefined") {
  document.addEventListener("apricity:rated", forgetRanked);
  document.addEventListener("apricity:auth-changed", forgetRanked);
}
