import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { SEMANTIC_EMBEDDING_SPACE, type SemanticIdentity } from "../../src/semantic/contracts";
import { canonicalSemanticId, createCanonicalHydrator } from "./canonical";
import { createAwsSemanticStore } from "./aws-store";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const vector = Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0);
const id = (part: string, overrides: Partial<Omit<SemanticIdentity, "semanticId">> = {}): SemanticIdentity => {
  const value = { sampleId: "smp_A", recordingId: "rec_A", kind: "saved_clip" as const, clipId: `clp_${part}`, start: 0, end: 4, audioSha256: "a".repeat(64), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, processingFingerprint: "fp-v1", ...overrides };
  return { ...value, semanticId: canonicalSemanticId(value)! };
};
const av = (value: unknown): any => Array.isArray(value) ? { L: value.map(av) } : value && typeof value === "object" ? { M: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, av(entry)])) } : typeof value === "number" ? { N: String(value) } : typeof value === "boolean" ? { BOOL: value } : { S: value };
const record = (identity = id("A")) => ({ identity, vector, display: { samplePath: "a.wav", sampleTitle: "A", clipName: "Clip", tags: [] }, playback: { fileKey: "audio/a.wav", start: 0, end: 4 }, revision: sha(JSON.stringify([identity.semanticId, ""])), metadataUpdatedAt: "2026-01-01T00:00:00Z" });
const sampleItem = (value = "smp_A") => av({ id: value, recordingId: "rec_A", path: "a.wav", title: "A", audio: { key: "audio/a.wav", sha256: "a".repeat(64) } }).M;
const recordingItem = (value = "rec_A") => av({ id: value }).M;
const clipItem = (value = "clp_A") => av({ id: value, sampleId: "smp_A", name: "Clip", start: 0, end: 4 }).M;
const sourceRows = (count: number) => Array.from({ length: count }, (_, index) => av(record(id(`cap_${index}`))).M);

function fixture() {
  const commands: unknown[] = [];
  const store = createAwsSemanticStore({
    send: async (command) => { commands.push(command); return { Item: undefined, Items: [] }; },
    readAnalysisObject: async () => null,
    tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" },
    analysisBucket: "bucket",
  });
  return { store, commands };
}

