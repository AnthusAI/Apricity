// Web data layer: domain operations (idempotent sequences over the client).
// All operations follow Amplify semantics: limit before filter, pagination, proper error propagation.

import { client } from "./client.js";
import { callWasm, extractReferences } from "../apricity.js";
import { planScoreRefs, planKeep, planSkip, planPutOff, planMerge, type CatalogRef, type Lookups, type ScoreRef } from "./plans.js";
import { getCurrentUser, ownerValue } from "./auth.js";

interface OpResult<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; errorType: string }>;
}

/**
 * Keep a candidate: upsert Verdict → create/update curated Clip → create CrateItems and Crates.
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
  const owner = await ownerValue();

  try {
    // Validate candidate exists
    const candidateResult = await dataClient.models.Candidate.get({ id: candidateId });
    if (!candidateResult.data) {
      return { errors: [{ message: `Candidate ${candidateId} not found`, errorType: "NotFound" }] };
    }
    const candidate = candidateResult.data as any;

    // Generate curated clip ID via wasm
    const clipIdResult = await callWasm("rw_ids", { kind: "curated_clip_id", candidate_id: candidateId });
    if (!clipIdResult.data || clipIdResult.errors?.length) {
      return {
        errors: [{ message: "Failed to generate curated clip ID", errorType: "Internal" }],
      };
    }
    const clipId = clipIdResult.data as string;

    // Fetch lookups
    const myVerdict = await dataClient.models.Verdict.get({ candidateId, judge });
    const curatedClipResult = await dataClient.models.Clip.get({ id: clipId });
    const curatedClip = curatedClipResult.data;

    const cratesResult = await collectAll(
      async (token) =>
        await dataClient.models.Crate.cratesByOwner({ owner }, { nextToken: token })
    );
    const cratesByName = new Map(
      (cratesResult || []).map((c: any) => [c.name, c])
    );

    const crateItemsResult = await collectAll(
      async (token) =>
        await dataClient.models.CrateItem.crateItemsByCandidate({ candidateId }, { nextToken: token })
    );
    const existingCrateItems = crateItemsResult || [];

    // Build lastPositionByCrate map: fetch the last item for each existing target crate
    const lastPositionByCrate = new Map<string, string | null>();
    if (options?.crates && options.crates.length > 0) {
      for (const crateName of options.crates) {
        const crateRecord = cratesByName.get(crateName);
        if (crateRecord) {
          // Fetch last item for existing crate with single call
          const lastItemResult = await dataClient.models.CrateItem.crateItemsByCrate(
            { crateId: crateRecord.id },
            { sortDirection: "DESC", limit: 1 }
          );
          if (lastItemResult && lastItemResult.data && lastItemResult.data.length > 0) {
            const lastItem = lastItemResult.data[0] as any;
            lastPositionByCrate.set(crateRecord.id, lastItem.position || null);
          } else {
            lastPositionByCrate.set(crateRecord.id, null);
          }
        }
        // For new crates, we don't know the ID yet, so they won't be in the map
        // planKeep will use "a0" as default for missing IDs
      }
    }

    // Helper to generate the next position using wasm
    const positionAfter = async (lastPosition: string | null): Promise<string> => {
      const result = await callWasm("rw_ids", { kind: "position_between", a: lastPosition, b: null });
      return result.data as string;
    };

    // Plan the operations
    const plan = await planKeep(
      candidateId,
      judge,
      candidate,
      myVerdict.data || null,
      curatedClip || null,
      cratesByName,
      existingCrateItems,
      clipId,
      new Date().toISOString(),
      () => crypto.randomUUID(),
      lastPositionByCrate,
      positionAfter,
      options
    );

    // Check for plan errors (e.g., null candidate)
    if ("errors" in plan && plan.errors) {
      return { errors: plan.errors as any };
    }

    // Now we know plan is KeepPlan, not error result
    const keepPlan = plan as any;

    // Apply the plan: create Crates first, then Verdicts, then Clips, then CrateItems
    for (const crate of keepPlan.crates.create) {
      const createRes = await dataClient.models.Crate.create(crate);
      if (createRes.errors?.length) {
        return { errors: createRes.errors as any };
      }
    }

    let verdict: any;
    if (keepPlan.verdicts.create) {
      const createRes = await dataClient.models.Verdict.create(keepPlan.verdicts.create);
      if (createRes.errors?.length) {
        return { errors: createRes.errors as any };
      }
      verdict = createRes.data;
    } else if (keepPlan.verdicts.update) {
      const updateRes = await dataClient.models.Verdict.update(keepPlan.verdicts.update);
      if (updateRes.errors?.length) {
        return { errors: updateRes.errors as any };
      }
      verdict = updateRes.data;
    }

    if (keepPlan.clips.create) {
      const createRes = await dataClient.models.Clip.create(keepPlan.clips.create);
      if (createRes.errors?.length) {
        return { errors: createRes.errors as any };
      }
    } else if (keepPlan.clips.update) {
      const updateRes = await dataClient.models.Clip.update(keepPlan.clips.update);
      if (updateRes.errors?.length) {
        return { errors: updateRes.errors as any };
      }
    }

    for (const item of keepPlan.crateItems.create) {
      const createRes = await dataClient.models.CrateItem.create(item);
      if (createRes.errors?.length) {
        return { errors: createRes.errors as any };
      }
    }

    return { data: { verdict } };
  } catch (e) {
    return { errors: [{ message: String(e), errorType: "Internal" }] };
  }
}

/**
 * Skip a candidate: upsert Verdict (verdict="skip") → delete curated Clip if no other keeper → delete CrateItems.
 */
