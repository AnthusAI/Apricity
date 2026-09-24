import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planScoreRefs, planKeep, planSkip, planPutOff, planMerge, type CatalogRef, type Lookups, type ScoreRef } from "../../src/data/plans.js";

// Load wasm and get functions
const root = new URL("../../../", import.meta.url).pathname;
const wasm = readFileSync(root + "target/wasm32-wasip1/release/apricitus_web.wasm");
const { instantiate } = await import(root + "web/src/wasm/shim.js");
const rw = await instantiate(new WebAssembly.Module(wasm));

/**
 * Call rw_references to get real catalog refs.
 */
function getCatalogRefs(text: string, folder: string, file: string): CatalogRef[] {
  const result = rw.call("rw_references", JSON.stringify({ text, folder, file }));
  return result.data || [];
}

/**
 * Call rw_ids to get curated_slice_id for a candidate
 */
function getCuratedSliceId(candidateId: string): string {
  const result = rw.call("rw_ids", JSON.stringify({ kind: "curated_slice_id", candidate_id: candidateId }));
  return result.data as string;
}

/**
 * Call rw_markup_merge to merge ML slices. Throws on wasm errors.
 */
function callMarkupMerge(existing: any[], proposals: any[], usedByScore: string[], nameCounters: any): any {
  const result = rw.call("rw_markup_merge", JSON.stringify({
    existing,
    proposed: proposals,
    used_by_score: usedByScore,
    name_counters: nameCounters,
  }));
  if (result.errors?.length) {
    throw new Error(`rw_markup_merge error: ${result.errors[0]}`);
  }
  return result.data || {};
}

