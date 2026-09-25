// Library and score data for the Library and Score views, read through the data layer
// (design/storage.md §4.1). The same code runs locally (`apricity serve`: GraphQL with the
// library's API key, files at /files/<key>) and in the cloud (AppSync as the signed-in user, files
// from the bucket): only the injected client and file functions differ.
//
// Mapping (records -> the shapes the UI has always consumed):
//   sample path       "samples/" + Clip.path (the catalog alias scores resolve; Clip.aliases also match)
//   SampleSummary     Clip summary fields + Recording title/credit/rights (+ the parent's title for stems)
//   Manifest          the Clip.analysis attachment (files/analysis/<clipId>/<sha>.json) + annotations
//                     rebuilt from Slice (slicesByClip) and Marker (markersByClip) records,
//                     as crates/apricity-data/src/loader.rs does for the CLI
//   audio bytes       Clip.audio.key through files.ts getUrl
//   score path        `${Score.folder}/${Score.title}.${Score.format}` (= legacyPath for migrated scores)
//   score id          scr_<folder with / as _>_<title>_<format> (migration's scheme)

import type { Manifest, Marker as MarkerAnn, SampleSummary, SavedClip } from "../apricity";

/** Signed out (cloud), or the signed-in user may not read the catalog. */
export class SignedOut extends Error {
  constructor(message = "Sign in to see the library") {
    super(message);
    this.name = "SignedOut";
  }
}

/** Why uploading can't happen from the web app yet: analysis runs on a Mac, never in the cloud (design/storage.md §7.7). */
export const NEEDS_ANALYSIS_SERVER = "Uploading and re-analysing needs the local analysis server; not available in the cloud yet";
export const NEEDS_ANALYSIS_LOCAL = "Uploading and re-analysing needs the local analysis server, which apricity serve does not run yet; analyse the file with the analysis tools and migrate it into the library";

type GqlError = { message?: string; errorType?: string };
type Page<T> = { data?: T[] | null; nextToken?: string | null; errors?: GqlError[] };

const UNAUTHORIZED = /unauthori[sz]ed|not authorized|no current user|NoValidAuthTokens|UserUnAuthenticated|NoSignedUser|No federated jwt|UserNotAuthenticated/i;

/** Does this thrown error or GraphQL error list mean "not signed in / not allowed"? */
export function isUnauthorized(e: unknown): boolean {
  if (!e) return false;
  if (Array.isArray(e)) return e.some(isUnauthorized);
  const o = e as { name?: string; message?: string; errorType?: string; errors?: unknown };
  if (o.errorType === "Unauthorized") return true;
  if (o.errors && isUnauthorized(o.errors)) return true;
  return UNAUTHORIZED.test(`${o.name ?? ""} ${o.message ?? ""}`);
}

/** Reads that are unauthorized mean "signed out"; writes keep the server's message (e.g. not the owner). */
function fail(errors: GqlError[], write = false): never {
  if (isUnauthorized(errors) && !write) throw new SignedOut();
  throw new Error(errors.map((e) => e.message ?? e.errorType ?? "error").join("\n"));
}

/** Every item of a list or index query, following nextToken; errors throw (SignedOut if unauthorized). */
export async function listAll<T>(page: (nextToken: string | null) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let token: string | null = null;
  do {
    let r: Page<T>;
    try {
      r = await page(token);
    } catch (e) {
      if (isUnauthorized(e)) throw new SignedOut();
      throw e;
    }
    if (r.errors?.length) fail(r.errors);
    out.push(...(r.data ?? []).filter((x): x is T => x != null));
    token = r.nextToken ?? null;
  } while (token);
  return out;
}

// ------------------------------------------------------------------ records