export async function skipCandidate(candidateId: string): Promise<OpResult> {
  const dataClient = client();
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { errors: [{ message: "No authenticated user", errorType: "Unauthorized" }] };
  }

  const judge = currentUser.sub;
  const owner = await ownerValue();

  try {
    // Validate candidate exists
    const candidateResult = await dataClient.models.Candidate.get({ id: candidateId });
    if (!candidateResult.data) {
      return { errors: [{ message: `Candidate ${candidateId} not found`, errorType: "NotFound" }] };
    }

    // Generate curated clip ID via wasm
    const clipIdResult = await callWasm("rw_ids", { kind: "curated_clip_id", candidate_id: candidateId });
    if (!clipIdResult.data || clipIdResult.errors?.length) {
      return {
        errors: [{ message: "Failed to generate curated clip ID", errorType: "Internal" }],
      };
    }
    const clipId = clipIdResult.data as string;

    // Fetch my crates
    const mycratesResult = await collectAll(
      async (token) =>
        await dataClient.models.Crate.cratesByOwner({ owner }, { nextToken: token })
    );
    const myCrateIds = new Set((mycratesResult || []).map((c: any) => c.id));

    // Fetch all crate items for this candidate, then filter to my crates
    const crateItemsResult = await collectAll(
      async (token) =>
        await dataClient.models.CrateItem.crateItemsByCandidate({ candidateId }, { nextToken: token })
    );
    const existingCrateItems = (crateItemsResult || []).filter((item: any) => myCrateIds.has(item.crateId));

    const allVerdicts = await collectAll(
      async (token) =>
        await dataClient.models.Verdict.list({
          filter: { candidateId: { eq: candidateId } },
          nextToken: token,
        })
    );

    // Plan the operations
    const plan = planSkip(candidateId, judge, existingCrateItems, allVerdicts || [], clipId, new Date().toISOString());

    // Apply the plan: delete first, then update
    for (const id of plan.clips.delete) {
      const deleteRes = await dataClient.models.Clip.delete({ id });
      if (deleteRes.errors?.length) {
        return { errors: deleteRes.errors as any };
      }
    }

    for (const id of plan.crateItems.delete) {
      const deleteRes = await dataClient.models.CrateItem.delete({ id });
      if (deleteRes.errors?.length) {
        return { errors: deleteRes.errors as any };
      }
    }

    const updateRes = await dataClient.models.Verdict.update(plan.verdicts.update);
    if (updateRes.errors?.length) {
      return { errors: updateRes.errors as any };
    }
    const verdict = updateRes.data;

    return { data: { verdict } };
  } catch (e) {
    return { errors: [{ message: String(e), errorType: "Internal" }] };
  }
}

/**
 * Put off a candidate: create/update Verdict (verdict="later").
 */