describe("planScoreRefs", () => {
  describe("Scenario 1: Single clip with slice (score_refs.feature)", () => {
    it("should create a ScoreRef with clip and slice resolved", () => {
      const text = `tempo 90
key C
bars 1
clip beat = marine-band/stems/Thunderer/drums.wav  slice loop-1
track beat`;

      const refs = getCatalogRefs(text, "scores", "test.apr");

      // Mock lookups
      const lookups: Lookups = {
        clipsByPath: new Map([
          ["marine-band/stems/Thunderer/drums.wav", { id: "clp-1", path: "marine-band/stems/Thunderer/drums.wav" }],
        ]),
        clipsById: new Map(),
        slicesByClipAndName: new Map([
          [
            "clp-1",
            new Map([["loop-1", { id: "slc-a", start: 10, end: 14 }]]),
          ],
        ]),
        slicesById: new Map(),
      };

      const plan = planScoreRefs("score-1", refs, lookups, []);
      assert.deepEqual(plan, {
        create: [
          {
            id: "sref_score-1_beat",
            scoreId: "score-1",
            clipAlias: "beat",
            clipPath: "marine-band/stems/Thunderer/drums.wav",
            clipId: "clp-1",
            sliceName: "loop-1",
            sliceId: "slc-a",
            start: 10,
            end: 14,
          },
        ],
        update: [],
        delete: [],
      });
    });
  });

  describe("Scenario 2: Kit pad references", () => {
    it("should create a ScoreRef for a kit pad slice", () => {
      const text = `tempo 90
key C
bars 1
clip band = marine-band/Thunderer.mp3
kit drums
  crash = band  slice hit-3
track drums  steps "crash . . ."`;

      const refs = getCatalogRefs(text, "scores", "test.apr");

      // Mock lookups
      const lookups: Lookups = {
        clipsByPath: new Map([["marine-band/Thunderer.mp3", { id: "clp-2", path: "marine-band/Thunderer.mp3" }]]),
        clipsById: new Map(),
        slicesByClipAndName: new Map([
          [
            "clp-2",
            new Map([["hit-3", { id: "slc-h", start: 19.8, end: 20.3 }]]),
          ],
        ]),
        slicesById: new Map(),
      };

      const plan = planScoreRefs("score-2", refs, lookups, []);
      assert.deepEqual(plan, {
        create: [
          {
            id: "sref_score-2_band",
            scoreId: "score-2",
            clipAlias: "band",
            clipPath: "marine-band/Thunderer.mp3",
            clipId: "clp-2",
          },
          {
            id: "sref_score-2_band_drums.crash",
            scoreId: "score-2",
            clipAlias: "band",
            clipPath: "marine-band/Thunderer.mp3",
            clipId: "clp-2",
            sliceName: "hit-3",
            sliceId: "slc-h",
            start: 19.8,
            end: 20.3,
          },
        ],
        update: [],
        delete: [],
      });
    });
  });

  describe("Scenario 3: Saving again replaces references", () => {
    it("should delete old refs and create new ones", () => {
      const text1 = `tempo 90
key C
bars 1
clip beat = marine-band/stems/Thunderer/drums.wav  slice loop-1
track beat`;

      const text2 = `tempo 90
key C
bars 1
clip whole = marine-band/Thunderer.mp3
track whole`;

      const refs1 = getCatalogRefs(text1, "scores", "test.apr");
      const refs2 = getCatalogRefs(text2, "scores", "test.apr");

      // Mock lookups
      const lookups: Lookups = {
        clipsByPath: new Map([
          ["marine-band/stems/Thunderer/drums.wav", { id: "clp-1", path: "marine-band/stems/Thunderer/drums.wav" }],
          ["marine-band/Thunderer.mp3", { id: "clp-2", path: "marine-band/Thunderer.mp3" }],
        ]),
        clipsById: new Map(),
        slicesByClipAndName: new Map([
          [
            "clp-1",
            new Map([["loop-1", { id: "slc-a", start: 10, end: 14 }]]),
          ],
        ]),
        slicesById: new Map(),
      };

      // First save
      const plan1 = planScoreRefs("score-1", refs1, lookups, []);
      const existing = plan1.create;

      // Second save
      const plan2 = planScoreRefs("score-1", refs2, lookups, existing);

      // Should have: 1 delete (old beat ref), 1 create (new whole ref)
      assert.deepEqual(plan2, {
        create: [
          {
            id: "sref_score-1_whole",
            scoreId: "score-1",
            clipAlias: "whole",
            clipPath: "marine-band/Thunderer.mp3",
            clipId: "clp-2",
          },
        ],
        update: [],
        delete: ["sref_score-1_beat"],
      });
    });
  });

  describe("Scenario 4: Unresolved reference to missing clip", () => {
    it("should keep unresolved clipPath without clipId", () => {
      const text = `tempo 90
key C
bars 1
clip x = somewhere/else.wav
track x`;

      const refs = getCatalogRefs(text, "scores", "test.apr");

      // Mock lookups (no clip found)
      const lookups: Lookups = {
        clipsByPath: new Map(),
        clipsById: new Map(),
        slicesByClipAndName: new Map(),
        slicesById: new Map(),
      };

      const plan = planScoreRefs("score-3", refs, lookups, []);
      assert.deepEqual(plan, {
        create: [
          {
            id: "sref_score-3_x",
            scoreId: "score-3",
            clipAlias: "x",
            clipPath: "somewhere/else.wav",
          },
        ],
        update: [],
        delete: [],
      });
    });
  });

  describe("Scenario 5: @clp_ and @slc_ forms", () => {
    it("should resolve @clp_ and @slc_ references by id", () => {
      const text = `tempo 90
key C
bars 1
clip source = @clp_abc123  slice @slc_xyz
track source`;

      const refs = getCatalogRefs(text, "scores", "test.apr");

      // Mock lookups
      const lookups: Lookups = {
        clipsByPath: new Map(),
        clipsById: new Map([["clp_abc123", { id: "clp-abc", path: "marine-band/x.wav" }]]),
        slicesByClipAndName: new Map(),
        slicesById: new Map([["slc_xyz", { id: "slc-xyz", start: 5, end: 10 }]]),
      };

      const plan = planScoreRefs("score-4", refs, lookups, []);
      assert.deepEqual(plan, {
        create: [
          {
            id: "sref_score-4_source",
            scoreId: "score-4",
            clipAlias: "source",
            clipPath: "marine-band/x.wav",
            clipId: "clp-abc",
            sliceId: "slc-xyz",
            start: 5,
            end: 10,
          },
        ],
        update: [],
        delete: [],
      });
    });
  });

  describe("Scenario 6: Saving same text twice", () => {
    it("should result in empty create/delete when saved again", () => {
      const text = `tempo 90
key C
bars 1
clip beat = marine-band/stems/Thunderer/drums.wav  slice loop-1
track beat`;

      const refs = getCatalogRefs(text, "scores", "test.apr");

      // Mock lookups
      const lookups: Lookups = {
        clipsByPath: new Map([
          ["marine-band/stems/Thunderer/drums.wav", { id: "clp-1", path: "marine-band/stems/Thunderer/drums.wav" }],
        ]),
        clipsById: new Map(),
        slicesByClipAndName: new Map([
          [
            "clp-1",
            new Map([["loop-1", { id: "slc-a", start: 10, end: 14 }]]),
          ],
        ]),
        slicesById: new Map(),
      };

      // First save
      const plan1 = planScoreRefs("score-1", refs, lookups, []);
      const existing = plan1.create;

      // Second save (same text)
      const plan2 = planScoreRefs("score-1", refs, lookups, existing);

      assert.deepEqual(plan2, {
        create: [],
        update: [],
        delete: [],
      });
    });
  });

  describe("Scenario 7: Re-save with different clip", () => {
    it("should update when clip changes from clp-1 to clp-2", () => {
      const text1 = `tempo 90
key C
bars 1
clip beat = marine-band/old.wav
track beat`;

      const text2 = `tempo 90
key C
bars 1
clip beat = marine-band/new.wav
track beat`;

      const refs1 = getCatalogRefs(text1, "scores", "test.apr");
      const refs2 = getCatalogRefs(text2, "scores", "test.apr");

      // Mock lookups
      const lookups: Lookups = {
        clipsByPath: new Map([
          ["marine-band/old.wav", { id: "clp-1", path: "marine-band/old.wav" }],
          ["marine-band/new.wav", { id: "clp-2", path: "marine-band/new.wav" }],
        ]),
        clipsById: new Map(),
        slicesByClipAndName: new Map(),
        slicesById: new Map(),
      };

      // First save
      const plan1 = planScoreRefs("score-1", refs1, lookups, []);
      const existing = plan1.create;

      // Second save
      const plan2 = planScoreRefs("score-1", refs2, lookups, existing);

      // Should have one update with the new clipId and new clipPath, nulling removed fields
      assert.deepEqual(plan2, {
        create: [],
        update: [
          {
            id: "sref_score-1_beat",
            scoreId: "score-1",
            clipAlias: "beat",
            clipPath: "marine-band/new.wav",
            clipId: "clp-2",
            sliceName: null as any,
            sliceId: null as any,
            start: null as any,
            end: null as any,
          },
        ],
        delete: [],
      });
    });
  });
});

