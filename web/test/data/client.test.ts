import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { authAware } from "../../src/data/client.ts";

describe("authAware", () => {
  const fake = (who: string) => ({ models: { Score: { list: async (o: unknown) => ({ who, o }) } } });
  it("a guest reads through the identity pool, a signed-in person through the user pool", async () => {
    let signed = false;
    const c = authAware(fake("userPool"), fake("guest"), async () => signed);
    assert.deepEqual(await c.models.Score.list({ limit: 1 }), { who: "guest", o: { limit: 1 } });
    signed = true;
    assert.deepEqual(await c.models.Score.list({ limit: 2 }), { who: "userPool", o: { limit: 2 } });
  });
});

describe("local identity", () => {
  it("survives Amplify.configure and answers getCurrentUser and ownerValue", async () => {
    const { bootstrap, localIdentity, mode } = await import("../../src/data/client.ts");
    const { getCurrentUser, ownerValue } = await import("../../src/data/auth.ts");
    const outputs = { version: "1.4", custom: { apricity: { mode: "local", identity: { sub: "local", groups: ["curators"] } } } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(outputs))) as typeof fetch;
    try {
      assert.equal(await bootstrap(), "local");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(mode(), "local");
    assert.deepEqual(localIdentity(), { sub: "local", groups: ["curators"] });
    assert.deepEqual(await getCurrentUser(), { sub: "local", username: "local", groups: ["curators"] });
    assert.equal(await ownerValue(), "local::local");
  });
});
