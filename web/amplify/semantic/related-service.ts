import { SEMANTIC_EMBEDDING_SPACE, type SemanticIdentity, type SemanticRecord, type SemanticSearchHit, type SemanticSearchRequest, type SemanticSearchResponse, validateSemanticRecord } from "../../src/semantic/contracts";
import { canonicalSemanticId } from "./canonical";

const DEFAULT_RELATED_LIMIT = 6;
const MAX_RELATED_LIMIT = 24;
const MAX_REPRESENTATIVES = 4;

export class RelatedClipServiceError extends Error {
  constructor(public readonly status: 400 | 409 | 503, public readonly code: "semantic_request_invalid" | "semantic_space_unsupported" | "semantic_unavailable", public readonly retryable: boolean) { super(code); this.name = "RelatedClipServiceError"; }
}

type ReadSource = (request: { embeddingSpace: typeof SEMANTIC_EMBEDDING_SPACE; sampleId: string; clipId: string }, context?: unknown) => Promise<unknown | null>;
type ReadSampleSources = (request: { embeddingSpace: typeof SEMANTIC_EMBEDDING_SPACE; sampleId: string }, context?: unknown) => Promise<unknown[]>;
type HydrateSource = (candidate: { identity: SemanticIdentity; revision: string }, context?: unknown) => Promise<Omit<SemanticSearchHit, "score"> | null>;
type Search = (request: SemanticSearchRequest, context?: unknown) => Promise<SemanticSearchResponse>;
export type RelatedClipServiceOptions = Readonly<{ readSource: ReadSource; hydrateSource: HydrateSource; search: Search }>;
export type RelatedAudioServiceOptions = Readonly<RelatedClipServiceOptions & { readSampleSources: ReadSampleSources }>;
export type RelatedClipService = Readonly<{ related: (request: unknown, context?: unknown) => Promise<RelatedResponse> }>;
export type RelatedAudioService = RelatedClipService;
type RelatedResponse = { state: "ready" | "awaiting_analysis"; hits: SemanticSearchHit[] };
type NormalizedRequest = { embeddingSpace: typeof SEMANTIC_EMBEDDING_SPACE; sampleId: string; clipId?: string; limit: number };
type CurrentSource = { record: SemanticRecord; hit: Omit<SemanticSearchHit, "score"> };

/** Backwards-compatible saved-clip entry point, delegated to the unified implementation. */
export function createRelatedClipService(options: RelatedClipServiceOptions): RelatedClipService { return createService(options); }
/** Stored-vector related-audio service for saved clips and sample passages. */
export function createRelatedAudioService(options: RelatedAudioServiceOptions): RelatedAudioService { return createService(options); }

function createService(options: RelatedClipServiceOptions & Partial<Pick<RelatedAudioServiceOptions, "readSampleSources">>): RelatedClipService {
  return { async related(request: unknown, context?: unknown): Promise<RelatedResponse> {
    const normalized = normalizeRequest(request);
    if (normalized.clipId) return relatedClip(options, normalized as NormalizedRequest & { clipId: string }, context);
    if (!options.readSampleSources) throw invalid();
    return relatedSample(options as RelatedAudioServiceOptions, normalized, context);
  } };
}

async function relatedClip(options: RelatedClipServiceOptions, request: NormalizedRequest & { clipId: string }, context?: unknown): Promise<RelatedResponse> {
  let stored: unknown | null;
  try { stored = await options.readSource({ embeddingSpace: request.embeddingSpace, sampleId: request.sampleId, clipId: request.clipId }, context); } catch { throw unavailable(); }
  const source = validSource(stored, request);
  if (!source) return awaiting();
  const current = await hydrate(options.hydrateSource, source, context);
  return current ? searchAndRank(options.search, [current], request, true, context) : awaiting();
}

async function relatedSample(options: RelatedAudioServiceOptions, request: NormalizedRequest, context?: unknown): Promise<RelatedResponse> {
  let stored: unknown[];
  try { stored = await options.readSampleSources({ embeddingSpace: request.embeddingSpace, sampleId: request.sampleId }, context); } catch { throw unavailable(); }
  if (!Array.isArray(stored)) throw unavailable();
  const records = [...new Map(stored.map((value) => validSampleSource(value, request)).filter((value): value is SemanticRecord => value !== null).map((record) => [record.identity.semanticId, record])).values()];
  const current: CurrentSource[] = [];
  for (const record of records) { const value = await hydrate(options.hydrateSource, record, context); if (value) current.push(value); }
  if (!current.length) return awaiting();
  if (new Set(current.map((source) => source.record.identity.processingFingerprint)).size !== 1) throw unavailable();
  return searchAndRank(options.search, representatives(current), request, false, context);
}