// ============================================================================
// planKeep tests (from keep.feature)
// ============================================================================

describe("planKeep (keep.feature)", () => {
  describe("Scenario 1: Keeping creates a verdict, a curated slice and a crate item", () => {
    it("should plan verdict create, slice create, and crate item create", () => {
      const candidateId = "cand-1";
      const candidate = {
        id: candidateId,
        clipId: "clp-1",
        recordingId: "rec-1",
        start: 10,
        end: 14,
        kind: "loop",
        name: "loop-cand",
      };

      const judge = "alice";
      const sliceId = getCuratedSliceId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      let newIdCounter = 0;
      const newId = () => `crate-new-${++newIdCounter}`;

      const plan = planKeep(
        candidateId,
        judge,
        candidate,
        null,
        null,
        new Map(),
        [],
        sliceId,
        now,
        newId,
        new Map(),
        { stars: 4, tags: ["brass"], name: "horn-loop", crates: ["digs"] }
      ) as any;

      assert.deepEqual(plan, {
        verdicts: {
          create: {
            candidateId,
            judge,
            verdict: "keep",
            stars: 4,
            tags: ["brass"],
            name: "horn-loop",
            judgedAt: now,
            by: "person",
          },
          update: undefined,
        },
        slices: {
          create: {
            id: sliceId,
            clipId: "clp-1",
            name: "horn-loop",
            start: 10,
            end: 14,
            source: "curated",
            candidateId,
            kind: "loop",
          },
          update: undefined,
        },
        crates: {
          create: [
            {
              id: "crate-new-1",
              name: "digs",
            },
          ],
        },
        crateItems: {
          create: [
            {
              crateId: "crate-new-1",
              candidateId,
              position: "a0",
            },
          ],
        },
      });
    });
  });

  describe("Scenario 2: Keeping twice changes nothing", () => {
    it("should plan no changes if verdict and crates unchanged", () => {
      const candidateId = "cand-1";
      const candidate = {
        id: candidateId,
        clipId: "clp-1",
        recordingId: "rec-1",
        start: 10,
        end: 14,
        kind: "loop",
        name: "loop-cand",
      };

      const judge = "alice";
      const sliceId = getCuratedSliceId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const myVerdict = {
        candidateId,
        judge,
        verdict: "keep",
        stars: 4,
        tags: ["brass"],
        name: "horn-loop",
      };

      const curatedSlice = {
        id: sliceId,
        clipId: "clp-1",
        name: "horn-loop",
      };

      const crateId = "crate-1";
      const crateItem = {
        id: "item-1",
        crateId,
        candidateId,
      };

      let newIdCounter = 0;
      const newId = () => `crate-new-${++newIdCounter}`;

      const plan = planKeep(
        candidateId,
        judge,
        candidate,
        myVerdict,
        curatedSlice,
        new Map([["digs", { id: crateId, name: "digs" }]]),
        [crateItem],
        sliceId,
        now,
        newId,
        new Map([[crateId, null]]),
        { stars: 4, tags: ["brass"], name: "horn-loop", crates: ["digs"] }
      ) as any;

      assert.deepEqual(plan, {
        verdicts: {
          create: undefined,
          update: {
            candidateId,
            judge,
            verdict: "keep",
            stars: 4,
            tags: ["brass"],
            name: "horn-loop",
            judgedAt: now,
            by: "person",
          },
        },
        slices: {
          create: undefined,
          update: undefined,
        },
        crates: {
          create: [],
        },
        crateItems: {
          create: [],
        },
      });
    });
  });

  describe("Scenario 3: Crate with existing item at a3 gets next position a4", () => {
    it("should create crate item at position a4 when last item is at a3", () => {
      const candidateId = "cand-2";
      const candidate = {
        id: candidateId,
        clipId: "clp-1",
        recordingId: "rec-1",
        start: 20,
        end: 24,
        kind: "loop",
        name: "loop-cand-2",
      };

      const judge = "alice";
      const sliceId = getCuratedSliceId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const crateId = "crate-digs";
      let newIdCounter = 0;
      const newId = () => `crate-new-${++newIdCounter}`;

      const plan = planKeep(
        candidateId,
        judge,
        candidate,
        null,
        null,
        new Map([["digs", { id: crateId, name: "digs" }]]),
        [],
        sliceId,
        now,
        newId,
        new Map([[crateId, "a3"]]),
        { crates: ["digs"] }
      ) as any;

      assert.deepEqual(plan, {
        verdicts: {
          create: {
            candidateId,
            judge,
            verdict: "keep",
            stars: undefined,
            tags: undefined,
            name: undefined,
            judgedAt: now,
            by: "person",
          },
          update: undefined,
        },
        slices: {
          create: {
            id: sliceId,
            clipId: "clp-1",
            name: "loop-cand-2",
            start: 20,
            end: 24,
            source: "curated",
            candidateId,
            kind: "loop",
          },
          update: undefined,
        },
        crates: {
          create: [],
        },
        crateItems: {
          create: [
            {
              crateId: "crate-digs",
              candidateId,
              position: "a4",
            },
          ],
        },
      });
    });
  });

  describe("Scenario 4: Keeping an unknown candidate fails", () => {
    it("should return error when candidate is null", () => {
      const candidateId = "no-such-candidate";
      const judge = "alice";
      const sliceId = getCuratedSliceId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const newId = () => "crate-new-1";

      const result = planKeep(
        candidateId,
        judge,
        null,
        null,
        null,
        new Map(),
        [],
        sliceId,
        now,
        newId,
        new Map()
      );

      assert.deepEqual(result, { errors: [{ errorType: "NotFound" }] });
    });
  });
});

