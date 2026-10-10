import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { probeCacheStorage } from "../src/semantic/encoder-evaluation-cache.ts";

describe("browser evaluation cache probe", () => {
  it("records a real CacheStorage rejection as a memory fallback", async () => {
    assert.deepEqual(await probeCacheStorage(undefined), { available: false, error: "CacheStorage is not exposed by this browser context" });
    const blocked = await probeCacheStorage({ keys: async () => { throw new Error("storage disabled"); } });
    assert.deepEqual(blocked, { available: false, error: "storage disabled" });
  });

  it("accepts CacheStorage only after its API call succeeds", async () => {
    assert.deepEqual(await probeCacheStorage({ keys: async () => [] }), { available: true });
  });
});
