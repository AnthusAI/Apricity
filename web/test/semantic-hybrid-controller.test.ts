import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHybridSearchController } from "../src/semantic/hybrid-controller.ts";
import type { SemanticSearchHit, SemanticSearchResponse } from "../src/semantic/contracts.ts";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void };
const deferred = <T>(): Deferred<T> => { let resolve!: (value: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const unit = (index = 0) => Array.from({ length: 512 }, (_, i) => i === index ? 1 : 0);
const response = (id = "a") => ({ hits: [{ semanticId: id } as SemanticSearchHit], embeddingSpace: "clap-htsat-unfused-512-v1", candidateCount: 1, filteredCount: 0 } as SemanticSearchResponse);

class Clock {
  now = 0; private next = 0; private jobs = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, delay: number) => { const id = ++this.next; this.jobs.set(id, { at: this.now + delay, fn }); return id; };
  clearTimeout = (id: number) => { this.jobs.delete(id); };
  tick(ms: number) { this.now += ms; for (;;) { const due = [...this.jobs].filter(([, job]) => job.at <= this.now).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) return; this.jobs.delete(due[0]); due[1].fn(); } }
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("hybrid semantic search controller", () => {
  it("keeps lexical search immediate, debounces only semantic work, and Enter replaces a pending timer", async () => {
    const clock = new Clock(), lexical: string[] = [], encodes: string[] = [];
    const controller = createHybridSearchController({ timerClock: clock, onLexical: (query) => lexical.push(query), createEncoderClient: () => ({ encode: async (q) => { encodes.push(q); return { embeddingSpace: "clap-htsat-unfused-512-v1", vector: unit() }; }, cancel() {}, dispose() {} }), searchAudio: async () => response() });
    controller.setQuery("rain");
    assert.deepEqual(lexical, ["rain"]); assert.deepEqual(encodes, []);
    clock.tick(599); await settle(); assert.deepEqual(encodes, []);
    controller.setQuery("rain falling"); clock.tick(599); await settle(); assert.deepEqual(encodes, []);
    controller.submit(); await settle();
    assert.deepEqual(lexical, ["rain", "rain falling", "rain falling"]);
    assert.deepEqual(encodes, ["rain falling"]);
  });

  it("does no semantic work for empty input and sends a finite unit vector with capped candidate limit and constraints", async () => {
    const clock = new Clock(); const requests: any[] = [];
    const controller = createHybridSearchController({ timerClock: clock, createEncoderClient: () => ({ encode: async () => ({ embeddingSpace: "clap-htsat-unfused-512-v1", vector: unit() }), cancel() {}, dispose() {} }), searchAudio: async (request) => { requests.push(request); return response(); } });
    controller.setQuery("   "); clock.tick(1000); await settle(); assert.equal(requests.length, 0);
    controller.setQuery("bass", { immediate: true, kind: "saved_clip", sampleId: "smp_a" }); await settle();
    assert.equal(requests.length, 1); assert.equal(requests[0].limit, 100); assert.equal(requests[0].kind, "saved_clip"); assert.equal(requests[0].sampleId, "smp_a"); assert.equal(Math.hypot(...requests[0].queryVector), 1);
  });

  it("isolates wrong-space and invalid vectors before retrieval, and retries only the latest failure immediately", async () => {
    const clock = new Clock(), states: any[] = [], requests: any[] = []; let failOnce = true;
    const controller = createHybridSearchController({ timerClock: clock, onState: (state) => states.push(state), createEncoderClient: () => ({ encode: async () => ({ embeddingSpace: "wrong-space" as any, vector: unit() }), cancel() {}, dispose() {} }), searchAudio: async (request) => { requests.push(request); return response("unreachable"); } });
    controller.setQuery("rain", { immediate: true }); await settle();
    assert.equal(requests.length, 0); assert.equal(states.at(-1).phase, "error");
    for (const vector of [Array(511).fill(0), Array.from({ length: 512 }, (_, i) => i === 0 ? Number.NaN : 0), Array(512).fill(0)]) {
      const malformed = createHybridSearchController({ timerClock: clock, onState: (state) => states.push(state), createEncoderClient: () => ({ encode: async () => ({ embeddingSpace: "clap-htsat-unfused-512-v1", vector }), cancel() {}, dispose() {} }), searchAudio: async (request) => { requests.push(request); return response(); } });
      malformed.setQuery("invalid", { immediate: true }); await settle();
      assert.equal(requests.length, 0); assert.equal(states.at(-1).phase, "error");
    }
    const good = createHybridSearchController({ timerClock: clock, onState: (state) => states.push(state), createEncoderClient: () => ({ encode: async () => ({ embeddingSpace: "clap-htsat-unfused-512-v1", vector: unit() }), cancel() {}, dispose() {} }), searchAudio: async (request) => { requests.push(request); if (failOnce) { failOnce = false; throw new Error("offline"); } return response("retry"); } });
    good.setQuery("rain", { immediate: true }); await settle(); assert.equal(states.at(-1).phase, "error");
    good.retry(); await settle(); assert.equal(states.at(-1).phase, "ready"); assert.equal(states.at(-1).hits[0].semanticId, "retry");
  });

  it("recreates failed lazy loaders without letting stale or disposed work repaint", async () => {
    const clock = new Clock(), states: any[] = [], firstLoad = deferred<any>(); let creates = 0;
    const client = { encode: async () => ({ embeddingSpace: "clap-htsat-unfused-512-v1", vector: unit() }), cancel() {}, dispose() {} };
    const controller = createHybridSearchController({
      timerClock: clock,
      onState: (state) => states.push(state),
      createEncoderClient: () => ++creates === 1 ? firstLoad.promise : client,
      searchAudio: async () => response("recovered"),
    });

    controller.setQuery("rain", { immediate: true }); await settle();
    firstLoad.reject(new Error("download failed")); await settle();
    assert.equal(states.at(-1).phase, "error");
    controller.retry(); await settle();
    assert.equal(creates, 2);
    assert.equal(states.at(-1).phase, "ready");
    assert.equal(states.at(-1).hits[0].semanticId, "recovered");

    const staleLoad = deferred<any>(); let staleCreates = 0;
    const stale = createHybridSearchController({
      timerClock: clock,
      onState: (state) => states.push(state),
      createEncoderClient: () => ++staleCreates === 1 ? staleLoad.promise : client,
      searchAudio: async () => response("new"),
    });
    stale.setQuery("old", { immediate: true }); await settle();
    stale.clear(); staleLoad.reject(new Error("aborted initial load")); await settle();
    stale.setQuery("new", { immediate: true }); await settle();
    assert.equal(staleCreates, 2);
    assert.equal(states.at(-1).phase, "ready");
    assert.equal(states.at(-1).query, "new");

    let lateProgress: ((event: any) => void) | undefined;
    const disposedStates: any[] = [];
    const disposable = createHybridSearchController({
      timerClock: clock,
      onState: (state) => disposedStates.push(state),
      createEncoderClient: () => ({ encode: async (_query, encodeOptions) => {
        lateProgress = encodeOptions?.onProgress;
        return { embeddingSpace: "clap-htsat-unfused-512-v1", vector: unit() };
      }, cancel() {}, dispose() {} }),
      searchAudio: async () => response(),
    });
    disposable.setQuery("wind", { immediate: true }); await settle();
    disposable.dispose(); const stateCount = disposedStates.length;
    lateProgress?.({ type: "progress", requestId: "late", loaded: 1, phase: "download" }); await settle();
    assert.equal(disposedStates.length, stateCount);
  });

  it("prevents overlapping encoding and retrieval work from repainting out of order", async () => {
    const clock = new Clock(), states: any[] = [], encodes = new Map<string, Deferred<any>>(), searches = new Map<string, Deferred<SemanticSearchResponse>>();
    const controller = createHybridSearchController({ timerClock: clock, onState: (state) => states.push(state), createEncoderClient: () => ({ encode: (query) => { const d = deferred<any>(); encodes.set(query, d); return d.promise; }, cancel() {}, dispose() {} }), searchAudio: (request) => { const d = deferred<SemanticSearchResponse>(); searches.set(request.queryVector[0] === 1 ? "old" : "new", d); return d.promise; } });
    controller.setQuery("old", { immediate: true }); await settle(); controller.setQuery("new", { immediate: true }); await settle();
    encodes.get("old")!.resolve({ embeddingSpace: "clap-htsat-unfused-512-v1", vector: unit() }); encodes.get("new")!.resolve({ embeddingSpace: "clap-htsat-unfused-512-v1", vector: unit(1) }); await settle();
    assert.equal(searches.has("old"), false); assert.equal(searches.has("new"), true);
    searches.get("new")!.resolve(response("new")); await settle(); assert.equal(states.at(-1).hits[0].semanticId, "new");
  });

  it("ignores an old retrieval that resolves after the current retrieval", async () => {
    const clock = new Clock(), states: any[] = [], searches: Deferred<SemanticSearchResponse>[] = [];
    const controller = createHybridSearchController({ timerClock: clock, onState: (state) => states.push(state), createEncoderClient: () => ({ encode: async (q) => ({ embeddingSpace: "clap-htsat-unfused-512-v1", vector: unit(q === "old" ? 0 : 1) }), cancel() {}, dispose() {} }), searchAudio: () => { const item = deferred<SemanticSearchResponse>(); searches.push(item); return item.promise; } });
    controller.setQuery("old", { immediate: true }); await settle(); assert.equal(searches.length, 1);
    controller.setQuery("new", { immediate: true }); await settle(); assert.equal(searches.length, 2);
    searches[1].resolve(response("new")); await settle(); assert.equal(states.at(-1).hits[0].semanticId, "new");
    searches[0].resolve(response("old")); await settle(); assert.equal(states.at(-1).hits[0].semanticId, "new");
  });

  it("clears, cancels, and disposes across phases without stale progress, results, errors, or callback leaks", async () => {
    const clock = new Clock(), encode = deferred<any>(), search = deferred<SemanticSearchResponse>(), states: any[] = []; let lateProgress: ((event: any) => void) | undefined;
    const controller = createHybridSearchController({ timerClock: clock, onState: (state) => { states.push(state); throw new Error("view callback gone"); }, createEncoderClient: () => ({ encode: (_q, options) => { lateProgress = options?.onProgress; lateProgress?.({ type: "progress", requestId: "x", loaded: 1, phase: "download" }); return encode.promise; }, cancel() {}, dispose() {} }), searchAudio: () => search.promise });
    controller.setQuery("rain", { immediate: true }); await settle(); controller.clear();
    lateProgress?.({ type: "progress", requestId: "x", loaded: 2, phase: "download" });
    encode.resolve({ embeddingSpace: "clap-htsat-unfused-512-v1", vector: unit() }); await settle(); assert.equal(states.at(-1).phase, "idle"); assert.equal(states.at(-1).query, "");
    controller.setQuery("bass", { immediate: true }); await settle(); controller.cancel(); encode.reject(new Error("late")); await settle(); assert.equal(states.at(-1).phase, "idle");
    controller.setQuery("wind", { immediate: true }); await settle(); controller.dispose(); assert.throws(() => controller.setQuery("again"), /disposed/);
    search.reject(new Error("late fetch")); await settle(); assert.equal(states.at(-1).phase, "idle");
  });
});
