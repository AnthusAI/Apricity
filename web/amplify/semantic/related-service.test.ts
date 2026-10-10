import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { SEMANTIC_EMBEDDING_SPACE, type SemanticIdentity, type SemanticRecord, type SemanticSearchHit, type SemanticSearchRequest } from "../../src/semantic/contracts";
import { canonicalSemanticId } from "./canonical";
import { RelatedClipServiceError, createRelatedAudioService, createRelatedClipService } from "./related-service";

const vector = (axis = 0) => Array.from({ length: 512 }, (_, index) => index === axis ? 1 : 0);
const revision = (semanticId: string) => createHash("sha256").update(JSON.stringify([semanticId, ""])).digest("hex");
const identity = (suffix: string, overrides: Partial<Omit<SemanticIdentity, "semanticId">> = {}): SemanticIdentity => {
  const value = { sampleId: `smp_${suffix}`, recordingId: `rec_${suffix}`, kind: "saved_clip" as const, clipId: `clp_${suffix}`, start: 0, end: 4, audioSha256: "a".repeat(64), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, processingFingerprint: "processing-v1", ...overrides };
  if (value.kind === "window") delete (value as Partial<SemanticIdentity>).clipId;
  return { ...value, semanticId: canonicalSemanticId(value)! };
};
const source = (value: SemanticIdentity, overrides: Partial<SemanticRecord> = {}): SemanticRecord => ({
  identity: value, vector: vector(), display: { samplePath: `${value.sampleId}.wav`, sampleTitle: value.sampleId, clipName: value.clipId, tags: [] }, playback: { fileKey: `${value.sampleId}.wav`, start: value.start, end: value.end }, revision: revision(value.semanticId), metadataUpdatedAt: "2026-01-01T00:00:00Z", ...overrides,
});
const hit = (value: SemanticIdentity, score: number): SemanticSearchHit => ({
  score, identity: value, parent: { sampleId: value.sampleId, recordingId: value.recordingId, samplePath: `${value.sampleId}.wav`, sampleTitle: value.sampleId }, timeRange: { start: value.start, end: value.end }, card: { clipId: value.clipId, clipName: value.clipId, tags: [] }, playback: { fileKey: `${value.sampleId}.wav`, start: value.start, end: value.end },
});
const noScore = (value: SemanticIdentity) => { const { score: _score, ...result } = hit(value, 0); return result; };

function fixture(overrides: Partial<Parameters<typeof createRelatedClipService>[0]> = {}) {
  const current = identity("A"); const calls: unknown[] = [];
  const readSource = overrides.readSource ?? (async () => source(current));
  const hydrateSource = overrides.hydrateSource ?? (async ({ identity: candidate, revision: candidateRevision }) => candidateRevision === revision(candidate.semanticId) ? noScore(candidate) : null);
  const search = overrides.search ?? (async () => ({ hits: [], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 0, filteredCount: 0 }));
  const service = createRelatedClipService({
    readSource,
    hydrateSource,
    search: async (request, context) => { calls.push(request); return search(request, context); },
  });
  return { service, current, calls };
}

