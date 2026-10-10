import { SearchVectorsCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  SEMANTIC_EMBEDDING_SPACE,
  type SemanticIdentity,
  type SemanticSearchHit,
  type SemanticSearchResponse,
  type ValidSemanticSearchRequest,
  validateSearchRequest,
} from "../../src/semantic/contracts";
import { canonicalSemanticId, roundHalfUpMicroseconds } from "./canonical";

const MAX_CANDIDATES = 100;
const requestKeys = new Set(["queryVector", "embeddingSpace", "kind", "sampleId", "limit"]);

export type CloudSearchServiceErrorCode = "semantic_request_invalid" | "semantic_space_unsupported" | "semantic_unavailable";

/** A structured boundary error intended for the later HTTP integration. */
export class CloudSearchServiceError extends Error {
  constructor(public readonly status: 400 | 409 | 503, public readonly code: CloudSearchServiceErrorCode, public readonly retryable: boolean) {
    super(code);
    this.name = "CloudSearchServiceError";
  }
}

/** Compatible with DynamoDBClient#send while keeping the external response untrusted until decoded. */
export type SearchVectorsSend = (command: SearchVectorsCommand) => Promise<unknown>;
export type CloudSearchCandidate = Readonly<{ identity: SemanticIdentity; revision: string }>;

export type CloudSearchServiceOptions = Readonly<{
  send: SearchVectorsSend;
  tableName: string;
  indexName: string;
  hydrate: (candidate: CloudSearchCandidate, context: unknown) => Promise<Omit<SemanticSearchHit, "score"> | null>;
}>;

export type CloudSearchService = Readonly<{
  search: (request: unknown, context?: unknown) => Promise<SemanticSearchResponse>;
}>;

/**
 * Isolated native-vector adapter. It deliberately has no HTTP surface and does
 * not substitute indexed display data for the required canonical hydrator.
 */
export function createCloudSearchService(options: CloudSearchServiceOptions): CloudSearchService {
  return {
    async search(request: unknown, context?: unknown): Promise<SemanticSearchResponse> {
      const normalized = normalizeRequest(request);
      const command = new SearchVectorsCommand(commandInput(options.tableName, options.indexName, normalized));
      let output: unknown;
      try {
        // This is intentionally the adapter's only DynamoDB operation: no Scan, Query, or pagination path exists.
        output = await options.send(command);
      } catch (error) {
        throw unavailable(error);
      }

      let candidates: CandidateScore[];
      try {
        candidates = decodeCandidates(output, normalized);
      } catch (error) {
        throw unavailable(error);
      }

      let guarded: Array<{ candidate: CandidateScore; hit: Omit<SemanticSearchHit, "score"> | null }>;
      try {
        guarded = await Promise.all(candidates.map(async (candidate) => ({
          candidate,
          hit: await options.hydrate({ identity: candidate.identity, revision: candidate.revision }, context),
        })));
      } catch (error) {
        throw unavailable(error);
      }

      const accepted = guarded.flatMap(({ candidate, hit }) => hit && sameIdentity(hit.identity, candidate.identity)
        ? [{ ...hit, score: candidate.score }]
        : []);
      accepted.sort((left, right) => right.score - left.score || left.identity.semanticId.localeCompare(right.identity.semanticId));
      const hits = accepted.slice(0, normalized.limit);
      return {
        hits,
        embeddingSpace: normalized.embeddingSpace,
        candidateCount: candidates.length,
        // Only candidates rejected by canonical hydration or identity validation are filtered; limiting is not filtering.
        filteredCount: candidates.length - accepted.length,
      };
    },
  };
}

function normalizeRequest(request: unknown): ValidSemanticSearchRequest {
  if (isObject(request) && Object.keys(request).every((key) => requestKeys.has(key)) && request.embeddingSpace !== undefined && request.embeddingSpace !== SEMANTIC_EMBEDDING_SPACE) {
    throw new CloudSearchServiceError(409, "semantic_space_unsupported", false);
  }
  try {
    return validateSearchRequest(request);
  } catch {
    throw new CloudSearchServiceError(400, "semantic_request_invalid", false);
  }
}

function commandInput(tableName: string, indexName: string, request: ValidSemanticSearchRequest) {
  const names: Record<string, string> = { "#space": "embeddingSpace" };
  const values: Record<string, AttributeValue> = { ":space": { S: request.embeddingSpace } };
  const terms = ["#space = :space"];
  if (request.kind) {
    names["#kind"] = "kind"; values[":kind"] = { S: request.kind }; terms.push("#kind = :kind");
  }
  if (request.sampleId) {
    names["#sampleId"] = "sampleId"; values[":sampleId"] = { S: request.sampleId }; terms.push("#sampleId = :sampleId");
  }
  return {
    TableName: tableName,
    IndexName: indexName,
    TopK: MAX_CANDIDATES,
    ProjectionExpression: "embeddingSpace, semanticId, identity, revision",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    SearchConditionExpression: terms.join(" AND "),
    // Native SearchVectors requires DynamoDB AttributeValues, not a document-client number array.
    SearchVector: request.queryVector.map((value) => ({ N: String(value) })),
  };
}

type CandidateScore = CloudSearchCandidate & { score: number };

