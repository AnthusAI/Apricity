// Pure plan logic for score reference diffing.
// No storage or wasm calls; takes catalog refs and existing refs, produces create/update/delete operations.

/**
 * A catalog reference as returned by rw_references.
 */
export interface CatalogRef {
  idSuffix: string;
  alias: string;
  source: string;
  catalogPath?: string;
  sampleId?: string;
  clipName?: string;
  clipId?: string;
  kitPad?: string;
}

/**
 * A ScoreRef record as stored in the database.
 */
export interface ScoreRef {
  id: string;
  scoreId: string;
  clipAlias: string;
  samplePath?: string;
  sampleId?: string;
  clipName?: string;
  clipId?: string;
  start?: number;
  end?: number;
  owner?: string;
}

/**
 * Lookup maps for resolved samples and clips.
 */
export interface Lookups {
  samplesByPath: Map<string, { id: string; path: string }>;
  samplesById: Map<string, { id: string; path: string }>;
  clipsBySampleAndName: Map<string, Map<string, { id: string; start: number; end: number }>>;
  clipsById: Map<string, { id: string; start: number; end: number }>;
}

/**
 * The plan: which ScoreRefs to create, update, or delete.
 */
export interface ScoreRefPlan {
  create: ScoreRef[];
  update: ScoreRef[];
  delete: string[];
}

/**
 * Plan score references: diff catalog refs against existing refs to determine create/update/delete operations.
 *
 * @param scoreId - The score's id
 * @param refs - Catalog references from rw_references
 * @param lookups - Resolved sample and clip records
 * @param existing - Existing ScoreRef records for this score
 * @returns A plan with create, update, and delete operations
 */
export function planScoreRefs(
  scoreId: string,
  refs: CatalogRef[],
  lookups: Lookups,
  existing: ScoreRef[]
): ScoreRefPlan {
  // Build the new state from catalog refs
  const newRefs = refs.map((ref) => {
    const id = `sref_${scoreId}_${ref.idSuffix}`;

    // Resolve sample: try id first, then path
    let sampleId: string | undefined;
    let samplePath: string | undefined;

    if (ref.sampleId) {
      // Sample id form: @smp_...
      const sample = lookups.samplesById.get(ref.sampleId);
      if (sample) {
        sampleId = sample.id;
        samplePath = sample.path;
      }
    } else if (ref.catalogPath) {
      // Catalog path form
      const sample = lookups.samplesByPath.get(ref.catalogPath);
      if (sample) {
        sampleId = sample.id;
        samplePath = sample.path;
      }
      // Always set samplePath, even if unresolved
      samplePath = samplePath || ref.catalogPath;
    }

    // Resolve clip: try id first, then name
    let clipId: string | undefined;
    let clipName = ref.clipName; // Keep clipName even if unresolved
    let start: number | undefined;
    let end: number | undefined;

    if (ref.clipId) {
      // Clip id form: @clp_...
      const clip = lookups.clipsById.get(ref.clipId);
      if (clip) {
        clipId = clip.id;
        start = clip.start;
        end = clip.end;
      }
    } else if (ref.clipName && sampleId) {
      // Named clip form: resolve by (sampleId, name)
      const sampleClips = lookups.clipsBySampleAndName.get(sampleId);
      if (sampleClips) {
        const clip = sampleClips.get(ref.clipName);
        if (clip) {
          clipId = clip.id;
          start = clip.start;
          end = clip.end;
        }
      }
    }

    // Build the ScoreRef record
    const record: ScoreRef = {
      id,
      scoreId,
      clipAlias: ref.alias,
      samplePath,
    };

    // Add optional fields if present
    if (sampleId) record.sampleId = sampleId;
    if (clipName) record.clipName = clipName;
    if (clipId) record.clipId = clipId;
    if (start !== undefined) record.start = start;
    if (end !== undefined) record.end = end;

    return record;
  });

  // Diff against existing refs
  const newIds = new Set(newRefs.map((r) => r.id));
  const existingIds = new Map(existing.map((r) => [r.id, r]));

  const create: ScoreRef[] = [];
  const update: ScoreRef[] = [];
  const deleteIds: string[] = [];

  // Process new refs
  for (const newRef of newRefs) {
    const oldRef = existingIds.get(newRef.id);
    if (!oldRef) {
      create.push(newRef);
    } else {
      // Check if anything changed; if so, update with all fields (nulling out removed ones)
      const changed = hasScoreRefChanged(oldRef, newRef);
      if (changed) {
        // Update with all fields, nulling out fields that are now absent
        const updateRecord: ScoreRef = {
          id: newRef.id,
          scoreId: newRef.scoreId,
          clipAlias: newRef.clipAlias,
          samplePath: newRef.samplePath,
        };
        if (newRef.sampleId) updateRecord.sampleId = newRef.sampleId;
        else updateRecord.sampleId = null as any;
        if (newRef.clipName) updateRecord.clipName = newRef.clipName;
        else updateRecord.clipName = null as any;
        if (newRef.clipId) updateRecord.clipId = newRef.clipId;
        else updateRecord.clipId = null as any;
        if (newRef.start !== undefined) updateRecord.start = newRef.start;
        else updateRecord.start = null as any;
        if (newRef.end !== undefined) updateRecord.end = newRef.end;
        else updateRecord.end = null as any;
        update.push(updateRecord);
      }
    }
  }

  // Delete old refs that are gone
  for (const [id, oldRef] of existingIds) {
    if (!newIds.has(id)) {
      deleteIds.push(id);
    }
  }

  return {
    create,
    update,
    delete: deleteIds,
  };
}

