import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { SearchVectorsCommand } from "@aws-sdk/client-dynamodb";
import { SEMANTIC_EMBEDDING_SPACE, type SemanticIdentity, type SemanticSearchHit } from "../../src/semantic/contracts";
import { canonicalSemanticId, createCanonicalHydrator } from "./canonical";
import { CloudSearchServiceError, createCloudSearchService } from "./search-service";

const vector = (entry = 0) => Array.from({ length: 512 }, (_, index) => index === entry ? 1 : 0);
const compact = (value: unknown) => JSON.stringify(value);
const identity = (suffix: string, overrides: Partial<Omit<SemanticIdentity, "semanticId">> = {}): SemanticIdentity => {
  const base = {
    sampleId: `smp_${suffix}`, recordingId: `rec_${suffix}`, kind: "saved_clip" as const, clipId: `clp_${suffix}`,
    start: 0.0000005, end: 4.0000005, audioSha256: "a".repeat(64),
    embeddingSpace: SEMANTIC_EMBEDDING_SPACE, processingFingerprint: "processing-v1", ...overrides,
  };
  return { ...base, semanticId: canonicalSemanticId(base)! };
};
const revision = (id: string) => createHash("sha256").update(compact([id, ""])).digest("hex");
const attributeIdentity = (value: SemanticIdentity) => ({ M: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === "number" ? { N: String(entry) } : { S: entry }])) });
const row = (value: SemanticIdentity, score = 0.9) => ({ Score: score, Item: { embeddingSpace: { S: value.embeddingSpace }, semanticId: { S: value.semanticId }, identity: attributeIdentity(value), revision: { S: revision(value.semanticId) } } });
const hit = (value: SemanticIdentity, score: number): SemanticSearchHit => ({ score, identity: value, parent: { sampleId: value.sampleId, recordingId: value.recordingId, samplePath: `${value.sampleId}.wav`, sampleTitle: value.sampleId }, timeRange: { start: value.start, end: value.end }, card: { clipId: value.clipId, clipName: value.clipId, clipKind: "loop", tags: [] }, playback: { fileKey: `${value.sampleId}.wav`, start: value.start, end: value.end } });

function fixture(output: unknown = { SearchResults: [] }) {
  const commands: unknown[] = [];
  const hydrated: SemanticIdentity[] = [];
  const service = createCloudSearchService({
    tableName: "SemanticRecords", indexName: "semantic-embedding-v1",
    send: async (command) => { commands.push(command); return output; },
    hydrate: async (candidate) => { hydrated.push(candidate.identity); return hit(candidate.identity, 0); },
  });
  return { service, commands, hydrated };
}