function decodeCandidates(output: unknown, request: ValidSemanticSearchRequest): CandidateScore[] {
  if (!isObject(output) || (output.SearchResults !== undefined && !Array.isArray(output.SearchResults))) throw new TypeError("invalid SearchVectors response");
  const rows = output.SearchResults ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_CANDIDATES) throw new TypeError("invalid SearchVectors result list");
  const candidates = rows.map((row) => decodeRow(row, request.embeddingSpace));
  const ids = new Set<string>();
  let fingerprint: string | undefined;
  for (const candidate of candidates) {
    if (ids.has(candidate.identity.semanticId)) throw new TypeError("duplicate semantic identity in SearchVectors result");
    ids.add(candidate.identity.semanticId);
    if ((request.kind !== undefined && candidate.identity.kind !== request.kind) || (request.sampleId !== undefined && candidate.identity.sampleId !== request.sampleId)) throw new TypeError("SearchVectors result violates request constraints");
    if (fingerprint === undefined) fingerprint = candidate.identity.processingFingerprint;
    else if (fingerprint !== candidate.identity.processingFingerprint) throw new TypeError("incompatible processing fingerprint in SearchVectors result");
  }
  return candidates;
}

function decodeRow(value: unknown, embeddingSpace: string): CandidateScore {
  if (!isObject(value) || !exactKeys(value, ["Score", "Item"]) || typeof value.Score !== "number" || !Number.isFinite(value.Score)) throw new TypeError("invalid SearchVectors score");
  const item = itemMap(value.Item, ["embeddingSpace", "semanticId", "identity", "revision"]);
  const indexedSpace = stringAttribute(item.embeddingSpace);
  const indexedId = stringAttribute(item.semanticId);
  const revision = stringAttribute(item.revision);
  if (indexedSpace !== embeddingSpace || !sha256(revision)) throw new TypeError("incompatible SearchVectors row");
  const identity = decodeIdentity(item.identity);
  if (identity.embeddingSpace !== embeddingSpace || identity.semanticId !== indexedId) throw new TypeError("incompatible SearchVectors identity");
  return { identity, revision, score: value.Score };
}

function decodeIdentity(value: unknown): SemanticIdentity {
  const raw = attributeMap(value);
  const kind = stringAttribute(raw.kind);
  const required = kind === "saved_clip"
    ? ["semanticId", "sampleId", "recordingId", "kind", "clipId", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint"]
    : kind === "window"
      ? ["semanticId", "sampleId", "recordingId", "kind", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint"]
      : [];
  if (!exactKeys(raw, required)) throw new TypeError("invalid semantic identity fields");
  const identity: SemanticIdentity = {
    semanticId: stringAttribute(raw.semanticId), sampleId: nonemptyAttribute(raw.sampleId), recordingId: nonemptyAttribute(raw.recordingId),
    kind: kind as SemanticIdentity["kind"], ...(kind === "saved_clip" ? { clipId: nonemptyAttribute(raw.clipId) } : {}),
    start: numberAttribute(raw.start), end: numberAttribute(raw.end), audioSha256: stringAttribute(raw.audioSha256),
    embeddingSpace: stringAttribute(raw.embeddingSpace) as SemanticIdentity["embeddingSpace"], processingFingerprint: nonemptyAttribute(raw.processingFingerprint),
  };
  if (!sha256(identity.audioSha256) || identity.embeddingSpace !== SEMANTIC_EMBEDDING_SPACE || !validBounds(identity.start, identity.end) || identity.semanticId !== canonicalSemanticId(identity)) throw new TypeError("noncanonical semantic identity");
  return identity;
}

function attributeMap(value: unknown, expected?: string[]): Record<string, AttributeValue> {
  if (!isObject(value) || !exactKeys(value, ["M"]) || !isObject(value.M) || (expected && !exactKeys(value.M, expected))) throw new TypeError("invalid DynamoDB map attribute");
  return value.M as Record<string, AttributeValue>;
}

function itemMap(value: unknown, expected: string[]): Record<string, AttributeValue> {
  if (!isObject(value) || !exactKeys(value, expected)) throw new TypeError("invalid projected DynamoDB item");
  return value as Record<string, AttributeValue>;
}

function stringAttribute(value: unknown): string {
  if (!isObject(value) || !exactKeys(value, ["S"]) || typeof value.S !== "string") throw new TypeError("invalid DynamoDB string attribute");
  return value.S;
}

function nonemptyAttribute(value: unknown): string {
  const result = stringAttribute(value);
  if (!result) throw new TypeError("empty DynamoDB string attribute");
  return result;
}

function numberAttribute(value: unknown): number {
  if (!isObject(value) || !exactKeys(value, ["N"]) || typeof value.N !== "string" || !value.N.trim()) throw new TypeError("invalid DynamoDB number attribute");
  const result = Number(value.N);
  if (!Number.isFinite(result)) throw new TypeError("nonfinite DynamoDB number attribute");
  return result;
}

function sameIdentity(left: SemanticIdentity, right: SemanticIdentity): boolean {
  return canonicalSemanticId(left) === right.semanticId && canonicalSemanticId(right) === left.semanticId
    && left.semanticId === right.semanticId && left.sampleId === right.sampleId && left.recordingId === right.recordingId
    && left.kind === right.kind && left.clipId === right.clipId && left.start === right.start && left.end === right.end
    && left.audioSha256 === right.audioSha256 && left.embeddingSpace === right.embeddingSpace
    && left.processingFingerprint === right.processingFingerprint;
}

function validBounds(start: number, end: number): boolean {
  const startMicroseconds = roundHalfUpMicroseconds(start);
  const endMicroseconds = roundHalfUpMicroseconds(end);
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start
    && startMicroseconds !== null && endMicroseconds !== null && endMicroseconds > startMicroseconds;
}
function sha256(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => key in value); }
function unavailable(_error: unknown): CloudSearchServiceError { return new CloudSearchServiceError(503, "semantic_unavailable", true); }
