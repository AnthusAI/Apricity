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
  clipId?: string;
  sliceName?: string;
  sliceId?: string;
  kitPad?: string;
}

/**
 * A ScoreRef record as stored in the database.
 */
export interface ScoreRef {
  id: string;
  scoreId: string;
  clipAlias: string;
  clipPath?: string;
  clipId?: string;
  sliceName?: string;
  sliceId?: string;
  start?: number;
  end?: number;
  owner?: string;
}

/**
 * Lookup maps for resolved clips and slices.
 */
export interface Lookups {
  clipsByPath: Map<string, { id: string; path: string }>;
  clipsById: Map<string, { id: string; path: string }>;
  slicesByClipAndName: Map<string, Map<string, { id: string; start: number; end: number }>>;
  slicesById: Map<string, { id: string; start: number; end: number }>;
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
 * @param lookups - Resolved clip and slice records
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

    // Resolve clip: try id first, then path
    let clipId: string | undefined;
    let clipPath: string | undefined;

    if (ref.clipId) {
      // Clip id form: @clp_...
      const clip = lookups.clipsById.get(ref.clipId);
      if (clip) {
        clipId = clip.id;
        clipPath = clip.path;
      }
    } else if (ref.catalogPath) {
      // Catalog path form
      const clip = lookups.clipsByPath.get(ref.catalogPath);
      if (clip) {
        clipId = clip.id;
        clipPath = clip.path;
      }
      // Always set clipPath, even if unresolved
      clipPath = clipPath || ref.catalogPath;
    }

    // Resolve slice: try id first, then name
    let sliceId: string | undefined;
    let sliceName = ref.sliceName; // Keep sliceName even if unresolved
    let start: number | undefined;
    let end: number | undefined;

    if (ref.sliceId) {
      // Slice id form: @slc_...
      const slice = lookups.slicesById.get(ref.sliceId);
      if (slice) {
        sliceId = slice.id;
        start = slice.start;
        end = slice.end;
      }
    } else if (ref.sliceName && clipId) {
      // Named slice form: resolve by (clipId, name)
      const clipSlices = lookups.slicesByClipAndName.get(clipId);
      if (clipSlices) {
        const slice = clipSlices.get(ref.sliceName);
        if (slice) {
          sliceId = slice.id;
          start = slice.start;
          end = slice.end;
        }
      }
    }

    // Build the ScoreRef record
    const record: ScoreRef = {
      id,
      scoreId,
      clipAlias: ref.alias,
      clipPath,
    };

    // Add optional fields if present
    if (clipId) record.clipId = clipId;
    if (sliceName) record.sliceName = sliceName;
    if (sliceId) record.sliceId = sliceId;
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
          clipPath: newRef.clipPath,
        };
        if (newRef.clipId) updateRecord.clipId = newRef.clipId;
        else updateRecord.clipId = null as any;
        if (newRef.sliceName) updateRecord.sliceName = newRef.sliceName;
        else updateRecord.sliceName = null as any;
        if (newRef.sliceId) updateRecord.sliceId = newRef.sliceId;
        else updateRecord.sliceId = null as any;
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
  if ((oldRef.clipPath ?? null) !== (newRef.clipPath ?? null)) return true;
  if ((oldRef.clipId ?? null) !== (newRef.clipId ?? null)) return true;
  if ((oldRef.sliceName ?? null) !== (newRef.sliceName ?? null)) return true;
  if ((oldRef.sliceId ?? null) !== (newRef.sliceId ?? null)) return true;
  if ((oldRef.start ?? null) !== (newRef.start ?? null)) return true;
  if ((oldRef.end ?? null) !== (newRef.end ?? null)) return true;
  return false;
}

// ============================================================================
// Curation domain plan functions
// ============================================================================

export interface KeepPlan {
  verdicts: { create: any; update?: any };
  slices: { create?: any; update?: any };
  crates: { create: any[] };
  crateItems: { create: any[] };
}

export interface SkipPlan {
  verdicts: { update: any };
  slices: { delete: string[] };
  crateItems: { delete: string[] };
}

export interface PutOffPlan {
  verdicts: { create: any; update?: any };
}

export interface MergePlan {
  slices: {
    update: any[];
    create: any[];
    retire: any[];
    delete: string[];
  };
  clip: { update?: any };
}

/**
 * Plan keeping a candidate: upsert Verdict, create/update curated Slice, create CrateItems and Crates.
 * Returns an error if candidate is null.
 *
 * @param candidateId - The candidate's id
 * @param judge - The current user's sub
 * @param candidate - The candidate record (or null)
 * @param myVerdict - Existing verdict from the judge, or null
 * @param curatedSlice - Existing curated slice, or null
 * @param cratesByName - Map of crate name to Crate record
 * @param existingCrateItems - Existing CrateItems for this candidate
 * @param sliceId - The curated slice id (from rw_ids)
 * @param options - Keep options (stars, tags, name, crates)
 * @returns A plan with create/update for Verdict, Slice, Crates, CrateItems, or error if candidate is null
 */
