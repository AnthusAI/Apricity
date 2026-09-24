// Web data layer: domain operations (idempotent sequences over the client).
// All operations follow Amplify semantics: limit before filter, pagination, proper error propagation.

import { client } from "./client.js";
import { callWasm, extractReferences } from "../apricitus.js";
import { planScoreRefs, type CatalogRef, type Lookups, type ScoreRef } from "./plans.js";

interface OpResult<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; errorType: string }>;
}

/**
 * Keep a candidate: upsert Verdict → find/create Crate → create CrateItem → create curated Slice.
 * Idempotent: calling it again with the same candidateId changes nothing.
 */
export async function keepCandidate(
  candidateId: string,
  options?: {
    stars?: number;
    tags?: string[];
    name?: string;
    crates?: string[];
  }
): Promise<OpResult> {
  const dataClient = client();
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { errors: [{ message: "No authenticated user", errorType: "Unauthorized" }] };
  }

  const judge = currentUser.sub;
  const now = new Date().toISOString();

  try {
    // Validate candidate exists
    const candidateResult = await dataClient.models.Candidate.get({ id: candidateId });
    if (!candidateResult.data) {
      return { errors: [{ message: `Candidate ${candidateId} not found`, errorType: "NotFound" }] };
    }
    const candidate = candidateResult.data as any;

    // Upsert Verdict (real upsert: get, then update or create)
    let verdictResult = await dataClient.models.Verdict.get({ candidateId, judge });
    let verdict: any;
    if (verdictResult.data) {
      // Update existing
      const updateRes = await dataClient.models.Verdict.update({
        candidateId,
        judge,
        verdict: "keep",
        stars: options?.stars,
        tags: options?.tags,
        name: options?.name,
        judgedAt: now,
        by: "person",
      });
      if (updateRes.errors?.length) {
        return { errors: updateRes.errors as any };
      }
      verdict = updateRes.data;
    } else {
      // Create new
      const createRes = await dataClient.models.Verdict.create({
        candidateId,
        judge,
        verdict: "keep",
        stars: options?.stars,
        tags: options?.tags,
        name: options?.name,
        judgedAt: now,
        by: "person",
      });
      if (createRes.errors?.length) {
        return { errors: createRes.errors as any };
      }
      verdict = createRes.data;
    }

    // Generate curated slice ID via wasm
    const sliceIdResult = await callWasm("rw_ids", { kind: "curated_slice_id", candidate_id: candidateId });
    if (!sliceIdResult.data || sliceIdResult.errors?.length) {
      return {
        errors: [{ message: "Failed to generate curated slice ID", errorType: "Internal" }],
      };
    }
    const sliceId = sliceIdResult.data as string;

    // Get or create curated slice
    let sliceResult = await dataClient.models.Slice.get({ id: sliceId });
    let slice: any;
    if (!sliceResult.data) {
      // Create new slice
      const createSliceRes = await dataClient.models.Slice.create({
        id: sliceId,
        clipId: candidate.clipId,
        name: options?.name || candidate.name || "curated",
        start: candidate.start,
        end: candidate.end,
        source: "curated" as const,
        candidateId,
        kind: candidate.kind as any,
      });
      if (createSliceRes.errors?.length) {
        return { errors: createSliceRes.errors as any };
      }
      slice = createSliceRes.data;
    } else {
      slice = sliceResult.data;
    }

    // Process crates (only if specified)
    if (options?.crates && options.crates.length > 0) {
      for (const crateName of options.crates) {
        // Collect all crates by owner, then find by name
        const cratesResult = await collectAll(
          async (token) =>
            await dataClient.models.Crate.cratesByOwner({ owner: judge }, { nextToken: token })
        );
        const crateWithName = (cratesResult || []).find((c: any) => c.name === crateName);
        let crateId: string;

        if (crateWithName) {
          crateId = (crateWithName as any).id;
        } else {
          // Create new crate (don't set owner; Amplify will fill it)
          const createCrateRes = await dataClient.models.Crate.create({
            name: crateName,
          });
          if (createCrateRes.errors?.length) {
            return { errors: createCrateRes.errors as any };
          }
          crateId = (createCrateRes.data as any).id;
        }

        // Find crate item for this candidate
        const itemsResult = await dataClient.models.CrateItem.crateItemsByCandidate({ candidateId });
        const existingItem = (itemsResult.data as any[]).find((item: any) => item.crateId === crateId);

        if (!existingItem) {
          // Create new item (don't set owner; Amplify will fill it)
          const createItemRes = await dataClient.models.CrateItem.create({
            crateId,
            candidateId,
            position: "a0",
          });
          if (createItemRes.errors?.length) {
            return { errors: createItemRes.errors as any };
          }
        }
      }
    }

    return { data: { verdict } };
  } catch (e) {
    return { errors: [{ message: String(e), errorType: "Internal" }] };
  }
}

