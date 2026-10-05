/** Strict public client for the forthcoming published-cluster service. */
import { bootstrap, semanticUrl } from "./client";

export type ClusterPreset = "broad" | "useful" | "fine";
export type ClusterCard = { semanticId: string; sampleId: string; recordingId: string; kind: "window" | "saved_clip"; start: number; end: number; sampleTitle: string; playback: { fileKey: string; start: number; end: number }; parentLink: string; link: string; clipId?: string; clipName?: string; score?: number | null };
export type ClusterLeaderboard = { runId: string; preset: ClusterPreset; algorithmVersions: Record<string, string>; clusters: { clusterId: string; distinctSampleCount: number; savedClipCount: number; representatives: ClusterCard[]; suggestedLabel: string | null; curatedLabel?: string }[] };
export type ClusterDetail = { runId: string; clusterId: string; order: "similarity" | "rating"; representatives: ClusterCard[]; members: ClusterCard[] };
export type ClusterMapPoint = { semanticId: string; clusterId: string | null; membership: number; x: number; y: number; cards: ClusterCard[] };
export type ClusterMap = { runId: string; displayedCount: number; totalVisibleCount: number; truncated: boolean; points: ClusterMapPoint[] };

export class ClusterClientError extends Error { constructor(message: string, readonly status?: number) { super(message); this.name = "ClusterClientError"; } }
type Request = { view: "leaderboard"; run?: string; preset?: ClusterPreset; order?: "samples" | "clips" } | { view: "detail"; cluster: string; run?: string; preset?: ClusterPreset; order?: "similarity" | "rating" } | { view: "map"; run?: string; preset?: ClusterPreset; limit?: number };