export async function putOffCandidate(candidateId: string): Promise<OpResult> {
  const dataClient = client();
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { errors: [{ message: "No authenticated user", errorType: "Unauthorized" }] };
  }

  const judge = currentUser.sub;

  try {
    // Validate candidate exists
    const candidateResult = await dataClient.models.Candidate.get({ id: candidateId });
    if (!candidateResult.data) {
      return { errors: [{ message: `Candidate ${candidateId} not found`, errorType: "NotFound" }] };
    }

    // Fetch existing verdict
    const myVerdictResult = await dataClient.models.Verdict.get({ candidateId, judge });
    const myVerdict = myVerdictResult.data;

    // Plan the operations
    const plan = planPutOff(candidateId, judge, myVerdict || null, new Date().toISOString());

    // Apply the plan
    let verdict: any;
    if (plan.verdicts.create) {
      const createRes = await dataClient.models.Verdict.create(plan.verdicts.create);
      if (createRes.errors?.length) {
        return { errors: createRes.errors as any };
      }
      verdict = createRes.data;
    } else if (plan.verdicts.update) {
      const updateRes = await dataClient.models.Verdict.update(plan.verdicts.update);
      if (updateRes.errors?.length) {
        return { errors: updateRes.errors as any };
      }
      verdict = updateRes.data;
    }

    return { data: { verdict } };
  } catch (e) {
    return { errors: [{ message: String(e), errorType: "Internal" }] };
  }
}

/**
 * Merge markup: apply a new set of ML clip proposals via wasm rw_markup_merge, then update clips.
 */
