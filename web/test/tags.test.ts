import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_TAGS, normalizeTag, parseTags, tagCounts, withTags } from "../src/data/tags.ts";

test("a tag is lowercase words joined by hyphens, without its #", () => {
  assert.equal(normalizeTag("#Techno"), "techno");
  assert.equal(normalizeTag("  Deep House "), "deep-house");
  assert.equal(normalizeTag("drum & bass!!"), "drum-bass");
  assert.equal(normalizeTag("Café"), "cafe");
  assert.equal(normalizeTag("##"), null);
  assert.equal(normalizeTag("x"), null);
  assert.equal(normalizeTag("a".repeat(40)), "a".repeat(24));
  assert.equal(normalizeTag("ab-".repeat(10)), "ab-ab-ab-ab-ab-ab-ab-ab");
});

test("typed tags: commas and #s separate them, otherwise it's one tag", () => {
  assert.deepEqual(parseTags("#Techno #deep house, lounge"), ["techno", "deep-house", "lounge"]);
  assert.deepEqual(parseTags("deep house"), ["deep-house"]);
  assert.deepEqual(parseTags("#a, techno, TECHNO"), ["techno"]);
  assert.equal(parseTags(Array.from({ length: 12 }, (_, i) => `#tag${i}`).join(" ")).length, MAX_TAGS);
});

test("adding tags keeps order, drops repeats, and stops at the limit", () => {
  assert.deepEqual(withTags(["techno"], ["lounge", "techno"]), ["techno", "lounge"]);
  assert.equal(withTags(["a1", "a2", "a3", "a4", "a5", "a6", "a7"], ["b1", "b2"]).length, MAX_TAGS);
});

test("tag counts: most used first, each score counted once", () => {
  const scores = [{ tags: ["techno", "lounge"] }, { tags: ["techno", "techno"] }, { tags: null }, { tags: ["ambient", null] }];
  assert.deepEqual(tagCounts(scores), [
    { tag: "techno", count: 2 },
    { tag: "ambient", count: 1 },
    { tag: "lounge", count: 1 },
  ]);
});