describe("stored-vector related clips", () => {
  it("uses one actual stored source vector in one bounded saved-clip query without model loading", async () => {
    const related = identity("C"); const { service, current, calls } = fixture({ search: async (request) => ({ hits: [hit(related, 1)], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 1, filteredCount: 0 }) });
    const response = await service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId! });
    assert.deepEqual(response, { state: "ready", hits: [hit(related, 1)] });
    assert.deepEqual(calls, [{ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, queryVector: vector(), kind: "saved_clip", limit: 100 }]);
  });

  it("returns awaiting_analysis and never queries for missing, malformed, stale, unauthorized, incompatible, or noncanonical stored sources", async () => {
    const { current } = fixture();
    const malformed = { ...source(current), vector: vector().slice(1) };
    const noncanonical = source({ ...current, semanticId: "0".repeat(64) });
    const window = identity("window", { kind: "window", clipId: undefined });
    for (const stored of [null, malformed, noncanonical, source(window), source(current, { identity: { ...current, clipId: "other" } as SemanticIdentity }), source(current, { revision: "0".repeat(64) })]) {
      const { service, calls } = fixture({ readSource: async () => stored });
      assert.deepEqual(await service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId! }), { state: "awaiting_analysis", hits: [] });
      assert.equal(calls.length, 0);
    }
    for (const hydrateSource of [
      async () => null,
      async () => ({} as never),
      async () => ({ identity: null } as never),
      async () => ({ ...noScore(current), identity: identity("other") }),
    ]) {
      const { service, calls } = fixture({ hydrateSource });
      assert.deepEqual(await service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId! }), { state: "awaiting_analysis", hits: [] });
      assert.equal(calls.length, 0);
    }
  });

  it("rejects malformed search output with a retryable unavailable error", async () => {
    const { current } = fixture();
    const related = identity("C");
    const malformedResponses = [
      { hits: [], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 101, filteredCount: 0 },
      { hits: [hit(related, 1)], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 0, filteredCount: 0 },
      { hits: [hit(related, 1)], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 1, filteredCount: 1 },
      { hits: [{ ...hit(related, 1), card: { ...hit(related, 1).card, clipKind: 42 } }], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 1, filteredCount: 0 },
      { hits: [{ ...hit(related, 1), playback: { ...hit(related, 1).playback, fileKey: "../private.wav" } }], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 1, filteredCount: 0 },
      { hits: [hit(identity("different-fingerprint", { processingFingerprint: "processing-v2" }), 1)], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 1, filteredCount: 0 },
    ];
    for (const response of malformedResponses) {
      const { service } = fixture({ search: async () => response as never });
      await assert.rejects(
        service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId! }),
        (error: unknown) => error instanceof RelatedClipServiceError && error.status === 503 && error.retryable,
      );
    }
  });

  it("guards canonical rename semantics and rejects wrong IDs, spaces, model fingerprints, bounds, and bad port output", async () => {
    const { current } = fixture();
    const renamed = source(current, { display: { samplePath: "renamed.wav", sampleTitle: "Renamed", clipName: "New label", tags: [] } });
    const ready = fixture({ readSource: async () => renamed });
    assert.equal((await ready.service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId! })).state, "ready");
    for (const request of [
      {}, { embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "", clipId: current.clipId }, { embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: "" }, { embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId, limit: 0 }, { embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId, limit: 25 }, { embeddingSpace: "other", sampleId: current.sampleId, clipId: current.clipId },
    ]) await assert.rejects(ready.service.related(request), (error: unknown) => error instanceof RelatedClipServiceError && (error.status === 400 || error.status === 409));
    for (const bad of [
      source(current, { identity: { ...current, processingFingerprint: "other" } as SemanticIdentity }),
      source(current, { identity: { ...current, end: 3 } as SemanticIdentity }),
    ]) {
      const badSource = fixture({ readSource: async () => bad });
      assert.equal((await badSource.service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId! })).state, "awaiting_analysis");
    }
    const badPort = fixture({ search: async () => ({ hits: [{ ...hit(identity("bad"), 0.8), score: Number.NaN }], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 1, filteredCount: 0 }) });
    await assert.rejects(badPort.service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId! }), (error: unknown) => error instanceof RelatedClipServiceError && error.status === 503 && error.retryable);
  });

  it("excludes every source-sample region before taking, deduplicates best scores, and orders score then semantic ID", async () => {
    const { current } = fixture(); const sourceAlias = identity("A-other", { sampleId: current.sampleId, recordingId: current.recordingId, clipId: "clp_other", start: 4, end: 8 });
    const c = identity("C"); const d = identity("D"); const duplicate = hit(c, 0.2);
    const { service } = fixture({ search: async () => ({ hits: [hit(current, 0.99), hit(sourceAlias, 0.98), duplicate, hit(c, 0.9), hit(d, 0.9)], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 5, filteredCount: 0 }) });
    const response = await service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId!, limit: 1 });
    assert.deepEqual(response.hits.map(({ identity: value, score }) => [value.semanticId, score]), [[ [c.semanticId, d.semanticId].sort()[0], 0.9 ]]);
  });

  it("maps source, hydration, and search dependency failures to retryable unavailable", async () => {
    const { current } = fixture();
    for (const dependencies of [
      { readSource: async () => { throw new Error("down"); } }, { hydrateSource: async () => { throw new Error("down"); } }, { search: async () => { throw new Error("down"); } },
    ]) {
      const { service } = fixture(dependencies);
      await assert.rejects(service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: current.clipId! }), (error: unknown) => error instanceof RelatedClipServiceError && error.status === 503 && error.retryable);
    }
  });
});