describe("typed cloud semantic search", () => {
  it("accepts the Python contract fixture's round-half-up canonical identity rather than a concatenated surrogate", async () => {
    const candidate: SemanticIdentity = { semanticId: "28a939c4ed0c0375bddc1465eed8b798b97823bee8f026b9e3323a6b71d88914", sampleId: "smp_A", recordingId: "rec_R1", kind: "saved_clip", clipId: "clp_a1", start: 0.0000005, end: 4.0000005, audioSha256: "a".repeat(64), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, processingFingerprint: "preprocess-v1" };
    const { service } = fixture({ SearchResults: [row(candidate)] });
    const response = await service.search({ queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE });
    assert.equal(response.hits[0]?.identity.semanticId, candidate.semanticId);
  });

  it("uses shared canonical identity rules for Unicode and rejects subnormal or out-of-i64 native bounds", async () => {
    const unicode = identity("unicode", { sampleId: "sämp🎵", recordingId: "録音", clipId: "clíp/雪", processingFingerprint: "fp-β" });
    assert.equal(unicode.semanticId, "5f55e9b2a87f472906a911412375413127ee204844eba0aada608ffc87a9b9d3");
    const { service } = fixture({ SearchResults: [row(unicode)] });
    assert.equal((await service.search({ queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE })).hits[0]?.identity.semanticId, unicode.semanticId);

    const subnormalBase = { ...identity("subnormal"), start: 0, end: Number.MIN_VALUE };
    const subnormal = { ...subnormalBase, semanticId: canonicalSemanticId(subnormalBase)! };
    const extreme = { ...identity("extreme"), end: 1e308, semanticId: "0".repeat(64) };
    for (const candidate of [subnormal, extreme]) {
      const invalid = fixture({ SearchResults: [row(candidate)] });
      await assert.rejects(invalid.service.search({ queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE }), (error: unknown) => error instanceof CloudSearchServiceError && error.status === 503 && error.code === "semantic_unavailable");
      assert.deepEqual(invalid.hydrated, []);
    }
  });

  it("sends exactly one native SearchVectors command with the official AttributeValue vector, bounded default top-k, projection, and mandatory hash expression", async () => {
    const candidate = identity("A"); const { service, commands, hydrated } = fixture({ SearchResults: [row(candidate, 0.8)] });
    const response = await service.search({ queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE });
    assert.equal(commands.length, 1); assert.equal(commands[0] instanceof SearchVectorsCommand, true);
    const input = (commands[0] as SearchVectorsCommand).input;
    assert.deepEqual(input, {
      TableName: "SemanticRecords", IndexName: "semantic-embedding-v1", TopK: 100,
      ProjectionExpression: "embeddingSpace, semanticId, identity, revision",
      ExpressionAttributeNames: { "#space": "embeddingSpace" },
      ExpressionAttributeValues: { ":space": { S: SEMANTIC_EMBEDDING_SPACE } },
      SearchConditionExpression: "#space = :space",
      SearchVector: vector().map((entry) => ({ N: String(entry) })),
    });
    assert.deepEqual(hydrated.map((entry) => entry.semanticId), [candidate.semanticId]);
    assert.deepEqual(response, { hits: [hit(candidate, 0.8)], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 1, filteredCount: 0 });
  });

  it("adds only supported equality filters and still performs one no-pagination native operation", async () => {
    const candidate = identity("A"); const { service, commands } = fixture({ SearchResults: [row(candidate)] });
    await service.search({ queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, kind: "saved_clip", sampleId: "smp_A", limit: 100 });
    assert.equal(commands.length, 1); assert.equal(commands[0] instanceof SearchVectorsCommand, true);
    const input = (commands[0] as SearchVectorsCommand).input;
    assert.equal(input.TopK, 100); assert.equal(input.SearchConditionExpression, "#space = :space AND #kind = :kind AND #sampleId = :sampleId");
    assert.deepEqual(input.ExpressionAttributeNames, { "#space": "embeddingSpace", "#kind": "kind", "#sampleId": "sampleId" });
    assert.deepEqual(input.ExpressionAttributeValues, { ":space": { S: SEMANTIC_EMBEDDING_SPACE }, ":kind": { S: "saved_clip" }, ":sampleId": { S: "smp_A" } });
    assert.equal("ExclusiveStartKey" in input, false); assert.equal("Limit" in input, false);
  });

  it("keeps score ordering deterministic across asynchronous canonical hydration, filters stale candidates, and applies the requested limit after guarding", async () => {
    const a = identity("A"), b = identity("B"), stale = identity("stale");
    const deferred = new Map<string, () => void>();
    const service = createCloudSearchService({
      tableName: "SemanticRecords", indexName: "semantic-embedding-v1", send: async () => ({ SearchResults: [row(b, 0.9), row(stale, 0.95), row(a, 0.9)] }),
      hydrate: (candidate) => new Promise((resolve) => deferred.set(candidate.identity.semanticId, () => resolve(candidate.identity.semanticId === stale.semanticId ? null : hit(candidate.identity, 123)))),
    });
    const searching = service.search({ queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, limit: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    deferred.get(a.semanticId)!(); deferred.get(stale.semanticId)!(); deferred.get(b.semanticId)!();
    const response = await searching;
    assert.deepEqual(response.hits.map((entry) => [entry.identity.semanticId, entry.score]), [[[a.semanticId, b.semanticId].sort()[0], 0.9]]);
    assert.equal(response.candidateCount, 3); assert.equal(response.filteredCount, 1);
  });

  it("uses the canonical hydrator to return fresh records, reject stale records, and count only rejected candidates", async () => {
    const fresh = identity("fresh"); const acceptedBeyondLimit = identity("also-fresh"); const stale = identity("stale");
    const samples = new Map([
      [fresh.sampleId, { id: fresh.sampleId, recordingId: fresh.recordingId, path: "fresh.wav", title: "Fresh", status: "ready", duration: 8, tags: ["fresh"], audio: { key: "audio/fresh.wav", sha256: fresh.audioSha256 } }],
      [acceptedBeyondLimit.sampleId, { id: acceptedBeyondLimit.sampleId, recordingId: acceptedBeyondLimit.recordingId, path: "also-fresh.wav", title: "Also fresh", status: "ready", duration: 8, tags: ["fresh"], audio: { key: "audio/also-fresh.wav", sha256: acceptedBeyondLimit.audioSha256 } }],
      [stale.sampleId, { id: stale.sampleId, recordingId: stale.recordingId, path: "stale.wav", title: "Stale", status: "ready", duration: 8, tags: ["stale"], audio: { key: "audio/stale.wav", sha256: stale.audioSha256 } }],
    ]);
    const clips = new Map([
      [fresh.clipId!, { id: fresh.clipId!, sampleId: fresh.sampleId, name: "Fresh clip", kind: "loop", tags: ["fresh"], start: fresh.start, end: fresh.end }],
      [acceptedBeyondLimit.clipId!, { id: acceptedBeyondLimit.clipId!, sampleId: acceptedBeyondLimit.sampleId, name: "Also fresh clip", kind: "loop", tags: ["fresh"], start: acceptedBeyondLimit.start, end: acceptedBeyondLimit.end }],
      [stale.clipId!, { id: stale.clipId!, sampleId: stale.sampleId, name: "Retired clip", kind: "loop", tags: ["stale"], start: stale.start, end: stale.end, retired: true }],
    ]);
    const hydrate = createCanonicalHydrator({
      processingFingerprint: "processing-v1",
      readSample: async (id) => samples.get(id) ?? null,
      readRecording: async (id) => ({ id, title: "Recording", license: "cc0-1.0" }),
      readClip: async (id) => clips.get(id) ?? null,
      readAnalysis: async () => null,
    });
    const service = createCloudSearchService({
      tableName: "SemanticRecords", indexName: "semantic-embedding-v1",
      send: async () => ({ SearchResults: [row(stale, 0.99), row(fresh, 0.9), row(acceptedBeyondLimit, 0.8)] }),
      hydrate,
    });
    const response = await service.search({ queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, limit: 1 });
    assert.deepEqual(response, { hits: [{ ...await hydrate({ identity: fresh, revision: revision(fresh.semanticId) })!, score: 0.9 }], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 3, filteredCount: 1 });
  });

  it("rejects strict-invalid requests as 400 and unsupported embedding spaces as 409 without querying", async () => {
    const { service, commands } = fixture();
    for (const request of [
      { queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, unexpected: true },
      { queryVector: vector().slice(0, 511), embeddingSpace: SEMANTIC_EMBEDDING_SPACE },
      { queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, limit: 101 },
    ]) await assert.rejects(service.search(request), (error: unknown) => error instanceof CloudSearchServiceError && error.status === 400 && error.code === "semantic_request_invalid" && error.retryable === false);
    await assert.rejects(service.search({ queryVector: vector(), embeddingSpace: "other" }), (error: unknown) => error instanceof CloudSearchServiceError && error.status === 409 && error.code === "semantic_space_unsupported" && error.retryable === false);
    assert.equal(commands.length, 0);
  });

  it("fails closed before hydration on malformed, duplicate, mismatched-space, or incompatible-fingerprint native rows", async () => {
    const candidate = identity("A");
    const incompatibleFingerprint = identity("B", { processingFingerprint: "processing-v2" });
    for (const output of [
      { SearchResults: [{ Score: Number.NaN, Item: row(candidate).Item }] },
      { SearchResults: [{ Score: 0.8, Item: { ...row(candidate).Item, display: { S: "leak" } } }] },
      { SearchResults: [row(candidate), row(candidate)] },
      { SearchResults: [{ ...row(candidate), Item: { ...row(candidate).Item, embeddingSpace: { S: "other" } } }] },
      { SearchResults: [row(candidate), row(incompatibleFingerprint)] },
    ]) {
      const { service, hydrated } = fixture(output);
      await assert.rejects(service.search({ queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE }), (error: unknown) => error instanceof CloudSearchServiceError && error.status === 503 && error.code === "semantic_unavailable" && error.retryable === true);
      assert.equal(hydrated.length, 0);
    }
  });

  it("fails closed before hydration when native SearchVectors rows violate requested kind or sampleId filters", async () => {
    const candidate = identity("A");
    for (const request of [
      { queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, kind: "window" },
      { queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "smp_other" },
    ]) {
      const { service, hydrated } = fixture({ SearchResults: [row(candidate)] });
      await assert.rejects(service.search(request), (error: unknown) => error instanceof CloudSearchServiceError && error.status === 503 && error.code === "semantic_unavailable" && error.retryable === true);
      assert.equal(hydrated.length, 0);
    }
  });

  it("maps throttling and unavailable native errors to retryable 503 without a fallback", async () => {
    for (const name of ["ThrottlingException", "ProvisionedThroughputExceededException", "InternalServerError"]) {
      const service = createCloudSearchService({ tableName: "SemanticRecords", indexName: "semantic-embedding-v1", send: async () => { throw { name }; }, hydrate: async () => null });
      await assert.rejects(service.search({ queryVector: vector(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE }), (error: unknown) => error instanceof CloudSearchServiceError && error.status === 503 && error.code === "semantic_unavailable" && error.retryable === true);
    }
  });
});
