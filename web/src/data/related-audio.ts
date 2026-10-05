import { bootstrap, semanticUrl } from "./client";
import { SEMANTIC_EMBEDDING_SPACE, type SemanticSearchHit } from "../semantic/contracts";

export const DEFAULT_RELATED_AUDIO_LIMIT = 6;
export const MAX_RELATED_AUDIO_LIMIT = 24;

export interface RelatedAudioRequest { embeddingSpace: typeof SEMANTIC_EMBEDDING_SPACE; sampleId: string; clipId?: string; limit?: number; }
export interface RelatedAudioResponse { state: "ready" | "awaiting_analysis"; hits: SemanticSearchHit[]; }

export class RelatedAudioError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly status?: number) { super(message); this.name = "RelatedAudioError"; }
}

type ClientDeps = { bootstrap: () => Promise<unknown>; semanticUrl: () => string | null; fetch: typeof globalThis.fetch };

/** Related retrieval is storage-only: it never imports a browser vector producer or sends vectors. */
export function createRelatedAudioClient(deps: ClientDeps) {
  return async (request: RelatedAudioRequest, options: { signal?: AbortSignal } = {}): Promise<RelatedAudioResponse> => {
    const normalized = validateRequest(request);
    throwIfAborted(options.signal);
    await deps.bootstrap();
    throwIfAborted(options.signal);
    const base = deps.semanticUrl();
    if (!base) throw new RelatedAudioError("semantic_unavailable", "Related sound is not configured for this deployment", true);
    let response: Response;
    try {
      response = await deps.fetch(`${base.replace(/\/$/, "")}/related`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(normalized), signal: options.signal });
    } catch (cause) {
      if (isAbort(cause)) throw cause;
      throw new RelatedAudioError("semantic_unavailable", "Related sound is temporarily unavailable", true);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new RelatedAudioError("invalid_response", "Related sound returned invalid JSON", true, response.status); }
    if (!response.ok) {
      const error = object(body)?.error;
      const detail = object(error);
      throw new RelatedAudioError(typeof detail?.code === "string" ? detail.code : "related_request_failed", typeof detail?.message === "string" ? detail.message : `Related sound failed (${response.status})`, detail?.retryable === true, response.status);
    }
    if (!validResponse(body, normalized)) throw new RelatedAudioError("invalid_response", "Related sound returned an invalid response", true, response.status);
    return body;
  };
}

/** Lazily bootstraps the configured endpoint, just as semantic search does. */
export const relatedAudio = createRelatedAudioClient({ bootstrap, semanticUrl, fetch: (...args) => globalThis.fetch(...args) });

function validateRequest(value: RelatedAudioRequest): Required<Omit<RelatedAudioRequest, "clipId">> & Pick<RelatedAudioRequest, "clipId"> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["embeddingSpace", "sampleId", "clipId", "limit"].includes(key)) || value.embeddingSpace !== SEMANTIC_EMBEDDING_SPACE || !nonempty(value.sampleId) || (value.clipId !== undefined && !nonempty(value.clipId))) throw new TypeError("invalid related sound request");
  const limit = value.limit === undefined ? DEFAULT_RELATED_AUDIO_LIMIT : value.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RELATED_AUDIO_LIMIT) throw new TypeError("related sound limit must be 1 through 24");
  return { embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: value.sampleId, ...(value.clipId ? { clipId: value.clipId } : {}), limit };
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError"); }
function isAbort(value: unknown): value is DOMException { return value instanceof DOMException && value.name === "AbortError"; }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function bounds(value: unknown): value is { start: number; end: number } { const v = object(value); return !!v && typeof v.start === "number" && Number.isFinite(v.start) && typeof v.end === "number" && Number.isFinite(v.end) && v.start >= 0 && v.end > v.start; }
function identity(value: unknown): boolean { const v: any = object(value); return !!v && Object.keys(v).length === (v.kind === "saved_clip" ? 10 : 9) && /^[0-9a-f]{64}$/.test(v.semanticId) && nonempty(v.sampleId) && nonempty(v.recordingId) && (v.kind === "saved_clip" || v.kind === "window") && (v.kind === "saved_clip" ? nonempty(v.clipId) : v.clipId === undefined) && validBounds(v.start, v.end) && /^[0-9a-f]{64}$/.test(v.audioSha256) && v.embeddingSpace === SEMANTIC_EMBEDDING_SPACE && nonempty(v.processingFingerprint); }
function validBounds(start: unknown, end: unknown): boolean { return typeof start === "number" && Number.isFinite(start) && start >= 0 && typeof end === "number" && Number.isFinite(end) && end > start; }
function safePlaybackKey(value: unknown): value is string { return nonempty(value) && !value.includes("\0") && !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(value) && !value.split(/[\\/]/).includes(".."); }
function validHit(value: unknown): value is SemanticSearchHit { const hit: any = object(value); if (!hit || Object.keys(hit).length !== 6 || "vector" in hit || typeof hit.score !== "number" || !Number.isFinite(hit.score) || !identity(hit.identity) || !bounds(hit.timeRange) || !bounds(hit.playback)) return false; const parent: any = object(hit.parent), card: any = object(hit.card), id: any = hit.identity; return !!parent && Object.keys(parent).length === 4 && parent.sampleId === id.sampleId && parent.recordingId === id.recordingId && nonempty(parent.samplePath) && nonempty(parent.sampleTitle) && !!card && Array.isArray(card.tags) && card.tags.every((tag: unknown) => typeof tag === "string") && safePlaybackKey(hit.playback.fileKey) && hit.timeRange.start === id.start && hit.timeRange.end === id.end && hit.playback.start === id.start && hit.playback.end === id.end && (id.kind === "window" ? Object.keys(card).length === 1 : card.clipId === id.clipId && nonempty(card.clipName) && Object.keys(card).every((key) => ["clipId", "clipName", "clipKind", "tags"].includes(key)) && (card.clipKind === undefined || typeof card.clipKind === "string")); }
function validResponse(value: unknown, request: { sampleId: string; limit: number }): value is RelatedAudioResponse { const response: any = object(value); return !!response && Object.keys(response).length === 2 && (response.state === "ready" || response.state === "awaiting_analysis") && Array.isArray(response.hits) && response.hits.length <= request.limit && response.hits.every(validHit) && response.hits.every((hit: SemanticSearchHit) => hit.identity.sampleId !== request.sampleId) && (response.state !== "awaiting_analysis" || response.hits.length === 0); }
