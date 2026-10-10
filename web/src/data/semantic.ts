import { bootstrap, mode, semanticAuthSession, semanticUrl } from "./client";
import { SemanticTransportError, createSemanticTransport } from "./semantic-transport";
import {
  SEMANTIC_EMBEDDING_SPACE,
  type SemanticSearchRequest,
  type SemanticSearchResponse,
  validateSearchRequest,
} from "../semantic/contracts";

export class SemanticSearchError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "SemanticSearchError";
  }
}

const transport = createSemanticTransport({
  bootstrap,
  semanticUrl,
  mode,
  fetchAuthSession: semanticAuthSession,
  fetch: (...args) => globalThis.fetch(...args),
});

/**
 * Query the configured semantic service. Configuration is bootstrapped lazily so opening a
 * normal lexical view never starts semantic work. A cloud deployment without a configured URL
 * is unavailable; it never falls back to a local endpoint.
 */
export async function searchAudio(request: SemanticSearchRequest, options: { signal?: AbortSignal } = {}): Promise<SemanticSearchResponse> {
  const normalized = validateSearchRequest(request);
  if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  let response: Response;
  try {
    response = await transport.post("search", normalized, options);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    if (cause instanceof SemanticTransportError) throw new SemanticSearchError(cause.code, cause.message, cause.retryable);
    throw new SemanticSearchError("semantic_unavailable", "Semantic search is temporarily unavailable", true);
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new SemanticSearchError("invalid_response", "Semantic search returned invalid JSON", true, response.status); }
  if (!response.ok) {
    const detail = body && typeof body === "object" ? body as { error?: { code?: unknown; message?: unknown; retryable?: unknown } } : {};
    throw new SemanticSearchError(typeof detail.error?.code === "string" ? detail.error.code : "semantic_request_failed", typeof detail.error?.message === "string" ? detail.error.message : `Semantic search failed (${response.status})`, detail.error?.retryable === true, response.status);
  }
  if (!validResponse(body)) throw new SemanticSearchError("invalid_response", "Semantic search returned an invalid response", true, response.status);
  return body;
}

function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function bounds(value: unknown): value is { start: number; end: number } { const v = object(value); return !!v && typeof v.start === "number" && Number.isFinite(v.start) && typeof v.end === "number" && Number.isFinite(v.end) && v.start >= 0 && v.end > v.start; }
function identity(value: unknown): boolean { const v: any = object(value); return !!v && typeof v.semanticId === "string" && /^[0-9a-f]{64}$/.test(v.semanticId) && typeof v.sampleId === "string" && v.sampleId.length > 0 && typeof v.recordingId === "string" && v.recordingId.length > 0 && (v.kind === "saved_clip" || v.kind === "window") && (v.kind === "window" ? v.clipId === undefined : typeof v.clipId === "string" && v.clipId.length > 0) && bounds(v as unknown) && typeof v.audioSha256 === "string" && /^[0-9a-f]{64}$/.test(v.audioSha256) && v.embeddingSpace === SEMANTIC_EMBEDDING_SPACE && typeof v.processingFingerprint === "string" && v.processingFingerprint.length > 0; }
function validHit(value: unknown): boolean { const hit: any = object(value); if (!hit || "vector" in hit || typeof hit.score !== "number" || !Number.isFinite(hit.score) || !identity(hit.identity) || !bounds(hit.timeRange) || !bounds(hit.playback)) return false; const parent: any = object(hit.parent), card: any = object(hit.card), identityValue: any = hit.identity; if (!parent || parent.sampleId !== identityValue.sampleId || parent.recordingId !== identityValue.recordingId || typeof parent.samplePath !== "string" || typeof parent.sampleTitle !== "string" || !card || !Array.isArray(card.tags) || card.tags.some((tag: unknown) => typeof tag !== "string") || typeof hit.playback.fileKey !== "string" || !hit.playback.fileKey.length) return false; if (hit.timeRange.start !== identityValue.start || hit.timeRange.end !== identityValue.end || hit.playback.start !== identityValue.start || hit.playback.end !== identityValue.end) return false; if (identityValue.kind === "window") return card.clipId === undefined && card.clipName === undefined && card.clipKind === undefined; return card.clipId === identityValue.clipId && typeof card.clipName === "string" && (card.clipKind === undefined || typeof card.clipKind === "string"); }
function validResponse(value: unknown): value is SemanticSearchResponse { const v: any = object(value); return !!v && Object.keys(v).length === 4 && v.embeddingSpace === SEMANTIC_EMBEDDING_SPACE && Array.isArray(v.hits) && v.hits.every(validHit) && Number.isInteger(v.candidateCount) && v.candidateCount >= 0 && Number.isInteger(v.filteredCount) && v.filteredCount >= 0 && v.filteredCount <= v.candidateCount; }
