import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildVerdict, Cycles, incumbentLetter, lettersOf, noteFor, revealed, validBest, type CycleRecord, type VerdictRecord } from "../../src/data/cycles.ts";

const cycle: CycleRecord = {
  id: "cyc_1",
  title: "ave-house: which is better?",
  question: "which is better?",
  incumbentScoreId: "scr_incumbent",
  status: "open",
  createdAt: "2026-09-20T00:00:00Z",
  options: [
    { letter: "B", scoreId: "scr_incumbent", audio: { key: "cycles/cyc_1/B.m4a" } },
    { letter: "A", scoreId: "scr_cand1", audio: { key: "cycles/cyc_1/A.m4a" } },
    { letter: "C", scoreId: "scr_cand2", audio: { key: "cycles/cyc_1/C.m4a" } },
  ],
};

describe("pure cycle helpers", () => {
  it("finds the incumbent's letter", () => {
    assert.equal(incumbentLetter(cycle), "B");
    assert.equal(incumbentLetter({ ...cycle, incumbentScoreId: "scr_nope" }), null);
  });

  it("lists letters in order", () => assert.deepEqual(lettersOf(cycle), ["A", "B", "C"]));

  it("a valid best is one of the letters, or 'same'", () => {
    assert.equal(validBest(cycle, "A"), true);
    assert.equal(validBest(cycle, "same"), true);
    assert.equal(validBest(cycle, "D"), false);
    assert.equal(validBest(cycle, ""), false);
  });

  it("is revealed once you've saved a verdict, or the cycle has closed", () => {
    assert.equal(revealed(cycle, null), false);
    assert.equal(revealed(cycle, { cycleId: "cyc_1", judge: "u1", best: "A", savedAt: "" }), true);
    assert.equal(revealed({ ...cycle, status: "closed" }, null), true);
  });

  it("builds a verdict, dropping blank notes and trimming text", () => {
    const now = new Date("2026-09-27T12:00:00Z");
    const v = buildVerdict("cyc_1", "sub-123", "A", { A: "  punchier kick  ", B: "   ", C: "" }, "  prefer A overall  ", now);
    assert.deepEqual(v, {
      cycleId: "cyc_1",
      judge: "sub-123",
      best: "A",
      notes: [{ letter: "A", note: "punchier kick" }],
      note: "prefer A overall",
      savedAt: "2026-09-27T12:00:00.000Z",
    });
  });

  it("noteFor reads a saved note back, or '' when there isn't one", () => {
    const v: VerdictRecord = { cycleId: "cyc_1", judge: "u1", best: "A", notes: [{ letter: "A", note: "nice" }], savedAt: "" };
    assert.equal(noteFor(v, "A"), "nice");
    assert.equal(noteFor(v, "B"), "");
    assert.equal(noteFor(null, "A"), "");
  });
});

/** A stub client: a ListeningCycle table and a CycleVerdict identifier-keyed table, recording calls. */
function stub(cycles: CycleRecord[] = [], verdicts: VerdictRecord[] = []) {
  const calls: string[] = [];
  const page = (data: unknown[]) => Promise.resolve({ data, nextToken: null });
  const client = {
    models: {
      ListeningCycle: {
        list: (args: any) => (calls.push("ListeningCycle.list"), page(cycles.filter((c) => !args?.filter || c.status === args.filter.status.eq))),
        get: ({ id }: { id: string }) => (calls.push(`ListeningCycle.get ${id}`), Promise.resolve({ data: cycles.find((c) => c.id === id) ?? null })),
      },
      CycleVerdict: {
        get: ({ cycleId, judge }: { cycleId: string; judge: string }) => (
          calls.push(`CycleVerdict.get ${cycleId} ${judge}`), Promise.resolve({ data: verdicts.find((v) => v.cycleId === cycleId && v.judge === judge) ?? null })
        ),
        create: (r: VerdictRecord) => (calls.push(`create ${r.cycleId} ${r.judge} ${r.best}`), verdicts.push(r), Promise.resolve({ data: r })),
        update: (r: VerdictRecord) => {
          calls.push(`update ${r.cycleId} ${r.judge} ${r.best}`);
          const i = verdicts.findIndex((v) => v.cycleId === r.cycleId && v.judge === r.judge);
          if (i >= 0) verdicts[i] = r;
          return Promise.resolve({ data: r });
        },
      },
    },
  };
  return { client, calls };
}

describe("Cycles", () => {
  it("lists only open cycles, newest first", async () => {
    const closed: CycleRecord = { ...cycle, id: "cyc_0", status: "closed", createdAt: "2026-09-19T00:00:00Z" };
    const newer: CycleRecord = { ...cycle, id: "cyc_2", createdAt: "2026-09-25T00:00:00Z" };
    const { client } = stub([closed, cycle, newer]);
    const store = new Cycles({ client: () => client, judge: async () => "sub-1" });
    assert.deepEqual(
      (await store.openCycles()).map((c) => c.id),
      ["cyc_2", "cyc_1"],
    );
  });

  it("a guest has no verdict, and cannot save one", async () => {
    const { client } = stub([cycle]);
    const store = new Cycles({ client: () => client, judge: async () => null });
    assert.equal(await store.verdict("cyc_1"), null);
    await assert.rejects(store.saveVerdict("cyc_1", "A", {}, ""), /Sign in/);
  });

  it("saves a verdict, then updates it (upsert), keyed by cycleId+judge (the sub)", async () => {
    const { client, calls } = stub([cycle]);
    const store = new Cycles({ client: () => client, judge: async () => "sub-123", now: () => new Date("2026-09-27T00:00:00Z") });
    assert.equal(await store.verdict("cyc_1"), null);
    const first = await store.saveVerdict("cyc_1", "A", { A: "great" }, "");
    assert.equal(first.judge, "sub-123");
    assert.deepEqual(await store.verdict("cyc_1"), first);
    const second = await store.saveVerdict("cyc_1", "same", {}, "actually the same");
    assert.equal(second.best, "same");
    assert.deepEqual(await store.verdict("cyc_1"), second);
    // One read (the first verdict() call); saveVerdict reuses that cache rather than re-fetching, so a create and an
    // update follow it directly.
    assert.deepEqual(calls, ["CycleVerdict.get cyc_1 sub-123", "create cyc_1 sub-123 A", "update cyc_1 sub-123 same"]);
  });

  it("reset() forgets what was loaded (after sign-in or sign-out)", async () => {
    const { client, calls } = stub([cycle]);
    const store = new Cycles({ client: () => client, judge: async () => "sub-123" });
    await store.openCycles();
    await store.verdict("cyc_1");
    store.reset();
    await store.openCycles();
    await store.verdict("cyc_1");
    assert.deepEqual(calls, ["ListeningCycle.list", "CycleVerdict.get cyc_1 sub-123", "ListeningCycle.list", "CycleVerdict.get cyc_1 sub-123"]);
  });
});