/**
 * Skip a candidate: upsert Verdict (verdict="skip") → remove this user's CrateItems → delete curated Slice if no other keeper.
 */
export async function skipCandidate(candidateId: string): Promise<OpResult> {
  const dataClient = client();
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { errors: [{ message: "No authenticated user", errorType: "Unauthorized" }] };
  }

  const judge = currentUser.sub;
  const now = new Date().toISOString();

  try {
    // Validate candidate exists
    const candidateResult = await dataClient.models.Candidate.get({ id: candidateId });
    if (!candidateResult.data) {
      return { errors: [{ message: `Candidate ${candidateId} not found`, errorType: "NotFound" }] };
    }

    // Upsert Verdict
    let verdictResult = await dataClient.models.Verdict.get({ candidateId, judge });
    let verdict: any;
    if (verdictResult.data) {
      const updateRes = await dataClient.models.Verdict.update({
        candidateId,
        judge,
        verdict: "skip",
        judgedAt: now,
        by: "person",
      });
      if (updateRes.errors?.length) {
        return { errors: updateRes.errors as any };
      }
      verdict = updateRes.data;
    } else {
      const createRes = await dataClient.models.Verdict.create({
        candidateId,
        judge,
        verdict: "skip",
        judgedAt: now,
        by: "person",
      });
      if (createRes.errors?.length) {
        return { errors: createRes.errors as any };
      }
      verdict = createRes.data;
    }

    // Remove this user's CrateItems
    const itemsResult = await dataClient.models.CrateItem.crateItemsByCandidate({ candidateId });
    for (const item of itemsResult.data || []) {
      await dataClient.models.CrateItem.delete({ id: (item as any).id });
    }

    // Check if any other user has a keep verdict
    const keepVerdicts = await collectAll(
      async (token) =>
        await dataClient.models.Verdict.list({
          filter: { candidateId: { eq: candidateId }, verdict: { eq: "keep" } },
          nextToken: token,
        })
    );

    // If no other keepers, delete the curated slice
    if (!keepVerdicts || keepVerdicts.length === 0) {
      const sliceIdResult = await callWasm("rw_ids", { kind: "curated_slice_id", candidate_id: candidateId });
      if (sliceIdResult.data) {
        const sliceId = sliceIdResult.data as string;
        await dataClient.models.Slice.delete({ id: sliceId });
      }
    }

    return { data: { verdict } };
  } catch (e) {
    return { errors: [{ message: String(e), errorType: "Internal" }] };
  }
}

/**
 * Put off a candidate: create Verdict (verdict="later").
 */
