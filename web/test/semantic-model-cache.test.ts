import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createModelCache, type CacheProgress } from "../src/semantic/model-cache.ts";

describe("model cache", () => {
  it("uses persistent CacheStorage when it is available", async () => {
    const stored = new Map<string, Response>();
    const cache = createModelCache({ cacheStorage: { open: async () => ({ match: async (key) => stored.get(String(key)), put: async (key, response) => { stored.set(String(key), response); } }) } });
    await cache.put("https://example.test/model.onnx", new Response("weights"));
    assert.equal(await (await cache.match("https://example.test/model.onnx"))?.text(), "weights");
  });

  it("reports cache_unavailable once and continues after blocked reads and writes", async () => {
    const progress: CacheProgress[] = [];
    const cache = createModelCache({
      cacheStorage: { open: async () => { throw new Error("storage disabled"); } },
      indexedDB: undefined,
      onProgress: (event) => progress.push(event),
    });
    assert.equal(await cache.match("https://example.test/model.onnx"), undefined);
    await cache.put("https://example.test/model.onnx", new Response("weights"));
    assert.deepEqual(progress, [{ phase: "cache_unavailable", loaded: 0, detail: "storage disabled" }]);
  });

  it("turns CacheStorage operation failures into misses instead of rejecting callers", async () => {
    const cache = createModelCache({
      cacheStorage: { open: async () => ({ match: async () => { throw new Error("read denied"); }, put: async () => { throw new Error("write denied"); } }) },
      indexedDB: undefined,
    });
    assert.equal(await cache.match("https://example.test/model.onnx"), undefined);
    await cache.put("https://example.test/model.onnx", new Response("weights"));
  });

  it("falls back promptly when IndexedDB opening is blocked or never settles", async () => {
    const blocked = createModelCache({
      cacheStorage: { open: async () => { throw new Error("storage disabled"); } },
      indexedDB: { open: () => { const request: Record<string, unknown> = {}; queueMicrotask(() => (request.onblocked as (() => void) | undefined)?.()); return request as IDBOpenDBRequest; } } as unknown as IDBFactory,
      timeoutMs: 50,
    });
    assert.equal(await blocked.match("https://example.test/model.onnx"), undefined);

    const timedOut = createModelCache({
      cacheStorage: { open: async () => { throw new Error("storage disabled"); } },
      indexedDB: { open: () => ({}) as IDBOpenDBRequest } as unknown as IDBFactory,
      timeoutMs: 1,
    });
    assert.equal(await timedOut.match("https://example.test/model.onnx"), undefined);
  });

  it("treats aborted transactions and corrupt IndexedDB reads as cache misses and closes on version changes", async () => {
    let database!: { onversionchange?: () => void; close: () => void };
    let closed = false;
    const aborted = createModelCache({
      cacheStorage: { open: async () => { throw new Error("storage disabled"); } },
      indexedDB: { open: () => {
        const request: Record<string, unknown> = {};
        queueMicrotask(() => {
          const transaction: Record<string, unknown> = {
            objectStore: () => ({ get: () => { const read: Record<string, unknown> = {}; queueMicrotask(() => (transaction.onabort as (() => void) | undefined)?.()); return read as IDBRequest; } }),
          };
          database = { close: () => { closed = true; }, transaction: () => transaction } as unknown as typeof database;
          request.result = database as unknown as IDBDatabase;
          (request.onsuccess as (() => void) | undefined)?.();
        });
        return request as IDBOpenDBRequest;
      } } as unknown as IDBFactory,
    });
    assert.equal(await aborted.match("https://example.test/model.onnx"), undefined);
    database.onversionchange?.();
    assert.ok(closed);

    const corrupt = createModelCache({
      cacheStorage: { open: async () => { throw new Error("storage disabled"); } },
      indexedDB: { open: () => {
        const request: Record<string, unknown> = {};
        queueMicrotask(() => {
          const transaction: Record<string, unknown> = {
            objectStore: () => ({ get: () => {
              const read: Record<string, unknown> = {};
              queueMicrotask(() => { read.result = { body: new ArrayBuffer(1), headers: 12 }; (read.onsuccess as (() => void) | undefined)?.(); });
              return read as IDBRequest;
            } }),
          };
          request.result = { close: () => {}, transaction: () => transaction } as unknown as IDBDatabase;
          (request.onsuccess as (() => void) | undefined)?.();
        });
        return request as IDBOpenDBRequest;
      } } as unknown as IDBFactory,
    });
    assert.equal(await corrupt.match("https://example.test/model.onnx"), undefined);
  });
});
