// Page-side Apricity: compiling scores (wasm) and talking to the local server.

import { instantiate, type Apricity } from "./wasm/shim.js";

export interface ClipSummary {
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
  slices: number;
  markers: number;
}

export interface Slice {
  name: string;
  start: number;
  end: number;
  source?: "user" | "ml";
  tags?: string[];
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
  annotations?: { slices?: Slice[]; markers?: Marker[]; tags?: string[] };
}

/** One sound a track can play (its clip's region, a chop, or a pad), and where it's recorded. */
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

export interface Timeline {
  tempo: number;
  meter: number;
  key: string;
  length_beats: number;
  sources: { clip: string; path: string; bpm?: number | null; key?: string; region?: [number, number] }[];
  events: TimelineEvent[];
  harmony: { start_beat: number; end_beat: number; label: string; fit: { chord: string; coverage: number } | null }[];
  tracks: { name: string; clip: string; region_key: string; kit?: string; chops?: number; pieces?: TimelinePiece[] }[];
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
export function manifest(audioPath: string, fresh = false): Promise<Manifest | null> {
  if (fresh || !manifestCache.has(audioPath)) {
    manifestCache.set(audioPath, fetch(`/files/${encodePath(audioPath)}.apricity.json`).then((r) => (r.ok ? r.json() : null)));
  }
  return manifestCache.get(audioPath)!;
}

export function encodePath(p: string) {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** Compile a score: find its sources, fetch their manifests, compile in wasm. */
export async function compile(yaml: string, scorePath: string): Promise<CompileResult> {
  const rw = await getCompiler();
  const s = rw.call("rw_sources", yaml, scorePath);
  if (s.errors) return { errors: s.errors };
  const manifests: Record<string, Manifest> = {};
  await Promise.all(
    (s.sources as string[]).map(async (p) => {
      const m = await manifest(p);
      if (m) manifests[p] = m;
    }),
  );
  return rw.call("rw_compile", yaml, scorePath, JSON.stringify(manifests));
}

// ------------------------------------------------------------------ server

async function json<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.detail ?? body.errors?.join("\n") ?? r.statusText), { errors: body.errors });
  return body;
}

export const api = {
  clips: () => fetch("/api/clips").then((r) => json<{ clips: ClipSummary[]; unanalyzed: string[]; jobs: { path: string; state: string; error?: string }[] }>(r)),
  scores: () => fetch("/api/scores").then((r) => json<{ scores: { path: string; modified: number }[] }>(r)),
  score: (path: string) => fetch(`/files/${encodePath(path)}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${path}: ${r.status}`)))),
  saveScore: (path: string, text: string) => fetch(`/api/score?path=${encodeURIComponent(path)}`, { method: "PUT", body: text }).then(json),
  saveAnnotations: (path: string, ann: Manifest["annotations"]) =>
    fetch(`/api/annotations?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ann) }).then(json),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return fetch("/api/upload", { method: "POST", body: fd }).then((r) => json<{ path: string; state: string }>(r));
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
 * Extract score references: clips and slices referenced in score text.
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
    clipId?: string;
    sliceName?: string;
    sliceId?: string;
    kitPad?: string;
  }>;
  errors?: string[];
}> {
  const rw = await getCompiler();
  const result = rw.call("rw_references", JSON.stringify({ text, folder, file }));
  return result;
}
