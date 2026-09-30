import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SEMANTIC_EMBEDDING_SPACE, validateSearchRequest, validateSemanticRecord } from "../src/semantic/contracts.ts";

const unit = (index = 0) => Array.from({ length: 512 }, (_, value) => value === index ? 1 : 0);
const record = () => ({
  identity: { semanticId: "a".repeat(64), sampleId: "smp_A", recordingId: "rec_R1", kind: "saved_clip" as const, clipId: "clp_A", start: 0, end: 4, audioSha256: "b".repeat(64), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, processingFingerprint: "processing-v1" },
  vector: unit(), display: { samplePath: "library/a.wav", sampleTitle: "A", clipName: "Renamed", clipKind: "loop", tags: ["drum"] }, playback: { fileKey: "audio/a.wav", start: 0, end: 4 }, revision: "c".repeat(64), metadataUpdatedAt: "2026-09-30T12:00:00Z",
});

describe("semantic record contracts", () => {
  it("accepts only complete current record identities and finite unit vectors", () => {
    assert.deepEqual(validateSemanticRecord(record()), record());
    for (const mutate of [(value: any) => value.vector[0] = 2, (value: any) => value.vector[1] = Number.NaN, (value: any) => delete value.identity.clipId, (value: any) => value.playback.end = 0]) {
      const invalid = record(); mutate(invalid); assert.throws(() => validateSemanticRecord(invalid));
    }
  });

  it("permits optional saved-clip display fields only when they are strings and requires aware timestamps", () => {
    const withoutOptional = record(); delete withoutOptional.display.clipName; delete withoutOptional.display.clipKind;
    assert.deepEqual(validateSemanticRecord(withoutOptional), withoutOptional);
    for (const mutate of [(value: any) => value.display.clipName = 7, (value: any) => value.display.clipKind = false, (value: any) => value.metadataUpdatedAt = "2026-09-30T12:00:00"]) {
      const invalid = record(); mutate(invalid); assert.throws(() => validateSemanticRecord(invalid));
    }
  });

  it("permits schema-valid empty display strings while keeping playback identifiers nonempty", () => {
    const emptyDisplay = record();
    emptyDisplay.display = { samplePath: "", sampleTitle: "", clipName: "", clipKind: "", tags: [""] };
    assert.deepEqual(validateSemanticRecord(emptyDisplay), emptyDisplay);
    const invalidFileKey = record(); invalidFileKey.playback.fileKey = "";
    assert.throws(() => validateSemanticRecord(invalidFileKey));
  });

  it("uses the shared search request rules: supported space and default/max limit", () => {
    assert.deepEqual(validateSearchRequest({ queryVector: unit(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE }), { queryVector: unit(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, limit: 24 });
    assert.equal(validateSearchRequest({ queryVector: unit(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, limit: 100 }).limit, 100);
    for (const request of [{ queryVector: unit(), embeddingSpace: "other" }, { queryVector: unit(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, limit: 101 }, { queryVector: unit(), embeddingSpace: SEMANTIC_EMBEDDING_SPACE, limit: 0 }, { queryVector: [...unit().slice(0, 511), 0.5], embeddingSpace: SEMANTIC_EMBEDDING_SPACE }]) assert.throws(() => validateSearchRequest(request));
  });
});
