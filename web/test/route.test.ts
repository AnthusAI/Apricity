import { test } from "node:test";
import assert from "node:assert/strict";

import { href, parse, sampleKey, titleOf, type Route } from "../src/route.ts";

const url = (r: Route) => {
  const h = href(r);
  const u = new URL(h, "https://apricity.anth.us");
  return parse(u.pathname, u.search, u.hash);
};

test("every page and item round-trips through its URL", () => {
  const routes: Route[] = [
    { page: "home" },
    { page: "activity" },
    { page: "scores" },
    { page: "beats", score: "examples/salamander-beat.apr" },
    { page: "melodies", score: "scores/google_123/my tune.apr", play: true },
    { page: "scores", score: "examples/march-blues.yaml" },
    { page: "samples" },
    { page: "samples", sample: "marine-band/stems/Thunderer/drums" },
    { page: "clips", clip: { sample: "marine-band/stems/Thunderer/drums", name: "loop-1" } },
    { page: "help", help: { file: "language.md", anchor: "tracks" } },
    { page: "help", help: { file: "chords.md" } },
  ];
  for (const r of routes) assert.deepEqual(url(r), r, href(r));
});

test("the URLs read well", () => {
  assert.equal(href({ page: "beats", score: "examples/salamander-beat.apr" }), "/beats/examples/salamander-beat");
  assert.equal(href({ page: "beats", score: "examples/salamander-beat.apr", play: true }), "/beats/examples/salamander-beat?play");
  assert.equal(href({ page: "samples", sample: sampleKey("samples/marine-band/Thunderer.mp3") }), "/samples/marine-band/Thunderer");
  assert.equal(href({ page: "help", help: { file: "language.md", anchor: "tracks" } }), "/help/language#tracks");
  assert.equal(href({ page: "melodies", score: "scores/u/my tune.apr" }), "/melodies/scores/u/my%20tune");
});

test("odd names survive; bad paths go to the page; unknown ones go home", () => {
  const r: Route = { page: "clips", clip: { sample: "x/a#b", name: "loop ü" } };
  assert.deepEqual(url(r), r);
  assert.deepEqual(parse("/samples/../etc"), { page: "samples" });
  assert.deepEqual(parse("/samples/%E0%A4%A"), { page: "samples" });
  assert.deepEqual(parse("/nowhere/at/all"), { page: "home" });
  assert.deepEqual(parse("/clips/only-one"), { page: "clips" });
  assert.equal(titleOf({ page: "beats" }, "Salamander Beat"), "Salamander Beat · Beats · Apricity");
  assert.equal(titleOf({ page: "home" }), "Apricity");
});
