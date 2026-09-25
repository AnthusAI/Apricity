import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rank, totals, windowStart, widenedNote, type DayTally } from "../src/data/rank-window.ts";
import { ratingOf, tallyDeltas, tallyId } from "../amplify/functions/tally/deltas.ts";

const now = new Date("2026-09-25T12:00:00Z");
// A tally as the Lambda writes it: the day row plus the all-time row.
const rated = (targetId: string, day: string, count: number, sum: number): DayTally[] => [
  { targetId, day, count, sum },
  { targetId, day: "all", count, sum },
];
const item = (id: string, createdAt = "2026-01-01T00:00:00Z") => ({ id, createdAt });

describe("windowStart", () => {
  it("a week is today and the six days before", () => assert.equal(windowStart("week", now), "2026-09-19"));
  it("month and year", () => {
    assert.equal(windowStart("month", now), "2026-08-27");
    assert.equal(windowStart("year", now), "2025-09-26");
  });
  it("all time has no start", () => assert.equal(windowStart("all", now), null));
});

describe("totals", () => {
  const t = [...rated("a", "2026-09-25", 2, 9), ...rated("a", "2026-09-01", 1, 1), ...rated("b", "2026-09-18", 1, 5)];
  it("sums the day rows inside the window", () => {
    assert.deepEqual([...totals(t, "week", now)], [["a", { count: 2, sum: 9 }]]);
    assert.deepEqual([...totals(t, "month", now)], [["a", { count: 3, sum: 10 }], ["b", { count: 1, sum: 5 }]]);
  });
  it("all time reads only the all rows", () =>
    assert.deepEqual([...totals(t, "all", now)], [["a", { count: 3, sum: 10 }], ["b", { count: 1, sum: 5 }]]));
  it("ignores rows emptied by deletes", () =>
    assert.equal(totals([{ targetId: "a", day: "2026-09-25", count: 0, sum: 0 }], "week", now).size, 0));
});

describe("rank", () => {
  it("one 5-star vote does not beat many 4-star votes", () => {
    const t = [...rated("one", "2026-09-24", 1, 5), ...rated("many", "2026-09-24", 10, 40)];
    const r = rank([item("one"), item("many")], t, "week", now, { enough: 1 });
    assert.deepEqual(r.rows.map((x) => x.item.id), ["many", "one"]);
    assert.equal(r.rows[0].standing.average, 4);
  });

  it("unrated items follow the rated ones, newest first", () => {
    const items = [item("old", "2026-01-01T00:00:00Z"), item("new", "2026-09-01T00:00:00Z"), item("liked")];
    const r = rank(items, rated("liked", "2026-09-25", 1, 1), "week", now, { enough: 1 });
    assert.deepEqual(r.rows.map((x) => x.item.id), ["liked", "new", "old"]);
    assert.deepEqual(r.rows[1].standing, { count: 0, sum: 0, average: null, score: 0 });
  });

  it("a quiet week widens to the month, and says so", () => {
    const t = ["a", "b", "c", "d", "e"].flatMap((id) => rated(id, "2026-09-05", 1, 4)).concat(rated("f", "2026-09-24", 1, 5));
    const r = rank(["a", "b", "c", "d", "e", "f"].map((id) => item(id)), t, "week", now);
    assert.equal(r.window, "month");
    assert.equal(r.widened, true);
    assert.equal(widenedNote(r), "Quiet week — showing top of the month");
  });

  it("widens all the way to all time", () => {
    const r = rank([item("a")], rated("a", "2024-01-01", 1, 3), "week", now);
    assert.equal(r.window, "all");
    assert.equal(widenedNote(r), "Quiet week — showing top of all time");
    assert.equal(r.rows[0].standing.count, 1);
  });

  it("with fewer than five rated items, all of them rated in the window is enough", () => {
    const r = rank([item("a"), item("b")], [...rated("a", "2026-09-24", 1, 3), ...rated("b", "2026-09-25", 1, 4)], "week", now);
    assert.equal(r.window, "week");
    assert.equal(r.widened, false);
    assert.equal(widenedNote(r), null);
  });

  it("nothing rated at all: keeps the asked window, newest first", () => {
    const r = rank([item("x", "2026-02-01T00:00:00Z"), item("y", "2026-03-01T00:00:00Z")], [], "week", now);
    assert.equal(r.window, "week");
    assert.deepEqual(r.rows.map((x) => x.item.id), ["y", "x"]);
  });

  it("only counts tallies of the listed items", () => {
    const r = rank([item("a")], [...rated("a", "2026-09-25", 1, 2), ...rated("other", "2026-09-25", 50, 250)], "week", now, { enough: 1 });
    assert.equal(r.rows[0].standing.score, (3 * 2.5 + 2) / 4);
  });
});