export interface FileRef {
  key: string;
  sha256?: string;
  size?: number | null;
  contentType?: string | null;
}
export interface ClipRecord {
  id: string;
  recordingId: string;
  path: string;
  aliases?: string[] | null;
  collection: string;
  title: string;
  role?: string | null;
  stem?: string | null;
  parentClipId?: string | null;
  excerptStart?: number | null;
  audio: FileRef;
  analysis?: FileRef | null;
  status?: string | null;
  duration?: number | null;
  bpm?: number | null;
  bpmStability?: number | null;
  meter?: number | null;
  key?: string | null;
  camelot?: string | null;
  keysOverTime?: (string | null)[] | null;
  tuningCents?: number | null;
  noteCount?: number | null;
}
export interface RecordingRecord {
  id: string;
  title: string;
  collection: string;
  credit?: string | null;
  rights?: string | null;
}
export interface SliceRecord {
  id: string;
  clipId: string;
  name: string;
  start: number;
  end: number;
  source: "user" | "ml" | "curated";
  kind?: string | null;
  tags?: (string | null)[] | null;
  evidence?: unknown;
  candidateId?: string | null;
  retired?: boolean | null;
}
export interface MarkerRecord {
  id: string;
  clipId: string;
  name: string;
  seconds: number;
  source?: string | null;
  note?: string | null;
}
export interface ScoreRecord {
  id: string;
  title: string;
  folder: string;
  format?: "apr" | "yaml" | null;
  text: string;
  legacyPath?: string | null;
  updatedAt?: string | null;
}
export interface JobRecord {
  id: string;
  kind: string;
  clipId?: string | null;
  state?: "queued" | "running" | "done" | "failed" | null;
  error?: string | null;
}

// ------------------------------------------------------------------ pure mappers

/** The path the UI and scores use for a clip: repo-relative, under samples/. */
export const samplePath = (clip: Pick<ClipRecord, "path">) => `samples/${clip.path}`;

/** "Bb major" -> "Bb", "C minor" -> "Cm" (the old summary's key label). */
export function keyLabel(k: string | null | undefined): string {
  if (!k) return "";
  const [tonic, mode] = k.trim().split(/\s+/);
  return tonic + (mode === "minor" ? "m" : "");
}

/** Keys over time as labels, repeats in a row collapsed (as the old summary did). */
export function keysOverTime(keys: (string | null)[] | null | undefined): string[] {
  const out: string[] = [];
  for (const k of keys ?? []) {
    const label = keyLabel(k);
    if (label && out[out.length - 1] !== label) out.push(label);
  }
  return out;
}

