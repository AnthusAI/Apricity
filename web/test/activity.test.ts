import { test } from "node:test";
import assert from "node:assert/strict";

import { FILTERS, kindName, lineText } from "../src/data/activity.ts";

test("card labels and lines read as words", () => {
  assert.equal(kindName({ targetType: "score", kind: "beat" }), "Beat");
  assert.equal(kindName({ targetType: "score", kind: null }), "Score");
  assert.equal(kindName({ targetType: "sample", kind: "sample" }), "Sample");
  assert.equal(lineText({ what: "made" }, "sample"), "added it");
  assert.equal(lineText({ what: "made" }, "score"), "made it");
  assert.equal(lineText({ what: "rated", stars: 4 }, "clip"), "rated it ★★★★☆");
  assert.equal(lineText({ what: "rated", stars: 9 }, "clip"), "rated it ★★★★★");
  assert.equal(lineText({ what: "commented" }, "score"), "commented");
  assert.deepEqual(FILTERS.map((f) => f.kind), [null, "song", "beat", "chords", "melody", "sample", "clip"]);
});
