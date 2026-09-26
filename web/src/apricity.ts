// Page-side Apricity: compiling scores (wasm) and reading the library through the data layer.

import { instantiate, type Apricity } from "./wasm/shim.js";
import { Catalog, NEEDS_ANALYSIS_LOCAL, NEEDS_ANALYSIS_SERVER, SignedOut, type Me, type ScoreKind } from "./data/catalog.js";
import type { Ratings } from "./data/ratings.js";
export type { ClipItem } from "./data/catalog.js";

/** A sample in the library: an analyzed audio file. */
export interface SampleSummary {
  /** The Sample record's id (what ratings name). */
  id: string;
  createdAt?: string | null;
  path: string;
  title: string;
  group: string;
  excerpt_start?: string;
  credit?: string;
  rights?: string;
  duration: number;
  bpm: number | null;
  stability?: number;
  meter?: number;
  key: string;
  camelot?: string;
  keys_over_time: string[];
  tuning_cents?: number;
  notes: number;
  clips: number; // clips saved with it
  markers: number;
  stem?: string | null;
}

/** A clip saved with a sample: a named region (yours, or automatic markup's). */
export interface SavedClip {
  name: string;
  start: number;
  end: number;
  source?: "user" | "ml";
  tags?: string[];
  id?: string; // its Clip record, when it has one
  retired?: boolean; // no longer proposed, kept for the scores that use it
  candidate?: string;
  owner?: string; // who made it (cloud records)
}
export interface Marker {
  name: string;
  seconds: number;
  source?: "user" | "ml";
  note?: string;
}
export interface Manifest {
  source: { path: string; duration: number; sample_rate: number; channels: number };
  rhythm: { bpm: number | null; bpm_stability?: number; beats: number[]; downbeats: number[]; meter: number | null };
  tonal: {
    key: { tonic: string; mode: string; camelot?: string; strength: number };
    alternatives?: { tonic: string; mode: string; strength: number }[];
    tuning_hz: number;
    tuning_cents?: number;
    segments?: { start: number; end: number; key: { tonic: string; mode: string } }[];
    pitch_class_profile: number[];
  };
  notes?: unknown[];
  annotations?: { clips?: SavedClip[]; markers?: Marker[]; tags?: string[] };
}

/** One sound a track can play (its clip's region, or a pad: a slice or a clip), and where it's recorded. */
export interface TimelinePiece {
  source: number; // index into sources
  src_start: number; // seconds
  src_end: number;
  name?: string; // a drum-kit pad
}

export interface TimelineEvent {
  track: string;
  source: number;
  start_beat: number;
  dur_beats: number;
  src_start: number;
  src_end: number;
  semitones: number;
  piece?: number; // index into its track's pieces
  reverse?: boolean;
}

/** What the harmony solver knows about a track (absent when it plays re-pitched). */
export interface TrackVoice {
  name: string;
  pcp: number[];
  tonic?: number;
  role?: string;
  transpose?: "auto" | "follow" | number;
}

export interface Timeline {
  tempo: number;
  meter: number;
  key: string;
  length_beats: number;
  sources: { clip: string; path: string; bpm?: number | null; key?: string; region?: [number, number] }[];
  events: TimelineEvent[];
  harmony: { start_beat: number; end_beat: number; label: string; fit: { chord: string; coverage: number } | null }[];
  tracks: { name: string; clip: string; region_key: string; kit?: string; chops?: number; pieces?: TimelinePiece[]; voice?: TrackVoice; pitch?: string }[];
  warnings: string[];
}

export type CompileResult = { timeline: Timeline; explain: string; errors?: undefined } | { errors: string[]; timeline?: undefined };

let wasmModule: Promise<WebAssembly.Module> | null = null;
export function apricityModule(): Promise<WebAssembly.Module> {
  wasmModule ??= WebAssembly.compileStreaming(fetch("/apricity_web.wasm"));
  return wasmModule;
}

let compiler: Promise<Apricity> | null = null;
function getCompiler() {
  compiler ??= apricityModule().then(instantiate);
  return compiler;
}

const manifestCache = new Map<string, Promise<Manifest | null>>();
/** A sample's manifest (analysis + annotations), rebuilt from its library records. */
export function manifest(audioPath: string, fresh = false): Promise<Manifest | null> {
  if (fresh || !manifestCache.has(audioPath)) {
    const p = catalog().manifest(audioPath);
    p.catch(() => manifestCache.delete(audioPath));
    manifestCache.set(audioPath, p);
  }
  return manifestCache.get(audioPath)!;
}

/** Where a sample's audio can be fetched (with Range): /files/<key> locally, a signed URL in the cloud. */
export const audioUrl = (path: string) => catalog().audioUrl(path);

/** What the Beat editor's grid needs from a score's text (kits, pads, step tracks and their lines). */
export async function stepsView(text: string): Promise<import("./ui/beat/model").StepsView> {
  return (await getCompiler()).call("rw_steps", text);
}

/** What the piano roll needs from a score's text (the key's scale, and the `notes` tracks with their lines). */
export async function melodyView(text: string): Promise<import("./ui/melody/model").MelodyView> {
  return (await getCompiler()).call("rw_melody", text);
}

/** What the chord harp needs from a score's text (key, palette, progression, strings and their lines). */
export async function chordsView(text: string): Promise<import("./ui/chords/model").ChordsView> {
  return (await getCompiler()).call("rw_chords", text);
}

/** How well a compiled score's strings (its tracks' voices) fit each chord: the harmony solver's score and coverage. */
export async function chordFits(key: string, voices: TrackVoice[], labels: string[]): Promise<{ label: string; name: string; score: number; coverage: number; voices: { name: string; semitones: number; on_chord: number }[] }[]> {
  const r = (await getCompiler()).call("rw_fit", key, JSON.stringify(voices), JSON.stringify(labels));
  if (r.errors) throw new Error(r.errors.join("; "));
  return r.fits;
}

