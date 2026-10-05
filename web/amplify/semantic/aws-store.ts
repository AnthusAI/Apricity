import { createHash } from "node:crypto";

import { GetItemCommand, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { SEMANTIC_EMBEDDING_SPACE, type SemanticRecord, validateSemanticRecord } from "../../src/semantic/contracts";
import { canonicalSemanticId, type CanonicalClip, type CanonicalFileRef, type CanonicalRecording, type CanonicalSample } from "./canonical";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 4096;
const MAX_EMPTY_PAGES = 16;
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const safeKey = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export type AwsDynamoSend = (command: GetItemCommand | QueryCommand) => Promise<unknown>;
/** The S3 adapter returns decoded bytes, null only for a confirmed missing object, and throws for outages. */
export type AnalysisObjectReader = (request: { Bucket: string; Key: string }) => Promise<Uint8Array | null>;
export type AwsSemanticStoreOptions = Readonly<{
  send: AwsDynamoSend;
  readAnalysisObject: AnalysisObjectReader;
  tables: { sample: string; recording: string; clip: string; semantic: string };
  analysisBucket: string;
}>;
export type AwsSemanticStore = Readonly<{
  readSample: (id: string) => Promise<CanonicalSample | null>;
  readRecording: (id: string) => Promise<CanonicalRecording | null>;
  readClip: (id: string) => Promise<CanonicalClip | null>;
  readAnalysis: (ref: CanonicalFileRef) => Promise<Uint8Array | null>;
  readSource: (request: { embeddingSpace: string; sampleId: string; clipId: string }) => Promise<SemanticRecord | null>;
  readSampleSources: (request: { embeddingSpace: string; sampleId: string }) => Promise<SemanticRecord[]>;
}>;

/**
 * A per-handler-invocation AWS adapter.  Its maps deliberately live in this factory, never module scope:
 * callers create one instance per request so canonical reads cannot cross authorization contexts.
 */
export function createAwsSemanticStore(options: AwsSemanticStoreOptions): AwsSemanticStore {
  const cache = new Map<string, Promise<unknown>>();
  const memo = <T>(key: string, read: () => Promise<T>) => {
    let value = cache.get(key) as Promise<T> | undefined;
    if (!value) { value = read(); cache.set(key, value); }
    return value;
  };
  const get = async (table: string, id: string, projection: string, names?: Record<string, string>) => {
    if (!safeId(id)) return null;
    const output = await options.send(new GetItemCommand({ TableName: table, Key: { id: { S: id } }, ConsistentRead: true, ProjectionExpression: projection, ...(names ? { ExpressionAttributeNames: names } : {}) }));
    if (!object(output)) throw new Error("malformed DynamoDB GetItem response");
    if (output.Item === undefined) return null;
    return attributeMap(output.Item);
  };
  return {
    readSample: (id) => memo(`sample:${id}`, async () => {
      const item = await get(options.tables.sample, id, "id, recordingId, path, title, #status, duration, tags, audio, analysis", { "#status": "status" });
      if (item === null) return null;
      const result = sample(item);
      if (result.id !== id) throw new Error("foreign Sample GetItem row");
      return result;
    }),
    readRecording: (id) => memo(`recording:${id}`, async () => {
      const item = await get(options.tables.recording, id, "id, title, rights, license, author, credit");
      if (item === null) return null;
      const result = recording(item);
      if (result.id !== id) throw new Error("foreign Recording GetItem row");
      return result;
    }),
    readClip: (id) => memo(`clip:${id}`, async () => {
      const item = await get(options.tables.clip, id, "id, sampleId, #name, #start, #end, kind, tags, retired", { "#name": "name", "#start": "start", "#end": "end" });
      if (item === null) return null;
      const result = clip(item);
      if (result.id !== id) throw new Error("foreign Clip GetItem row");
      return result;
    }),
    async readAnalysis(ref) {
      if (!fileRef(ref) || !ref.key.startsWith("analysis/")) return null;
      const bytes = await options.readAnalysisObject({ Bucket: options.analysisBucket, Key: `files/${ref.key}` });
      if (bytes === null) return null;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new Error("invalid analysis object");
      return bytes;
    },
    readSampleSources: (request) => memo(`sources:${request.embeddingSpace}:${request.sampleId}`, () => sources(options, request)),
    async readSource(request) {
      const records = await memo(`sources:${request.embeddingSpace}:${request.sampleId}`, () => sources(options, request));
      const matches = records.filter((record) => record.identity.kind === "saved_clip" && record.identity.clipId === request.clipId);
      if (matches.length > 1) throw new Error("duplicate stored clip source");
      return matches[0] ?? null;
    },
  };
}

async function sources(options: AwsSemanticStoreOptions, request: { embeddingSpace: string; sampleId: string }): Promise<SemanticRecord[]> {
  if (request.embeddingSpace !== SEMANTIC_EMBEDDING_SPACE || !safeId(request.sampleId)) return [];
  const partition = sha(JSON.stringify([request.embeddingSpace, request.sampleId]));
  const records: SemanticRecord[] = []; const seen = new Set<string>(); const cursors = new Set<string>(); let key: Record<string, AttributeValue> | undefined; let bytes = 0; let emptyPages = 0;
  for (;;) {
    const output = await options.send(new QueryCommand({ TableName: options.tables.semantic, IndexName: "semantic-by-sample", KeyConditionExpression: "samplePartition = :samplePartition", ExpressionAttributeValues: { ":samplePartition": { S: partition } }, ProjectionExpression: "identity, #vector, display, playback, revision, metadataUpdatedAt", ExpressionAttributeNames: { "#vector": "vector" }, ...(key ? { ExclusiveStartKey: key } : {}) }));
    if (!object(output) || !Array.isArray(output.Items)) throw new Error("malformed DynamoDB Query response");
    emptyPages = output.Items.length === 0 ? emptyPages + 1 : 0;
    if (emptyPages > MAX_EMPTY_PAGES) throw new Error("semantic source pagination made no progress");
    for (const item of output.Items) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (records.length + 1 > MAX_RECORDS || bytes > MAX_BYTES) throw new Error("semantic source limit exceeded");
      const parsed = semantic(attributeMap(item));
      if (parsed.identity.sampleId !== request.sampleId || parsed.identity.embeddingSpace !== request.embeddingSpace || canonicalSemanticId(parsed.identity) !== parsed.identity.semanticId || seen.has(parsed.identity.semanticId)) throw new Error("invalid semantic source row");
      seen.add(parsed.identity.semanticId); records.push(parsed);
    }
    const next = output.LastEvaluatedKey;
    if (next === undefined) return records;
    key = nativeKey(next);
    const cursor = JSON.stringify(key);
    if (cursors.has(cursor)) throw new Error("semantic source pagination repeated cursor");
    cursors.add(cursor);
  }
}

