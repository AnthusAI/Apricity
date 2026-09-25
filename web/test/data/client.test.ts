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