export function clusterEndpoint(base: string, request: Request): string {
  const url = new URL(base, typeof location === "undefined" ? "http://localhost" : location.origin);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/clusters`;
  const q = url.searchParams;
  q.set("view", request.view);
  if (request.view === "detail") q.set("cluster", request.cluster);
  if (request.run) q.set("run", request.run);
  if (request.preset) q.set("preset", request.preset);
  if ("order" in request && request.order) q.set("order", request.order);
  if (request.view === "map" && request.limit) q.set("limit", String(request.limit));
  return /^[a-z][a-z\d+.-]*:/i.test(base) ? url.href : `${url.pathname}${url.search}`;
}

export async function getClusters(request: Request, options: { signal?: AbortSignal } = {}): Promise<ClusterLeaderboard | ClusterDetail | ClusterMap> {
  if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  await bootstrap();
  if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const base = semanticUrl();
  if (!base) throw new ClusterClientError("Published sound clusters are not configured for this deployment.");
  let response: Response;
  try { response = await fetch(clusterEndpoint(base, request), { method: "GET", signal: options.signal }); }
  catch (error) { if ((error as DOMException)?.name === "AbortError") throw error; throw new ClusterClientError("Couldn't reach published sound clusters."); }
  if (response.status === 404) throw new ClusterClientError("No published run or cluster was found.", 404);
  if (response.status === 503) throw new ClusterClientError("Published sound clusters are temporarily unavailable.", 503);
  if (!response.ok) throw new ClusterClientError(`Published sound clusters failed (${response.status}).`, response.status);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new ClusterClientError("Published sound clusters returned invalid JSON.", response.status); }
  const parsed = request.view === "leaderboard" ? parseClusterLeaderboard(payload) : request.view === "detail" ? parseClusterDetail(payload) : parseClusterMap(payload);
  if ((request.run && parsed.runId !== request.run) || (request.preset && "preset" in parsed && parsed.preset !== request.preset) || (request.view === "detail" && (parsed as ClusterDetail).clusterId !== request.cluster)) throw new ClusterClientError("Published sound clusters returned a different selection.", response.status);
  return parsed;
}

const runId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const link = (v: unknown) => typeof v === "string" && v.startsWith("/") && !v.includes("//") && !v.split("/").includes("..");
function card(value: unknown, detail = false): ClusterCard {
  const v = object(value); const allowed = ["semanticId", "sampleId", "recordingId", "kind", "start", "end", "sampleTitle", "playback", "parentLink", "link", "clipId", "clipName", ...(detail ? ["score"] : [])];
  if (!v || !keys(v, allowed) || !runId(v.semanticId) || typeof v.sampleId !== "string" || !v.sampleId || typeof v.recordingId !== "string" || !v.recordingId || (v.kind !== "window" && v.kind !== "saved_clip") || !number(v.start) || !number(v.end) || v.start < 0 || v.end <= v.start || typeof v.sampleTitle !== "string" || !v.sampleTitle || !link(v.parentLink) || !link(v.link)) throw new ClusterClientError("Published sound clusters returned an unsafe card.");
  const playback = object(v.playback);
  if (!playback || !keys(playback, ["fileKey", "start", "end"]) || typeof playback.fileKey !== "string" || !playback.fileKey || playback.fileKey.startsWith("/") || playback.fileKey.split(/[\\/]/).includes("..") || playback.start !== v.start || playback.end !== v.end) throw new ClusterClientError("Published sound clusters returned an unsafe playback range.");
  if ((v.kind === "saved_clip") !== (typeof v.clipId === "string" && !!v.clipId && typeof v.clipName === "string" && !!v.clipName)) throw new ClusterClientError("Published sound clusters returned an invalid clip card.");
  if (detail && v.score !== undefined && v.score !== null && !number(v.score)) throw new ClusterClientError("Published sound clusters returned a non-finite rank.");
  return v as ClusterCard;
}
export function parseClusterLeaderboard(value: unknown): ClusterLeaderboard {
  const v = object(value); const versions = v ? object(v.algorithmVersions) : null;
  if (!v || !keys(v, ["runId", "preset", "algorithmVersions", "clusters"]) || !runId(v.runId) || !["broad", "useful", "fine"].includes(v.preset as string) || !Array.isArray(v.clusters) || !versions || !Object.values(versions).every((x) => typeof x === "string")) throw new ClusterClientError("Published sound clusters returned an invalid leaderboard.");
  const clusters = v.clusters.map((value) => { const row = object(value); const samples = row?.distinctSampleCount; const clips = row?.savedClipCount; if (!row || !keys(row, ["clusterId", "distinctSampleCount", "savedClipCount", "representatives", "suggestedLabel", "curatedLabel"]) || typeof row.clusterId !== "string" || !new RegExp(`^${v.runId}:\\d+$`).test(row.clusterId) || typeof samples !== "number" || !Number.isInteger(samples) || samples < 0 || typeof clips !== "number" || !Number.isInteger(clips) || clips < 0 || !Array.isArray(row.representatives) || (row.suggestedLabel !== null && typeof row.suggestedLabel !== "string") || (row.curatedLabel !== undefined && typeof row.curatedLabel !== "string")) throw new ClusterClientError("Published sound clusters returned an invalid cluster."); return { ...row, representatives: row.representatives.map((x) => card(x)) } as ClusterLeaderboard["clusters"][number]; });
  return { runId: v.runId, preset: v.preset as ClusterPreset, algorithmVersions: versions as Record<string, string>, clusters };
}
export function parseClusterDetail(value: unknown): ClusterDetail {
  const v = object(value); if (!v || !keys(v, ["runId", "clusterId", "order", "representatives", "members"]) || !runId(v.runId) || typeof v.clusterId !== "string" || !new RegExp(`^${v.runId}:\\d+$`).test(v.clusterId) || (v.order !== "similarity" && v.order !== "rating") || !Array.isArray(v.representatives) || !Array.isArray(v.members)) throw new ClusterClientError("Published sound clusters returned an invalid cluster detail.");
  return { runId: v.runId, clusterId: v.clusterId, order: v.order, representatives: v.representatives.map((x) => card(x)), members: v.members.map((x) => card(x, true)) };
}
export function parseClusterMap(value: unknown): ClusterMap {
  const v = object(value);
  const displayed = v?.displayedCount, total = v?.totalVisibleCount;
  if (!v || !keys(v, ["runId", "displayedCount", "totalVisibleCount", "truncated", "points"]) || !runId(v.runId) || typeof displayed !== "number" || !Number.isInteger(displayed) || typeof total !== "number" || !Number.isInteger(total) || displayed < 0 || total < displayed || typeof v.truncated !== "boolean" || v.truncated !== (total > displayed) || !Array.isArray(v.points) || v.points.length !== displayed || displayed > 10_000) throw new ClusterClientError("Published sound clusters returned an invalid map.");
  const points = v.points.map((value) => { const p = object(value); if (!p || !keys(p, ["semanticId", "clusterId", "membership", "x", "y", "cards"]) || !runId(p.semanticId) || (p.clusterId !== null && (typeof p.clusterId !== "string" || !new RegExp(`^${v.runId}:\\d+$`).test(p.clusterId))) || !number(p.membership) || p.membership < 0 || p.membership > 1 || !number(p.x) || !number(p.y) || !Array.isArray(p.cards)) throw new ClusterClientError("Published sound clusters returned an unsafe map point."); return { semanticId: p.semanticId, clusterId: p.clusterId, membership: p.membership, x: p.x, y: p.y, cards: p.cards.map((x) => card(x)) } as ClusterMapPoint; });
  return { runId: v.runId, displayedCount: displayed, totalVisibleCount: total, truncated: v.truncated, points };
}
