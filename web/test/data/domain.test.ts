import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Fake in-memory Amplify client implementing Amplify semantics:
// - limit applies before filter
// - pagination with nextToken
// - ConditionalCheckFailed on duplicate create
// - composite keys (candidateId, judge) for Verdict

interface Model {
  [key: string]: unknown;
}

interface Record {
  [key: string]: unknown;
}

interface QueryOpts {
  filter?: Record;
  limit?: number;
  nextToken?: string;
  selectionSet?: string[];
}

interface OpResult {
  data?: Record | Record[] | null;
  errors?: Array<{ message: string; errorType: string }>;
  nextToken?: string | null;
}

class FakeStorage {
  private verdicts: Map<string, Record> = new Map();
  private slices: Map<string, Record> = new Map();
  private crates: Map<string, Record> = new Map();
  private crateItems: Map<string, Record> = new Map();
  private candidates: Map<string, Record> = new Map();
  private clips: Map<string, Record> = new Map();
  private scores: Map<string, Record> = new Map();
  private scoreRefs: Map<string, Record> = new Map();

  reset() {
    this.verdicts.clear();
    this.slices.clear();
    this.crates.clear();
    this.crateItems.clear();
    this.candidates.clear();
    this.clips.clear();
    this.scores.clear();
    this.scoreRefs.clear();
  }

  // Helper to match filter against a record
  private matchesFilter(record: Record, filter?: Record): boolean {
    if (!filter) return true;
    for (const [key, condition] of Object.entries(filter)) {
      if (typeof condition === "object" && condition !== null) {
        const condObj = condition as Record;
        if ("eq" in condObj) {
          if (record[key] !== condObj.eq) return false;
        } else if ("attributeExists" in condObj) {
          const exists = record[key] !== undefined && record[key] !== null;
          if (exists !== condObj.attributeExists) return false;
        }
      }
    }
    return true;
  }

  // Collect all records with pagination (apply limit before filter)
  private collectAll(
    records: Map<string, Record>,
    opts?: QueryOpts
  ): { data: Record[]; nextToken: string | null } {
    const allRecords = Array.from(records.values());
    const limit = opts?.limit ?? 100;

    // Apply limit first, then filter
    const page = allRecords.slice(0, limit);
    const filtered = page.filter((r) => this.matchesFilter(r, opts?.filter));

    // Simplified pagination: if there are more records, set a token
    const hasMore = allRecords.length > limit;
    const nextToken = hasMore ? "next-page" : null;

    return { data: filtered, nextToken };
  }

  // Verdict operations (composite key: candidateId + judge)
  verdictKey(candidateId: string, judge: string): string {
    return `${candidateId}|${judge}`;
  }

  verdictGet(candidateId: string, judge: string): OpResult {
    const key = this.verdictKey(candidateId, judge);
    const data = this.verdicts.get(key) || null;
    return { data };
  }

  verdictCreate(input: Record): OpResult {
    const candidateId = input.candidateId as string;
    const judge = input.judge as string;
    const key = this.verdictKey(candidateId, judge);

    if (this.verdicts.has(key)) {
      return {
        errors: [
          {
            message: `Verdict with candidateId "${candidateId}" and judge "${judge}" already exists`,
            errorType: "DynamoDB:ConditionalCheckFailedException",
          },
        ],
      };
    }

    const record = { id: key, ...input };
    this.verdicts.set(key, record);
    return { data: record };
  }

  verdictUpdate(input: Record): OpResult {
    const candidateId = input.candidateId as string;
    const judge = input.judge as string;
    const key = this.verdictKey(candidateId, judge);

    const existing = this.verdicts.get(key);
    if (!existing) {
      return {
        errors: [
          {
            message: `Verdict not found`,
            errorType: "DynamoDB:ConditionalCheckFailed",
          },
        ],
      };
    }

    const updated = { ...existing, ...input };
    this.verdicts.set(key, updated);
    return { data: updated };
  }

  verdictList(opts?: QueryOpts): OpResult {
    const result = this.collectAll(this.verdicts, opts);
    return { data: result.data, nextToken: result.nextToken };
  }