describe("tallyDeltas", () => {
  const r = (stars: number, ratedAt: string) => ({ targetType: "score", targetId: "s1", stars, ratedAt });
  it("a new rating adds to its day and to all time", () =>
    assert.deepEqual(tallyDeltas(null, r(4, "2026-09-25T10:00:00Z")), [
      { targetType: "score", targetId: "s1", day: "2026-09-25", count: 1, sum: 4 },
      { targetType: "score", targetId: "s1", day: "all", count: 1, sum: 4 },
    ]));
  it("a deleted rating comes off both", () =>
    assert.deepEqual(tallyDeltas(r(2, "2026-09-20T10:00:00Z"), null), [
      { targetType: "score", targetId: "s1", day: "2026-09-20", count: -1, sum: -2 },
      { targetType: "score", targetId: "s1", day: "all", count: -1, sum: -2 },
    ]));
  it("changing a rating moves it to today; all time only changes the sum", () =>
    assert.deepEqual(tallyDeltas(r(2, "2026-09-20T10:00:00Z"), r(5, "2026-09-25T10:00:00Z")), [
      { targetType: "score", targetId: "s1", day: "2026-09-20", count: -1, sum: -2 },
      { targetType: "score", targetId: "s1", day: "all", count: 0, sum: 3 },
      { targetType: "score", targetId: "s1", day: "2026-09-25", count: 1, sum: 5 },
    ]));
  it("re-rating the same day with the same stars changes nothing", () =>
    assert.deepEqual(tallyDeltas(r(3, "2026-09-25T10:00:00Z"), r(3, "2026-09-25T11:00:00Z")), []));
  it("zero stars is a vote; stars are clamped to 0..5", () => {
    assert.deepEqual(tallyDeltas(null, r(0, "2026-09-25T10:00:00Z"))[0], { targetType: "score", targetId: "s1", day: "2026-09-25", count: 1, sum: 0 });
    assert.equal(tallyDeltas(null, r(9, "2026-09-25T10:00:00Z"))[0].sum, 5);
  });
  it("tally ids", () => assert.equal(tallyId({ targetType: "clip", targetId: "clp_1", day: "all" }), "clip#clp_1#all"));
});

describe("ratingOf (stream images)", () => {
  const img = (id: string, owner: string, stars = "4") => ({
    id: { S: id },
    owner: { S: owner },
    targetType: { S: "score" },
    targetId: { S: "scr_a" },
    stars: { N: stars },
    ratedAt: { S: "2026-09-25T10:00:00Z" },
  });
  it("reads a rating whose id names its owner", () => {
    assert.deepEqual(ratingOf(img("score#scr_a#google_1", "google_1")), { targetType: "score", targetId: "scr_a", stars: 4, ratedAt: "2026-09-25T10:00:00Z" });
    assert.ok(ratingOf(img("score#scr_a#google_1", "abc-sub::google_1")));
    assert.ok(ratingOf(img("score#scr_a#abc-sub", "abc-sub::google_1")));
  });
  it("ignores a second rating with another id (no ballot stuffing)", () => {
    assert.equal(ratingOf(img("score#scr_a#google_1-again", "google_1")), null);
    assert.equal(ratingOf(img("score#scr_a#google_2", "google_1")), null);
    assert.equal(ratingOf(img("score#scr_b#google_1", "google_1")), null);
  });
  it("ignores incomplete images", () => {
    assert.equal(ratingOf(undefined), null);
    assert.equal(ratingOf({ ...img("score#scr_a#g", "g"), stars: { N: "x" } }), null);
  });
});

import { filterItems } from "../src/ui/ranked-list.ts";
import { summaryText, nextRating } from "../src/ui/stars.ts";

describe("filterItems", () => {
  const items = [
    { id: "a", title: "Chop Shop", owner: "u1" },
    { id: "b", title: "March Blues", owner: "u2" },
  ];
  const text = (i: (typeof items)[number]) => i.title;
  const owner = (i: (typeof items)[number]) => i.owner;
  it("searches", () => assert.deepEqual(filterItems(items, { query: "blue", mine: false, me: null }, text, owner).map((i) => i.id), ["b"]));
  const u1 = { owners: ["u1", "sub1::u1"], curator: false };
  it("mine keeps only yours", () => assert.deepEqual(filterItems(items, { query: "", mine: true, me: u1 }, text, owner).map((i) => i.id), ["a"]));
  it("mine while signed out shows nothing", () => assert.deepEqual(filterItems(items, { query: "", mine: true, me: null }, text, owner), []));
  it("mine on a list without owners shows nothing", () => assert.deepEqual(filterItems(items, { query: "", mine: true, me: u1 }, text), []));
});

describe("stars", () => {
  it("summary text", () => {
    assert.equal(summaryText(null, 0), "");
    assert.equal(summaryText(4.25, 12), "★ 4.3 · 12");
    assert.equal(summaryText(5, 1), "★ 5 · 1");
    assert.equal(summaryText(0, 2), "★ 0 · 2");
  });
  it("clicking your rating again takes it back", () => {
    assert.equal(nextRating(null, 4), 4);
    assert.equal(nextRating(4, 2), 2);
    assert.equal(nextRating(3, 3), null);
    assert.equal(nextRating(null, 0), 0);
  });
});
