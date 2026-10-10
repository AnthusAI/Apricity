import assert from "node:assert/strict";
import { test } from "node:test";

import { RelatedAudio, RelatedAudioController } from "../src/ui/related-audio.ts";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => (resolve = done)); return { promise, resolve }; };
const response = (state: "ready" | "awaiting_analysis", name: string) => ({ state, hits: state === "ready" ? [{ identity: { semanticId: name } as any }] : [] });

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { toggle: () => {} };
  constructor(readonly tagName: string) {}
  append(...kids: (FakeElement | string)[]) { this.children.push(...kids.filter((kid): kid is FakeElement => kid instanceof FakeElement)); }
  replaceChildren(...kids: (FakeElement | string)[]) { this.children = []; this.append(...kids); }
  addEventListener() {}
  setAttribute() {}
  querySelector() { return new FakeElement("circle"); }
}

const relatedMatch = (name: string) => ({
  hit: { identity: { semanticId: name }, parent: { samplePath: `samples/${name}.wav` }, timeRange: { start: 0, end: 1 }, playback: { start: 0, end: 1 } },
  entry: { base: { samplePath: `samples/${name}.wav`, title: name }, sample: { title: name } },
} as any);

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

test("a superseded catalog gate cannot start an old sample or clip request", async () => {
  for (const oldRequest of [{ sampleId: "smp_old" }, { sampleId: "smp_parent", clipId: "old" }]) {
    const catalog = deferred<void>(); const requested: string[] = [];
    const controller = new RelatedAudioController({ request: async (request) => {
      requested.push(request.clipId ?? request.sampleId);
      return response("ready", request.clipId ?? request.sampleId) as any;
    } });
    void controller.load(oldRequest, () => catalog.promise);
    await controller.load({ sampleId: oldRequest.clipId ? "smp_parent" : "smp_new", clipId: "new" });
    catalog.resolve();
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(requested, ["new"], `old ${oldRequest.clipId ?? "sample"} request never starts`);
  }
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

test("catalog failure is retryable and only requests related audio after the catalog succeeds", async () => {
  let catalogAttempts = 0; let retrievals = 0;
  const controller = new RelatedAudioController({ request: async () => {
    retrievals++;
    return response("ready", "retry") as any;
  } });
  await controller.load({ sampleId: "smp_A" }, async () => {
    catalogAttempts++;
    if (catalogAttempts === 1) throw new Error("catalog offline");
  });
  assert.equal(controller.state.phase, "error");
  assert.equal(retrievals, 0);
  await controller.retry();
  assert.equal(catalogAttempts, 2);
  assert.equal(retrievals, 1);
  assert.equal(controller.state.hits[0].identity.semanticId, "retry");
});

test("terminal disposal ignores pending catalog and retrieval work", async () => {
  const catalog = deferred<void>(); const retrieval = deferred<any>(); let requests = 0;
  const catalogController = new RelatedAudioController({ request: async () => { requests++; return response("ready", "late") as any; } });
  void catalogController.load({ sampleId: "smp_A" }, () => catalog.promise);
  catalogController.dispose(); catalog.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(catalogController.state.phase, "idle");
  assert.equal(requests, 0);

  const retrievalController = new RelatedAudioController({ request: () => { requests++; return retrieval.promise; } });
  void retrievalController.load({ sampleId: "smp_A" });
  retrievalController.dispose(); retrieval.resolve(response("ready", "late"));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(retrievalController.state.phase, "idle");
  const callsAtDisposal = requests;
  await retrievalController.load({ sampleId: "smp_after_disposal" });
  await retrievalController.retry();
  assert.equal(requests, callsAtDisposal, "load and retry after disposal cannot call related audio");
});

test("ready related cards use the shared feed grid and retain the six-card limit", async () => {
  const previousDocument = globalThis.document;
  (globalThis as any).document = { createElement: (tag: string) => new FakeElement(tag) };
  try {
    const related = new RelatedAudio({ request: async () => ({ state: "ready", hits: Array.from({ length: 7 }, (_, n) => ({ identity: { semanticId: String(n) } })) }), resolve: (hit) => relatedMatch(hit.identity.semanticId), active: () => true, card: () => Object.assign(new FakeElement("article"), { className: "feed-card sound-card" }) as any });
    related.load({ sampleId: "smp_A" });
    await new Promise((done) => setTimeout(done, 0));
    const grid = (related.root as any).children[1] as FakeElement;
    assert.equal(grid.className, "feed-grid");
    assert.equal(grid.children.length, 6);
  } finally {
    (globalThis as any).document = previousDocument;
  }
});
