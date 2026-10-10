export const SEMANTIC_EMBEDDING_SPACE = "clap-htsat-unfused-512-v1" as const;
export const SEMANTIC_VECTOR_DIMENSIONS = 512;
export const DEFAULT_SEMANTIC_LIMIT = 24;
export const MAX_SEMANTIC_LIMIT = 100;

export type SemanticKind = "saved_clip" | "window";
export interface SemanticIdentity { semanticId: string; sampleId: string; recordingId: string; kind: SemanticKind; clipId?: string; start: number; end: number; audioSha256: string; embeddingSpace: typeof SEMANTIC_EMBEDDING_SPACE; processingFingerprint: string; }
export interface SemanticRecord { identity: SemanticIdentity; vector: number[]; display: { samplePath: string; sampleTitle: string; clipName?: string; clipKind?: string; tags: string[] }; playback: { fileKey: string; start: number; end: number }; revision: string; metadataUpdatedAt: string; }
export interface SemanticSearchRequest { queryVector: number[]; embeddingSpace: typeof SEMANTIC_EMBEDDING_SPACE; kind?: SemanticKind; sampleId?: string; limit?: number; }
export interface ValidSemanticSearchRequest extends Omit<SemanticSearchRequest, "limit"> { limit: number; }
export interface SemanticSearchHit { score: number; identity: SemanticIdentity; parent: { sampleId: string; recordingId: string; samplePath: string; sampleTitle: string }; timeRange: { start: number; end: number }; card: { clipId?: string; clipName?: string; clipKind?: string; tags: string[] }; playback: { fileKey: string; start: number; end: number }; }
export interface SemanticSearchResponse { hits: SemanticSearchHit[]; embeddingSpace: typeof SEMANTIC_EMBEDDING_SPACE; candidateCount: number; filteredCount: number; }

const sha = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("semantic value must be an object"); return value as Record<string, unknown>; };
const exact = (value: Record<string, unknown>, keys: string[]) => { if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new TypeError("semantic object has unexpected fields"); };

export function validateSemanticVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== SEMANTIC_VECTOR_DIMENSIONS || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) throw new TypeError("semantic vector must have 512 finite entries");
  const norm = Math.hypot(...value);
  if (norm <= 1e-9 || Math.abs(norm - 1) > 1e-4) throw new TypeError("semantic vector must have unit norm");
  return [...value];
}

export function validateSemanticRecord(value: unknown): SemanticRecord {
  const record = object(value); exact(record, ["identity", "vector", "display", "playback", "revision", "metadataUpdatedAt"]);
  const identity = object(record.identity); const saved = identity.kind === "saved_clip";
  exact(identity, saved ? ["semanticId", "sampleId", "recordingId", "kind", "clipId", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint"] : ["semanticId", "sampleId", "recordingId", "kind", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint"]);
  if (!sha(identity.semanticId) || !nonempty(identity.sampleId) || !nonempty(identity.recordingId) || !sha(identity.audioSha256) || !nonempty(identity.processingFingerprint) || (identity.kind !== "saved_clip" && identity.kind !== "window") || (saved && !nonempty(identity.clipId)) || identity.embeddingSpace !== SEMANTIC_EMBEDDING_SPACE || !validBounds(identity.start, identity.end)) throw new TypeError("invalid semantic identity");
  const display = object(record.display);
  for (const key of Object.keys(display)) if (!["samplePath", "sampleTitle", "clipName", "clipKind", "tags"].includes(key)) throw new TypeError("invalid semantic display");
  if (typeof display.samplePath !== "string" || typeof display.sampleTitle !== "string" || !Array.isArray(display.tags) || display.tags.some((tag) => typeof tag !== "string") || (display.clipName !== undefined && typeof display.clipName !== "string") || (display.clipKind !== undefined && typeof display.clipKind !== "string")) throw new TypeError("invalid semantic display");
  const playback = object(record.playback); exact(playback, ["fileKey", "start", "end"]);
  if (!nonempty(playback.fileKey) || !validBounds(playback.start, playback.end) || playback.start !== identity.start || playback.end !== identity.end || !sha(record.revision) || !awareTimestamp(record.metadataUpdatedAt)) throw new TypeError("invalid semantic record");
  validateSemanticVector(record.vector);
  return value as SemanticRecord;
}

function validBounds(start: unknown, end: unknown): boolean { return typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start; }
function awareTimestamp(value: unknown): value is string { return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value)); }

export function validateSearchRequest(value: unknown): ValidSemanticSearchRequest {
  const request = object(value); for (const key of Object.keys(request)) if (!["queryVector", "embeddingSpace", "kind", "sampleId", "limit"].includes(key)) throw new TypeError("unsupported semantic request field");
  if (request.embeddingSpace !== SEMANTIC_EMBEDDING_SPACE || (request.kind !== undefined && request.kind !== "saved_clip" && request.kind !== "window") || (request.sampleId !== undefined && !nonempty(request.sampleId))) throw new TypeError("unsupported semantic request");
  const limit = request.limit === undefined ? DEFAULT_SEMANTIC_LIMIT : request.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_SEMANTIC_LIMIT) throw new TypeError("semantic limit must be 1 through 100");
  const kind = request.kind as SemanticKind | undefined;
  const sampleId = request.sampleId as string | undefined;
  return { queryVector: validateSemanticVector(request.queryVector), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, ...(kind ? { kind } : {}), ...(sampleId ? { sampleId } : {}), limit: limit as number };
}