// ============================================================================
// planSkip tests (from keep.feature)
// ============================================================================

describe("planSkip (keep.feature)", () => {
  describe("Scenario 1: Skipping after keeping removes the curated slice", () => {
    it("should plan verdict update to skip and slice delete when no other keeper", () => {
      const candidateId = "cand-1";
      const sliceId = getCuratedSliceId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const existingCrateItems = [
        { id: "item-1", crateId: "crate-1", candidateId },
      ];

      const allVerdicts = [
        { candidateId, judge: "alice", verdict: "keep" },
      ];

      const plan = planSkip(candidateId, "alice", existingCrateItems, allVerdicts, sliceId, now);

      assert.deepEqual(plan, {
        verdicts: {
          update: {
            candidateId,
            judge: "alice",
            verdict: "skip",
            judgedAt: now,
            by: "person",
          },
        },
        slices: {
          delete: [sliceId],
        },
        crateItems: {
          delete: ["item-1"],
        },
      });
    });
  });

  describe("Scenario 2: A skip keeps the slice while someone else still keeps it", () => {
    it("should plan verdict update to skip and NOT delete slice if other keeper exists", () => {
      const candidateId = "cand-1";
      const sliceId = getCuratedSliceId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const existingCrateItems = [
        { id: "item-1", crateId: "crate-1", candidateId },
      ];

      const allVerdicts = [
        { candidateId, judge: "alice", verdict: "keep" },
        { candidateId, judge: "bob", verdict: "keep" },
      ];

      const plan = planSkip(candidateId, "alice", existingCrateItems, allVerdicts, sliceId, now);

      assert.deepEqual(plan, {
        verdicts: {
          update: {
            candidateId,
            judge: "alice",
            verdict: "skip",
            judgedAt: now,
            by: "person",
          },
        },
        slices: {
          delete: [],
        },
        crateItems: {
          delete: ["item-1"],
        },
      });
    });
  });
});

