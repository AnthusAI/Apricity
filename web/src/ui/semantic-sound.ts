/**
 * Pure reconciliation between semantic retrieval and the current section records.  Retrieval
 * is authoritative for relevance order; the loaded entries are authoritative for what a card
 * is allowed to name, link, rate, and play.
 */
import { applyClipFilter, type ClipFilter, type FilterContext } from "../data/clip-filter";
import type { Standing } from "../data/rank-window";
import type { Entry } from "../data/sections";
import type { SemanticSearchHit } from "../semantic/contracts";
import type { HybridSearchState } from "../semantic/hybrid-controller";
import { sampleKey } from "../route";

export interface SemanticSoundMatch { hit: SemanticSearchHit; entry: Entry; }

/** Canonical destinations used by cards; clip results always retain a parent sample route. */
export function semanticSoundRoutes(match: SemanticSoundMatch) {
  const clip = match.entry.clip;
  const path = match.entry.base.samplePath ?? match.entry.base.path ?? match.hit.parent.samplePath;
  return {
    path,
    card: clip ? { page: "clips" as const, clip: { sample: sampleKey(path), name: clip.name } } : { page: "samples" as const, sample: sampleKey(path) },
    parent: { page: "samples" as const, sample: sampleKey(path) },
  };
}

/** Applies the section Mine selection before reconciliation, without changing semantic rank. */
export function semanticEntriesForView(entries: readonly Entry[], mine: boolean, local: boolean, isMine: (entry: Entry) => boolean): Entry[] {
  return mine && !local ? entries.filter(isMine) : [...entries];
}

/** The sound host's independently observable state.  It deliberately does not depend on lexical cards. */
export function soundHostState(query: string, state: HybridSearchState, catalogReady: boolean, catalogError?: unknown):
  { kind: "hidden" | "results" } | { kind: "status" | "waiting" | "error" | "empty"; text: string } {
  if (!query || state.query !== query || state.phase === "idle") return { kind: "hidden" };
  if (catalogError) return { kind: "error", text: "Sound cards unavailable. Retry" };
  if (state.phase === "ready") return catalogReady
    ? state.hits?.length ? { kind: "results" } : { kind: "empty", text: `No sound matches “${query}”.` }
    : { kind: "waiting", text: "Preparing sound matches…" };
  if (state.phase === "error") return { kind: "error", text: "Sound matches unavailable. Retry" };
  const progress = state.progress;
  const percent = progress?.total ? ` ${Math.round((progress.loaded / progress.total) * 100)}%` : "";
  if (progress?.phase === "cache_unavailable") return { kind: "status", text: "Model cache unavailable; downloading for this browser session…" };
  if (state.phase === "debouncing") return { kind: "status", text: "Sound matches will search after typing pauses." };
  if (state.phase === "searching") return { kind: "status", text: "Finding sound matches…" };
  if (state.phase === "loading_model") return { kind: "status", text: "Preparing sound matches — first download is about 502 MB…" };
  return { kind: "status", text: `Loading sound model${percent}…` };
}

/** Saved clips only, with normal Clips filters applied without changing semantic score order. */
export function semanticClipHits(
  hits: readonly SemanticSearchHit[],
  entries: readonly Entry[],
  filter: ClipFilter,
  context: FilterContext,
  standings: ReadonlyMap<string, Standing>,
): SemanticSoundMatch[] {
  const clips = new Map(entries.filter((entry) => entry.clip).map((entry) => [entry.clip!.id, entry]));
  const candidates = hits.flatMap((hit) => {
    if (hit.identity.kind !== "saved_clip" || !hit.identity.clipId) return [];
    const entry = clips.get(hit.identity.clipId);
    const clip = entry?.clip;
    // A saved-clip vector is only valid for its current parent and exact canonical cut.
    return clip && hit.parent.sampleId === clip.sampleId && hit.identity.start === clip.start && hit.identity.end === clip.end
      ? [{ hit, entry, item: clip, standing: standings.get(clip.id) ?? { average: null, count: 0, sum: 0, score: 0 } }]
      : [];
  });
  // `top` intentionally means retain incoming retrieval order. Other list sort controls must
  // never turn a sound-relevance list into a rating/date/length list.
  const allowed = new Set(applyClipFilter(candidates, { ...filter, sort: "top" }, context).map((candidate) => candidate.hit.identity.semanticId));
  return candidates.filter((candidate) => allowed.has(candidate.hit.identity.semanticId)).map(({ hit, entry }) => ({ hit, entry }));
}

/** One best passage per visible current sample, in semantic score order. */
export function semanticSampleHits(hits: readonly SemanticSearchHit[], entries: readonly Entry[]): SemanticSoundMatch[] {
  const samples = new Map(entries.filter((entry) => entry.sample).map((entry) => [entry.sample!.id, entry]));
  const best = new Map<string, { hit: SemanticSearchHit; entry: Entry; index: number }>();
  hits.forEach((hit, index) => {
    const entry = samples.get(hit.parent.sampleId);
    if (!entry) return;
    const previous = best.get(entry.id);
    if (!previous || hit.score > previous.hit.score) best.set(entry.id, { hit, entry, index });
  });
  return [...best.values()].sort((a, b) => a.index - b.index).map(({ hit, entry }) => ({ hit, entry }));
}

/** Global search keeps clips and unsaved passages visibly separate. */
export function semanticGlobalHits(hits: readonly SemanticSearchHit[], clipEntries: readonly Entry[], sampleEntries: readonly Entry[]): { clips: SemanticSoundMatch[]; passages: SemanticSoundMatch[] } {
  const clips = new Map(clipEntries.filter((entry) => entry.clip).map((entry) => [entry.clip!.id, entry]));
  const samples = new Map(sampleEntries.filter((entry) => entry.sample).map((entry) => [entry.sample!.id, entry]));
  return {
    clips: hits.flatMap((hit) => {
      const entry = hit.identity.kind === "saved_clip" && hit.identity.clipId ? clips.get(hit.identity.clipId) : undefined;
      const clip = entry?.clip;
      return clip && hit.parent.sampleId === clip.sampleId && hit.identity.start === clip.start && hit.identity.end === clip.end ? [{ hit, entry }] : [];
    }),
    passages: hits.flatMap((hit) => hit.identity.kind === "window" && samples.get(hit.parent.sampleId) ? [{ hit, entry: samples.get(hit.parent.sampleId)! }] : []),
  };
}