async function hydrate(hydrateSource: HydrateSource, record: SemanticRecord, context?: unknown): Promise<CurrentSource | null> {
  let hit: Omit<SemanticSearchHit, "score"> | null;
  try { hit = await hydrateSource({ identity: record.identity, revision: record.revision }, context); } catch { throw unavailable(); }
  return hit && validHit({ ...hit, score: 0 }) && sameIdentity(hit.identity, record.identity) ? { record, hit } : null;
}

async function searchAndRank(search: Search, sources: CurrentSource[], request: NormalizedRequest, clipOnly: boolean, context?: unknown): Promise<RelatedResponse> {
  const all: SemanticSearchHit[] = [];
  for (const source of sources) {
    let response: SemanticSearchResponse;
    try { response = await search({ embeddingSpace: request.embeddingSpace, queryVector: source.record.vector, ...(clipOnly ? { kind: "saved_clip" as const } : {}), limit: 100 }, context); } catch { throw unavailable(); }
    const hits = validSearchResponse(response, request.embeddingSpace, source.record.identity.processingFingerprint, clipOnly);
    if (!hits) throw unavailable();
    all.push(...hits);
  }
  const best = new Map<string, SemanticSearchHit>();
  for (const hit of all) {
    if (hit.identity.sampleId === request.sampleId) continue;
    const previous = best.get(hit.identity.semanticId);
    if (!previous || compareHits(hit, previous) < 0) best.set(hit.identity.semanticId, hit);
  }
  return { state: "ready", hits: diversifyRecordings(clipOnly ? [...best.values()] : bestPassagePerSample([...best.values()])).slice(0, request.limit) };
}

function representatives(sources: CurrentSource[]): CurrentSource[] {
  const remaining = [...sources].sort((left, right) => left.record.identity.semanticId.localeCompare(right.record.identity.semanticId));
  const selected = [remaining.shift()!];
  while (selected.length < MAX_REPRESENTATIVES && remaining.length) {
    remaining.sort((left, right) => minimumDistance(right, selected) - minimumDistance(left, selected) || left.record.identity.semanticId.localeCompare(right.record.identity.semanticId));
    selected.push(remaining.shift()!);
  }
  return selected;
}
function minimumDistance(candidate: CurrentSource, selected: CurrentSource[]) { return Math.min(...selected.map((source) => 1 - dot(candidate.record.vector, source.record.vector))); }
function dot(left: number[], right: number[]) { return left.reduce((total, entry, index) => total + entry * right[index], 0); }
function bestPassagePerSample(hits: SemanticSearchHit[]) {
  const best = new Map<string, SemanticSearchHit>();
  for (const hit of hits) { const previous = best.get(hit.parent.sampleId); if (!previous || compareHits(hit, previous) < 0) best.set(hit.parent.sampleId, hit); }
  return [...best.values()].sort(compareHits);
}
function diversifyRecordings(hits: SemanticSearchHit[]) {
  const seen = new Set<string>(); const first: SemanticSearchHit[] = []; const remainder: SemanticSearchHit[] = [];
  for (const hit of [...hits].sort(compareHits)) (seen.has(hit.parent.recordingId) ? remainder : (seen.add(hit.parent.recordingId), first)).push(hit);
  return [...first, ...remainder];
}

