import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Labs, waitingCycles, type LabRecord } from "../../src/data/labs.ts";
import type { CycleRecord } from "../../src/data/cycles.ts";

const lab: LabRecord = {
  id: "lab_1",
  title: "ave-house: warmer low end",
  brief: "chase a warmer low end without losing the groove",
  sceneScoreId: "scr_examples_ave-house_apr",
  status: "open",
  owner: "sub-1::ryan",
  createdAt: "2026-09-20T00:00:00Z",
};

const cycle = (over: Partial<CycleRecord> = {}): CycleRecord => ({
  id: "cyc_1",
  title: "ave-house: which is better?",
  incumbentScoreId: "scr_examples_ave-house_apr",
  status: "open",
  createdAt: "2026-09-21T00:00:00Z",
  options: [{ letter: "A", scoreId: "scr_examples_ave-house_apr", audio: { key: "cycles/cyc_1/A.m4a" } }],
  labId: "lab_1",
  ...over,
});

describe("waitingCycles", () => {
  it("keeps only open cycles with no verdict yet", () => {
    const cs = [cycle({ id: "c1", status: "open" }), cycle({ id: "c2", status: "open" }), cycle({ id: "c3", status: "closed" })];
    assert.deepEqual(
      waitingCycles(cs, new Set(["c2"])).map((c) => c.id),
      ["c1"],
    );
  });
});

/** A stub client: a Lab table (labsByOwner) and a ListeningCycle table (cyclesByLab), recording calls. */
function stub(labs: LabRecord[] = [], cycles: CycleRecord[] = []) {
  const calls: string[] = [];
  const page = (data: unknown[]) => Promise.resolve({ data, nextToken: null });
  const client = {
    models: {
      Lab: {
        labsByOwner: (args: { owner: string }) => (calls.push(`labsByOwner ${args.owner}`), page(labs.filter((l) => l.owner === args.owner))),
        get: ({ id }: { id: string }) => (calls.push(`Lab.get ${id}`), Promise.resolve({ data: labs.find((l) => l.id === id) ?? null })),
      },
      ListeningCycle: {
        cyclesByLab: (args: { labId: string }) => (calls.push(`cyclesByLab ${args.labId}`), page(cycles.filter((c) => c.labId === args.labId))),
      },
    },
  };
  return { client, calls };
}

describe("Labs", () => {
  it("lists only the signed-in owner's labs, newest first", async () => {
    const older: LabRecord = { ...lab, id: "lab_0", owner: "sub-1::ryan", createdAt: "2026-09-10T00:00:00Z" };
    const someoneElse: LabRecord = { ...lab, id: "lab_x", owner: "sub-2::pat" };
    const { client } = stub([older, lab, someoneElse]);
    const store = new Labs({ client: () => client, owner: async () => "sub-1::ryan" });
    assert.deepEqual(
      (await store.myLabs()).map((l) => l.id),
      ["lab_1", "lab_0"],
    );
  });

  it("a guest has no labs, and myLabs never calls the client", async () => {
    const { client, calls } = stub([lab]);
    const store = new Labs({ client: () => client, owner: async () => null });
    assert.deepEqual(await store.myLabs(), []);
    assert.deepEqual(calls, []);
  });

  it("gets one lab by id", async () => {
    const { client } = stub([lab]);
    const store = new Labs({ client: () => client, owner: async () => "sub-1::ryan" });
    assert.equal((await store.lab("lab_1"))?.title, lab.title);
    assert.equal(await store.lab("lab_nope"), null);
  });

  it("lists a lab's cycles, newest first", async () => {
    const older = cycle({ id: "cyc_0", createdAt: "2026-09-19T00:00:00Z" });
    const newer = cycle({ id: "cyc_2", createdAt: "2026-09-25T00:00:00Z" });
    const elsewhere = cycle({ id: "cyc_9", labId: "lab_9" });
    const { client } = stub([lab], [older, cycle(), newer, elsewhere]);
    const store = new Labs({ client: () => client, owner: async () => "sub-1::ryan" });
    assert.deepEqual(
      (await store.cyclesFor("lab_1")).map((c) => c.id),
      ["cyc_2", "cyc_1", "cyc_0"],
    );
  });

  it("reset() forgets what was loaded (after sign-in or sign-out)", async () => {
    const { client, calls } = stub([lab], [cycle()]);
    const store = new Labs({ client: () => client, owner: async () => "sub-1::ryan" });
    await store.myLabs();
    await store.lab("lab_1");
    await store.cyclesFor("lab_1");
    store.reset();
    await store.myLabs();
    await store.lab("lab_1");
    await store.cyclesFor("lab_1");
    assert.deepEqual(calls, ["labsByOwner sub-1::ryan", "Lab.get lab_1", "cyclesByLab lab_1", "labsByOwner sub-1::ryan", "Lab.get lab_1", "cyclesByLab lab_1"]);
  });
});
