import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planScoreRefs, planKeep, planSkip, planPutOff, planMerge, type CatalogRef, type Lookups, type ScoreRef } from "../../src/data/plans.js";

// Load wasm and get functions
const root = new URL("../../../", import.meta.url).pathname;
const wasm = readFileSync(root + "target/wasm32-wasip1/release/apricity_web.wasm");
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
 * Call rw_ids to get curated_clip_id for a candidate
 */
function getCuratedClipId(candidateId: string): string {
  const result = rw.call("rw_ids", JSON.stringify({ kind: "curated_clip_id", candidate_id: candidateId }));
  return result.data as string;
}

/**
 * Get the next position after a given position using fractional indexing
 */
function getPositionAfter(lastPosition: string | null): string {
  const result = rw.call("rw_ids", JSON.stringify({ kind: "position_between", a: lastPosition, b: null }));
  return result.data as string;
}

/**
 * Call rw_markup_merge to merge ML clips. Throws on wasm errors.
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
  describe("Scenario 1: Single sample with clip (score_refs.feature)", () => {
    it("should create a ScoreRef with sample and clip resolved", () => {
      const text = `tempo 90
key C
bars 1
clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
track beat`;

      const refs = getCatalogRefs(text, "scores", "test.apr");

      // Mock lookups
      const lookups: Lookups = {
        samplesByPath: new Map([
          ["marine-band/stems/Thunderer/drums.wav", { id: "smp-1", path: "marine-band/stems/Thunderer/drums.wav" }],
        ]),
        samplesById: new Map(),
        clipsBySampleAndName: new Map([
          [
            "smp-1",
            new Map([["loop-1", { id: "clp-a", start: 10, end: 14 }]]),
          ],
        ]),
        clipsById: new Map(),
      };

      const plan = planScoreRefs("score-1", refs, lookups, []);
      assert.deepEqual(plan, {
        create: [
          {
            id: "sref_score-1_beat",
            scoreId: "score-1",
            clipAlias: "beat",
            samplePath: "marine-band/stems/Thunderer/drums.wav",
            sampleId: "smp-1",
            clipName: "loop-1",
            clipId: "clp-a",
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
    it("should create a ScoreRef for a kit pad clip", () => {
      const text = `tempo 90
key C
bars 1
clip band = marine-band/Thunderer.mp3
kit drums
  crash = band  hit-3
track drums  steps "crash . . ."`;

      const refs = getCatalogRefs(text, "scores", "test.apr");

      // Mock lookups
      const lookups: Lookups = {
        samplesByPath: new Map([["marine-band/Thunderer.mp3", { id: "smp-2", path: "marine-band/Thunderer.mp3" }]]),
        samplesById: new Map(),
        clipsBySampleAndName: new Map([
          [
            "smp-2",
            new Map([["hit-3", { id: "clp-h", start: 19.8, end: 20.3 }]]),
          ],
        ]),
        clipsById: new Map(),
      };

      const plan = planScoreRefs("score-2", refs, lookups, []);
      assert.deepEqual(plan, {
        create: [
          {
            id: "sref_score-2_band",
            scoreId: "score-2",
            clipAlias: "band",
            samplePath: "marine-band/Thunderer.mp3",
            sampleId: "smp-2",
          },
          {
            id: "sref_score-2_band_drums.crash",
            scoreId: "score-2",
            clipAlias: "band",
            samplePath: "marine-band/Thunderer.mp3",
            sampleId: "smp-2",
            clipName: "hit-3",
            clipId: "clp-h",
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
clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
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
        samplesByPath: new Map([
          ["marine-band/stems/Thunderer/drums.wav", { id: "smp-1", path: "marine-band/stems/Thunderer/drums.wav" }],
          ["marine-band/Thunderer.mp3", { id: "smp-2", path: "marine-band/Thunderer.mp3" }],
        ]),
        samplesById: new Map(),
        clipsBySampleAndName: new Map([
          [
            "smp-1",
            new Map([["loop-1", { id: "clp-a", start: 10, end: 14 }]]),
          ],
        ]),
        clipsById: new Map(),
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
            samplePath: "marine-band/Thunderer.mp3",
            sampleId: "smp-2",
          },
        ],
        update: [],
        delete: ["sref_score-1_beat"],
      });
    });
  });

  describe("Scenario 4: Unresolved reference to missing sample", () => {
    it("should keep unresolved samplePath without sampleId", () => {
      const text = `tempo 90
key C
bars 1
clip x = somewhere/else.wav
track x`;

      const refs = getCatalogRefs(text, "scores", "test.apr");

      // Mock lookups (no sample found)
      const lookups: Lookups = {
        samplesByPath: new Map(),
        samplesById: new Map(),
        clipsBySampleAndName: new Map(),
        clipsById: new Map(),
      };

      const plan = planScoreRefs("score-3", refs, lookups, []);
      assert.deepEqual(plan, {
        create: [
          {
            id: "sref_score-3_x",
            scoreId: "score-3",
            clipAlias: "x",
            samplePath: "somewhere/else.wav",
          },
        ],
        update: [],
        delete: [],
      });
    });
  });

  describe("Scenario 5: @smp_ and @clp_ forms", () => {
    it("should resolve @smp_ and @clp_ references by id", () => {
      const text = `tempo 90
key C
bars 1
clip source = @smp_abc123  @clp_xyz
track source`;

      const refs = getCatalogRefs(text, "scores", "test.apr");

      // Mock lookups
      const lookups: Lookups = {
        samplesByPath: new Map(),
        samplesById: new Map([["smp_abc123", { id: "smp-abc", path: "marine-band/x.wav" }]]),
        clipsBySampleAndName: new Map(),
        clipsById: new Map([["clp_xyz", { id: "clp-xyz", start: 5, end: 10 }]]),
      };

      const plan = planScoreRefs("score-4", refs, lookups, []);
      assert.deepEqual(plan, {
        create: [
          {
            id: "sref_score-4_source",
            scoreId: "score-4",
            clipAlias: "source",
            samplePath: "marine-band/x.wav",
            sampleId: "smp-abc",
            clipId: "clp-xyz",
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
clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
track beat`;

      const refs = getCatalogRefs(text, "scores", "test.apr");

      // Mock lookups
      const lookups: Lookups = {
        samplesByPath: new Map([
          ["marine-band/stems/Thunderer/drums.wav", { id: "smp-1", path: "marine-band/stems/Thunderer/drums.wav" }],
        ]),
        samplesById: new Map(),
        clipsBySampleAndName: new Map([
          [
            "smp-1",
            new Map([["loop-1", { id: "clp-a", start: 10, end: 14 }]]),
          ],
        ]),
        clipsById: new Map(),
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

  describe("Scenario 7: Re-save with different sample", () => {
    it("should update when sample changes from smp-1 to smp-2", () => {
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
        samplesByPath: new Map([
          ["marine-band/old.wav", { id: "smp-1", path: "marine-band/old.wav" }],
          ["marine-band/new.wav", { id: "smp-2", path: "marine-band/new.wav" }],
        ]),
        samplesById: new Map(),
        clipsBySampleAndName: new Map(),
        clipsById: new Map(),
      };

      // First save
      const plan1 = planScoreRefs("score-1", refs1, lookups, []);
      const existing = plan1.create;

      // Second save
      const plan2 = planScoreRefs("score-1", refs2, lookups, existing);

      // Should have one update with the new sampleId and new samplePath, nulling removed fields
      assert.deepEqual(plan2, {
        create: [],
        update: [
          {
            id: "sref_score-1_beat",
            scoreId: "score-1",
            clipAlias: "beat",
            samplePath: "marine-band/new.wav",
            sampleId: "smp-2",
            clipName: null as any,
            clipId: null as any,
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
  describe("Scenario 1: Keeping creates a verdict, a curated clip and a crate item", () => {
    it("should plan verdict create, clip create, and crate item create", async () => {
      const candidateId = "cand-1";
      const candidate = {
        id: candidateId,
        sampleId: "smp-1",
        recordingId: "rec-1",
        start: 10,
        end: 14,
        kind: "loop",
        name: "loop-cand",
      };

      const judge = "alice";
      const clipId = getCuratedClipId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      let newIdCounter = 0;
      const newId = () => `crate-new-${++newIdCounter}`;

      const plan = await planKeep(
        candidateId,
        judge,
        candidate,
        null,
        null,
        new Map(),
        [],
        clipId,
        now,
        newId,
        new Map(),
        getPositionAfter,
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
        clips: {
          create: {
            id: clipId,
            sampleId: "smp-1",
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
    it("should plan no changes if verdict and crates unchanged", async () => {
      const candidateId = "cand-1";
      const candidate = {
        id: candidateId,
        sampleId: "smp-1",
        recordingId: "rec-1",
        start: 10,
        end: 14,
        kind: "loop",
        name: "loop-cand",
      };

      const judge = "alice";
      const clipId = getCuratedClipId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const myVerdict = {
        candidateId,
        judge,
        verdict: "keep",
        stars: 4,
        tags: ["brass"],
        name: "horn-loop",
      };

      const curatedClip = {
        id: clipId,
        sampleId: "smp-1",
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

      const plan = await planKeep(
        candidateId,
        judge,
        candidate,
        myVerdict,
        curatedClip,
        new Map([["digs", { id: crateId, name: "digs" }]]),
        [crateItem],
        clipId,
        now,
        newId,
        new Map([[crateId, null]]),
        getPositionAfter,
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
        clips: {
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
    it("should create crate item at position a4 when last item is at a3", async () => {
      const candidateId = "cand-2";
      const candidate = {
        id: candidateId,
        sampleId: "smp-1",
        recordingId: "rec-1",
        start: 20,
        end: 24,
        kind: "loop",
        name: "loop-cand-2",
      };

      const judge = "alice";
      const clipId = getCuratedClipId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const crateId = "crate-digs";
      let newIdCounter = 0;
      const newId = () => `crate-new-${++newIdCounter}`;

      const plan = await planKeep(
        candidateId,
        judge,
        candidate,
        null,
        null,
        new Map([["digs", { id: crateId, name: "digs" }]]),
        [],
        clipId,
        now,
        newId,
        new Map([[crateId, "a3"]]),
        getPositionAfter,
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
        clips: {
          create: {
            id: clipId,
            sampleId: "smp-1",
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

  describe("Scenario 3b: Crate with existing item at a9 gets next position aA", () => {
    it("should create crate item at position aA when last item is at a9", async () => {
      const candidateId = "cand-2b";
      const candidate = {
        id: candidateId,
        sampleId: "smp-1",
        recordingId: "rec-1",
        start: 20,
        end: 24,
        kind: "loop",
        name: "loop-cand-2b",
      };

      const judge = "alice";
      const clipId = getCuratedClipId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const crateId = "crate-digs";
      let newIdCounter = 0;
      const newId = () => `crate-new-${++newIdCounter}`;

      const plan = await planKeep(
        candidateId,
        judge,
        candidate,
        null,
        null,
        new Map([["digs", { id: crateId, name: "digs" }]]),
        [],
        clipId,
        now,
        newId,
        new Map([[crateId, "a9"]]),
        getPositionAfter,
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
        clips: {
          create: {
            id: clipId,
            sampleId: "smp-1",
            name: "loop-cand-2b",
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
              position: "aA",
            },
          ],
        },
      });
    });
  });

  describe("Scenario 4: Keeping an unknown candidate fails", () => {
    it("should return error when candidate is null", async () => {
      const candidateId = "no-such-candidate";
      const judge = "alice";
      const clipId = getCuratedClipId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const newId = () => "crate-new-1";

      const result = await planKeep(
        candidateId,
        judge,
        null,
        null,
        null,
        new Map(),
        [],
        clipId,
        now,
        newId,
        new Map(),
        getPositionAfter
      );

      assert.deepEqual(result, { errors: [{ errorType: "NotFound" }] });
    });
  });
});

// ============================================================================
// planSkip tests (from keep.feature)
// ============================================================================

describe("planSkip (keep.feature)", () => {
  describe("Scenario 1: Skipping after keeping removes the curated clip", () => {
    it("should plan verdict update to skip and clip delete when no other keeper", () => {
      const candidateId = "cand-1";
      const clipId = getCuratedClipId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const existingCrateItems = [
        { id: "item-1", crateId: "crate-1", candidateId },
      ];

      const allVerdicts = [
        { candidateId, judge: "alice", verdict: "keep" },
      ];

      const plan = planSkip(candidateId, "alice", existingCrateItems, allVerdicts, clipId, now);

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
        clips: {
          delete: [clipId],
        },
        crateItems: {
          delete: ["item-1"],
        },
      });
    });
  });

  describe("Scenario 2: A skip keeps the clip while someone else still keeps it", () => {
    it("should plan verdict update to skip and NOT delete clip if other keeper exists", () => {
      const candidateId = "cand-1";
      const clipId = getCuratedClipId(candidateId);
      const now = "2026-09-24T12:00:00.000Z";

      const existingCrateItems = [
        { id: "item-1", crateId: "crate-1", candidateId },
      ];

      const allVerdicts = [
        { candidateId, judge: "alice", verdict: "keep" },
        { candidateId, judge: "bob", verdict: "keep" },
      ];

      const plan = planSkip(candidateId, "alice", existingCrateItems, allVerdicts, clipId, now);

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
        clips: {
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
  describe("Scenario: Putting off records a verdict and no clip", () => {
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
  describe("Scenario 1: An overlapping proposal keeps the clip's id and name", () => {
    it("should plan clip update with new span", () => {
      const sampleId = "smp-1";

      const existing = [
        { id: "clp-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
      ];

      const proposals = [
        { kind: "loop", start: 10.1, end: 14, rank: 1 },
      ];

      const mergeResult = callMarkupMerge(existing, proposals, [], { loop: 1 });
      const plan = planMerge(sampleId, mergeResult);

      assert.deepEqual(plan, {
        clips: {
          update: [
            { id: "clp-a", start: 10.1, end: 14, rank: 1 },
          ],
          create: [],
          retire: [],
          delete: [],
        },
        sample: {
          update: {
            id: sampleId,
            nameCounters: '{"loop":1}',
          },
        },
      });
    });
  });

  describe("Scenario 2: A new proposal gets a new name", () => {
    it("should plan clip create with new name and sample update with counters", () => {
      const sampleId = "smp-1";

      const existing = [
        { id: "clp-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
      ];

      const proposals = [
        { kind: "loop", start: 10, end: 14, rank: 2 },
        { kind: "loop", start: 30, end: 34, rank: 1 },
      ];

      const mergeResult = callMarkupMerge(existing, proposals, [], { loop: 1 });
      const plan = planMerge(sampleId, mergeResult);

      assert.deepEqual(plan, {
        clips: {
          update: [
            { id: "clp-a", start: 10, end: 14, rank: 2 },
          ],
          create: [
            {
              sampleId,
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
        sample: {
          update: {
            id: sampleId,
            nameCounters: '{"loop":2}',
          },
        },
      });
    });
  });

  describe("Scenario 3: Names are never reused", () => {
    it("should assign loop-3 after creating loop-2", () => {
      const sampleId = "smp-1";

      // After first merge that created loop-2, we have two clips
      const existing = [
        { id: "clp-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
        { id: "clp-b", name: "loop-2", kind: "loop", start: 30, end: 34, source: "ml", retired: false },
      ];

      // Second merge proposes only 50-54, so existing ones are no longer proposed
      const proposals = [
        { kind: "loop", start: 50, end: 54, rank: 1 },
      ];

      const mergeResult = callMarkupMerge(existing, proposals, [], { loop: 2 });
      const plan = planMerge(sampleId, mergeResult);

      assert.deepEqual(plan, {
        clips: {
          update: [],
          create: [
            {
              sampleId,
              name: "loop-3",
              start: 50,
              end: 54,
              source: "ml",
              rank: 1,
            },
          ],
          retire: [],
          delete: ["clp-a", "clp-b"],
        },
        sample: {
          update: {
            id: sampleId,
            nameCounters: '{"loop":3}',
          },
        },
      });
    });
  });

  describe("Scenario 4: A clip no longer proposed and not used by any score is deleted", () => {
    it("should plan clip delete when no proposals and no scores use it", () => {
      const sampleId = "smp-1";

      const existing = [
        { id: "clp-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
      ];

      const proposals = [];

      const mergeResult = callMarkupMerge(existing, proposals, [], { loop: 1 });
      const plan = planMerge(sampleId, mergeResult);

      assert.deepEqual(plan, {
        clips: {
          update: [],
          create: [],
          retire: [],
          delete: ["clp-a"],
        },
        sample: {
          update: {
            id: sampleId,
            nameCounters: '{"loop":1}',
          },
        },
      });
    });
  });

  describe("Scenario 5: A clip a score uses is retired, not deleted", () => {
    it("should plan clip retire when a score references it", () => {
      const sampleId = "smp-1";

      const existing = [
        { id: "clp-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
      ];

      const proposals = [];

      const mergeResult = callMarkupMerge(existing, proposals, ["clp-a"], { loop: 1 });
      const plan = planMerge(sampleId, mergeResult);

      assert.deepEqual(plan, {
        clips: {
          update: [],
          create: [],
          retire: [
            { id: "clp-a", retired: true },
          ],
          delete: [],
        },
        sample: {
          update: {
            id: sampleId,
            nameCounters: '{"loop":1}',
          },
        },
      });
    });
  });

  describe("Scenario 6: Clips made by people are left alone", () => {
    it("should not touch user-source clips during merge", () => {
      const sampleId = "smp-1";

      const existing = [
        { id: "clp-u", name: "mine", kind: "", start: 1, end: 2, source: "user", retired: false },
        { id: "clp-a", name: "loop-1", kind: "loop", start: 10, end: 14, source: "ml", retired: false },
      ];

      const proposals = [];

      const mergeResult = callMarkupMerge(existing, proposals, [], { loop: 1 });
      const plan = planMerge(sampleId, mergeResult);

      assert.deepEqual(plan, {
        clips: {
          update: [],
          create: [],
          retire: [],
          delete: ["clp-a"],
        },
        sample: {
          update: {
            id: sampleId,
            nameCounters: '{"loop":1}',
          },
        },
      });
    });
  });
});