/**
 * Check if a ScoreRef has changed.
 */
function hasScoreRefChanged(oldRef: ScoreRef, newRef: ScoreRef): boolean {
  if (oldRef.clipAlias !== newRef.clipAlias) return true;
  if ((oldRef.samplePath ?? null) !== (newRef.samplePath ?? null)) return true;
  if ((oldRef.sampleId ?? null) !== (newRef.sampleId ?? null)) return true;
  if ((oldRef.clipName ?? null) !== (newRef.clipName ?? null)) return true;
  if ((oldRef.clipId ?? null) !== (newRef.clipId ?? null)) return true;
  if ((oldRef.start ?? null) !== (newRef.start ?? null)) return true;
  if ((oldRef.end ?? null) !== (newRef.end ?? null)) return true;
  return false;
}

// ============================================================================
// Curation domain plan functions
// ============================================================================

export interface KeepPlan {
  verdicts: { create: any; update?: any };
  clips: { create?: any; update?: any };
  crates: { create: any[] };
  crateItems: { create: any[] };
}

export interface SkipPlan {
  verdicts: { update: any };
  clips: { delete: string[] };
  crateItems: { delete: string[] };
}

export interface PutOffPlan {
  verdicts: { create: any; update?: any };
}

export interface MergePlan {
  clips: {
    update: any[];
    create: any[];
    retire: any[];
    delete: string[];
  };
  sample: { update?: any };
}

/**
 * Plan keeping a candidate: upsert Verdict, create/update curated Clip, create CrateItems and Crates.
 * Returns an error if candidate is null.
 *
 * @param candidateId - The candidate's id
 * @param judge - The current user's sub
 * @param candidate - The candidate record (or null)
 * @param myVerdict - Existing verdict from the judge, or null
 * @param curatedClip - Existing curated clip, or null
 * @param cratesByName - Map of crate name to Crate record
 * @param existingCrateItems - Existing CrateItems for this candidate
 * @param clipId - The curated clip id (from rw_ids)
 * @param options - Keep options (stars, tags, name, crates)
 * @returns A plan with create/update for Verdict, Clip, Crates, CrateItems, or error if candidate is null
 */
export async function planKeep(
  candidateId: string,
  judge: string,
  candidate: any,
  myVerdict: any | null,
  curatedClip: any | null,
  cratesByName: Map<string, any>,
  existingCrateItems: any[],
  clipId: string,
  now: string,
  newId: () => string,
  lastPositionByCrate: Map<string, string | null>,
  positionAfter: (last: string | null) => string | Promise<string>,
  options?: { stars?: number; tags?: string[]; name?: string; crates?: string[] }
): Promise<KeepPlan | { errors: Array<{ errorType: string }> }> {
  // Handle null candidate
  if (!candidate) {
    return { errors: [{ errorType: "NotFound" }] };
  }

  const timestamp = now;

  // Verdict: create or update
  const verdictRecord = {
    candidateId,
    judge,
    verdict: "keep",
    stars: options?.stars,
    tags: options?.tags,
    name: options?.name,
    judgedAt: timestamp,
    by: "person",
  };

  // Clip: create if missing, update if exists
  let clipToCreate: any | undefined;
  let clipToUpdate: any | undefined;

  if (!curatedClip) {
    clipToCreate = {
      id: clipId,
      sampleId: candidate.sampleId,
      name: options?.name || candidate.name || "curated",
      start: candidate.start,
      end: candidate.end,
      source: "curated",
      candidateId,
      kind: candidate.kind,
    };
  } else {
    // Clip exists; update its name if provided
    if (options?.name && options.name !== curatedClip.name) {
      clipToUpdate = {
        id: clipId,
        name: options.name,
      };
    }
  }

  // Crates and CrateItems
  const cratesToCreate: any[] = [];
  const crateItemsToCreate: any[] = [];

  if (options?.crates && options.crates.length > 0) {
    for (const crateName of options.crates) {
      const crateRecord = cratesByName.get(crateName);
      let crateId: string;

      if (crateRecord) {
        crateId = crateRecord.id;
      } else {
        // Create new crate with deterministic ID
        crateId = newId();
        cratesToCreate.push({
          id: crateId,
          name: crateName,
        });
      }

      // Check if CrateItem already exists
      const existingItem = existingCrateItems.find((item: any) => item.crateId === crateId);
      if (!existingItem) {
        // Calculate position using fractional indexing
        const lastPosition = lastPositionByCrate.get(crateId);
        const position = await positionAfter(lastPosition || null);

        crateItemsToCreate.push({
          crateId,
          candidateId,
          position,
        });
      }
    }
  }

  return {
    verdicts: {
      create: !myVerdict ? verdictRecord : undefined,
      update: myVerdict ? verdictRecord : undefined,
    },
    clips: {
      create: clipToCreate,
      update: clipToUpdate,
    },
    crates: {
      create: cratesToCreate,
    },
    crateItems: {
      create: crateItemsToCreate,
    },
  };
}