export function planKeep(
  candidateId: string,
  judge: string,
  candidate: any,
  myVerdict: any | null,
  curatedSlice: any | null,
  cratesByName: Map<string, any>,
  existingCrateItems: any[],
  sliceId: string,
  now: string,
  newId: () => string,
  lastPositionByCrate: Map<string, string | null>,
  options?: { stars?: number; tags?: string[]; name?: string; crates?: string[] }
): KeepPlan | { errors: Array<{ errorType: string }> } {
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

  // Slice: create if missing, update if exists
  let sliceToCreate: any | undefined;
  let sliceToUpdate: any | undefined;

  if (!curatedSlice) {
    sliceToCreate = {
      id: sliceId,
      clipId: candidate.clipId,
      name: options?.name || candidate.name || "curated",
      start: candidate.start,
      end: candidate.end,
      source: "curated",
      candidateId,
      kind: candidate.kind,
    };
  } else {
    // Slice exists; update its name if provided
    if (options?.name && options.name !== curatedSlice.name) {
      sliceToUpdate = {
        id: sliceId,
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
        // Calculate position: "a0" if no last item, otherwise increment from "aN"
        const lastPosition = lastPositionByCrate.get(crateId);
        let position = "a0";
        if (lastPosition) {
          const match = lastPosition.match(/^a(\d+)$/);
          if (match) {
            const num = parseInt(match[1], 10) + 1;
            position = `a${num}`;
          }
        }

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
    slices: {
      create: sliceToCreate,
      update: sliceToUpdate,
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
 * Plan skipping a candidate: update Verdict, delete Slice if no other keeper, delete CrateItems.
 *
 * @param candidateId - The candidate's id
 * @param judge - The current user's sub
 * @param existingCrateItems - Existing CrateItems for this candidate
 * @param existingVerdicts - All existing verdicts for this candidate (to check for other keepers)
 * @param sliceId - The curated slice id
 * @returns A plan with Verdict update, Slice delete, CrateItem deletes
 */
export function planSkip(
  candidateId: string,
  judge: string,
  existingCrateItems: any[],
  existingVerdicts: any[],
  sliceId: string,
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

  // Slice: delete if no other keeper
  const slicesToDelete = hasOtherKeeper ? [] : [sliceId];

  // CrateItems: delete all for this candidate
  const crateItemIdsToDelete = existingCrateItems.map((item: any) => item.id);

  return {
    verdicts: {
      update: verdictRecord,
    },
    slices: {
      delete: slicesToDelete,
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
 * Plan merging markup: match proposed ML slices to existing, handle retirement.
 * Wraps rw_markup_merge output into Slice writes and Clip nameCounters update.
 *
 * @param clipId - The clip's id
 * @param mergeResult - Output from rw_markup_merge with {keep, create, retire, delete, name_counters}
 * @returns A plan with Slice create/update/retire/delete and Clip update
 */
export function planMerge(
  clipId: string,
  mergeResult: any
): MergePlan {
  // Extract the plan from wasm output
  const keep = mergeResult.keep || [];
  const create = mergeResult.create || [];
  const retire = mergeResult.retire || [];
  const deleteIds = mergeResult.delete || [];
  const nameCounters = mergeResult.name_counters || {};

  // Build Slice updates for kept slices
  const sliceUpdates = keep.map(([id, [start, end], rank]: [string, [number, number], number | null]) => ({
    id,
    start,
    end,
    ...(rank !== null && rank !== undefined && { rank }),
  }));

  // Build Slice creates for new slices
  const sliceCreates = create.map(([name, start, end, rank]: [string, number, number, number | null]) => ({
    clipId,
    name,
    start,
    end,
    source: "ml",
    ...(rank !== null && rank !== undefined && { rank }),
  }));

  // Build Slice retires (set retired: true)
  const sliceRetires = retire.map((id: string) => ({
    id,
    retired: true,
  }));

  // Build Clip update for nameCounters
  const clipUpdate = Object.keys(nameCounters).length > 0
    ? {
        id: clipId,
        nameCounters: JSON.stringify(nameCounters),
      }
    : undefined;

  return {
    slices: {
      update: sliceUpdates,
      create: sliceCreates,
      retire: sliceRetires,
      delete: deleteIds,
    },
    clip: {
      update: clipUpdate,
    },
  };
}
