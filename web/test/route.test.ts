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
    { page: "about" },
    { page: "how-it-works" },
    { page: "scores" },
    { page: "beats", score: "examples/salamander-beat.apr" },
    { page: "melodies", score: "scores/google_123/my tune.apr", play: true },
    { page: "scores", score: "examples/march-blues.yaml" },
    { page: "samples" },
    { page: "samples", sample: "marine-band/stems/Thunderer/drums" },
    { page: "clips", clip: { sample: "marine-band/stems/Thunderer/drums", name: "loop-1" } },
    { page: "clips", list: "kind=loop&stars=unrated-by-me" },
    { page: "clips", clip: { sample: "marine-band/Thunderer", name: "hit-3" }, list: "sort=newest" },
    { page: "help", help: { file: "language.md", anchor: "tracks" } },
    { page: "help", help: { file: "chords.md" } },
    { page: "tags" },
    { page: "tags", tag: "deep-house" },
    { page: "tags", tag: "techno", list: "kind=beat&window=month" },
    { page: "listen" },
    { page: "listen", listenCycle: "cyc_0123456789abcdef" },
  ];
  for (const r of routes) assert.deepEqual(url(r), r, href(r));
});

test("the URLs read well", () => {
  assert.equal(href({ page: "beats", score: "examples/salamander-beat.apr" }), "/beats/examples/salamander-beat");
  assert.equal(href({ page: "beats", score: "examples/salamander-beat.apr", play: true }), "/beats/examples/salamander-beat?play");
  assert.equal(href({ page: "samples", sample: sampleKey("samples/marine-band/Thunderer.mp3") }), "/samples/marine-band/Thunderer");
  assert.equal(href({ page: "help", help: { file: "language.md", anchor: "tracks" } }), "/help/language#tracks");
  assert.equal(href({ page: "melodies", score: "scores/u/my tune.apr" }), "/melodies/scores/u/my%20tune");
  assert.equal(href({ page: "listen" }), "/labs");
  assert.equal(href({ page: "listen", listenCycle: "cyc_abc" }), "/labs/cyc_abc");
  assert.deepEqual(parse("/listen"), { page: "listen" });
  assert.deepEqual(parse("/listen/cyc_abc"), { page: "listen", listenCycle: "cyc_abc" });
  assert.deepEqual(parse("/labs/cyc_abc"), { page: "listen", listenCycle: "cyc_abc" });
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
  assert.equal(titleOf({ page: "how-it-works" }), "How it works · Apricity");
  assert.equal(titleOf({ page: "listen" }), "My Labs · Apricity");
  assert.deepEqual(parse("/listen/cyc_abc/extra"), { page: "listen" });
});

test("search: its words in the query, and back", () => {
  for (const r of [{ page: "search", q: "deep house #lounge" }, { page: "search" }] as Route[]) assert.deepEqual(url(r), r);
  assert.equal(href({ page: "search", q: "a&b" }), "/search?q=a%26b");
  assert.deepEqual(parse("/search", "?q=%20%20"), { page: "search" });
  assert.equal(titleOf({ page: "search", q: "x" }, "“x”"), "“x” · Search · Apricity");
});

test("home and the sections keep their view in the query; an item's page doesn't", () => {
  for (const r of [{ page: "home", list: "order=recent&mine=1" }, { page: "beats", list: "window=month&q=house" }, { page: "samples", list: "q=march" }] as Route[]) assert.deepEqual(url(r), r);
  assert.equal(href({ page: "beats", score: "examples/b.apr", list: "q=x" }), "/beats/examples/b");
});