/**
 * Plan skipping a candidate: update Verdict, delete Clip if no other keeper, delete CrateItems.
 *
 * @param candidateId - The candidate's id
 * @param judge - The current user's sub
 * @param existingCrateItems - Existing CrateItems for this candidate
 * @param existingVerdicts - All existing verdicts for this candidate (to check for other keepers)
 * @param clipId - The curated clip id
 * @returns A plan with Verdict update, Clip delete, CrateItem deletes
 */
export function planSkip(
  candidateId: string,
  judge: string,
  existingCrateItems: any[],
  existingVerdicts: any[],
  clipId: string,
  now: string
): SkipPlan {
  const timestamp = now;

  // Verdict: update to skip
  const verdictRecord = {
    candidateId,
    judge,
    verdict: "skip",
    judgedAt: timestamp,
    by: "person",
  };

  // Check if any other judge has a keep verdict
  const hasOtherKeeper = existingVerdicts.some(
    (v: any) => v.judge !== judge && v.verdict === "keep"
  );

  // Clip: delete if no other keeper
  const clipsToDelete = hasOtherKeeper ? [] : [clipId];

  // CrateItems: delete all for this candidate
  const crateItemIdsToDelete = existingCrateItems.map((item: any) => item.id);

  return {
    verdicts: {
      update: verdictRecord,
    },
    clips: {
      delete: clipsToDelete,
    },
    crateItems: {
      delete: crateItemIdsToDelete,
    },
  };
}

/**
 * Plan putting off a candidate: create/update Verdict with verdict="later".
 *
 * @param candidateId - The candidate's id
 * @param judge - The current user's sub
 * @param myVerdict - Existing verdict from the judge, or null
 * @returns A plan with Verdict create or update
 */
export function planPutOff(
  candidateId: string,
  judge: string,
  myVerdict: any | null,
  now: string
): PutOffPlan {
  const timestamp = now;

  const verdictRecord = {
    candidateId,
    judge,
    verdict: "later",
    judgedAt: timestamp,
    by: "person",
  };

  return {
    verdicts: {
      create: !myVerdict ? verdictRecord : undefined,
      update: myVerdict ? verdictRecord : undefined,
    },
  };
}

/**
 * Plan merging markup: match proposed ML clips to existing, handle retirement.
 * Wraps rw_markup_merge output into Clip writes and Sample nameCounters update.
 *
 * @param sampleId - The sample's id
 * @param mergeResult - Output from rw_markup_merge with {keep, create, retire, delete, name_counters}
 * @returns A plan with Clip create/update/retire/delete and Sample update
 */
export function planMerge(
  sampleId: string,
  mergeResult: any
): MergePlan {
  // Extract the plan from wasm output
  const keep = mergeResult.keep || [];
  const create = mergeResult.create || [];
  const retire = mergeResult.retire || [];
  const deleteIds = mergeResult.delete || [];
  const nameCounters = mergeResult.name_counters || {};

  // Build Clip updates for kept clips
  const clipUpdates = keep.map(([id, [start, end], rank]: [string, [number, number], number | null]) => ({
    id,
    start,
    end,
    ...(rank !== null && rank !== undefined && { rank }),
  }));

  // Build Clip creates for new clips
  const clipCreates = create.map(([name, start, end, rank]: [string, number, number, number | null]) => ({
    sampleId,
    name,
    start,
    end,
    source: "ml",
    ...(rank !== null && rank !== undefined && { rank }),
  }));

  // Build Clip retires (set retired: true)
  const clipRetires = retire.map((id: string) => ({
    id,
    retired: true,
  }));

  // Build Sample update for nameCounters
  const sampleUpdate = Object.keys(nameCounters).length > 0
    ? {
        id: sampleId,
        nameCounters: JSON.stringify(nameCounters),
      }
    : undefined;

  return {
    clips: {
      update: clipUpdates,
      create: clipCreates,
      retire: clipRetires,
      delete: deleteIds,
    },
    sample: {
      update: sampleUpdate,
    },
  };
}