export async function mergeMarkup(
  sampleId: string,
  proposed: Array<{ kind: string; start: number; end: number; rank?: number; evidence?: unknown }>
): Promise<OpResult> {
  const dataClient = client();

  try {
    // Get existing clips for this sample
    const existingResult = await collectAll(
      async (token) =>
        await dataClient.models.Clip.list({
          filter: { sampleId: { eq: sampleId } },
          nextToken: token,
        })
    );
    const existingClips = existingResult || [];

    // Get sample to access nameCounters
    const sampleResult = await dataClient.models.Sample.get({ id: sampleId });
    if (!sampleResult.data) {
      return { errors: [{ message: `Sample ${sampleId} not found`, errorType: "NotFound" }] };
    }
    const sample = sampleResult.data as any;

    // Get clips used by any score
    const scoreRefsResult = await collectAll(async (token) => await dataClient.models.ScoreRef.list({ nextToken: token }));
    const usedByScore = new Set(
      (scoreRefsResult || []).filter((ref: any) => ref.clipId).map((ref: any) => ref.clipId)
    );

    // Call wasm rw_markup_merge
    const nameCounters = sample.nameCounters ? JSON.parse(sample.nameCounters as string) : {};
    const existingForMerge = existingClips.map((s: any) => ({
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

    // Plan the merge
    const plan = planMerge(sampleId, mergeResult.data);

    // Apply the plan: delete, then retire, then update, then create, then update sample
    for (const id of plan.clips.delete) {
      const deleteRes = await dataClient.models.Clip.delete({ id });
      if (deleteRes.errors?.length) {
        return { errors: deleteRes.errors as any };
      }
    }

    for (const clip of plan.clips.retire) {
      const updateRes = await dataClient.models.Clip.update(clip);
      if (updateRes.errors?.length) {
        return { errors: updateRes.errors as any };
      }
    }

    for (const clip of plan.clips.update) {
      const updateRes = await dataClient.models.Clip.update(clip);
      if (updateRes.errors?.length) {
        return { errors: updateRes.errors as any };
      }
    }

    for (const clip of plan.clips.create) {
      const newClipId = await generateMlClipId(sampleId, clip.name);
      const createRes = await dataClient.models.Clip.create({
        ...clip,
        id: newClipId,
      });
      if (createRes.errors?.length) {
        return { errors: createRes.errors as any };
      }
    }

    if (plan.sample.update) {
      const updateRes = await dataClient.models.Sample.update(plan.sample.update);
      if (updateRes.errors?.length) {
        return { errors: updateRes.errors as any };
      }
    }

    return { data: {} };
  } catch (e) {
    return { errors: [{ message: String(e), errorType: "Internal" }] };
  }
}

/**
 * Save a score: parse its text via wasm, resolve samples/clips, write ScoreRef records.
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

    // Fetch lookups: samples and clips
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
 * Fetch lookup maps for samples and clips referenced in catalog refs.
 */
async function fetchLookups(
  dataClient: any,
  catalogRefs: CatalogRef[]
): Promise<Lookups> {
  const lookups: Lookups = {
    samplesByPath: new Map(),
    samplesById: new Map(),
    clipsBySampleAndName: new Map(),
    clipsById: new Map(),
  };

  // Collect all unique paths and ids we need to fetch
  const pathsToFetch = new Set<string>();
  const idsToFetch = new Set<string>();
  const sampleIdsForClipNames = new Set<string>();
  const clipIdsToFetch = new Set<string>();

  for (const ref of catalogRefs) {
    if (ref.catalogPath) {
      pathsToFetch.add(ref.catalogPath);
    }
    if (ref.sampleId) {
      idsToFetch.add(ref.sampleId);
    }
    if (ref.clipName && ref.sampleId) {
      sampleIdsForClipNames.add(ref.sampleId); // Track which sample ids we need clip names for
    }
    if (ref.clipId) {
      clipIdsToFetch.add(ref.clipId);
    }
  }

  // Fetch samples by path
  for (const path of pathsToFetch) {
    const sampleResults = await collectAll(async (token) => await dataClient.models.Sample.samplesByPath({ path }, { nextToken: token }));
    const sample = (sampleResults as any[])?.[0];
    if (sample) {
      lookups.samplesByPath.set(path, { id: sample.id, path: sample.path });
    }
  }

  // Fetch samples by id
  for (const id of idsToFetch) {
    const sampleResult = await dataClient.models.Sample.get({ id });
    if (sampleResult.data) {
      const sample = sampleResult.data as any;
      lookups.samplesById.set(id, { id: sample.id, path: sample.path });
    }
  }

  // Fetch clips by (sampleId, name)
  for (const sampleId of sampleIdsForClipNames) {
    // Find all catalog refs for this sampleId to get the names
    const names = new Set<string>();
    for (const ref of catalogRefs) {
      if (ref.clipName) {
        // Check if this ref's sampleId matches
        let refSampleId = ref.sampleId;
        if (!refSampleId && ref.catalogPath) {
          const sample = lookups.samplesByPath.get(ref.catalogPath);
          if (sample) refSampleId = sample.id;
        }
        if (refSampleId === sampleId) {
          names.add(ref.clipName);
        }
      }
    }

    for (const name of names) {
      const clipResults = await collectAll(
        async (token) =>
          await dataClient.models.Clip.clipsBySampleAndName({ sampleId, name }, { nextToken: token })
      );
      const clip = (clipResults as any[])?.[0];
      if (clip) {
        if (!lookups.clipsBySampleAndName.has(sampleId)) {
          lookups.clipsBySampleAndName.set(sampleId, new Map());
        }
        (lookups.clipsBySampleAndName.get(sampleId) as Map<string, any>).set(name, {
          id: clip.id,
          start: clip.start,
          end: clip.end,
        });
      }
    }
  }

  // Fetch clips by id
  for (const id of clipIdsToFetch) {
    const clipResult = await dataClient.models.Clip.get({ id });
    if (clipResult.data) {
      const clip = clipResult.data as any;
      lookups.clipsById.set(id, { id: clip.id, start: clip.start, end: clip.end });
    }
  }

  return lookups;
}

// ---- helpers

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
 * Generate a curated clip ID via wasm.
 */
async function getCuratedClipId(candidateId: string): Promise<string> {
  const result = await callWasm("rw_ids", { kind: "curated_clip_id", candidate_id: candidateId });
  return (result.data as string) || `clp_${candidateId}`;
}

/**
 * Generate an ML clip ID via wasm.
 */
async function generateMlClipId(sampleId: string, name: string): Promise<string> {
  const result = await callWasm("rw_ids", { kind: "migrated_clip_id", sample_id: sampleId, name });
  return (result.data as string) || `clp_${sampleId}_${name}`;
}