/** Compile a score: find its sources, fetch their manifests, compile in wasm. */
export async function compile(yaml: string, scorePath: string): Promise<CompileResult> {
  const rw = await getCompiler();
  const s = rw.call("rw_sources", yaml, scorePath);
  if (s.errors) return { errors: s.errors };
  const manifests: Record<string, Manifest> = {};
  try {
    await Promise.all(
      (s.sources as string[]).map(async (p) => {
        const m = await manifest(p);
        if (m) manifests[p] = m;
      }),
    );
  } catch (e) {
    return { errors: [e instanceof SignedOut ? "Sign in to compile scores against the library." : `Couldn't load the samples: ${(e as Error).message}`] };
  }
  return rw.call("rw_compile", yaml, scorePath, JSON.stringify(manifests));
}

// ------------------------------------------------------------------ library data

let catalogInstance: Catalog | null = null;
/** The library catalog over the data layer (loaded lazily, so tests can import this module). */
function catalog(): Catalog {
  if (!catalogInstance) throw new Error("the data layer is not ready yet");
  return catalogInstance;
}

/** Wire the catalog to the data layer; main.ts's bootstrap() must have run. */
export async function connectCatalog() {
  if (catalogInstance) return catalogInstance;
  const [{ client }, files] = await Promise.all([import("./data/client.js"), import("./data/files.js")]);
  catalogInstance = new Catalog({
    client,
    readText: async (key) => (await files.downloadData({ path: key })).text(),
    url: async (key) => (await files.getUrl({ path: key })).url,
    // Locally every record is editable (null); in the cloud, the signed-in person.
    me: async () => ((await import("./data/client.js")).mode() === "local" ? null : me()),
  });
  // Sign-in or sign-out changes what may be read: forget what was loaded.
  document.addEventListener("apricity:auth-changed", () => (catalogInstance?.reset(), manifestCache.clear()));
  return catalogInstance;
}

const ready = () => connectCatalog();

let ratingsInstance: Promise<Ratings> | null = null;
/** Star ratings (your own, and everyone's tallies). */
export function ratings(): Promise<Ratings> {
  ratingsInstance ??= (async () => {
    const [{ client, mode }, auth, { Ratings }] = await Promise.all([import("./data/client.js"), import("./data/auth.js"), import("./data/ratings.js")]);
    const r = new Ratings({
      client,
      mode,
      // Locally everyone is the library's one identity; in the cloud, the Cognito username (what AppSync stores).
      who: async () => (mode() === "local" ? "local" : ((await auth.currentAccount())?.username ?? null)),
    });
    document.addEventListener("apricity:auth-changed", () => r.reset());
    return r;
  })();
  return ratingsInstance;
}

/** Who is signed in, as records name their owner; null for a guest. Locally, the library's one identity. */
export async function me(): Promise<Me | null> {
  const { mode } = await import("./data/client.js");
  if (mode() === "local") return { owners: ["local"], curator: true };
  const a = await (await import("./data/auth.js")).currentAccount();
  return a ? { owners: [a.username, `${a.sub}::${a.username}`], curator: a.groups.includes("curators") } : null;
}

export const api = {
  samples: async () => (await ready()).samples(),
  scores: async () => (await ready()).scores(),
  clips: async () => (await ready()).clips(),
  score: async (path: string) => (await ready()).score(path),
  saveScore: async (path: string, text: string, kind?: ScoreKind) => {
    const { saveScore } = await import("./data/domain.js");
    return (await ready()).saveScore(path, text, saveScore, kind);
  },
  setScoreKind: async (path: string, kind: ScoreKind) => (await ready()).setScoreKind(path, kind),
  /** Saves the clips (as Clip records); markers and tags are not edited here. */
  saveAnnotations: async (path: string, ann: Manifest["annotations"]) => {
    const r = await (await ready()).saveClips(path, ann?.clips ?? []);
    manifestCache.delete(path);
    return r;
  },
  upload: async (_file: File): Promise<{ path: string; state: string }> => {
    const { mode } = await import("./data/client.js");
    throw new Error(mode() === "cloud" ? NEEDS_ANALYSIS_SERVER : NEEDS_ANALYSIS_LOCAL);
  },
};

// ------------------------------------------------------------------ data layer wasm helpers

/**
 * Call a wasm data function (rw_ids, rw_rank, rw_markup_merge).
 * Input and output are JSON objects; errors are returned in the result.
 */
export async function callWasm(
  funcName: "rw_ids" | "rw_rank" | "rw_markup_merge",
  input: unknown
): Promise<{ data?: unknown; errors?: string[] }> {
  const rw = await getCompiler();
  const result = rw.call(funcName, JSON.stringify(input));
  return result;
}

/**
 * Extract sources from a score (for finding clips to load).
 */
export async function extractSources(yaml: string, scorePath: string): Promise<{ sources?: string[]; errors?: string[] }> {
  const rw = await getCompiler();
  return rw.call("rw_sources", yaml, scorePath);
}

/**
 * Extract score references: the samples and saved clips a score uses.
 */
export async function extractReferences(
  text: string,
  folder: string,
  file: string
): Promise<{
  data?: Array<{
    idSuffix: string;
    alias: string;
    source: string;
    catalogPath?: string;
    sampleId?: string;
    clipName?: string;
    clipId?: string;
    kitPad?: string;
  }>;
  errors?: string[];
}> {
  const rw = await getCompiler();
  const result = rw.call("rw_references", JSON.stringify({ text, folder, file }));
  return result;
}