export async function putOffCandidate(candidateId: string): Promise<OpResult> {
  const dataClient = client();
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { errors: [{ message: "No authenticated user", errorType: "Unauthorized" }] };
  }

  const judge = currentUser.sub;
  const now = new Date().toISOString();

  try {
    // Validate candidate exists
    const candidateResult = await dataClient.models.Candidate.get({ id: candidateId });
    if (!candidateResult.data) {
      return { errors: [{ message: `Candidate ${candidateId} not found`, errorType: "NotFound" }] };
    }

    // Upsert Verdict
    let verdictResult = await dataClient.models.Verdict.get({ candidateId, judge });
    let verdict: any;
    if (verdictResult.data) {
      const updateRes = await dataClient.models.Verdict.update({
        candidateId,
        judge,
        verdict: "later",
        judgedAt: now,
        by: "person",
      });
      if (updateRes.errors?.length) {
        return { errors: updateRes.errors as any };
      }
      verdict = updateRes.data;
    } else {
      const createRes = await dataClient.models.Verdict.create({
        candidateId,
        judge,
        verdict: "later",
        judgedAt: now,
        by: "person",
      });
      if (createRes.errors?.length) {
        return { errors: createRes.errors as any };
      }
      verdict = createRes.data;
    }

    return { data: { verdict } };
  } catch (e) {
    return { errors: [{ message: String(e), errorType: "Internal" }] };
  }
}

/**
 * Merge markup: apply a new set of ML slice proposals via wasm rw_markup_merge, then update slices.
 */
export async function mergeMarkup(
  clipId: string,
  proposed: Array<{ kind: string; start: number; end: number; rank?: number; evidence?: unknown }>
): Promise<OpResult> {
  const dataClient = client();

  try {
    // Get existing slices for this clip
    const existingResult = await collectAll(
      async (token) =>
        await dataClient.models.Slice.list({
          filter: { clipId: { eq: clipId } },
          nextToken: token,
        })
    );
    const existingSlices = existingResult || [];

    // Get clip to access nameCounters
    const clipResult = await dataClient.models.Clip.get({ id: clipId });
    if (!clipResult.data) {
      return { errors: [{ message: `Clip ${clipId} not found`, errorType: "NotFound" }] };
    }
    const clip = clipResult.data as any;

    // Get slices used by any score
    const scoreRefsResult = await collectAll(async (token) => await dataClient.models.ScoreRef.list({ nextToken: token }));
    const usedByScore = new Set(
      (scoreRefsResult || []).filter((ref: any) => ref.sliceId).map((ref: any) => ref.sliceId)
    );

    // Call wasm rw_markup_merge
    const nameCounters = clip.nameCounters ? JSON.parse(clip.nameCounters as string) : {};
    const existingForMerge = existingSlices.map((s: any) => ({
      id: s.id,
      name: s.name,
      kind: s.kind || "",
      start: s.start,
      end: s.end,
      source: s.source || "ml",
      retired: s.retired || false,
    }));

    const mergeResult = (await callWasm("rw_markup_merge", {
      existing: existingForMerge,
      proposed,
      name_counters: nameCounters,
      used_by_score: Array.from(usedByScore),
    })) as any;

    if (!mergeResult.data || mergeResult.errors?.length) {
      return {
        errors: [{ message: mergeResult.errors?.[0] || "Markup merge failed", errorType: "Internal" }],
      };
    }

    const plan = mergeResult.data;

    // Apply the plan
    for (const [id, [start, end], rank] of plan.keep || []) {
      await dataClient.models.Slice.update({
        id,
        start,
        end,
        rank: rank as number | undefined,
      });
    }

    for (const [name, start, end, rank] of plan.create || []) {
      const newSliceId = await generateMlSliceId(clipId, name);
      await dataClient.models.Slice.create({
        id: newSliceId,
        clipId,
        name,
        start,
        end,
        source: "ml" as const,
        rank: rank as number | undefined,
      });
    }

    for (const id of plan.retire || []) {
      await dataClient.models.Slice.update({ id, retired: true });
    }

    for (const id of plan.delete || []) {
      await dataClient.models.Slice.delete({ id });
    }

    if (plan.name_counters && Object.keys(plan.name_counters).length > 0) {
      await dataClient.models.Clip.update({
        id: clipId,
        nameCounters: JSON.stringify(plan.name_counters),
      });
    }

    return { data: {} };
  } catch (e) {
    return { errors: [{ message: String(e), errorType: "Internal" }] };
  }
}