describe("AWS semantic store", () => {
  it("uses exact consistent canonical GetItem keys and minimal projections", async () => {
    const { store, commands } = fixture();
    await Promise.all([store.readSample("smp_A"), store.readRecording("rec_A"), store.readClip("clp_A")]);
    assert.equal(commands.length, 3);
    assert.deepEqual((commands[0] as GetItemCommand).input, { TableName: "Sample", Key: { id: { S: "smp_A" } }, ConsistentRead: true, ProjectionExpression: "id, recordingId, path, title, #status, duration, tags, audio, analysis", ExpressionAttributeNames: { "#status": "status" } });
    assert.deepEqual((commands[1] as GetItemCommand).input, { TableName: "Recording", Key: { id: { S: "rec_A" } }, ConsistentRead: true, ProjectionExpression: "id, title, rights, license, author, credit" });
    assert.deepEqual((commands[2] as GetItemCommand).input, { TableName: "Clip", Key: { id: { S: "clp_A" } }, ConsistentRead: true, ProjectionExpression: "id, sampleId, #name, #start, #end, kind, tags, retired", ExpressionAttributeNames: { "#name": "name", "#start": "start", "#end": "end" } });
  });

  it("treats the AWS omitted Item shape as absence, propagates outages, and rejects foreign canonical GetItem rows", async () => {
    const missing = createAwsSemanticStore({ send: async () => ({}), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    assert.equal(await missing.readSample("smp_A"), null);
    assert.equal(await missing.readRecording("rec_A"), null);
    assert.equal(await missing.readClip("clp_A"), null);
    const explicitMissing = createAwsSemanticStore({ send: async () => ({ Item: undefined }), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    assert.equal(await explicitMissing.readSample("smp_A"), null);
    const down = createAwsSemanticStore({ send: async () => { throw new Error("DynamoDB down"); }, readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(down.readSample("smp_A"));
    for (const [method, item] of [["readSample", sampleItem("smp_foreign")], ["readRecording", recordingItem("rec_foreign")], ["readClip", clipItem("clp_foreign")]] as const) {
      const foreign = createAwsSemanticStore({ send: async () => ({ Item: item }), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
      await assert.rejects(foreign[method](method === "readSample" ? "smp_A" : method === "readRecording" ? "rec_A" : "clp_A"));
    }
    const malformedFileRef = createAwsSemanticStore({ send: async () => ({ Item: { id: { S: "smp_A" }, recordingId: { S: "rec_A" }, path: { S: "a.wav" }, title: { S: "A" }, audio: { M: { key: { S: "audio/a.wav" }, sha256: { NULL: true } } } } }), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(malformedFileRef.readSample("smp_A"));
  });

  it("reads only safe analysis FileRefs below the decoded 16MiB cap and preserves absence versus outage", async () => {
    const bytes = new Uint8Array(Buffer.from("analysis")); let calls: unknown[] = [];
    const store = createAwsSemanticStore({ send: async () => ({ Items: [] }), readAnalysisObject: async (request) => { calls.push(request); return bytes; }, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    assert.deepEqual(await store.readAnalysis({ key: "analysis/smp_A/grid.json", sha256: sha(bytes) }), bytes);
    assert.deepEqual(calls, [{ Bucket: "bucket", Key: "files/analysis/smp_A/grid.json" }]);
    assert.equal(await store.readAnalysis({ key: "analysis/../escape.json", sha256: sha(bytes) }), null);
    const missing = createAwsSemanticStore({ send: async () => ({ Items: [] }), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    assert.equal(await missing.readAnalysis({ key: "analysis/a.json", sha256: "a".repeat(64) }), null);
    const down = createAwsSemanticStore({ send: async () => ({ Items: [] }), readAnalysisObject: async () => { throw new Error("S3 down"); }, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(down.readAnalysis({ key: "analysis/a.json", sha256: "a".repeat(64) }));
    const tooLarge = createAwsSemanticStore({ send: async () => ({ Items: [] }), readAnalysisObject: async () => new Uint8Array(16 * 1024 * 1024 + 1), tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(tooLarge.readAnalysis({ key: "analysis/a.json", sha256: "a".repeat(64) }));
    const malformed = createAwsSemanticStore({ send: async () => ({ Items: [] }), readAnalysisObject: async () => { throw new Error("must not read"); }, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    assert.equal(await malformed.readAnalysis({ key: "analysis/a.json", sha256: "a".repeat(64), unexpected: true } as any), null);
    const badHash = createAwsSemanticStore({ send: async () => ({ Items: [] }), readAnalysisObject: async () => bytes, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    assert.deepEqual(await badHash.readAnalysis({ key: "analysis/a.json", sha256: "a".repeat(64) }), bytes);
  });

  it("lets the canonical hydrator reject an analysis hash mismatch after the exact safe S3 read", async () => {
    const bytes = new Uint8Array(Buffer.from(JSON.stringify({ source: { sha256: "a".repeat(64) }, rhythm: { bpm: 120, meter: 4, beats: [0], downbeats: [0] } })));
    const store = createAwsSemanticStore({ send: async () => ({}), readAnalysisObject: async () => bytes, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    const identity = id("window", { kind: "window", clipId: undefined, start: 0, end: 4 });
    const hydrate = createCanonicalHydrator({ processingFingerprint: "fp-v1", readSample: async () => ({ id: "smp_A", recordingId: "rec_A", path: "a.wav", title: "A", status: "ready", audio: { key: "audio/a.wav", sha256: "a".repeat(64) }, analysis: { key: "analysis/smp_A/grid.json", sha256: "b".repeat(64) } }), readRecording: async () => ({ id: "rec_A" }), readClip: async () => null, readAnalysis: store.readAnalysis });
    assert.equal(await hydrate({ identity, revision: sha(JSON.stringify([identity.semanticId, ""])) }), null);
  });

  it("queries only the dedicated sample GSI using compact SHA-256 partitioning, pages fully, and returns full stored records", async () => {
    const value = record(); const commands: unknown[] = []; let page = 0;
    const store = createAwsSemanticStore({ send: async (command) => { commands.push(command); return page++ === 0 ? { Items: [av(value).M], LastEvaluatedKey: { samplePartition: { S: "next" } } } : { Items: [] }; }, readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    assert.deepEqual(await store.readSampleSources({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "smp_A" }), [value]);
    assert.equal(commands.every((command) => command instanceof QueryCommand), true);
    const partition = sha(JSON.stringify([SEMANTIC_EMBEDDING_SPACE, "smp_A"]));
    assert.deepEqual((commands[0] as QueryCommand).input, { TableName: "Semantic", IndexName: "semantic-by-sample", KeyConditionExpression: "samplePartition = :samplePartition", ExpressionAttributeValues: { ":samplePartition": { S: partition } }, ProjectionExpression: "identity, #vector, display, playback, revision, metadataUpdatedAt", ExpressionAttributeNames: { "#vector": "vector" } });
    assert.deepEqual((commands[1] as QueryCommand).input.ExclusiveStartKey, { samplePartition: { S: "next" } });
  });

  it("fails closed rather than returning a partial source set, rejects malformed or wrong-scope rows, and never substitutes another clip", async () => {
    const value = record();
    const overLimit = createAwsSemanticStore({ send: async () => ({ Items: sourceRows(4097) }), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(overLimit.readSampleSources({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "smp_A" }));
    const wrong = record(id("wrong", { sampleId: "smp_other" }));
    const scoped = createAwsSemanticStore({ send: async () => ({ Items: [av(wrong).M] }), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(scoped.readSampleSources({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "smp_A" }));
    assert.equal(await scoped.readSource({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "smp_A", clipId: "clp_A" }).catch(() => null), null);
    const wrongModel = { ...value, identity: { ...value.identity, embeddingSpace: "foreign-model" } };
    const foreignModel = createAwsSemanticStore({ send: async () => ({ Items: [av(wrongModel).M] }), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(foreignModel.readSampleSources({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "smp_A" }));
    const duplicate = createAwsSemanticStore({ send: async () => ({ Items: [av(value).M, av(value).M] }), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(duplicate.readSampleSources({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "smp_A" }));
    const malformed = createAwsSemanticStore({ send: async () => ({ Items: [{ identity: { S: "not-a-map" } }] }), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(malformed.readSampleSources({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "smp_A" }));
  });

  it("bounds repeated cursors and empty repeated pages, rejects oversized source payloads, and never queries invalid source scope", async () => {
    let cursorCalls = 0;
    const looping = createAwsSemanticStore({ send: async () => { cursorCalls += 1; return { Items: [], LastEvaluatedKey: { samplePartition: { S: "same" } } }; }, readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(looping.readSampleSources({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "smp_A" }));
    assert.equal(cursorCalls, 2);
    const huge = createAwsSemanticStore({ send: async () => ({ Items: [{ payload: { S: "x".repeat(16 * 1024 * 1024 + 1) } }] }), readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    await assert.rejects(huge.readSampleSources({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "smp_A" }));
    let queries = 0;
    const invalid = createAwsSemanticStore({ send: async () => { queries += 1; return { Items: [] }; }, readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" });
    assert.deepEqual(await invalid.readSampleSources({ embeddingSpace: "", sampleId: "smp_A" }), []);
    assert.deepEqual(await invalid.readSampleSources({ embeddingSpace: "foreign-model", sampleId: "smp_A" }), []);
    assert.equal(await invalid.readSource({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "", clipId: "clp_A" }), null);
    assert.equal(queries, 0);
  });

  it("keeps memoized canonical data request-local so independent curator and guest contexts cannot share it", async () => {
    let reads = 0;
    const options = { send: async () => { reads += 1; return { Item: undefined, Items: [] }; }, readAnalysisObject: async () => null, tables: { sample: "Sample", recording: "Recording", clip: "Clip", semantic: "Semantic" }, analysisBucket: "bucket" };
    const guest = createAwsSemanticStore(options); const curator = createAwsSemanticStore(options);
    await guest.readSample("smp_A"); await guest.readSample("smp_A"); await curator.readSample("smp_A");
    assert.equal(reads, 2);
  });
});