describe("stored-vector related samples", () => {
  const e0 = vector(0);
  const e1 = vector(1);
  const negativeE0 = e0.map((entry) => -entry);
  const diagonal = e0.map((_entry, index) => (index === 0 || index === 1 ? 1 / Math.sqrt(2) : 0));

  function sampleFixture(overrides: Partial<Parameters<typeof createRelatedAudioService>[0]> = {}) {
    const current = identity("sample-source", { clipId: "source-clip" });
    const calls: SemanticSearchRequest[] = [];
    const readSource = overrides.readSource ?? (async () => source(current, { vector: e0 }));
    const readSampleSources = overrides.readSampleSources ?? (async () => [source(current, { vector: e0 })]);
    const hydrateSource = overrides.hydrateSource ?? (async ({ identity: candidate }) => noScore(candidate));
    const search = overrides.search ?? (async () => ({ hits: [], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 0, filteredCount: 0 }));
    return {
      current,
      calls,
      service: createRelatedAudioService({ readSource, readSampleSources, hydrateSource, search: async (request, context) => { calls.push(request); return search(request, context); } }),
    };
  }

  it("selects up to four deterministic farthest-point sample representatives and queries each once", async () => {
    const sourceIds = [
      identity("rep-e0", { sampleId: "sample", recordingId: "recording" }),
      identity("rep-e1", { sampleId: "sample", recordingId: "recording", start: 4, end: 8 }),
      identity("rep-neg-e0", { sampleId: "sample", recordingId: "recording", start: 8, end: 12 }),
      identity("rep-diagonal", { sampleId: "sample", recordingId: "recording", start: 12, end: 16 }),
      identity("rep-duplicate", { sampleId: "sample", recordingId: "recording", start: 16, end: 20 }),
    ];
    const records = [source(sourceIds[0], { vector: e0 }), source(sourceIds[1], { vector: e1 }), source(sourceIds[2], { vector: negativeE0 }), source(sourceIds[3], { vector: diagonal }), source(sourceIds[4], { vector: e0 })];
    const { service, calls } = sampleFixture({ readSampleSources: async () => records });
    await service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "sample" });
    const queried = calls.map((call) => call.queryVector);
    assert.equal(queried.length, 4);
    assert.deepEqual(queried, expectedRepresentatives(records).map((record) => record.vector));
    assert.ok(calls.every((call) => call.limit === 100 && call.kind === undefined));
  });

  it("breaks farthest-point equidistance ties by semantic ID and never queries stale or duplicate source records", async () => {
    const first = identity("tie-first", { sampleId: "sample", recordingId: "recording" });
    const second = identity("tie-second", { sampleId: "sample", recordingId: "recording", start: 4, end: 8 });
    const stale = source(identity("stale", { sampleId: "sample", recordingId: "recording", start: 8, end: 12 }), { vector: negativeE0 });
    const { service, calls } = sampleFixture({
      readSampleSources: async () => [source(first, { vector: e0 }), source(second, { vector: e1 }), source(first, { vector: e0 }), stale],
      hydrateSource: async ({ identity: candidate }) => candidate.semanticId === stale.identity.semanticId ? null : noScore(candidate),
    });
    await service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "sample" });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.queryVector), expectedRepresentatives([source(first, { vector: e0 }), source(second, { vector: e1 })]).map((record) => record.vector));
  });

  it("returns awaiting analysis without querying when no current source remains, rejects mixed fingerprints, and fails closed on any search failure", async () => {
    const invalid = source(identity("wrong-sample"), { vector: e1 });
    const noSources = sampleFixture({ readSampleSources: async () => [null, invalid] });
    assert.deepEqual(await noSources.service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "sample" }), { state: "awaiting_analysis", hits: [] });
    assert.equal(noSources.calls.length, 0);
    const a = source(identity("fp-a", { sampleId: "sample" }), { vector: e0 });
    const b = source(identity("fp-b", { sampleId: "sample", start: 4, end: 8, processingFingerprint: "other" }), { vector: e1 });
    const mixed = sampleFixture({ readSampleSources: async () => [a, b] });
    await assert.rejects(mixed.service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "sample" }), unavailableError);
    assert.equal(mixed.calls.length, 0);
    const failed = sampleFixture({ readSampleSources: async () => [a, source(identity("fp-c", { sampleId: "sample", start: 4, end: 8 }), { vector: e1 })], search: async () => { throw new Error("down"); } });
    await assert.rejects(failed.service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "sample" }), unavailableError);
  });

  it("groups sample results by parent sample, preserves clip results ungrouped, validates windows, and diversifies recordings before remainders", async () => {
    const sourceId = identity("group-source", { sampleId: "source", recordingId: "source-recording" });
    const aLow = identity("a-low", { sampleId: "A", recordingId: "R1" });
    const aBest = identity("a-best", { sampleId: "A", recordingId: "R1", start: 4, end: 8 });
    const b = identity("b", { sampleId: "B", recordingId: "R1" });
    const c = identity("c", { sampleId: "C", recordingId: "R2" });
    const window = identity("window-hit", { sampleId: "D", recordingId: "R3", kind: "window", clipId: undefined, start: 2, end: 6 });
    // The repeated window is an index alias: canonical semantic-ID merging retains its strongest score.
    const candidates = [hit(aLow, 0.99), hit(aBest, 0.98), hit(b, 0.97), hit(c, 0.96), windowHit(window, 0.95), windowHit(window, 0.5), hit(aBest, 0.5)];
    const sample = sampleFixture({ readSampleSources: async () => [source(sourceId, { vector: e0 })], search: async () => ({ hits: candidates, embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: candidates.length, filteredCount: 0 }) });
    const response = await sample.service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "source", limit: 4 });
    assert.deepEqual(response.hits.map((value) => value.identity.semanticId), [aLow.semanticId, c.semanticId, window.semanticId, b.semanticId]);
    const clip = sampleFixture({ readSource: async () => source(sourceId, { vector: e0 }), search: async () => ({ hits: [hit(aLow, 0.99), hit(aBest, 0.98)], embeddingSpace: SEMANTIC_EMBEDDING_SPACE, candidateCount: 2, filteredCount: 0 }) });
    assert.equal((await clip.service.related({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: "source", clipId: sourceId.clipId! })).hits.length, 2);
  });

  it("strictly validates the unified request and candidate canonical records for both clip and window forms", async () => {
    const { service, current } = sampleFixture();
    for (const request of [
      { embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, clipId: null },
      { embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, limit: 25 },
      { embeddingSpace: SEMANTIC_EMBEDDING_SPACE, sampleId: current.sampleId, unknown: true },
    ]) await assert.rejects(service.related(request), (error: unknown) => error instanceof RelatedClipServiceError && error.status === 400);
  });
});