function normalizeRequest(value: unknown): NormalizedRequest {
  if (!object(value) || !exact(value, ["embeddingSpace", "sampleId", "clipId", "limit"], ["clipId", "limit"])) throw invalid();
  if (value.embeddingSpace !== SEMANTIC_EMBEDDING_SPACE) throw typeof value.embeddingSpace === "string" ? unsupported() : invalid();
  if (!nonempty(value.sampleId) || (value.clipId !== undefined && !nonempty(value.clipId))) throw invalid();
  const limit = value.limit === undefined ? DEFAULT_RELATED_LIMIT : value.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RELATED_LIMIT) throw invalid();
  return { embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: value.sampleId, ...(value.clipId ? { clipId: value.clipId } : {}), limit };
}
function validSource(value: unknown, request: { embeddingSpace: string; sampleId: string; clipId: string }): SemanticRecord | null { const record = recordOf(value); return record && record.identity.kind === "saved_clip" && record.identity.sampleId === request.sampleId && record.identity.clipId === request.clipId && record.identity.embeddingSpace === request.embeddingSpace ? record : null; }
function validSampleSource(value: unknown, request: { embeddingSpace: string; sampleId: string }): SemanticRecord | null { const record = recordOf(value); return record && record.identity.sampleId === request.sampleId && record.identity.embeddingSpace === request.embeddingSpace ? record : null; }
function recordOf(value: unknown): SemanticRecord | null { try { const record = validateSemanticRecord(value); return canonicalSemanticId(record.identity) === record.identity.semanticId ? record : null; } catch { return null; } }
function validSearchResponse(value: unknown, embeddingSpace: string, fingerprint: string, clipOnly: boolean): SemanticSearchHit[] | null {
  if (!object(value) || !exact(value, ["hits", "embeddingSpace", "candidateCount", "filteredCount"]) || value.embeddingSpace !== embeddingSpace || !Array.isArray(value.hits) || typeof value.candidateCount !== "number" || !Number.isInteger(value.candidateCount) || value.candidateCount < 0 || value.candidateCount > 100 || typeof value.filteredCount !== "number" || !Number.isInteger(value.filteredCount) || value.filteredCount < 0 || value.filteredCount > value.candidateCount || value.hits.length > value.candidateCount - value.filteredCount) return null;
  return value.hits.every((hit) => validHit(hit) && (!clipOnly || hit.identity.kind === "saved_clip") && hit.identity.processingFingerprint === fingerprint) ? value.hits : null;
}
function validHit(value: unknown): value is SemanticSearchHit {
  if (!object(value) || !exact(value, ["score", "identity", "parent", "timeRange", "card", "playback"]) || typeof value.score !== "number" || !Number.isFinite(value.score) || !identity(value.identity) || !object(value.parent) || !exact(value.parent, ["sampleId", "recordingId", "samplePath", "sampleTitle"]) || value.parent.sampleId !== value.identity.sampleId || value.parent.recordingId !== value.identity.recordingId || !nonempty(value.parent.samplePath) || !nonempty(value.parent.sampleTitle) || !object(value.timeRange) || !exact(value.timeRange, ["start", "end"]) || value.timeRange.start !== value.identity.start || value.timeRange.end !== value.identity.end || !card(value.card, value.identity) || !object(value.playback) || !exact(value.playback, ["fileKey", "start", "end"]) || !safeRelativeKey(value.playback.fileKey) || value.playback.start !== value.identity.start || value.playback.end !== value.identity.end) return false;
  return true;
}
function card(value: unknown, id: SemanticIdentity) { if (!object(value)) return false; return id.kind === "window" ? exact(value, ["tags"]) && Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string") : exact(value, ["clipId", "clipName", "clipKind", "tags"], ["clipKind"]) && value.clipId === id.clipId && nonempty(value.clipName) && (value.clipKind === undefined || typeof value.clipKind === "string") && Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string"); }
function identity(value: unknown): value is SemanticIdentity {
  if (!object(value)) return false; const saved = value.kind === "saved_clip";
  if (!exact(value, saved ? ["semanticId", "sampleId", "recordingId", "kind", "clipId", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint"] : ["semanticId", "sampleId", "recordingId", "kind", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint"])) return false;
  const candidate = value as SemanticIdentity;
  return (candidate.kind === "saved_clip" || candidate.kind === "window") && nonempty(candidate.semanticId) && nonempty(candidate.sampleId) && nonempty(candidate.recordingId) && (!saved || nonempty(candidate.clipId)) && typeof candidate.start === "number" && typeof candidate.end === "number" && Number.isFinite(candidate.start) && Number.isFinite(candidate.end) && candidate.start >= 0 && candidate.end > candidate.start && /^[0-9a-f]{64}$/.test(candidate.audioSha256) && candidate.embeddingSpace === SEMANTIC_EMBEDDING_SPACE && nonempty(candidate.processingFingerprint) && canonicalSemanticId(candidate) === candidate.semanticId;
}
function sameIdentity(left: SemanticIdentity, right: SemanticIdentity) { return left.semanticId === right.semanticId && left.sampleId === right.sampleId && left.recordingId === right.recordingId && left.kind === right.kind && left.clipId === right.clipId && left.start === right.start && left.end === right.end && left.audioSha256 === right.audioSha256 && left.embeddingSpace === right.embeddingSpace && left.processingFingerprint === right.processingFingerprint && canonicalSemanticId(left) === left.semanticId && canonicalSemanticId(right) === right.semanticId; }
function compareHits(left: SemanticSearchHit, right: SemanticSearchHit) { return right.score - left.score || left.identity.semanticId.localeCompare(right.identity.semanticId); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[], optional: string[] = []) { const allowed = new Set([...keys, ...optional]); return Object.keys(value).every((key) => allowed.has(key)) && keys.filter((key) => !optional.includes(key)).every((key) => key in value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function safeRelativeKey(value: unknown): value is string { return nonempty(value) && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."); }
function awaiting(): RelatedResponse { return { state: "awaiting_analysis", hits: [] }; }
function invalid() { return new RelatedClipServiceError(400, "semantic_request_invalid", false); }
function unsupported() { return new RelatedClipServiceError(409, "semantic_space_unsupported", false); }
function unavailable() { return new RelatedClipServiceError(503, "semantic_unavailable", true); }
