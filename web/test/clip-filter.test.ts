import { test } from "node:test";
import assert from "node:assert/strict";

import { applyClipFilter, DEFAULT_FILTER, filterQuery, kindOf, parseFilter, type ClipFilter } from "../src/data/clip-filter.ts";
import type { ClipItem, Me } from "../src/data/catalog.ts";
import type { Standing } from "../src/data/rank-window.ts";

const now = new Date("2026-09-26T12:00:00Z");
const me: Me = { owners: ["u1::u1"], curator: false };
const clip = (id: string, over: Partial<ClipItem> = {}): ClipItem => ({
  id,
  name: `${over.kind ?? "loop"}-1`,
  sampleId: "s1",
  samplePath: "samples/a.flac",
  sampleTitle: "A",
  start: 0,
  end: 2,
  source: "ml",
  owner: null,
  createdAt: "2026-09-25T00:00:00Z",
  ...over,
});
const st = (average: number | null, count = average === null ? 0 : 1): Standing => ({ average, count, sum: (average ?? 0) * count, score: average ?? 0 });

const rows = [
  { item: clip("a", { kind: "loop", end: 4 }), standing: st(4) },
  { item: clip("b", { kind: "hit", end: 0.4, createdAt: "2025-01-01T00:00:00Z" }), standing: st(2) },
  { item: clip("c", { kind: "section", end: 30, source: "user", owner: "u1::u1" }), standing: st(null) },
  { item: clip("d", { kind: "phrase", start: 1, end: 6, source: "user", owner: "u2::u2", samplePath: "samples/b.flac" }), standing: st(null) },
];
const ids = (f: Partial<ClipFilter>, mine = new Map<string, number>()) => applyClipFilter(rows, { ...DEFAULT_FILTER, ...f }, { me, mine, now }).map((r) => r.item.id);

test("the default filter keeps everything in ranked order", () => {
  assert.deepEqual(ids({}), ["a", "b", "c", "d"]);
});

test("stars: at least N, nobody rated, and not rated by me", () => {
  assert.deepEqual(ids({ stars: "3" }), ["a"]);
  assert.deepEqual(ids({ stars: "unrated" }), ["c", "d"]);
  assert.deepEqual(ids({ stars: "unrated-by-me" }, new Map([["a", 5], ["d", 1]])), ["b", "c"]);
});

test("added, kind, origin, sample and length", () => {
  assert.deepEqual(ids({ added: "month" }), ["a", "c", "d"]);
  assert.deepEqual(ids({ kind: "hit" }), ["b"]);
  assert.deepEqual(ids({ origin: "auto" }), ["a", "b"]);
  assert.deepEqual(ids({ origin: "mine" }), ["c"]);
  assert.deepEqual(ids({ origin: "others" }), ["d"]);
  assert.deepEqual(ids({ sample: "samples/b.flac" }), ["d"]);
  assert.deepEqual(ids({ length: "short" }), ["b"]);
  assert.deepEqual(ids({ length: "medium" }), ["a", "d"]);
  assert.deepEqual(ids({ length: "long" }), ["c"]);
});

test("sorts: by date, length and my stars", () => {
  assert.deepEqual(ids({ sort: "oldest" }), ["b", "a", "c", "d"]);
  assert.deepEqual(ids({ sort: "longest" }), ["c", "d", "a", "b"]);
  assert.deepEqual(ids({ sort: "shortest" }), ["b", "a", "d", "c"]);
  assert.deepEqual(ids({ sort: "mine" }, new Map([["c", 5], ["b", 0]])), ["c", "b", "a", "d"]);
});

test("a filter round-trips through its query, and only non-defaults are written", () => {
  const f: ClipFilter = { ...DEFAULT_FILTER, stars: "unrated-by-me", kind: "loop", sample: "samples/marine band/x.flac", sort: "newest" };
  assert.deepEqual(parseFilter(filterQuery(f)), f);
  assert.equal(filterQuery(DEFAULT_FILTER), "");
  assert.deepEqual(parseFilter("kind=bogus&stars=9"), DEFAULT_FILTER);
});

test("a clip's kind comes from its record, else its name", () => {
  assert.equal(kindOf({ kind: "hit", name: "x" }), "hit");
  assert.equal(kindOf({ name: "loop-12" }), "loop");
  assert.equal(kindOf({ name: "my-favorite" }), null);
});
