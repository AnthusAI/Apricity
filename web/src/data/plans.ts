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
