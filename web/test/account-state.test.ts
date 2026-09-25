import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { displayName, initial, emptyKind, emptyText } from "../src/ui/account-state.ts";

describe("displayName", () => {
  it("shows a real email", () => assert.equal(displayName({ email: "a@b.co" }), "a@b.co"));
  it("hides provider ids and missing emails", () => {
    for (const email of ["Google_1234-abcdef", "signinwithapple_0a1b", "facebook_12ab", "amazon_ff", "", undefined, "user-1234"])
      assert.equal(displayName({ email }), "Signed in");
    assert.equal(displayName(null), "Signed in");
  });
  it("initial", () => {
    assert.equal(initial({ email: "ryan@x.io" }), "R");
    assert.equal(initial({ email: "google_ab12" }), "•");
  });
});

describe("emptyKind", () => {
  it("signed out wins", () => assert.equal(emptyKind({ signedIn: false, refused: true, empty: true }), "signed-out"));
  it("refused", () => assert.equal(emptyKind({ signedIn: true, refused: true, empty: false }), "no-access"));
  it("empty", () => assert.equal(emptyKind({ signedIn: true, refused: false, empty: true }), "empty"));
  it("has data", () => assert.equal(emptyKind({ signedIn: true, refused: false, empty: false }), null));
  it("text", () => {
    assert.match(emptyText("library", "empty"), /library is empty/);
    assert.equal(emptyText("score", "empty"), "No scores yet.");
    assert.match(emptyText("library", "no-access"), /Ask an admin/);
  });
});