// ============================================================================
// planPutOff tests (from keep.feature)
// ============================================================================

describe("planPutOff (keep.feature)", () => {
  describe("Scenario: Putting off records a verdict and no slice", () => {
    it("should plan verdict create with verdict=later", () => {
      const candidateId = "cand-1";
      const now = "2026-09-24T12:00:00.000Z";

      const plan = planPutOff(candidateId, "alice", null, now);

      assert.deepEqual(plan, {
        verdicts: {
          create: {
            candidateId,
            judge: "alice",
            verdict: "later",
            judgedAt: now,
            by: "person",
          },
          update: undefined,
        },
      });
    });
  });
});

// ============================================================================
// planMerge tests (from markup_merge.feature)
// ============================================================================

describe("planMerge (markup_merge.feature)", () => {
  describe("Scenario 1: An overlapping proposal keeps the slice's id and name", () => {
    it("should plan slice update with new span", () => {
      const clipId = "clp-1";

      const existing = [
        { id: "slc-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
      ];

      const proposals = [
        { kind: "loop", start: 10.1, end: 14, rank: 1 },
      ];

      const mergeResult = callMarkupMerge(existing, proposals, [], { loop: 1 });
      const plan = planMerge(clipId, mergeResult);

      assert.deepEqual(plan, {
        slices: {
          update: [
            { id: "slc-a", start: 10.1, end: 14, rank: 1 },
          ],
          create: [],
          retire: [],
          delete: [],
        },
        clip: {
          update: {
            id: clipId,
            nameCounters: '{"loop":1}',
          },
        },
      });
    });
  });

  describe("Scenario 2: A new proposal gets a new name", () => {
    it("should plan slice create with new name and clip update with counters", () => {
      const clipId = "clp-1";

      const existing = [
        { id: "slc-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
      ];

      const proposals = [
        { kind: "loop", start: 10, end: 14, rank: 2 },
        { kind: "loop", start: 30, end: 34, rank: 1 },
      ];

      const mergeResult = callMarkupMerge(existing, proposals, [], { loop: 1 });
      const plan = planMerge(clipId, mergeResult);

      assert.deepEqual(plan, {
        slices: {
          update: [
            { id: "slc-a", start: 10, end: 14, rank: 2 },
          ],
          create: [
            {
              clipId,
              name: "loop-2",
              start: 30,
              end: 34,
              source: "ml",
              rank: 1,
            },
          ],
          retire: [],
          delete: [],
        },
        clip: {
          update: {
            id: clipId,
            nameCounters: '{"loop":2}',
          },
        },
      });
    });
  });

  describe("Scenario 3: Names are never reused", () => {
    it("should assign loop-3 after creating loop-2", () => {
      const clipId = "clp-1";

      // After first merge that created loop-2, we have two slices
      const existing = [
        { id: "slc-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
        { id: "slc-b", name: "loop-2", kind: "loop", start: 30, end: 34, source: "ml", retired: false },
      ];

      // Second merge proposes only 50-54, so existing ones are no longer proposed
      const proposals = [
        { kind: "loop", start: 50, end: 54, rank: 1 },
      ];

      const mergeResult = callMarkupMerge(existing, proposals, [], { loop: 2 });
      const plan = planMerge(clipId, mergeResult);

      assert.deepEqual(plan, {
        slices: {
          update: [],
          create: [
            {
              clipId,
              name: "loop-3",
              start: 50,
              end: 54,
              source: "ml",
              rank: 1,
            },
          ],
          retire: [],
          delete: ["slc-a", "slc-b"],
        },
        clip: {
          update: {
            id: clipId,
            nameCounters: '{"loop":3}',
          },
        },
      });
    });
  });

  describe("Scenario 4: A slice no longer proposed and not used by any score is deleted", () => {
    it("should plan slice delete when no proposals and no scores use it", () => {
      const clipId = "clp-1";

      const existing = [
        { id: "slc-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
      ];

      const proposals = [];

      const mergeResult = callMarkupMerge(existing, proposals, [], { loop: 1 });
      const plan = planMerge(clipId, mergeResult);

      assert.deepEqual(plan, {
        slices: {
          update: [],
          create: [],
          retire: [],
          delete: ["slc-a"],
        },
        clip: {
          update: {
            id: clipId,
            nameCounters: '{"loop":1}',
          },
        },
      });
    });
  });

  describe("Scenario 5: A slice a score uses is retired, not deleted", () => {
    it("should plan slice retire when a score references it", () => {
      const clipId = "clp-1";

      const existing = [
        { id: "slc-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
      ];

      const proposals = [];

      const mergeResult = callMarkupMerge(existing, proposals, ["slc-a"], { loop: 1 });
      const plan = planMerge(clipId, mergeResult);

      assert.deepEqual(plan, {
        slices: {
          update: [],
          create: [],
          retire: [
            { id: "slc-a", retired: true },
          ],
          delete: [],
        },
        clip: {
          update: {
            id: clipId,
            nameCounters: '{"loop":1}',
          },
        },
      });
    });
  });

  describe("Scenario 6: Slices made by people are left alone", () => {
    it("should not touch user-source slices during merge", () => {
      const clipId = "clp-1";

      const existing = [
        { id: "slc-u", name: "mine", kind: "", start: 1, end: 2, source: "user", retired: false },
        { id: "slc-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
      ];

      const proposals = [];

      const mergeResult = callMarkupMerge(existing, proposals, [], { loop: 1 });
      const plan = planMerge(clipId, mergeResult);

      assert.deepEqual(plan, {
        slices: {
          update: [],
          create: [],
          retire: [],
          delete: ["slc-a"],
        },
        clip: {
          update: {
            id: clipId,
            nameCounters: '{"loop":1}',
          },
        },
      });
    });
  });
});
