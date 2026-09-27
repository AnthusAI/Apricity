import { test } from "node:test";
import assert from "node:assert/strict";

import { itemOf, rowItem, talliesOf, targetOf } from "../amplify/functions/ranking/item.ts";
import { rowsFor } from "../src/data/ranked.ts";

const S = (s: string) => ({ S: s });
const N = (n: number) => ({ N: String(n) });
const card = (type: string, id: string, extra: Record<string, unknown> = {}) => ({ id: S(`${type}#${id}`), targetType: S(type), targetId: S(id), lastAt: S("2026-09-26T10:00:00.000Z"), lastWhat: S("rated"), lastBy: S("u1::u1"), comments: N(2), title: S("old title"), ...extra }) as never;

test("a score: its path, title and tags from its record; its news from its card", () => {
  const it = itemOf("score", "scr_1", {
    card: card("score", "scr_1", { kind: S("beat"), owner: S("u1::u1") }),
    score: { folder: S("scores/u1"), title: S("groove"), format: S("apr"), tags: { L: [S("techno"), S("lounge")] } } as never,
  });
  assert.deepEqual(it, {
    targetType: "score",
    targetId: "scr_1",
    kind: "beat",
    title: "groove",
    owner: "u1::u1",
    tags: ["techno", "lounge"],
    lastAt: "2026-09-26T10:00:00.000Z",
    lastWhat: "rated",
    lastBy: "u1::u1",
    comments: 2,
    path: "scores/u1/groove.apr",
  });
});

test("a clip: its sample's path and its stretch; a retired clip, or an item without a card, has no rows", () => {
  const clip = itemOf("clip", "clp_1", { card: card("clip", "clp_1", { kind: S("clip") }), clip: { name: S("loop-1"), start: N(1.5), end: N(3) } as never, sample: { path: S("marine-band/X.mp3") } as never });
  assert.equal(clip?.samplePath, "samples/marine-band/X.mp3");
  assert.deepEqual([clip?.clipStart, clip?.clipEnd, clip?.title], [1.5, 3, "loop-1"]);
  assert.equal(itemOf("clip", "clp_1", { card: card("clip", "clp_1"), clip: { retired: { BOOL: true } } as never, sample: { path: S("a.mp3") } as never }), null);
  assert.equal(itemOf("score", "scr_1", { card: undefined, score: {} as never }), null);
});

test("a listening-cycle candidate score gets no Ranked rows even if a card somehow exists for it", () => {
  // Belt and suspenders: changesOf keeps a candidate's card from ever being written, but if one existed anyway,
  // itemOf + rowsFor (the same path rebuild() drives) must still produce zero rows, matching ranked.ts's listsOf.
  const it = itemOf("score", "scr_9", {
    card: card("score", "scr_9", { kind: S("song"), owner: S("u1::u1") }),
    score: { folder: S("cycles/cyc_1"), title: S("funk-b"), format: S("apr"), tags: { L: [S("candidate")] } } as never,
  })!;
  assert.deepEqual(it.tags, ["candidate"]);
  const rows = rowsFor(it, [], new Date("2026-09-27T00:00:00Z"));
  assert.deepEqual(rows, []);
});

test("rows as Ranked items, and which item a stream record is about", () => {
  const it = itemOf("sample", "smp_1", { card: card("sample", "smp_1", { kind: S("sample") }), sample: { path: S("a/b.flac") } as never })!;
  const rows = rowsFor(it, talliesOf([{ targetId: S("smp_1"), day: S("all"), count: N(2), sum: N(8) } as never]), new Date("2026-09-27T00:00:00Z"));
  const item = rowItem(rows[0], "2026-09-27T00:00:00.000Z");
  assert.equal(item.__typename.S, "Ranked");
  assert.equal(item.list.S, "feed|top|all");
  assert.equal(item.path.S, "samples/a/b.flac");
  assert.equal(item.stars.N, "4");
  assert.equal(item.tags, undefined);
  assert.deepEqual(targetOf("Score", { id: S("scr_9") } as never), ["score", "scr_9"]);
  assert.deepEqual(targetOf("Tally", { targetType: S("clip"), targetId: S("clp_2") } as never), ["clip", "clp_2"]);
});
