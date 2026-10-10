import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLAP_BROWSER_MANIFEST,
  createEncoderService,
  normalizeEmbedding,
  type EncoderEvent,
  type TextEncoderRuntime,
} from "../src/semantic/encoder.ts";

const unit = (index = 0) => Array.from({ length: 512 }, (_, i) => (i === index ? 2 : 0));

describe("pinned browser CLAP feasibility encoder", () => {
  it("pins the approved text-only fp32 WASM export", () => {
    assert.deepEqual(CLAP_BROWSER_MANIFEST, {
      embeddingSpace: "clap-htsat-unfused-512-v1",
      modelId: "Xenova/clap-htsat-unfused",
      revision: "c28f2883575e590e04d3146ff0713c2448d691ba",
      runtime: "@huggingface/transformers@3.8.1",
      architecture: "ClapTextModelWithProjection",
      dtype: "fp32",
      device: "wasm",
      textOnly: true,
      assets: ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/text_model.onnx"],
    });
  });

  it("normalizes exactly 512 finite values and rejects missing, zero, and NaN embeddings", () => {
    const normalized = normalizeEmbedding(unit());
    assert.equal(normalized.length, 512);
    assert.ok(Math.abs(Math.hypot(...normalized) - 1) < 1e-12);
    for (const invalid of [undefined, [], Array(512).fill(0), [...Array(511).fill(0), Number.NaN]]) {
      assert.throws(() => normalizeEmbedding(invalid), /512 finite|near-zero/);
    }
  });

  it("loads only on a nonempty request, reports progress, and reuses a normalized-text cache entry", async () => {
    const events: EncoderEvent[] = [];
    let loads = 0;
    const service = createEncoderService({
      post: (event) => events.push(event),
      loadRuntime: async (onProgress) => {
        loads++;
        onProgress({ loaded: 10, total: 20, phase: "download" });
        return fakeRuntime(unit());
      },
    });
    await service.handle({ type: "encode", requestId: "blank", text: "   " });
    assert.equal(loads, 0);
    assert.deepEqual(events.at(-1), { type: "error", requestId: "blank", code: "empty_text", message: "Text is required", retryable: false });

    await service.handle({ type: "encode", requestId: "one", text: "  rain  " });
    await service.handle({ type: "encode", requestId: "two", text: "rain" });
    assert.equal(loads, 1);
    assert.ok(events.some((event) => event.type === "progress" && event.phase === "download"));
    assert.equal(events.filter((event) => event.type === "result").length, 2);
  });

  it("never broadcasts later loading progress to empty, settled-cancelled, or unknown request ids", async () => {
    const events: EncoderEvent[] = [];
    let progress!: (event: { loaded: number; total?: number; phase: string }) => void;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const service = createEncoderService({
      post: (event) => events.push(event),
      loadRuntime: async (onProgress) => {
        progress = onProgress;
        await pending;
        return fakeRuntime(unit());
      },
    });

    await service.handle({ type: "encode", requestId: "empty", text: "   " });
    const active = service.handle({ type: "encode", requestId: "active", text: "rain" });
    await Promise.resolve();
    progress({ loaded: 10, total: 20, phase: "download" });
    release();
    await active;

    assert.deepEqual(
      events.filter((event) => event.type === "progress").map((event) => event.requestId),
      ["active"],
    );

    const afterSettlement: EncoderEvent[] = [];
    let laterProgress!: (event: { loaded: number; total?: number; phase: string }) => void;
    let releaseLater!: () => void;
    const laterPending = new Promise<void>((resolve) => { releaseLater = resolve; });
    let attempt = 0;
    const laterService = createEncoderService({
      post: (event) => afterSettlement.push(event),
      loadRuntime: async (onProgress) => {
        attempt++;
        if (attempt === 1) throw new Error("offline");
        laterProgress = onProgress;
        await laterPending;
        return fakeRuntime(unit());
      },
    });
    await laterService.handle({ type: "encode", requestId: "settled", text: "rain" });
    await laterService.handle({ type: "cancel", requestId: "settled" });
    await laterService.handle({ type: "cancel", requestId: "unknown" });
    const laterActive = laterService.handle({ type: "encode", requestId: "later-active", text: "drums" });
    await Promise.resolve();
    laterProgress({ loaded: 10, total: 20, phase: "download" });
    releaseLater();
    await laterActive;
    assert.deepEqual(
      afterSettlement.filter((event) => event.type === "progress").map((event) => event.requestId),
      ["later-active"],
    );
  });

  it("allows retry after a transient load failure without selecting another runtime", async () => {
    const events: EncoderEvent[] = [];
    let attempt = 0;
    const service = createEncoderService({
      post: (event) => events.push(event),
      loadRuntime: async () => {
        attempt++;
        if (attempt === 1) throw Object.assign(new Error("network offline"), { retryable: true });
        return fakeRuntime(unit(1));
      },
    });
    await service.handle({ type: "encode", requestId: "first", text: "drums" });
    await service.handle({ type: "encode", requestId: "retry", text: "drums" });
    assert.deepEqual(events[0], { type: "error", requestId: "first", code: "model_load_failed", message: "network offline", retryable: true });
    assert.equal(events.at(-1)?.type, "result");
    assert.equal(attempt, 2);
  });

  it("suppresses cancelled and out-of-order results while a kernel is still running", async () => {
    const events: EncoderEvent[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const service = createEncoderService({
      post: (event) => events.push(event),
      loadRuntime: async () => fakeRuntime(unit(), async () => { await pending; }),
    });
    const first = service.handle({ type: "encode", requestId: "old", text: "bass" });
    await Promise.resolve();
    service.handle({ type: "cancel", requestId: "old" });
    release();
    await first;
    await service.handle({ type: "encode", requestId: "new", text: "bass" });
    assert.deepEqual(events.filter((event) => event.type === "result").map((event) => event.requestId), ["new"]);
  });

  it("broadcasts loading progress to the newest active request and clears cancelled request ids", async () => {
    const events: EncoderEvent[] = [];
    let progress!: (event: { loaded: number; total?: number; phase: string }) => void;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const service = createEncoderService({
      post: (event) => events.push(event),
      loadRuntime: async (onProgress) => {
        progress = onProgress;
        await pending;
        return fakeRuntime(unit());
      },
    });
    const cancelled = service.handle({ type: "encode", requestId: "cancelled", text: "rain" });
    await Promise.resolve();
    const latest = service.handle({ type: "encode", requestId: "latest", text: "drums" });
    await Promise.resolve();
    await service.handle({ type: "cancel", requestId: "cancelled" });
    progress({ loaded: 10, total: 20, phase: "download" });
    release();
    await Promise.all([cancelled, latest]);
    assert.ok(events.some((event) => event.type === "progress" && event.requestId === "latest"));
    assert.ok(!events.some((event) => event.type === "progress" && event.requestId === "cancelled"));
    await service.handle({ type: "encode", requestId: "cancelled", text: "rain" });
    assert.equal(events.filter((event) => event.type === "result" && event.requestId === "cancelled").length, 1);
  });

  it("refreshes the query LRU on a cache hit", async () => {
    let encodes = 0;
    const service = createEncoderService({ post: () => {}, loadRuntime: async () => ({ encode: async (text) => { encodes++; return unit(Number(text.slice(1)) % 512); } }) });
    for (let index = 0; index < 128; index++) await service.handle({ type: "encode", requestId: `a${index}`, text: `p${index}` });
    await service.handle({ type: "encode", requestId: "refresh", text: "p0" });
    for (let index = 128; index <= 256; index++) await service.handle({ type: "encode", requestId: `b${index}`, text: `p${index}` });
    await service.handle({ type: "encode", requestId: "survives", text: "p0" });
    await service.handle({ type: "encode", requestId: "evicted", text: "p1" });
    assert.equal(encodes, 259);
  });
});

function fakeRuntime(vector: number[], beforeEncode: () => Promise<void> = async () => {}): TextEncoderRuntime {
  return { encode: async () => { await beforeEncode(); return vector; } };
}
