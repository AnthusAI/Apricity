import { test } from "node:test";
import assert from "node:assert/strict";

import { hiddenRow, listRows, listsOf, rowsFor, tagRow, tagsIn, type RankItem } from "../src/data/ranked.ts";
import { homeRank } from "../src/data/home-feed.ts";
import { rank, type DayTally } from "../src/data/rank-window.ts";

const now = new Date("2026-09-27T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const item = (id: string, kind: RankItem["kind"], ageDays: number, tags: string[] = []): RankItem => ({
  targetType: kind === "sample" ? "sample" : kind === "clip" ? "clip" : "score",
  targetId: id,
  kind,
  title: id,
  owner: null,
  path: `examples/${id}.apr`,
  tags,
  lastAt: daysAgo(ageDays),
});
/** `n` ratings of `s` stars `ago` days back: that day's row and the all-time one. */
const rated = (id: string, s: number, n: number, ago = 1): DayTally[] => [
  { targetId: id, day: daysAgo(ago).slice(0, 10), count: n, sum: s * n },
  { targetId: id, day: "all", count: n, sum: s * n },
];

const items = [item("song-a", "song", 2, ["techno"]), item("song-b", "song", 40, ["techno", "lounge"]), item("new", "song", 0.5, ["techno"]), item("beat", "beat", 1, ["techno"]), item("clip", "clip", 3), item("meh", "song", 5, ["techno"])];
const tallies: Record<string, DayTally[]> = { "song-a": rated("song-a", 4, 3), "song-b": rated("song-b", 5, 6, 30), beat: rated("beat", 5, 8), clip: rated("clip", 5, 9), meh: rated("meh", 1, 4, 20) };
const all = items.flatMap((i) => rowsFor(i, tallies[i.targetId] ?? [], now));
const ids = (list: string) => listRows(all, list).map((r) => r.targetId);

test("an item's lists: the feed's Top and Recent (all and its kind), and each tag in every window for a score", () => {
  assert.deepEqual(listsOf({ targetType: "clip", kind: "clip", tags: [] }), ["feed|top|all", "feed|top|clip", "feed|recent|all", "feed|recent|clip"]);
  const song = listsOf({ targetType: "score", kind: "song", tags: ["techno"] });
  assert.deepEqual(song.slice(4), ["tag|techno|week", "tag|techno|month", "tag|techno|year", "tag|techno|all"]);
});

test("a listening-cycle candidate (tagged candidate) is in no list: not the feed, not a tag leaderboard", () => {
  assert.deepEqual(listsOf({ targetType: "score", kind: "song", tags: ["candidate"] }), []);
  assert.deepEqual(listsOf({ targetType: "score", kind: "song", tags: ["techno", "candidate"] }), [], "candidate wins even alongside a real tag");
  assert.deepEqual(rowsFor({ ...item("cand-1", "song", 0, ["candidate"]) }, [], now), []);
});

test("Top sorts as the home page ranks (stars over all time, kind weight, freshness)", () => {
  const home = homeRank(
    items.map((i) => ({ id: i.targetId, kind: i.kind, createdAt: i.lastAt, modified: Date.parse(i.lastAt) / 1000 })),
    Object.values(tallies).flat(),
    "all",
    now,
  ).rows.map((r) => r.item.id);
  assert.deepEqual(ids("feed|top|all"), home);
  assert.deepEqual(ids("feed|top|song"), home.filter((id) => !["beat", "clip"].includes(id)));
  assert.deepEqual(ids("feed|top|clip"), ["clip"]);
});

test("Recent sorts newest first", () => {
  assert.deepEqual(ids("feed|recent|all"), ["new", "beat", "song-a", "clip", "meh", "song-b"]);
});

test("a tag's leaderboard sorts as the lists rank in its window", () => {
  for (const w of ["week", "month", "all"] as const) {
    const tagged = items.filter((i) => i.tags.includes("techno"));
    const want = rank(
      tagged.map((i) => ({ id: i.targetId, createdAt: i.lastAt })),
      Object.values(tallies).flat(),
      w,
      now,
      { enough: 0 }, // no widening: each window is its own list
    ).rows.map((r) => r.item.id);
    assert.deepEqual(ids(`tag|techno|${w}`), want, w);
  }
});

test("a row carries its card and its stars in the list's window", () => {
  const r = all.find((x) => x.list === "tag|lounge|week" && x.targetId === "song-b")!;
  assert.equal(r.ratings, 0); // rated a month ago: not this week
  const a = all.find((x) => x.list === "feed|top|all" && x.targetId === "song-b")!;
  assert.equal(a.ratings, 6);
  assert.equal(a.stars, 5);
  assert.equal(a.id, "feed|top|all|score#song-b");
  assert.equal(a.path, "examples/song-b.apr");
});

test("the tags list: the most used first, then by name, A first, a prefix before what it starts", () => {
  const at = now.toISOString();
  const rows = [tagRow("techno", 2, at), tagRow("ambient", 2, at), tagRow("lounge", 5, at), tagRow("tech", 2, at), tagRow("a-1", 2, at), tagRow("a0", 2, at)];
  assert.deepEqual(listRows(rows, "tags").map((r) => [r.title, r.ratings]), [["lounge", 5], ["a-1", 2], ["a0", 2], ["ambient", 2], ["tech", 2], ["techno", 2]]);
  assert.equal(tagRow("techno", 2, at).targetId, "tag:techno", "never an item's id, so an item's rows never include it");
});

test("a hidden row says which item and nothing about it; an item's tags come from its all-time tag lists", () => {
  const h = hiddenRow({ targetType: "clip", targetId: "clp_1" }, now.toISOString());
  assert.deepEqual([h.id, h.list, h.targetId, h.title, h.owner, h.path], ["hidden|clip#clp_1", "hidden", "clp_1", "", null, null]);
  const rows = rowsFor(item("scr_1", "beat", 1, ["techno", "lounge"]), [], now);
  assert.deepEqual([...tagsIn(rows.map((r) => r.list))].sort(), ["lounge", "techno"]);
  assert.deepEqual([...tagsIn(rows.map((r) => r.id))].sort(), ["lounge", "techno"]);
});
