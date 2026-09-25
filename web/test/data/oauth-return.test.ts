import { describe, it } from "node:test";
import assert from "node:assert";
import { isOAuthReturn, SESSION_EVENTS } from "../../src/data/auth";

describe("Google redirect detection", () => {
  it("recognises the code and state a redirect brings back", () => {
    assert.strictEqual(isOAuthReturn("?code=abc123&state=xyz"), true);
  });
  it("ignores ordinary page loads and partial parameters", () => {
    assert.strictEqual(isOAuthReturn(""), false);
    assert.strictEqual(isOAuthReturn("?tab=library"), false);
    assert.strictEqual(isOAuthReturn("?code=abc123"), false);
    assert.strictEqual(isOAuthReturn("?state=xyz"), false);
  });
  it("re-reads the session after every sign-in, sign-out and refresh", () => {
    for (const e of ["signedIn", "signedOut", "tokenRefresh", "signInWithRedirect"]) assert.ok((SESSION_EVENTS as readonly string[]).includes(e));
  });
});
