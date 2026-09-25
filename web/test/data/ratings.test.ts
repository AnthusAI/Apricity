import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ratings, ratingId, talliesFrom, type RatingRecord } from "../../src/data/ratings.ts";

/** A stub client: a Rating table and a Tally index, recording calls. */
function stub(ratings: RatingRecord[] = [], tallies: any[] = []) {
  const calls: string[] = [];
  const page = (data: unknown[]) => Promise.resolve({ data, nextToken: null });
  const client = {
    models: {
      Rating: {
        list: () => (calls.push("Rating.list"), page(ratings)),
        create: (r: RatingRecord) => (calls.push(`create ${r.id} ${r.stars}`), ratings.push(r), Promise.resolve({ data: r })),
        update: (r: RatingRecord) => (calls.push(`update ${r.id} ${r.stars}`), Promise.resolve({ data: r })),
        delete: ({ id }: { id: string }) => (calls.push(`delete ${id}`), Promise.resolve({ data: { id } })),
      },
      Tally: { talliesByTypeAndDay: ({ targetType }: { targetType: string }) => (calls.push(`Tally ${targetType}`), page(tallies)) },
    },
  };
  return { client, calls };
}
const at = () => new Date("2026-09-25T10:00:00Z");

describe("Ratings", () => {
  it("rates, re-rates and takes a rating back, one record per person per item", async () => {
    const { client, calls } = stub();
    const r = new Ratings({ client: () => client, who: async () => "google_1", mode: () => "cloud", now: at });
    await r.rate("score", "scr_a", 4);
    assert.equal(await r.mineFor("score", "scr_a"), 4);
    await r.rate("score", "scr_a", 0);
    assert.equal(await r.mineFor("score", "scr_a"), 0);
    await r.rate("score", "scr_a", null);
    assert.equal(await r.mineFor("score", "scr_a"), null);
    assert.deepEqual(calls, ["Rating.list", "create score#scr_a#google_1 4", "update score#scr_a#google_1 0", "delete score#scr_a#google_1"]);
  });

  it("guests cannot rate, and have no ratings", async () => {
    const { client } = stub();
    const r = new Ratings({ client: () => client, who: async () => null, mode: () => "cloud" });
    assert.equal(await r.mineFor("clip", "clp_1"), null);
    await assert.rejects(r.rate("clip", "clp_1", 3), /Sign in to rate/);
  });

  it("only 0 to 5 whole stars", async () => {
    const { client } = stub();
    const r = new Ratings({ client: () => client, who: async () => "g", mode: () => "cloud" });
    for (const bad of [6, -1, 2.5]) await assert.rejects(r.rate("score", "s", bad), /0 to 5/);
  });

  it("ignores a stray rating whose id is not yours", async () => {
    const stray: RatingRecord = { id: "score#scr_a#someone-else", targetType: "score", targetId: "scr_a", stars: 5, ratedAt: "2026-09-25T00:00:00Z" };
    const { client } = stub([stray]);
    const r = new Ratings({ client: () => client, who: async () => "google_1", mode: () => "cloud" });
    assert.equal(await r.mineFor("score", "scr_a"), null);
  });

  it("cloud tallies come from the Tally index", async () => {
    const { client, calls } = stub([], [{ targetType: "clip", targetId: "clp_1", day: "all", count: 2, sum: 7, id: "x" }]);
    const r = new Ratings({ client: () => client, who: async () => null, mode: () => "cloud" });
    assert.deepEqual(await r.tallies("clip"), [{ targetId: "clp_1", day: "all", count: 2, sum: 7 }]);
    assert.deepEqual(calls, ["Tally clip"]);
  });

  it("local tallies are summed from the ratings", async () => {
    const rs: RatingRecord[] = [
      { id: ratingId("score", "s1", "a"), targetType: "score", targetId: "s1", stars: 4, ratedAt: "2026-09-25T01:00:00Z" },
      { id: ratingId("score", "s1", "b"), targetType: "score", targetId: "s1", stars: 2, ratedAt: "2026-09-24T01:00:00Z" },
      { id: ratingId("clip", "c1", "a"), targetType: "clip", targetId: "c1", stars: 5, ratedAt: "2026-09-25T01:00:00Z" },
    ];
    const { client } = stub(rs);
    const r = new Ratings({ client: () => client, who: async () => "a", mode: () => "local" });
    const t = await r.tallies("score");
    assert.deepEqual(t.find((x) => x.day === "all"), { targetId: "s1", day: "all", count: 2, sum: 6 });
    assert.equal(t.length, 3);
  });

  it("talliesFrom matches what the Lambda writes", () =>
    assert.deepEqual(talliesFrom([{ targetType: "score", targetId: "s", stars: 3, ratedAt: "2026-09-25T00:00:00Z" }]), [
      { targetId: "s", day: "2026-09-25", count: 1, sum: 3 },
      { targetId: "s", day: "all", count: 1, sum: 3 },
    ]));
});