function windowHit(value: SemanticIdentity, score: number): SemanticSearchHit {
  return { score, identity: value, parent: { sampleId: value.sampleId, recordingId: value.recordingId, samplePath: `${value.sampleId}.wav`, sampleTitle: value.sampleId }, timeRange: { start: value.start, end: value.end }, card: { tags: [] }, playback: { fileKey: `${value.sampleId}.wav`, start: value.start, end: value.end } };
}

function unavailableError(error: unknown): boolean { return error instanceof RelatedClipServiceError && error.status === 503 && error.retryable; }

function expectedRepresentatives(records: SemanticRecord[]): SemanticRecord[] {
  const distinct = [...new Map(records.map((record) => [record.identity.semanticId, record])).values()].sort((left, right) => left.identity.semanticId.localeCompare(right.identity.semanticId));
  const chosen = [distinct.shift()!];
  while (chosen.length < 4 && distinct.length > 0) {
    distinct.sort((left, right) => Math.min(...chosen.map((selected) => 1 - dot(right.vector, selected.vector))) - Math.min(...chosen.map((selected) => 1 - dot(left.vector, selected.vector))) || left.identity.semanticId.localeCompare(right.identity.semanticId));
    chosen.push(distinct.shift()!);
  }
  return chosen;
}
function dot(left: number[], right: number[]) { return left.reduce((total, entry, index) => total + entry * right[index], 0); }