function attributeMap(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("malformed DynamoDB item");
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, attribute(entry)]));
}
function attribute(value: unknown): unknown {
  if (!object(value) || Object.keys(value).length !== 1) throw new Error("malformed AttributeValue");
  if (typeof value.S === "string") return value.S;
  if (typeof value.N === "string" && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value.N) && Number.isFinite(Number(value.N))) return Number(value.N);
  if (typeof value.BOOL === "boolean") return value.BOOL;
  if (value.NULL === true) return null;
  if (Array.isArray(value.L)) return value.L.map(attribute);
  if (object(value.M)) return attributeMap(value.M);
  throw new Error("unsupported AttributeValue");
}
function nativeKey(value: unknown): Record<string, AttributeValue> {
  if (!object(value) || !Object.keys(value).length) throw new Error("malformed query cursor");
  for (const entry of Object.values(value)) attribute(entry);
  return value as Record<string, AttributeValue>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) { return Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => key in value); }
function fileRef(value: unknown): value is CanonicalFileRef {
  return object(value) && exact(value, ["key", "sha256"], ["size", "contentType"]) && safeKey(value.key) && hash(value.sha256) && (value.size === undefined || typeof value.size === "number" && Number.isInteger(value.size) && value.size >= 0) && (value.contentType === undefined || typeof value.contentType === "string");
}
function sample(value: Record<string, unknown>): CanonicalSample {
  if (!exact(value, ["id", "recordingId", "path", "title", "audio"], ["status", "duration", "tags", "analysis"]) || !safeId(value.id) || !safeId(value.recordingId) || !safeId(value.path) || !safeId(value.title) || !fileRef(value.audio) || (value.status !== undefined && value.status !== null && typeof value.status !== "string") || (value.duration !== undefined && value.duration !== null && (typeof value.duration !== "number" || !Number.isFinite(value.duration))) || (value.tags !== undefined && value.tags !== null && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string"))) || (value.analysis !== undefined && value.analysis !== null && !fileRef(value.analysis))) throw new Error("malformed Sample record");
  return value as unknown as CanonicalSample;
}
function recording(value: Record<string, unknown>): CanonicalRecording {
  if (!exact(value, ["id"], ["title", "rights", "license", "author", "credit"]) || !safeId(value.id) || Object.values(value).some((entry) => entry !== null && typeof entry !== "string")) throw new Error("malformed Recording record");
  return value as unknown as CanonicalRecording;
}
function clip(value: Record<string, unknown>): CanonicalClip {
  if (!exact(value, ["id", "sampleId", "name", "start", "end"], ["kind", "tags", "retired"]) || !safeId(value.id) || !safeId(value.sampleId) || !safeId(value.name) || typeof value.start !== "number" || typeof value.end !== "number" || !Number.isFinite(value.start) || !Number.isFinite(value.end) || (value.kind !== undefined && value.kind !== null && typeof value.kind !== "string") || (value.tags !== undefined && value.tags !== null && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string"))) || (value.retired !== undefined && value.retired !== null && typeof value.retired !== "boolean")) throw new Error("malformed Clip record");
  return value as unknown as CanonicalClip;
}
function semantic(value: Record<string, unknown>): SemanticRecord {
  if (!exact(value, ["identity", "vector", "display", "playback", "revision", "metadataUpdatedAt"])) throw new Error("unexpected semantic projection");
  try { return validateSemanticRecord(value); } catch { throw new Error("malformed semantic record"); }
}
function safeId(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
