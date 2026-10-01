import assert from "node:assert/strict";
import { test } from "node:test";

import { RelatedAudioController } from "../src/ui/related-audio.ts";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => (resolve = done)); return { promise, resolve }; };
const response = (state: "ready" | "awaiting_analysis", name: string) => ({ state, hits: state === "ready" ? [{ identity: { semanticId: name } as any }] : [] });

test("related controller shows loading, explicit empty and awaiting-analysis states", async () => {
  const states: string[] = [];
  const controller = new RelatedAudioController({ request: async () => ({ state: "ready", hits: [] }), onState: (state) => states.push(state.phase) });
  await controller.load({ sampleId: "smp_A" });
  assert.deepEqual(states, ["loading", "ready"]);
  assert.equal(controller.state.phase, "ready");
  assert.equal(controller.state.hits.length, 0);
  const awaiting = new RelatedAudioController({ request: async () => response("awaiting_analysis", "") as any });
  await awaiting.load({ sampleId: "smp_A" });
  assert.equal(awaiting.state.phase, "awaiting_analysis");
});

test("new clip on the same parent aborts and prevents the old response repainting", async () => {
  const old = deferred<any>(); const fresh = deferred<any>(); const seen: string[] = [];
  const controller = new RelatedAudioController({ request: (request) => request.clipId === "old" ? old.promise : fresh.promise, onState: (state) => seen.push(state.phase + ":" + (state.hits[0]?.identity.semanticId ?? "")) });
  void controller.load({ sampleId: "smp_A", clipId: "old" });
  void controller.load({ sampleId: "smp_A", clipId: "new" });
  old.resolve(response("ready", "old")); fresh.resolve(response("ready", "new"));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(controller.state.hits[0].identity.semanticId, "new");
  assert.ok(!seen.includes("ready:old"));
});

test("clear, timeout failure, and retry have truthful lifecycle states", async () => {
  const pending = deferred<any>(); let attempts = 0;
  const controller = new RelatedAudioController({ request: async () => {
    attempts++;
    if (attempts === 1) return pending.promise;
    if (attempts === 2) throw new Error("timeout");
    return response("ready", "retry") as any;
  } });
  void controller.load({ sampleId: "smp_A" });
  controller.clear(); pending.resolve(response("ready", "late"));
  await Promise.resolve(); assert.equal(controller.state.phase, "idle");
  await controller.load({ sampleId: "smp_A" }); assert.equal(controller.state.phase, "error");
  await controller.retry(); assert.equal(controller.state.hits[0].identity.semanticId, "retry");
});
