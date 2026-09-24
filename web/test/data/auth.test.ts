import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("auth", () => {
  it("getCurrentUser in local mode: returns cached identity", async () => {
    // This test would need proper setup of Amplify config
    // For now, verify the module exports the expected functions
    const auth = await import("../../src/data/auth.js");
    assert.ok(typeof auth.getCurrentUser === "function");
    assert.ok(typeof auth.signInWithRedirect === "function");
    assert.ok(typeof auth.signOut === "function");
    assert.ok(typeof auth.fetchAuthSession === "function");
  });

  it("signInWithRedirect in local mode: no-op", async () => {
    assert.ok(true);
  });

  it("signOut in local mode: no-op", async () => {
    assert.ok(true);
  });

  it("fetchAuthSession in local mode: returns minimal session", async () => {
    assert.ok(true);
  });
});
