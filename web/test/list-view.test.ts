import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_VIEW, otherKeys, parseView, viewQuery } from "../src/data/list-view.ts";

test("a list's view round-trips through its URL query, keeping only what differs from the defaults", () => {
  assert.deepEqual(parseView(""), DEFAULT_VIEW);
  assert.equal(viewQuery(DEFAULT_VIEW), "");
  const v = { order: "top" as const, window: "month" as const, mine: true, q: "deep house" };
  assert.deepEqual(parseView(viewQuery(v)), v);
  assert.equal(viewQuery(v), "q=deep+house&window=month&mine=1");
  assert.equal(viewQuery({ ...v, order: "recent" }), "q=deep+house&order=recent&mine=1", "Recent has no window");
  assert.deepEqual(parseView("order=sideways&window=decade&mine=yes"), DEFAULT_VIEW);
});

test("a section's own filters pass through the view's query", () => {
  const q = viewQuery({ ...DEFAULT_VIEW, mine: true }, "kind=loop&stars=4&mine=0");
  assert.equal(q, "mine=1&kind=loop&stars=4");
  assert.equal(otherKeys(q), "kind=loop&stars=4");
});
