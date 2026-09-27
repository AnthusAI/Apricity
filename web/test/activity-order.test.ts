import { test } from "node:test";
import assert from "node:assert/strict";

import { topCards, type Card } from "../src/data/activity.ts";
import type { DayTally } from "../src/data/rank-window.ts";

const card = (id: string, lastAt: string, targetType: Card["targetType"] = "score"): Card => ({ id: `${targetType}#${id}`, targetType, targetId: id, lastAt });
/** `n` ratings of `s` stars, yesterday: that day's tally row and the all-time one. */
const stars = (id: string, s: number, n: number): DayTally[] => [
  { targetId: id, day: "2026-09-26", count: n, sum: s * n },
  { targetId: id, day: "all", count: n, sum: s * n },
];
const order = (cards: Card[], tallies: DayTally[][]) => topCards(cards, tallies.flat(), new Date("2026-09-27T00:00:00Z")).map((x) => x.card.targetId);

test("Top: rated first by their stars, then the rest newest first", () => {
  const cards = [card("new", "2026-09-26T10:00:00Z"), card("good", "2026-09-20T00:00:00Z"), card("best", "2026-09-01T00:00:00Z"), card("older", "2026-09-10T00:00:00Z")];
  assert.deepEqual(order(cards, [stars("good", 4, 3), stars("best", 5, 4)]), ["best", "good", "new", "older"]);
});

test("Top: equal ratings go to the more recent", () => {
  const cards = [card("a", "2026-09-10T00:00:00Z"), card("b", "2026-09-25T00:00:00Z")];
  assert.deepEqual(order(cards, [stars("a", 4, 2), stars("b", 4, 2)]), ["b", "a"]);
});

test("Top: songs lead; samples, clips and beats sit below the songs people liked", () => {
  const cards = [card("c", "2026-09-25T00:00:00Z", "clip"), { ...card("b", "2026-09-25T00:00:00Z"), kind: "beat" }, { ...card("s", "2026-09-25T00:00:00Z"), kind: "song" }];
  assert.deepEqual(order(cards, [stars("c", 5, 5), stars("b", 5, 5), stars("s", 3, 2)]), ["s", "b", "c"]);
});
