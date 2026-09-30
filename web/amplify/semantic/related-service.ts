import {
  SEMANTIC_EMBEDDING_SPACE,
  type SemanticIdentity,
  type SemanticRecord,
  type SemanticSearchHit,
  type SemanticSearchRequest,
  type SemanticSearchResponse,
  validateSemanticRecord,
} from "../../src/semantic/contracts";
import { canonicalSemanticId } from "./canonical";

const DEFAULT_RELATED_LIMIT = 6;
const MAX_RELATED_LIMIT = 24;

export class RelatedClipServiceError extends Error {
  constructor(public readonly status: 400 | 409 | 503, public readonly code: "semantic_request_invalid" | "semantic_space_unsupported" | "semantic_unavailable", public readonly retryable: boolean) {
    super(code);
    this.name = "RelatedClipServiceError";
  }
}

export type RelatedClipServiceOptions = Readonly<{
  readSource: (request: { embeddingSpace: typeof SEMANTIC_EMBEDDING_SPACE; sampleId: string; clipId: string }, context?: unknown) => Promise<unknown | null>;
  hydrateSource: (candidate: { identity: SemanticIdentity; revision: string }, context?: unknown) => Promise<Omit<SemanticSearchHit, "score"> | null>;
  search: (request: SemanticSearchRequest, context?: unknown) => Promise<SemanticSearchResponse>;
}>;
export type RelatedClipService = Readonly<{
  related: (request: unknown, context?: unknown) => Promise<{ state: "ready" | "awaiting_analysis"; hits: SemanticSearchHit[] }>;
}>;

/** Stored-vector-only related-clip orchestration. HTTP and UI ownership remain outside this module. */
export function createRelatedClipService(options: RelatedClipServiceOptions): RelatedClipService {
  return {
    async related(request: unknown, context?: unknown) {
      const normalized = normalizeRequest(request);
      let stored: unknown | null;
      try {
        stored = await options.readSource({ embeddingSpace: normalized.embeddingSpace, sampleId: normalized.sampleId, clipId: normalized.clipId }, context);
      } catch {
        throw unavailable();
      }
      const source = validSource(stored, normalized);
      if (!source) return { state: "awaiting_analysis", hits: [] };

      let hydrated: Omit<SemanticSearchHit, "score"> | null;
      try {
        hydrated = await options.hydrateSource({ identity: source.identity, revision: source.revision }, context);
      } catch {
        throw unavailable();
      }
      if (!hydrated || !validHit({ ...hydrated, score: 0 }) || !sameIdentity(hydrated.identity, source.identity)) return { state: "awaiting_analysis", hits: [] };

      let response: SemanticSearchResponse;
      try {
        // The source vector is already validated by validateSemanticRecord; no encoder is imported or invoked.
        response = await options.search({ embeddingSpace: normalized.embeddingSpace, queryVector: source.vector, kind: "saved_clip", limit: 100 }, context);
      } catch {
        throw unavailable();
      }
      const hits = validSearchResponse(response, normalized.embeddingSpace, source.identity);
      if (!hits) throw unavailable();

      const best = new Map<string, SemanticSearchHit>();
      for (const candidate of hits) {
        // This precedes both deduplication and the final limit so source aliases/windows never displace a match.
        if (candidate.identity.sampleId === normalized.sampleId) continue;
        const previous = best.get(candidate.identity.semanticId);
        if (!previous || candidate.score > previous.score) best.set(candidate.identity.semanticId, candidate);
      }
      return { state: "ready", hits: [...best.values()].sort(compareHits).slice(0, normalized.limit) };
    },
  };
}

function normalizeRequest(value: unknown): { embeddingSpace: typeof SEMANTIC_EMBEDDING_SPACE; sampleId: string; clipId: string; limit: number } {
  if (!object(value) || !exact(value, ["embeddingSpace", "sampleId", "clipId", "limit"], ["limit"])) throw invalid();
  if (value.embeddingSpace !== SEMANTIC_EMBEDDING_SPACE) throw typeof value.embeddingSpace === "string" ? unsupported() : invalid();
  if (!nonempty(value.sampleId) || !nonempty(value.clipId)) throw invalid();
  const limit = value.limit === undefined ? DEFAULT_RELATED_LIMIT : value.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RELATED_LIMIT) throw invalid();
  return { embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: value.sampleId, clipId: value.clipId, limit };
}

function validSource(value: unknown, request: { embeddingSpace: string; sampleId: string; clipId: string }): SemanticRecord | null {
  try {
    const record = validateSemanticRecord(value);
    return record.identity.kind === "saved_clip" && record.identity.sampleId === request.sampleId && record.identity.clipId === request.clipId && record.identity.embeddingSpace === request.embeddingSpace && canonicalSemanticId(record.identity) === record.identity.semanticId ? record : null;
  } catch { return null; }
}

