import { describe, it } from "node:test";
import assert from "node:assert/strict";

const vector = Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0);
const sha = "a".repeat(64);
const identity = (kind: "saved_clip" | "window" = "saved_clip") => ({ semanticId: sha, sampleId: "smp_A", recordingId: "rec_A", kind, ...(kind === "saved_clip" ? { clipId: "clp_A" } : {}), start: 0, end: 4, audioSha256: "b".repeat(64), embeddingSpace: "clap-htsat-unfused-512-v1", processingFingerprint: "fp-v1" });
const hit = (kind: "saved_clip" | "window" = "saved_clip") => ({ score: 1, identity: identity(kind), parent: { sampleId: "smp_A", recordingId: "rec_A", samplePath: "a.wav", sampleTitle: "A" }, timeRange: { start: 0, end: 4 }, card: kind === "saved_clip" ? { clipId: "clp_A", clipName: "A", tags: [] } : { tags: [] }, playback: { fileKey: "audio/a.wav", start: 0, end: 4 } });
const ok = (hits: unknown[] = []) => new Response(JSON.stringify({ hits, embeddingSpace: "clap-htsat-unfused-512-v1", candidateCount: hits.length, filteredCount: 0 }));
const outputs = () => new Response(JSON.stringify({ custom: { apricity: { mode: "local", semanticUrl: "/semantic" } } }));

describe("semantic client", () => {
  it("bootstraps lazily and posts the contract-normalized request to the configured URL", async () => {
    const { searchAudio } = await import("../src/data/semantic.ts"); const realFetch = globalThis.fetch; const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = (async (url, init) => { calls.push([String(url), init]); return String(url) === "/amplify_outputs.json" ? outputs() : ok(); }) as typeof fetch;
    try { assert.deepEqual(await searchAudio({ queryVector: vector, embeddingSpace: "clap-htsat-unfused-512-v1" }), { hits: [], embeddingSpace: "clap-htsat-unfused-512-v1", candidateCount: 0, filteredCount: 0 }); } finally { globalThis.fetch = realFetch; }
    assert.deepEqual(calls.map(([url]) => url), ["/amplify_outputs.json", "/semantic/search"]); assert.equal(JSON.parse(String(calls[1][1]?.body)).limit, 24);
  });

  it("accepts canonical saved-clip and window hits", async () => {
    const { searchAudio } = await import("../src/data/semantic.ts"); const realFetch = globalThis.fetch; let search = 0;
    globalThis.fetch = (async (url) => String(url) === "/amplify_outputs.json" ? outputs() : ok([hit(search++ ? "window" : "saved_clip")])) as typeof fetch;
    try { assert.equal((await searchAudio({ queryVector: vector, embeddingSpace: "clap-htsat-unfused-512-v1" })).hits[0].identity.kind, "saved_clip"); assert.equal((await searchAudio({ queryVector: vector, embeddingSpace: "clap-htsat-unfused-512-v1" })).hits[0].identity.kind, "window"); } finally { globalThis.fetch = realFetch; }
  });

  it("rejects malformed hit relationships and vectors", async () => {
    const { searchAudio, SemanticSearchError } = await import("../src/data/semantic.ts"); const realFetch = globalThis.fetch;
    for (const malformed of [Object.assign(hit(), { parent: { ...hit().parent, sampleId: "wrong" } }), Object.assign(hit(), { timeRange: { start: 0, end: 5 } }), Object.assign(hit(), { vector }), Object.assign(hit("window"), { identity: { ...identity("window"), clipId: null } })]) {
      globalThis.fetch = (async (url) => String(url) === "/amplify_outputs.json" ? outputs() : ok([malformed])) as typeof fetch;
      await assert.rejects(searchAudio({ queryVector: vector, embeddingSpace: "clap-htsat-unfused-512-v1" }), (error: unknown) => error instanceof SemanticSearchError && error.code === "invalid_response");
    }
    globalThis.fetch = realFetch;
  });

  it("reports null errors, structured 503s, failures, invalid queries, and aborts", async () => {
    const { searchAudio, SemanticSearchError } = await import("../src/data/semantic.ts"); const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => String(url) === "/amplify_outputs.json" ? outputs() : new Response("null", { status: 500 })) as typeof fetch;
    await assert.rejects(searchAudio({ queryVector: vector, embeddingSpace: "clap-htsat-unfused-512-v1" }), (e: unknown) => e instanceof SemanticSearchError && e.code === "semantic_request_failed");
    globalThis.fetch = (async (url) => String(url) === "/amplify_outputs.json" ? outputs() : new Response(JSON.stringify({ error: { code: "semantic_corpus_unavailable", message: "retry", retryable: true } }), { status: 503 })) as typeof fetch;
    await assert.rejects(searchAudio({ queryVector: vector, embeddingSpace: "clap-htsat-unfused-512-v1" }), (e: unknown) => e instanceof SemanticSearchError && e.code === "semantic_corpus_unavailable" && e.status === 503);
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    await assert.rejects(searchAudio({ queryVector: vector, embeddingSpace: "clap-htsat-unfused-512-v1" }), (e: unknown) => e instanceof SemanticSearchError && e.code === "semantic_unavailable");
    await assert.rejects(searchAudio({ queryVector: [1], embeddingSpace: "clap-htsat-unfused-512-v1" }));
    const before = new AbortController(); before.abort(); let calls = 0; globalThis.fetch = (async () => { calls++; return outputs(); }) as typeof fetch;
    await assert.rejects(searchAudio({ queryVector: vector, embeddingSpace: "clap-htsat-unfused-512-v1" }, { signal: before.signal }), { name: "AbortError" }); assert.equal(calls, 0);
    const after = new AbortController(); globalThis.fetch = (async (url) => { if (String(url) === "/amplify_outputs.json") { after.abort(); return outputs(); } return ok(); }) as typeof fetch;
    await assert.rejects(searchAudio({ queryVector: vector, embeddingSpace: "clap-htsat-unfused-512-v1" }, { signal: after.signal }), { name: "AbortError" }); globalThis.fetch = realFetch;
  });

  it("clears an earlier semantic endpoint when a later bootstrap fails", async () => {
    const { bootstrap, semanticUrl } = await import("../src/data/client.ts"); const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => outputs()) as typeof fetch;
    await bootstrap(); assert.equal(semanticUrl(), "/semantic");
    globalThis.fetch = (async () => new Response("unavailable", { status: 503, statusText: "unavailable" })) as typeof fetch;
    try { await bootstrap(); assert.equal(semanticUrl(), null); } finally { globalThis.fetch = realFetch; }
  });
});
