import { test } from "node:test";
import assert from "node:assert/strict";

import { byline, handleProblem, Handles, normalizeHandle, suggestHandle } from "../src/data/handles.ts";

test("handle rules: 3-20 characters, a letter first, nothing reserved", () => {
  assert.equal(normalizeHandle("  @Ryan "), "ryan");
  assert.equal(handleProblem("ryan"), null);
  assert.equal(handleProblem("dj_k-9"), null);
  assert.match(handleProblem("ab")!, /At least 3/);
  assert.match(handleProblem("a".repeat(21))!, /At most 20/);
  assert.match(handleProblem("9lives")!, /Start with a letter/);
  assert.match(handleProblem("dot.dot")!, /Start with a letter/);
  assert.match(handleProblem("Admin")!, /reserved/);
});

test("a suggestion from the email's local part", () => {
  assert.equal(suggestHandle("rap@endymion.com"), "rap");
  assert.equal(suggestHandle("Jo.Smith+tag@x.io"), "jo-smith-tag");
  assert.equal(suggestHandle("42@x.io"), "");
  assert.equal(suggestHandle("al@x.io"), "al0");
  assert.equal(suggestHandle("admin@x.io"), "");
  assert.equal(suggestHandle(undefined), "");
});

test("an owner in either form finds the handle; the newest wins", () => {
  const h = new Handles([
    { id: "ryan", owner: "google_1", createdAt: "2026-09-01" },
    { id: "ryan2", owner: "google_1", createdAt: "2026-09-02" },
    { id: "bea", owner: "sub-b::google_2", createdAt: "2026-09-01" },
    { id: "ghost", owner: null },
  ]);
  assert.equal(h.of("google_1"), "ryan2");
  assert.equal(h.of("sub-a::google_1"), "ryan2");
  assert.equal(h.of("google_2"), "bea");
  assert.equal(h.of("sub-b::google_2"), "bea");
  assert.equal(h.of("google_3"), undefined);
  assert.equal(h.mine(["google_3", "sub::google_1"]), "ryan2");
  assert.deepEqual(h.rowsOf(["google_1"]).map((r) => r.id).sort(), ["ryan", "ryan2"], "both, so a change can drop the old one");
  assert.equal(byline(h, "google_2", false), "by @bea");
  assert.equal(byline(h, "google_2", true), "yours");
  assert.equal(byline(h, "google_3", false), "");
  assert.equal(byline(null, "google_2", false), "");
});