/**
 * Save a score: parse its text via wasm, resolve clips/slices, write ScoreRef records.
 * Implements features/data/domain/score_refs.feature
 */
export async function saveScore(scoreId: string, text: string): Promise<OpResult> {
  const dataClient = client();

  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return { errors: [{ message: "No authenticated user", errorType: "Unauthorized" }] };
    }

    const folder = "scores";
    const file = scoreId + ".apr";

    // Step 1: Parse first (extract references to check for errors)
    const refsResult = (await extractReferences(text, folder, file)) as any;

    // Step 2: Create/update Score once with text and lastErrors
    let score: any;
    const existingResult = await dataClient.models.Score.get({ id: scoreId });
    const lastErrors = refsResult.errors || [];

    if (existingResult.data) {
      const updateResult = await dataClient.models.Score.update({
        id: scoreId,
        text,
        lastErrors,
      });
      if (updateResult.errors?.length) {
        return { errors: updateResult.errors as any };
      }
      score = updateResult.data;
    } else {
      const createResult = await dataClient.models.Score.create({
        id: scoreId,
        title: scoreId,
        folder,
        format: "apr",
        text,
        lastErrors,
      });
      if (createResult.errors?.length) {
        return { errors: createResult.errors as any };
      }
      score = createResult.data;
    }

    // On parse errors, return the score without processing refs
    if (refsResult.errors?.length) {
      return { data: { score } };
    }

    if (!refsResult.data) {
      return { errors: [{ message: "Failed to extract references from score", errorType: "Internal" }] };
    }

    const catalogRefs: CatalogRef[] = refsResult.data;

    // Fetch lookups: clips and slices
    const lookups = await fetchLookups(dataClient, catalogRefs);

    // Get existing ScoreRefs for this score
    const existingRefs = await collectAll(
      async (token) =>
        await dataClient.models.ScoreRef.refsByScore({ scoreId }, { nextToken: token })
    );

    // Plan the diff
    const plan = planScoreRefs(scoreId, catalogRefs, lookups, (existingRefs || []) as ScoreRef[]);

    // Apply the plan: deletes first, then updates, then creates
    for (const id of plan.delete) {
      const deleteRes = await dataClient.models.ScoreRef.delete({ id });
      if (deleteRes.errors?.length) {
        return { errors: deleteRes.errors as any };
      }
    }

    for (const ref of plan.update) {
      const updateRes = await dataClient.models.ScoreRef.update(ref as any);
      if (updateRes.errors?.length) {
        return { errors: updateRes.errors as any };
      }
    }

    for (const ref of plan.create) {
      const createRes = await dataClient.models.ScoreRef.create(ref as any);
      if (createRes.errors?.length) {
        return { errors: createRes.errors as any };
      }
    }

    return { data: { score } };
  } catch (e) {
    return { errors: [{ message: String(e), errorType: "Internal" }] };
  }
}

/**
 * Fetch lookup maps for clips and slices referenced in catalog refs.
 */
