import assert from "node:assert/strict";
import { test } from "node:test";

import { RelatedAudioError, createRelatedAudioClient } from "../src/data/related-audio.ts";

const sha = "a".repeat(64);
const hit = (sampleId = "smp_B") => ({
  score: 0.8,
  identity: { semanticId: sha, sampleId, recordingId: "rec_B", kind: "window", start: 1, end: 3, audioSha256: "b".repeat(64), embeddingSpace: "clap-htsat-unfused-512-v1", processingFingerprint: "fp-v1" },
  parent: { sampleId, recordingId: "rec_B", samplePath: "samples/b.wav", sampleTitle: "B" },
  timeRange: { start: 1, end: 3 }, card: { tags: [] }, playback: { fileKey: "audio/b.wav", start: 1, end: 3 },
});

test("related client lazily posts the frozen bounded contract to the configured semantic URL", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const client = createRelatedAudioClient({ bootstrap: async () => {}, semanticUrl: () => "/semantic", fetch: async (url, init) => { calls.push([String(url), init]); return new Response(JSON.stringify({ state: "ready", hits: [hit()] })); } });
  assert.equal((await client({ embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A" })).hits.length, 1);
  assert.equal(calls[0][0], "/semantic/related");
  assert.deepEqual(JSON.parse(String(calls[0][1]?.body)), { embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A", limit: 6 });
});

test("related client sends the selected saved clip exactly and never fabricates it for a sample", async () => {
  const bodies: unknown[] = [];
  const client = createRelatedAudioClient({ bootstrap: async () => {}, semanticUrl: () => "/semantic", fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ state: "ready", hits: [] })); } });
  await client({ embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A", clipId: "clp_A", limit: 24 });
  await client({ embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A" });
  assert.deepEqual(bodies, [{ embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A", clipId: "clp_A", limit: 24 }, { embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A", limit: 6 }]);
});

test("related client rejects malformed vectors, source leaks, excess hits, and nonempty awaiting responses", async () => {
  for (const body of [
    { state: "ready", hits: [{ ...hit(), vector: [1] }] },
    { state: "ready", hits: [hit("smp_A")] },
    { state: "ready", hits: Array.from({ length: 7 }, () => hit()) },
    { state: "awaiting_analysis", hits: [hit()] },
  ]) {
    const client = createRelatedAudioClient({ bootstrap: async () => {}, semanticUrl: () => "/semantic", fetch: async () => new Response(JSON.stringify(body)) });
    await assert.rejects(client({ embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A" }), (error: unknown) => error instanceof RelatedAudioError && error.code === "invalid_response");
  }
});

test("related client propagates aborts and preserves structured retryable errors", async () => {
  const before = new AbortController(); before.abort();
  const client = createRelatedAudioClient({ bootstrap: async () => {}, semanticUrl: () => "/semantic", fetch: async () => { throw new Error("not reached"); } });
  await assert.rejects(client({ embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A" }, { signal: before.signal }), { name: "AbortError" });
  const failed = createRelatedAudioClient({ bootstrap: async () => {}, semanticUrl: () => "/semantic", fetch: async () => new Response(JSON.stringify({ error: { code: "index_lag", message: "try again", retryable: true } }), { status: 503 }) });
  await assert.rejects(failed({ embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A" }), (error: unknown) => error instanceof RelatedAudioError && error.code === "index_lag" && error.retryable);
});

test("related client rejects null limits and unknown request fields before bootstrap", async () => {
  let bootstraps = 0;
  const client = createRelatedAudioClient({ bootstrap: async () => { bootstraps++; }, semanticUrl: () => "/semantic", fetch: async () => new Response() });
  for (const request of [
    { embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A", limit: null },
    { embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A", unexpected: true },
  ]) await assert.rejects(client(request as any), TypeError);
  assert.equal(bootstraps, 0);
});

test("related client rejects unsafe playback keys and malformed response metadata", async () => {
  for (const body of [
    { state: "ready", hits: [{ ...hit(), playback: { fileKey: "/audio/b.wav", start: 1, end: 3 } }] },
    { state: "ready", hits: [{ ...hit(), playback: { fileKey: "audio/../b.wav", start: 1, end: 3 } }] },
    { state: "ready", hits: [{ ...hit(), playback: { fileKey: "audio/\u0000b.wav", start: 1, end: 3 } }] },
    { state: "ready", hits: [{ ...hit(), parent: { ...hit().parent, unexpected: true } }] },
    { state: "ready", hits: [{ ...hit(), identity: { ...hit().identity, clipId: "wrong-for-window" } }] },
  ]) {
    const client = createRelatedAudioClient({ bootstrap: async () => {}, semanticUrl: () => "/semantic", fetch: async () => new Response(JSON.stringify(body)) });
    await assert.rejects(client({ embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "smp_A" }), (error: unknown) => error instanceof RelatedAudioError && error.code === "invalid_response");
  }
});