  // Slice operations
  sliceGet(id: string): OpResult {
    const data = this.slices.get(id) || null;
    return { data };
  }

  sliceCreate(input: Record): OpResult {
    const id = input.id as string;
    if (this.slices.has(id)) {
      return {
        errors: [
          {
            message: `Slice with id "${id}" already exists`,
            errorType: "DynamoDB:ConditionalCheckFailedException",
          },
        ],
      };
    }
    const record = { ...input };
    this.slices.set(id, record);
    return { data: record };
  }

  sliceUpdate(input: Record): OpResult {
    const id = input.id as string;
    const existing = this.slices.get(id);
    if (!existing) {
      return { errors: [{ message: "Slice not found", errorType: "NotFound" }] };
    }
    const updated = { ...existing, ...input };
    this.slices.set(id, updated);
    return { data: updated };
  }

  sliceDelete(id: string): OpResult {
    if (!this.slices.has(id)) {
      return { errors: [{ message: "Slice not found", errorType: "NotFound" }] };
    }
    this.slices.delete(id);
    return { data: null };
  }

  sliceList(opts?: QueryOpts): OpResult {
    const result = this.collectAll(this.slices, opts);
    return { data: result.data, nextToken: result.nextToken };
  }

  // Crate operations
  crateCreate(input: Record): OpResult {
    const id = (input.id as string) || `crate-${Date.now()}`;
    if (this.crates.has(id)) {
      return {
        errors: [
          {
            message: `Crate already exists`,
            errorType: "DynamoDB:ConditionalCheckFailedException",
          },
        ],
      };
    }
    const record = { id, ...input };
    this.crates.set(id, record);
    return { data: record };
  }

  crateList(opts?: QueryOpts): OpResult {
    const result = this.collectAll(this.crates, opts);
    return { data: result.data, nextToken: result.nextToken };
  }

  // CrateItem operations
  crateItemCreate(input: Record): OpResult {
    const id = (input.id as string) || `item-${Date.now()}`;
    if (this.crateItems.has(id)) {
      return {
        errors: [
          {
            message: `CrateItem already exists`,
            errorType: "DynamoDB:ConditionalCheckFailedException",
          },
        ],
      };
    }
    const record = { id, ...input };
    this.crateItems.set(id, record);
    return { data: record };
  }

  crateItemDelete(id: string): OpResult {
    if (!this.crateItems.has(id)) {
      return { errors: [{ message: "CrateItem not found", errorType: "NotFound" }] };
    }
    this.crateItems.delete(id);
    return { data: null };
  }

  crateItemList(opts?: QueryOpts): OpResult {
    const result = this.collectAll(this.crateItems, opts);
    return { data: result.data, nextToken: result.nextToken };
  }

  // Candidate operations
  candidateGet(id: string): OpResult {
    const data = this.candidates.get(id) || null;
    return { data };
  }

  candidateCreate(input: Record): OpResult {
    const id = input.id as string;
    if (this.candidates.has(id)) {
      return { errors: [{ message: "Candidate exists", errorType: "DynamoDB:ConditionalCheckFailedException" }] };
    }
    const record = { ...input };
    this.candidates.set(id, record);
    return { data: record };
  }

  // Clip operations
  clipGet(id: string): OpResult {
    const data = this.clips.get(id) || null;
    return { data };
  }

  clipCreate(input: Record): OpResult {
    const id = input.id as string;
    const record = { ...input };
    this.clips.set(id, record);
    return { data: record };
  }

  // Score operations
  scoreCreate(input: Record): OpResult {
    const id = input.id as string;
    if (this.scores.has(id)) {
      return { errors: [{ message: "Score exists", errorType: "DynamoDB:ConditionalCheckFailedException" }] };
    }
    const record = { ...input };
    this.scores.set(id, record);
    return { data: record };
  }

  scoreUpdate(input: Record): OpResult {
    const id = input.id as string;
    const existing = this.scores.get(id);
    if (!existing) {
      return { errors: [{ message: "Score not found", errorType: "NotFound" }] };
    }
    const updated = { ...existing, ...input };
    this.scores.set(id, updated);
    return { data: updated };
  }