/** 214 -> "00:03:34" (sources.json's excerpt_start form). */
export function excerptLabel(seconds: number | null | undefined): string | undefined {
  if (seconds === null || seconds === undefined) return undefined;
  const s = Math.round(seconds);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

const GROUP_ORDER: Record<string, number> = { "marine-band": 0, "citizen-dj": 1, uploads: 2 };

/** A readable title from a filename: "Army-bugle_calls.wav" -> "Army bugle calls". */
const fileTitle = (path: string) => (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");

/** A recording's own title, unless migration had to invent one from its id (uploads). */
function recordingTitle(rec: RecordingRecord | undefined): string | undefined {
  if (!rec || rec.title === rec.id.replace(/^rec_/, "")) return undefined;
  return rec.title;
}

export interface Counts {
  slices: Map<string, number>;
  markers: Map<string, number>;
}

export function toSummary(clip: ClipRecord, recordings: Map<string, RecordingRecord>, clips: Map<string, ClipRecord>, counts: Counts): SampleSummary {
  const rec = recordings.get(clip.recordingId);
  let title = recordingTitle(rec) ?? fileTitle(clip.path);
  if (clip.stem) {
    const parent = clip.parentClipId ? clips.get(clip.parentClipId) : undefined;
    const base = recordingTitle(rec) ?? (parent ? fileTitle(parent.path) : fileTitle(clip.path.split("/").slice(0, -1).join("/")));
    title = `${base} · ${clip.stem}`;
  }
  return {
    path: samplePath(clip),
    title,
    group: clip.collection.split("/")[0],
    excerpt_start: excerptLabel(clip.excerptStart),
    credit: rec?.credit ?? undefined,
    rights: rec?.rights ?? undefined,
    duration: clip.duration ?? 0,
    bpm: clip.bpm ?? null,
    stability: clip.bpmStability ?? undefined,
    meter: clip.meter ?? undefined,
    key: keyLabel(clip.key),
    camelot: clip.camelot ?? undefined,
    keys_over_time: keysOverTime(clip.keysOverTime),
    tuning_cents: clip.tuningCents ?? undefined,
    notes: clip.noteCount ?? 0,
    clips: counts.slices.get(clip.id) ?? 0,
    markers: counts.markers.get(clip.id) ?? 0,
    stem: clip.stem ?? null,
  };
}

/** Modern full-length recordings first, then the archive excerpts, then uploads; by path within. */
export function sortSummaries(list: SampleSummary[]): SampleSummary[] {
  const rank = (s: SampleSummary) => GROUP_ORDER[s.group] ?? 3;
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const byTime = <T>(at: (x: T) => number, name: (x: T) => string) => (a: T, b: T) => at(a) - at(b) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0);

/** Slice records -> the manifest's annotations.clips, in time order (retired ones kept and flagged). */
export function sliceAnnotations(slices: SliceRecord[]): SavedClip[] {
  return [...slices].sort(byTime((s) => s.start, (s) => s.name)).map((s) => {
    const out: SavedClip = { id: s.id, name: s.name, start: s.start, end: s.end, source: s.source === "ml" ? "ml" : "user" };
    const tags = (s.tags ?? []).filter((t): t is string => typeof t === "string");
    if (s.tags) out.tags = tags;
    if (s.retired) out.retired = true;
    if (s.candidateId) out.candidate = s.candidateId;
    return out;
  });
}

export function markerAnnotations(markers: MarkerRecord[]): MarkerAnn[] {
  return [...markers].sort(byTime((m) => m.seconds, (m) => m.name)).map((m) => {
    const out: MarkerAnn = { name: m.name, seconds: m.seconds };
    if (m.source === "ml" || m.source === "user") out.source = m.source;
    if (m.note) out.note = m.note;
    return out;
  });
}

/** The old `<audio>.apricity.json`: the analysis attachment plus annotations from the records. */
export function toManifest(analysis: Manifest, slices: SliceRecord[], markers: MarkerRecord[]): Manifest {
  return { ...analysis, annotations: { ...(analysis.annotations ?? {}), clips: sliceAnnotations(slices), markers: markerAnnotations(markers) } };
}

export const scorePath = (s: Pick<ScoreRecord, "folder" | "title" | "format">) => `${s.folder}/${s.title}.${s.format ?? "apr"}`;

/** "scores/my-piece.apr" -> its record's id, title, folder and format (migration's id scheme). */
export function scoreKey(path: string): { id: string; title: string; folder: string; format: "apr" | "yaml" } {
  const m = /^(.*)\/([^/]+)\.(apr|yaml)$/.exec(path);
  if (!m) throw new Error(`${path}: a score path is <folder>/<name>.apr or .yaml`);
  const [, folder, title, format] = m;
  return { id: `scr_${folder.replace(/\//g, "_")}_${title}_${format}`, title, folder, format: format as "apr" | "yaml" };
}

/** Checks the clips a person saved before they become records (what the Python server checked). */
export function validateClips(clips: SavedClip[], duration: number): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  clips.forEach((s, i) => {
    if (!/^[A-Za-z0-9_-]+$/.test(s.name ?? "")) problems.push(`clips[${i}]: name ${JSON.stringify(s.name)} must be letters, digits, - or _`);
    if (names.has(s.name)) problems.push(`clips[${i}]: name ${JSON.stringify(s.name)} is used twice`);
    names.add(s.name);
    if (!(s.start >= 0 && s.start < s.end && s.end <= duration + 1e-6)) problems.push(`clips[${i}] ${JSON.stringify(s.name)}: [${s.start}, ${s.end}] must satisfy 0 ≤ start < end ≤ ${duration}`);
  });
  return problems;
}

export interface SlicePlan {
  create: Omit<SliceRecord, "id">[];
  update: (Pick<SliceRecord, "id"> & Partial<SliceRecord>)[];
  delete: string[];
}

/** Edited clips vs the clip's slice records: what to create, update and delete (by slice id). */
export function planSlices(clipId: string, existing: SliceRecord[], edited: SavedClip[]): SlicePlan {
  const byId = new Map(existing.map((s) => [s.id, s]));
  const kept = new Set<string>();
  const plan: SlicePlan = { create: [], update: [], delete: [] };
  for (const c of edited) {
    const old = c.id ? byId.get(c.id) : undefined;
    const source = c.source === "ml" ? "ml" : old?.source === "curated" ? "curated" : "user";
    if (!old) {
      plan.create.push({ clipId, name: c.name, start: c.start, end: c.end, source, ...(c.tags ? { tags: c.tags } : {}) });
      continue;
    }
    kept.add(old.id);
    if (old.name !== c.name || old.start !== c.start || old.end !== c.end || old.source !== source) {
      plan.update.push({ id: old.id, name: c.name, start: c.start, end: c.end, source });
    }
  }
  // Retired slices never reach the editor; they stay for the scores that still use them.
  for (const s of existing) if (!kept.has(s.id) && !s.retired) plan.delete.push(s.id);
  return plan;
}

// ------------------------------------------------------------------ the catalog

export interface CatalogDeps {
  /** The generated Amplify data client (`client()` from data/client.ts). */
  client: () => any;
  /** A library file's text (files.ts downloadData). */
  readText: (key: string) => Promise<string>;
  /** A URL for a library file (files.ts getUrl). */
  url: (key: string) => Promise<string>;
}

interface Index {
  clips: ClipRecord[];
  byPath: Map<string, ClipRecord>;
  summaries: SampleSummary[];
  jobs: { path: string; state: string; error?: string }[];
}

export class Catalog {
  private index: Promise<Index> | null = null;
  private scoreList: Promise<ScoreRecord[]> | null = null;
  constructor(private deps: CatalogDeps) {}

  /** Forget everything cached (after sign-in or sign-out, or a save). */
  reset() {
    this.index = null;
    this.scoreList = null;
  }

  private get models() {
    return this.deps.client().models;
  }

  private load(): Promise<Index> {
    this.index ??= (async () => {
      const m = this.models;
      const [clips, recordings, slices, markers, jobs] = await Promise.all([
        listAll<ClipRecord>((nextToken) => m.Clip.list({ limit: 1000, nextToken })),
        listAll<RecordingRecord>((nextToken) => m.Recording.list({ limit: 1000, nextToken })),
        listAll<SliceRecord>((nextToken) => m.Slice.list({ limit: 1000, nextToken, selectionSet: ["id", "clipId", "retired"] })),
        listAll<MarkerRecord>((nextToken) => m.Marker.list({ limit: 1000, nextToken, selectionSet: ["id", "clipId"] })),
        listAll<JobRecord>((nextToken) => m.Job.list({ limit: 1000, nextToken })),
      ]);
      const count = (xs: { clipId: string; retired?: boolean | null }[]) => {
        const n = new Map<string, number>();
        for (const x of xs) if (!x.retired) n.set(x.clipId, (n.get(x.clipId) ?? 0) + 1);
        return n;
      };
      const counts = { slices: count(slices), markers: count(markers) };
      const recs = new Map(recordings.map((r) => [r.id, r]));
      const byId = new Map(clips.map((c) => [c.id, c]));
      const byPath = new Map<string, ClipRecord>();
      for (const c of clips) for (const p of [samplePath(c), c.path, ...(c.aliases ?? [])]) byPath.set(p, c);
      const analysed = clips.filter((c) => c.analysis?.key);
      const state = (s: JobRecord["state"]) => (s === "running" ? "analyzing" : s ?? "queued");
      return {
        clips,
        byPath,
        summaries: sortSummaries(analysed.map((c) => toSummary(c, recs, byId, counts))),
        jobs: jobs
          .filter((j) => j.kind === "analyze")
          .map((j) => {
            const c = j.clipId ? byId.get(j.clipId) : undefined;
            return { path: c ? samplePath(c) : j.clipId ?? j.id, state: state(j.state), ...(j.error ? { error: j.error } : {}) };
          }),
      };
    })();
    this.index.catch(() => (this.index = null)); // a failed load (e.g. signed out) is retried next time
    return this.index;
  }

  async samples() {
    const i = await this.load();
    return { samples: i.summaries, unanalyzed: i.clips.filter((c) => !c.analysis?.key).map(samplePath), jobs: i.jobs };
  }

  /** The clip record a sample path (or catalog alias) names. */
  async clip(path: string): Promise<ClipRecord | null> {
    const i = await this.load();
    return i.byPath.get(path) ?? i.byPath.get(path.replace(/^samples\//, "")) ?? null;
  }

  async manifest(path: string): Promise<Manifest | null> {
    const c = await this.clip(path);
    if (!c?.analysis?.key) return null;
    const m = this.models;
    const [text, slices, markers] = await Promise.all([
      this.deps.readText(c.analysis.key),
      listAll<SliceRecord>((nextToken) => m.Slice.slicesByClip({ clipId: c.id }, { limit: 1000, nextToken })),
      listAll<MarkerRecord>((nextToken) => m.Marker.markersByClip({ clipId: c.id }, { limit: 1000, nextToken })),
    ]);
    return toManifest(JSON.parse(text) as Manifest, slices, markers);
  }

  /** A URL for a sample's audio (a signed S3 URL in the cloud; Range requests work on both). */
  async audioUrl(path: string): Promise<string> {
    const c = await this.clip(path);
    if (!c) throw new Error(`${path}: not in the library`);
    return this.deps.url(c.audio.key);
  }

  private listScores(): Promise<ScoreRecord[]> {
    this.scoreList ??= listAll<ScoreRecord>((nextToken) => this.models.Score.list({ limit: 1000, nextToken }));
    this.scoreList.catch(() => (this.scoreList = null));
    return this.scoreList;
  }

  async scores(): Promise<{ scores: { path: string; modified: number }[] }> {
    const list = await this.listScores();
    const scores = list.map((s) => ({ path: scorePath(s), modified: s.updatedAt ? Date.parse(s.updatedAt) / 1000 : 0 }));
    return { scores: scores.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  }

  async score(path: string): Promise<string> {
    const found = (await this.listScores()).find((s) => scorePath(s) === path);
    if (found) return found.text;
    const r = await this.models.Score.get({ id: scoreKey(path).id });
    if (r.errors?.length) fail(r.errors);
    if (!r.data) throw new Error(`${path}: no such score`);
    return r.data.text;
  }

  /**
   * Save a score's text. A new path first gets its Score record (id, title and folder from the
   * path), then `save` (data/domain.ts saveScore) updates the text and its ScoreRefs.
   */
  async saveScore(path: string, text: string, save: (id: string, text: string) => Promise<{ errors?: GqlError[] }>) {
    const k = scoreKey(path);
    const existing = (await this.listScores()).find((s) => scorePath(s) === path);
    const id = existing?.id ?? k.id;
    if (!existing) {
      const got = await this.models.Score.get({ id });
      if (got.errors?.length) fail(got.errors);
      if (!got.data) {
        const r = await this.models.Score.create({ id, title: k.title, folder: k.folder, format: k.format, text });
        if (r.errors?.length) fail(r.errors, true);
      }
    }
    const r = await save(id, text);
    this.scoreList = null;
    if (r.errors?.length) fail(r.errors, true);
    return { ok: true };
  }

  /** Save the clips edited on a sample as Slice records (created, updated or deleted one by one). */
  async saveClips(path: string, clips: SavedClip[]) {
    const c = await this.clip(path);
    if (!c) throw new Error(`${path}: not in the library`);
    const problems = validateClips(clips, c.duration ?? Infinity);
    if (problems.length) throw Object.assign(new Error(problems.join("\n")), { errors: problems });
    const m = this.models;
    const existing = await listAll<SliceRecord>((nextToken) => m.Slice.slicesByClip({ clipId: c.id }, { limit: 1000, nextToken }));
    const plan = planSlices(c.id, existing, clips);
    const check = (r: { errors?: GqlError[] }) => r.errors?.length && fail(r.errors, true);
    for (const id of plan.delete) check(await m.Slice.delete({ id }));
    for (const u of plan.update) check(await m.Slice.update(u));
    for (const s of plan.create) check(await m.Slice.create({ id: `slc_${crypto.randomUUID()}`, ...s }));
    this.index = null;
    return { ok: true };
  }
}
