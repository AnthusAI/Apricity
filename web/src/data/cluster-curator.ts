/** Strict client for the local-only, startup-gated curator bridge. */
import { bootstrap, clusterCuratorEnabled, semanticUrl } from "./client";
import type { ClusterCard, ClusterPreset } from "./audio-clusters";

export type CuratorPreview = {
  runId: string;
  preset: ClusterPreset;
  state: "draft";
  runRevision: number;
  pointerRevision: number | null;
  review: null | { status: "approved"; notes: string; reviewedSemanticIds: string[] };
  clusters: { clusterId: string; suggestedLabel: string | null; curatedLabel: string | null; representatives: ClusterCard[] }[];
};

export type CuratorControl = { runId: string; runRevision: number; pointerRevision: number | null; overrides: Record<string, { label: string }>; review: CuratorPreview["review"] };
export type CuratorResult = CuratorControl | { runId: string; state: "published" };
export class CuratorClientError extends Error { constructor(message: string, readonly status?: number) { super(message); this.name = "CuratorClientError"; } }

const run = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const finiteInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const source = (value: unknown) => object(value);
const link = (value: unknown) => typeof value === "string" && value.startsWith("/") && !value.includes("//") && !value.split("/").includes("..");

function card(value: unknown): ClusterCard {
  const v = object(value);
  if (!v || !keys(v, ["semanticId", "sampleId", "recordingId", "kind", "start", "end", "sampleTitle", "playback", "parentLink", "link", "clipId", "clipName"]) || !run(v.semanticId) || typeof v.sampleId !== "string" || !v.sampleId || typeof v.recordingId !== "string" || !v.recordingId || (v.kind !== "window" && v.kind !== "saved_clip") || typeof v.start !== "number" || !Number.isFinite(v.start) || typeof v.end !== "number" || !Number.isFinite(v.end) || v.start < 0 || v.end <= v.start || typeof v.sampleTitle !== "string" || !v.sampleTitle || !link(v.parentLink) || !link(v.link)) throw new CuratorClientError("Curator preview returned an unsafe passage.");
  const playback = source(v.playback);
  if (!playback || !keys(playback, ["fileKey", "start", "end"]) || typeof playback.fileKey !== "string" || !playback.fileKey || playback.fileKey.startsWith("/") || playback.fileKey.split(/[\\/]/).includes("..") || playback.start !== v.start || playback.end !== v.end) throw new CuratorClientError("Curator preview returned an unsafe playback range.");
  if ((v.kind === "saved_clip") !== (typeof v.clipId === "string" && !!v.clipId && typeof v.clipName === "string" && !!v.clipName)) throw new CuratorClientError("Curator preview returned an invalid clip.");
  return v as ClusterCard;
}

function review(value: unknown): CuratorPreview["review"] {
  if (value === null) return null;
  const v = object(value);
  // The bridge may retain private audit metadata, but the browser accepts only the evidence it renders.
  if (!v || v.status !== "approved" || typeof v.notes !== "string" || !Array.isArray(v.reviewedSemanticIds) || !v.reviewedSemanticIds.every(run)) throw new CuratorClientError("Curator controls returned an invalid review.");
  return { status: "approved", notes: v.notes, reviewedSemanticIds: [...v.reviewedSemanticIds] };
}

function control(value: unknown): CuratorControl {
  const v = object(value); const overrides = v && object(v.overrides);
  if (!v || !run(v.runId) || !finiteInt(v.runRevision) || (v.pointerRevision !== null && !finiteInt(v.pointerRevision)) || !overrides) throw new CuratorClientError("Curator controls returned invalid state.");
  const parsed: Record<string, { label: string }> = {};
  for (const [clusterId, item] of Object.entries(overrides)) {
    const row = object(item);
    if (!new RegExp(`^${v.runId}:\\d+$`).test(clusterId) || !row || typeof row.label !== "string" || !row.label.trim() || row.label.length > 120) throw new CuratorClientError("Curator controls returned an invalid label override.");
    parsed[clusterId] = { label: row.label };
  }
  return { runId: v.runId, runRevision: v.runRevision, pointerRevision: v.pointerRevision as number | null, overrides: parsed, review: review(v.review) };
}

export function parseCuratorPreview(value: unknown): CuratorPreview {
  const v = object(value);
  if (!v || !run(v.runId) || !["broad", "useful", "fine"].includes(v.preset as string) || v.state !== "draft" || !finiteInt(v.runRevision) || (v.pointerRevision !== null && !finiteInt(v.pointerRevision)) || !Array.isArray(v.clusters)) throw new CuratorClientError("Curator preview returned invalid state.");
  const clusters = v.clusters.map((item) => {
    const row = object(item);
    if (!row || !keys(row, ["clusterId", "suggestedLabel", "curatedLabel", "representatives"]) || typeof row.clusterId !== "string" || !new RegExp(`^${v.runId}:\\d+$`).test(row.clusterId) || (row.suggestedLabel !== null && typeof row.suggestedLabel !== "string") || (row.curatedLabel !== null && typeof row.curatedLabel !== "string") || !Array.isArray(row.representatives)) throw new CuratorClientError("Curator preview returned an invalid cluster.");
    return { clusterId: row.clusterId, suggestedLabel: row.suggestedLabel, curatedLabel: row.curatedLabel, representatives: row.representatives.map(card) };
  });
  return { runId: v.runId, preset: v.preset as ClusterPreset, state: "draft", runRevision: v.runRevision, pointerRevision: v.pointerRevision as number | null, review: review(v.review), clusters };
}

export function curatorEndpoint(base: string): string {
  const url = new URL(base, typeof location === "undefined" ? "http://localhost" : location.origin);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/cluster-curator`;
  return /^[a-z][a-z\d+.-]*:/i.test(base) ? url.href : `${url.pathname}${url.search}`;
}

type Request = { op: "control" | "preview"; runId: string } | { op: "override"; runId: string; clusterId: string; label: string; expectedRunRevision: number } | { op: "review"; runId: string; reviewedSemanticIds: string[]; notes: string; expectedRunRevision: number } | { op: "publish"; runId: string; expectedRunRevision: number; expectedPointerRevision: number | null };

export async function curatorRequest(request: Request, options: { signal?: AbortSignal } = {}): Promise<CuratorResult | CuratorPreview> {
  if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  await bootstrap();
  if (!clusterCuratorEnabled()) throw new CuratorClientError("Curator review is not enabled on this local server.", 403);
  const base = semanticUrl();
  if (!base) throw new CuratorClientError("Curator review is not configured for this local server.", 503);
  let response: Response;
  try { response = await fetch(curatorEndpoint(base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: options.signal }); }
  catch (error) { if ((error as DOMException)?.name === "AbortError") throw error; throw new CuratorClientError("Couldn't reach local curator review."); }
  if (response.status === 403) throw new CuratorClientError("Curator review is not enabled on this local server.", 403);
  if (response.status === 400) throw new CuratorClientError("This review request is no longer valid. Refresh the draft and try again.", 400);
  if (response.status === 503) throw new CuratorClientError("Curator review is temporarily unavailable.", 503);
  if (!response.ok) throw new CuratorClientError(`Curator review failed (${response.status}).`, response.status);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new CuratorClientError("Curator review returned invalid JSON.", response.status); }
  if (request.op === "preview") return parseCuratorPreview(payload);
  const v = object(payload);
  if (request.op === "publish" && v && run(v.runId) && v.state === "published") return { runId: v.runId, state: "published" };
  return control(payload);
}