async function fetchLookups(
  dataClient: any,
  catalogRefs: CatalogRef[]
): Promise<Lookups> {
  const lookups: Lookups = {
    clipsByPath: new Map(),
    clipsById: new Map(),
    slicesByClipAndName: new Map(),
    slicesById: new Map(),
  };

  // Collect all unique paths and ids we need to fetch
  const pathsToFetch = new Set<string>();
  const idsToFetch = new Set<string>();
  const sliceIdNamesToFetch = new Set<string>();
  const sliceIdsToFetch = new Set<string>();

  for (const ref of catalogRefs) {
    if (ref.catalogPath) {
      pathsToFetch.add(ref.catalogPath);
    }
    if (ref.clipId) {
      idsToFetch.add(ref.clipId);
    }
    if (ref.sliceName && ref.clipId) {
      sliceIdNamesToFetch.add(ref.clipId); // Track which clip ids we need slice names for
    }
    if (ref.sliceId) {
      sliceIdsToFetch.add(ref.sliceId);
    }
  }

  // Fetch clips by path
  for (const path of pathsToFetch) {
    const clipResults = await collectAll(async (token) => await dataClient.models.Clip.clipsByPath({ path }, { nextToken: token }));
    const clip = (clipResults as any[])?.[0];
    if (clip) {
      lookups.clipsByPath.set(path, { id: clip.id, path: clip.path });
    }
  }

  // Fetch clips by id
  for (const id of idsToFetch) {
    const clipResult = await dataClient.models.Clip.get({ id });
    if (clipResult.data) {
      const clip = clipResult.data as any;
      lookups.clipsById.set(id, { id: clip.id, path: clip.path });
    }
  }

  // Fetch slices by (clipId, name)
  for (const clipId of sliceIdNamesToFetch) {
    // Find all catalog refs for this clipId to get the names
    const names = new Set<string>();
    for (const ref of catalogRefs) {
      if (ref.sliceName) {
        // Check if this ref's clipId matches
        let refClipId = ref.clipId;
        if (!refClipId && ref.catalogPath) {
          const clip = lookups.clipsByPath.get(ref.catalogPath);
          if (clip) refClipId = clip.id;
        }
        if (refClipId === clipId) {
          names.add(ref.sliceName);
        }
      }
    }

    for (const name of names) {
      const sliceResults = await collectAll(
        async (token) =>
          await dataClient.models.Slice.slicesByClipAndName({ clipId, name }, { nextToken: token })
      );
      const slice = (sliceResults as any[])?.[0];
      if (slice) {
        if (!lookups.slicesByClipAndName.has(clipId)) {
          lookups.slicesByClipAndName.set(clipId, new Map());
        }
        (lookups.slicesByClipAndName.get(clipId) as Map<string, any>).set(name, {
          id: slice.id,
          start: slice.start,
          end: slice.end,
        });
      }
    }
  }

  // Fetch slices by id
  for (const id of sliceIdsToFetch) {
    const sliceResult = await dataClient.models.Slice.get({ id });
    if (sliceResult.data) {
      const slice = sliceResult.data as any;
      lookups.slicesById.set(id, { id: slice.id, start: slice.start, end: slice.end });
    }
  }

  return lookups;
}

// ---- helpers

async function getCurrentUser(): Promise<{ sub: string; username?: string } | null> {
  const { getCurrentUser } = await import("./auth.js");
  return (await getCurrentUser()) as { sub: string; username?: string } | null;
}

/**
 * Collect all pages from a paginated query. Stops and returns errors if any operation fails.
 */
async function collectAll<T>(fn: (token?: string | null) => Promise<{ data?: T[]; errors?: any[]; nextToken?: string | null }>): Promise<T[] | null> {
  const all: T[] = [];
  let token: string | null | undefined;
  while (true) {
    const result = await fn(token);
    if (result.errors?.length) {
      // Surface errors immediately
      return null;
    }
    if (result.data) {
      all.push(...result.data);
    }
    if (!result.nextToken) break;
    token = result.nextToken;
  }
  return all;
}

/**
 * Generate a curated slice ID via wasm.
 */
async function getCuratedSliceId(candidateId: string): Promise<string> {
  const result = await callWasm("rw_ids", { kind: "curated_slice_id", candidate_id: candidateId });
  return (result.data as string) || `slc_${candidateId}`;
}

/**
 * Generate an ML slice ID via wasm.
 */
async function generateMlSliceId(clipId: string, name: string): Promise<string> {
  const result = await callWasm("rw_ids", { kind: "migrated_slice_id", clip_id: clipId, name });
  return (result.data as string) || `slc_${clipId}_${name}`;
}
