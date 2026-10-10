import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTextEncoderClient, TextEncoderClientError, type WorkerLike } from "../src/semantic/text-client.ts";

const vector = Array.from({ length: 512 }, (_, index) => index === 0 ? 2 : 0);

class FakeWorker implements WorkerLike {
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly sent: unknown[] = [];
  terminated = false;
  throwOnPost = false;
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener); }
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  postMessage(message: unknown) { if (this.throwOnPost) throw new Error("post failed"); this.sent.push(message); }
  terminate() { this.terminated = true; }
  emit(type: "message" | "error" | "messageerror", data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, data, message: typeof data === "string" ? data : undefined } as unknown as Event);
  }
}

describe("browser text encoder client", () => {
  it("is lazy for construction and blank text, then normalizes the nonempty request", async () => {
    const workers: FakeWorker[] = [];
    const client = createTextEncoderClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    await assert.rejects(client.encode("   "), (error: unknown) => error instanceof TextEncoderClientError && error.code === "empty_text");
    assert.equal(workers.length, 0);
    const pending = client.encode("  rain  ");
    assert.equal(workers.length, 1);
    const request = workers[0].sent[0] as { requestId: string; text: string };
    assert.equal(request.text, "rain");
    workers[0].emit("message", { type: "result", requestId: request.requestId, embeddingSpace: "clap-htsat-unfused-512-v1", vector });
    const result = await pending;
    assert.equal(result.embeddingSpace, "clap-htsat-unfused-512-v1");
    assert.ok(Math.abs(Math.hypot(...result.vector) - 1) < 1e-12);
  });

  it("forwards progress, aborts before/during loading, and ignores late responses", async () => {
    const worker = new FakeWorker();
    const client = createTextEncoderClient({ workerFactory: () => worker });
    const pre = new AbortController(); pre.abort();
    await assert.rejects(client.encode("rain", { signal: pre.signal }), /aborted/);
    assert.equal(worker.sent.length, 0);

    const controller = new AbortController(); const progress: string[] = [];
    const pending = client.encode("rain", { signal: controller.signal, onProgress: (event) => progress.push(event.phase) });
    const id = (worker.sent[0] as { requestId: string }).requestId;
    worker.emit("message", { type: "progress", requestId: id, loaded: 5, total: 10, phase: "download" });
    controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.deepEqual(progress, ["download"]);
    assert.deepEqual(worker.sent.at(-1), { type: "cancel", requestId: id });
    worker.emit("message", { type: "result", requestId: id, embeddingSpace: "clap-htsat-unfused-512-v1", vector });
  });

  it("rejects worker and model failures as retryable and recreates before retry", async () => {
    const workers: FakeWorker[] = [];
    const client = createTextEncoderClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const workerFailure = client.encode("rain");
    workers[0].emit("error", "startup failed");
    await assert.rejects(workerFailure, (error: unknown) => error instanceof TextEncoderClientError && error.retryable && error.code === "worker_failed");
    assert.ok(workers[0].terminated);

    const modelFailure = client.encode("rain");
    const secondId = (workers[1].sent[0] as { requestId: string }).requestId;
    workers[1].emit("message", { type: "error", requestId: secondId, code: "model_load_failed", message: "offline", retryable: true });
    await assert.rejects(modelFailure, (error: unknown) => error instanceof TextEncoderClientError && error.retryable && error.code === "model_load_failed");
    const retry = client.encode("rain");
    assert.equal(workers.length, 3);
    const thirdId = (workers[2].sent[0] as { requestId: string }).requestId;
    workers[2].emit("message", { type: "result", requestId: thirdId, embeddingSpace: "clap-htsat-unfused-512-v1", vector });
    await retry;
  });

  it("settles every active request after a model error or a postMessage failure, then recreates the worker", async () => {
    const workers: FakeWorker[] = [];
    const client = createTextEncoderClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const first = client.encode("rain");
    const second = client.encode("drums");
    const firstId = (workers[0].sent[0] as { requestId: string }).requestId;
    workers[0].emit("message", { type: "error", requestId: firstId, code: "model_load_failed", message: "offline", retryable: true });
    await assert.rejects(first, (error: unknown) => error instanceof TextEncoderClientError && error.code === "model_load_failed");
    await assert.rejects(second, (error: unknown) => error instanceof TextEncoderClientError && error.retryable);
    assert.ok(workers[0].terminated);

    const third = client.encode("bass");
    assert.equal(workers.length, 2);
    workers[1].throwOnPost = true;
    const fourth = client.encode("metal");
    await assert.rejects(third, (error: unknown) => error instanceof TextEncoderClientError && error.code === "worker_failed");
    await assert.rejects(fourth, (error: unknown) => error instanceof TextEncoderClientError && error.code === "worker_failed");
    assert.ok(workers[1].terminated);

    const retry = client.encode("bass");
    assert.equal(workers.length, 3);
    const retryId = (workers[2].sent[0] as { requestId: string }).requestId;
    workers[2].emit("message", { type: "result", requestId: retryId, embeddingSpace: "clap-htsat-unfused-512-v1", vector });
    await retry;
  });

  it("routes out-of-order responses and safely rejects invalid protocol messages without letting progress callbacks throw", async () => {
    const worker = new FakeWorker();
    const client = createTextEncoderClient({ workerFactory: () => worker });
    const first = client.encode("rain");
    const second = client.encode("drums");
    const firstId = (worker.sent[0] as { requestId: string }).requestId;
    const secondId = (worker.sent[1] as { requestId: string }).requestId;
    worker.emit("message", { type: "result", requestId: secondId, embeddingSpace: "clap-htsat-unfused-512-v1", vector: unit(1) });
    worker.emit("message", { type: "result", requestId: firstId, embeddingSpace: "clap-htsat-unfused-512-v1", vector });
    assert.equal((await first).vector[0], 1);
    assert.equal((await second).vector[1], 1);

    const wrongSpace = client.encode("bass");
    const wrongSpaceId = (worker.sent.at(-1) as { requestId: string }).requestId;
    worker.emit("message", { type: "result", requestId: wrongSpaceId, embeddingSpace: "other-space", vector });
    await assert.rejects(wrongSpace, (error: unknown) => error instanceof TextEncoderClientError && error.code === "invalid_embedding");

    const malformed = client.encode("metal");
    const malformedId = (worker.sent.at(-1) as { requestId: string }).requestId;
    worker.emit("message", { type: "nonsense", requestId: malformedId });
    await assert.rejects(malformed, (error: unknown) => error instanceof TextEncoderClientError && error.code === "invalid_response");

    const progress = client.encode("wind", { onProgress: () => { throw new Error("view disappeared"); } });
    const progressId = (worker.sent.at(-1) as { requestId: string }).requestId;
    worker.emit("message", { type: "progress", requestId: "unknown", loaded: 1, phase: "download" });
    worker.emit("message", { type: "progress", requestId: progressId, loaded: Number.NaN, phase: "download" });
    await assert.rejects(progress, (error: unknown) => error instanceof TextEncoderClientError && error.code === "invalid_response");

    const callbackThrows = client.encode("thunder", { onProgress: () => { throw new Error("view disappeared"); } });
    const callbackId = (worker.sent.at(-1) as { requestId: string }).requestId;
    worker.emit("message", { type: "progress", requestId: callbackId, loaded: 1, total: 2, phase: "download" });
    worker.emit("message", { type: "result", requestId: callbackId, embeddingSpace: "clap-htsat-unfused-512-v1", vector: Array(512).fill(0) });
    await assert.rejects(callbackThrows, (error: unknown) => error instanceof TextEncoderClientError && error.code === "invalid_embedding");
  });

  it("cancels all active work and makes disposal terminal", async () => {
    const worker = new FakeWorker();
    const client = createTextEncoderClient({ workerFactory: () => worker });
    const pending = client.encode("rain");
    client.cancel();
    await assert.rejects(pending, /cancelled/);
    client.dispose();
    assert.ok(worker.terminated);
    await assert.rejects(client.encode("rain"), /disposed/);
  });
});

function unit(index: number) { return Array.from({ length: 512 }, (_, item) => item === index ? 2 : 0); }