function validSearchResponse(value: unknown, embeddingSpace: string, source: SemanticIdentity): SemanticSearchHit[] | null {
  if (!object(value) || !exact(value, ["hits", "embeddingSpace", "candidateCount", "filteredCount"]) || value.embeddingSpace !== embeddingSpace || !Array.isArray(value.hits) || typeof value.candidateCount !== "number" || !Number.isInteger(value.candidateCount) || value.candidateCount < 0 || value.candidateCount > 100 || typeof value.filteredCount !== "number" || !Number.isInteger(value.filteredCount) || value.filteredCount < 0 || value.filteredCount > value.candidateCount || value.hits.length > value.candidateCount - value.filteredCount) return null;
  return value.hits.every((hit) => validHit(hit) && hit.identity.processingFingerprint === source.processingFingerprint) ? value.hits : null;
}

function validHit(value: unknown): value is SemanticSearchHit {
  if (!object(value) || !exact(value, ["score", "identity", "parent", "timeRange", "card", "playback"]) || typeof value.score !== "number" || !Number.isFinite(value.score) || !identity(value.identity) || value.identity.kind !== "saved_clip" || !object(value.parent) || !exact(value.parent, ["sampleId", "recordingId", "samplePath", "sampleTitle"]) || value.parent.sampleId !== value.identity.sampleId || value.parent.recordingId !== value.identity.recordingId || !nonempty(value.parent.samplePath) || !nonempty(value.parent.sampleTitle) || !object(value.timeRange) || !exact(value.timeRange, ["start", "end"]) || value.timeRange.start !== value.identity.start || value.timeRange.end !== value.identity.end || !object(value.card) || !exact(value.card, ["clipId", "clipName", "clipKind", "tags"], ["clipKind"]) || value.card.clipId !== value.identity.clipId || !nonempty(value.card.clipName) || (value.card.clipKind !== undefined && typeof value.card.clipKind !== "string") || !Array.isArray(value.card.tags) || value.card.tags.some((tag) => typeof tag !== "string") || !object(value.playback) || !exact(value.playback, ["fileKey", "start", "end"]) || !safeRelativeKey(value.playback.fileKey) || value.playback.start !== value.identity.start || value.playback.end !== value.identity.end) return false;
  return true;
}

function identity(value: unknown): value is SemanticIdentity {
  if (!object(value) || !exact(value, ["semanticId", "sampleId", "recordingId", "kind", "clipId", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint"])) return false;
  const candidate = value as unknown as SemanticIdentity;
  return candidate.kind === "saved_clip" && nonempty(candidate.semanticId) && nonempty(candidate.sampleId) && nonempty(candidate.recordingId) && nonempty(candidate.clipId) && typeof candidate.start === "number" && typeof candidate.end === "number" && Number.isFinite(candidate.start) && Number.isFinite(candidate.end) && candidate.start >= 0 && candidate.end > candidate.start && /^[0-9a-f]{64}$/.test(candidate.audioSha256) && candidate.embeddingSpace === SEMANTIC_EMBEDDING_SPACE && nonempty(candidate.processingFingerprint) && canonicalSemanticId(candidate) === candidate.semanticId;
}

function sameIdentity(left: SemanticIdentity, right: SemanticIdentity): boolean {
  return left.semanticId === right.semanticId && left.sampleId === right.sampleId && left.recordingId === right.recordingId && left.kind === right.kind && left.clipId === right.clipId && left.start === right.start && left.end === right.end && left.audioSha256 === right.audioSha256 && left.embeddingSpace === right.embeddingSpace && left.processingFingerprint === right.processingFingerprint && canonicalSemanticId(left) === left.semanticId && canonicalSemanticId(right) === right.semanticId;
}
function compareHits(left: SemanticSearchHit, right: SemanticSearchHit) { return right.score - left.score || left.identity.semanticId.localeCompare(right.identity.semanticId); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[], optional: string[] = []) { const allowed = new Set([...keys, ...optional]); return Object.keys(value).every((key) => allowed.has(key)) && keys.filter((key) => !optional.includes(key)).every((key) => key in value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function safeRelativeKey(value: unknown): value is string { return nonempty(value) && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."); }
function invalid() { return new RelatedClipServiceError(400, "semantic_request_invalid", false); }
function unsupported() { return new RelatedClipServiceError(409, "semantic_space_unsupported", false); }
function unavailable() { return new RelatedClipServiceError(503, "semantic_unavailable", true); }
