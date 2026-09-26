import { test } from "node:test";
import assert from "node:assert/strict";

import { homeRank, type HomeItem } from "../src/data/home-feed.ts";
import type { DayTally } from "../src/data/rank-window.ts";

const now = new Date("2026-09-26T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const item = (id: string, kind: HomeItem["kind"], ageDays = 60): HomeItem => ({ id, kind, createdAt: daysAgo(ageDays).toISOString(), modified: daysAgo(ageDays).getTime() / 1000 });
/** `votes` ratings of `stars` for `id`, `ageDays` ago: that day's tally row and the all-time one, as the Lambda keeps them. */
const rated = (id: string, stars: number, votes: number, ageDays = 1): DayTally[] => [
  { targetId: id, day: daysAgo(ageDays).toISOString().slice(0, 10), count: votes, sum: stars * votes },
  { targetId: id, day: "all", count: votes, sum: stars * votes },
];
const order = (items: HomeItem[], tallies: DayTally[][]) => homeRank(items, tallies.flat(), "week", now).rows.map((r) => r.item.id);

test("well-rated songs lead; unrated and poorly rated songs follow", () => {
  const items = [item("meh", "song"), item("new", "song", 1), item("great", "song"), item("good", "song")];
  const tallies = [rated("great", 5, 6), rated("good", 4, 3), rated("meh", 1, 4)];
  assert.deepEqual(order(items, tallies), ["great", "good", "new", "meh"]);
});

test("beats, chords and melodies sit below the songs people liked, however they're rated", () => {
  const items = [item("beat", "beat"), item("harp", "chords"), item("tune", "melody"), item("song", "song")];
  const tallies = [rated("beat", 5, 10), rated("harp", 5, 10), rated("tune", 5, 10), rated("song", 3, 3)];
  const got = order(items, tallies);
  assert.equal(got[0], "song");
  assert.equal(got[1], "beat"); // the best of the rest leads them
});

test("fresh lifts a song over an equally rated older one", () => {
  const items = [item("old", "song", 90), item("fresh", "song", 1)];
  const tallies = [rated("old", 4, 3, 30), rated("fresh", 4, 3, 30)];
  assert.deepEqual(order(items, tallies), ["fresh", "old"]);
});

test("a recent rating counts as fresh too", () => {
  const items = [item("a", "song", 90), item("b", "song", 90)];
  const tallies = [rated("a", 4, 3, 40), rated("b", 4, 3, 0)];
  assert.deepEqual(homeRank(items, tallies.flat(), "all", now).rows.map((r) => r.item.id), ["b", "a"]);
});

test("a quiet week widens, as the lists do", () => {
  const r = homeRank([item("a", "song")], rated("a", 5, 2, 20), "week", now);
  assert.equal(r.widened, true);
  assert.equal(r.window, "month");
});
