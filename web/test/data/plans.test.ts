import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planScoreRefs, type CatalogRef, type Lookups, type ScoreRef } from "../../src/data/plans.js";

// Load wasm and get rw_references function
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