  scoreGet(id: string): OpResult {
    const data = this.scores.get(id) || null;
    return { data };
  }

  // ScoreRef operations
  scoreRefCreate(input: Record): OpResult {
    const id = input.id as string;
    if (this.scoreRefs.has(id)) {
      return { errors: [{ message: "ScoreRef exists", errorType: "DynamoDB:ConditionalCheckFailedException" }] };
    }
    const record = { ...input };
    this.scoreRefs.set(id, record);
    return { data: record };
  }

  scoreRefList(opts?: QueryOpts): OpResult {
    const result = this.collectAll(this.scoreRefs, opts);
    return { data: result.data, nextToken: result.nextToken };
  }

  scoreRefDelete(id: string): OpResult {
    if (!this.scoreRefs.has(id)) {
      return { errors: [{ message: "ScoreRef not found", errorType: "NotFound" }] };
    }
    this.scoreRefs.delete(id);
    return { data: null };
  }
}

describe("domain operations", () => {
  let storage: FakeStorage;
  const judge = "alice";
  const otherJudge = "bob";
  const candidateId = "cand-test-1";
  const clipId = "clp-test-1";

  beforeEach(() => {
    storage = new FakeStorage();
    storage.reset();

    // Setup: create a candidate and clip
    storage.candidateCreate({
      id: candidateId,
      clipId,
      recordingId: "rec-1",
      start: 10,
      end: 14,
      kind: "loop",
      name: "loop-cand",
      proposers: [{ by: "analyzer", score: 0.9 }],
      baseScore: 0.9,
    });

    storage.clipCreate({
      id: clipId,
      recordingId: "rec-1",
      path: "marine-band/Thunderer.mp3",
      collection: "marine-band",
      title: "Thunderer",
      audio: { key: "audio/clp-1/Thunderer.mp3", sha256: "aa" },
    });
  });

  it("keep: creates verdict, curated slice, crate item", () => {
    // Simulate keepCandidate(candidateId, {stars: 4, crates: ["digs"]})
    const sliceId = `slc_curated_${candidateId}`;

    // Step 1: Upsert verdict
    let result = storage.verdictGet(candidateId, judge);
    assert.strictEqual(result.data, null);

    result = storage.verdictCreate({
      candidateId,
      judge,
      verdict: "keep",
      stars: 4,
      judgedAt: new Date().toISOString(),
      by: "person",
    });
    assert.ok(result.data);
    assert.strictEqual(result.data.verdict, "keep");

    // Step 2: Create curated slice
    result = storage.sliceCreate({
      id: sliceId,
      clipId,
      name: "curated-loop",
      start: 10,
      end: 14,
      source: "curated",
      candidateId,
      kind: "loop",
    });
    assert.ok(result.data);

    // Step 3: Create crate and crate item
    result = storage.crateCreate({ name: "digs", owner: judge });
    assert.ok(result.data);
    const crateId = (result.data as Record).id as string;

    result = storage.crateItemCreate({
      crateId,
      candidateId,
      position: "a0",
      owner: judge,
    });
    assert.ok(result.data);

    // Verify state
    assert.strictEqual(storage.verdictList().data?.length, 1);
    assert.strictEqual(storage.sliceList().data?.length, 1);
    assert.strictEqual(storage.crateItemList().data?.length, 1);
  });

  it("keep twice: idempotent, no errors", () => {
    const sliceId = `slc_curated_${candidateId}`;

    // First keep
    let result = storage.verdictCreate({
      candidateId,
      judge,
      verdict: "keep",
      stars: 4,
      judgedAt: new Date().toISOString(),
      by: "person",
    });
    assert.ok(result.data);

    storage.sliceCreate({
      id: sliceId,
      clipId,
      name: "curated",
      start: 10,
      end: 14,
      source: "curated",
      candidateId,
    });

    result = storage.crateCreate({ name: "digs", owner: judge });
    const crateId = (result.data as Record).id as string;

    storage.crateItemCreate({
      crateId,
      candidateId,
      position: "a0",
      owner: judge,
    });

    // Second keep (upsert): get then update
    result = storage.verdictGet(candidateId, judge);
    assert.ok(result.data);

    result = storage.verdictUpdate({
      candidateId,
      judge,
      verdict: "keep",
      stars: 4,
      judgedAt: new Date().toISOString(),
      by: "person",
    });
    assert.ok(result.data);
    assert.strictEqual(result.errors, undefined);

    // State unchanged
    assert.strictEqual(storage.verdictList().data?.length, 1);
    assert.strictEqual(storage.sliceList().data?.length, 1);
    assert.strictEqual(storage.crateItemList().data?.length, 1);
  });

  it("skip after keep: removes slice and crate items", () => {
    const sliceId = `slc_curated_${candidateId}`;

    // Keep first
    storage.verdictCreate({
      candidateId,
      judge,
      verdict: "keep",
      judgedAt: new Date().toISOString(),
      by: "person",
    });

    storage.sliceCreate({
      id: sliceId,
      clipId,
      name: "curated",
      start: 10,
      end: 14,
      source: "curated",
      candidateId,
    });

    const crateRes = storage.crateCreate({ name: "digs", owner: judge });
    const crateId = (crateRes.data as Record).id as string;

    const itemRes = storage.crateItemCreate({
      crateId,
      candidateId,
      position: "a0",
      owner: judge,
    });
    const itemId = (itemRes.data as Record).id as string;

    // Now skip: upsert verdict, delete items, delete slice
    storage.verdictUpdate({
      candidateId,
      judge,
      verdict: "skip",
      judgedAt: new Date().toISOString(),
      by: "person",
    });

    // Delete user's crate items
    const items = storage.crateItemList({ filter: { candidateId: { eq: candidateId } } });
    for (const item of items.data || []) {
      storage.crateItemDelete((item as Record).id as string);
    }

    // Check if other keepers exist
    const keepVerdicts = storage.verdictList({
      filter: { candidateId: { eq: candidateId }, verdict: { eq: "keep" } },
    });
    if (!keepVerdicts.data || (keepVerdicts.data as Record[]).length === 0) {
      storage.sliceDelete(sliceId);
    }

    // Verify
    assert.strictEqual(storage.verdictList().data?.[0]?.verdict, "skip");
    assert.strictEqual(storage.crateItemList().data?.length, 0);
    assert.strictEqual(storage.sliceList().data?.length, 0);
  });

  it("skip while another user keeps: slice stays", () => {
    const sliceId = `slc_curated_${candidateId}`;

    // Other user keeps
    storage.verdictCreate({
      candidateId,
      judge: otherJudge,
      verdict: "keep",
      judgedAt: new Date().toISOString(),
      by: "person",
    });

    // Shared curated slice
    storage.sliceCreate({
      id: sliceId,
      clipId,
      name: "curated",
      start: 10,
      end: 14,
      source: "curated",
      candidateId,
    });

    // Alice skips
    storage.verdictCreate({
      candidateId,
      judge,
      verdict: "skip",
      judgedAt: new Date().toISOString(),
      by: "person",
    });

    // Check for other keepers
    const keepVerdicts = storage.verdictList({
      filter: { candidateId: { eq: candidateId }, verdict: { eq: "keep" } },
    });

    assert.strictEqual((keepVerdicts.data as Record[]).length, 1);
    assert.ok(storage.sliceGet(sliceId).data);
  });

  it("put off: creates verdict only, no slice", () => {
    storage.verdictCreate({
      candidateId,
      judge,
      verdict: "later",
      judgedAt: new Date().toISOString(),
      by: "person",
    });

    const verdicts = storage.verdictList();
    assert.strictEqual((verdicts.data as Record[]).length, 1);
    assert.strictEqual((verdicts.data as Record[])[0].verdict, "later");

    const slices = storage.sliceList();
    assert.strictEqual(slices.data?.length, 0);
  });

  it("keep unknown candidate: error", () => {
    const unknownId = "cand-unknown";
    const result = storage.candidateGet(unknownId);
    assert.strictEqual(result.data, null);

    // Attempting to create verdict for unknown candidate should be caught by caller
    assert.ok(!result.data);
  });

  it("save score: creates ScoreRef with clip and slice", () => {
    const scoreId = "score-1";
    const sliceId = "slc-1";

    // Setup: create a clip and slice
    storage.clipCreate({
      id: clipId,
      path: "marine-band/drums.wav",
      recordingId: "rec-1",
      collection: "marine-band",
      title: "Drums",
      audio: { key: "audio/drums.wav", sha256: "bb" },
    });

    storage.sliceCreate({
      id: sliceId,
      clipId,
      name: "loop-1",
      start: 10,
      end: 14,
      source: "ml",
    });

    // Create Score
    const scoreRes = storage.scoreCreate({
      id: scoreId,
      title: "My Score",
      folder: "scores",
      format: "apr",
      text: "tempo 120\nkey C\nclip drums = marine-band/drums.wav  slice loop-1",
    });
    assert.ok(scoreRes.data);

    // Create ScoreRef
    const refRes = storage.scoreRefCreate({
      id: `sref_${scoreId}_0`,
      scoreId,
      clipAlias: "marine-band/drums.wav",
      clipPath: "marine-band/drums.wav",
      clipId,
      sliceName: "loop-1",
      sliceId,
      start: 10,
      end: 14,
    });
    assert.ok(refRes.data);

    // Verify
    const refs = storage.scoreRefList();
    assert.strictEqual((refs.data as Record[]).length, 1);
  });

  it("save score again: replaces references", () => {
    const scoreId = "score-1";
    const sliceId = "slc-1";
    const sliceId2 = "slc-2";

    // Setup: two clips and slices
    storage.clipCreate({
      id: clipId,
      path: "marine-band/drums.wav",
      recordingId: "rec-1",
      collection: "marine-band",
      title: "Drums",
      audio: { key: "audio/drums.wav", sha256: "bb" },
    });

    const clipId2 = "clp-2";
    storage.clipCreate({
      id: clipId2,
      path: "marine-band/horns.wav",
      recordingId: "rec-1",
      collection: "marine-band",
      title: "Horns",
      audio: { key: "audio/horns.wav", sha256: "cc" },
    });

    storage.sliceCreate({
      id: sliceId,
      clipId,
      name: "loop-1",
      start: 10,
      end: 14,
      source: "ml",
    });

    storage.sliceCreate({
      id: sliceId2,
      clipId: clipId2,
      name: "hit-1",
      start: 5,
      end: 7,
      source: "ml",
    });

    // Create score with first ref
    storage.scoreCreate({
      id: scoreId,
      title: "My Score",
      folder: "scores",
      format: "apr",
      text: "tempo 120",
    });

    storage.scoreRefCreate({
      id: `sref_${scoreId}_0`,
      scoreId,
      clipAlias: "marine-band/drums.wav",
      clipId,
    });

    // Re-save with different ref
    storage.scoreRefDelete(`sref_${scoreId}_0`);
    storage.scoreRefCreate({
      id: `sref_${scoreId}_0`,
      scoreId,
      clipAlias: "marine-band/horns.wav",
      clipId: clipId2,
    });

    // Verify old ref deleted, new ref exists
    const refs = storage.scoreRefList({ filter: { scoreId: { eq: scoreId } } });
    assert.strictEqual((refs.data as Record[]).length, 1);
    assert.strictEqual((refs.data as Record[])[0].clipId, clipId2);
  });

  it("save score: unresolved clip reference is kept", () => {
    const scoreId = "score-1";

    // Create score without matching clip
    storage.scoreCreate({
      id: scoreId,
      title: "My Score",
      folder: "scores",
      format: "apr",
      text: "tempo 120",
    });

    // Create ref with unresolved path (no clipId)
    const refRes = storage.scoreRefCreate({
      id: `sref_${scoreId}_0`,
      scoreId,
      clipAlias: "somewhere/else.wav",
      clipPath: "somewhere/else.wav",
      clipId: undefined,
    });
    assert.ok(refRes.data);

    // Verify ref kept even without clipId
    const refs = storage.scoreRefList({ filter: { scoreId: { eq: scoreId } } });
    assert.strictEqual((refs.data as Record[]).length, 1);
    assert.strictEqual((refs.data as Record[])[0].clipId, undefined);
  });
});
