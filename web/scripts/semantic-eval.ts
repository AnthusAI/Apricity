#!/usr/bin/env tsx
/** Validates raw evidence captured by web/semantic-eval.html; never performs inference. */
import { readFile } from "node:fs/promises";
import { EVALUATION_PROMPTS, isNormalizedVector512, isVector512, MINIMUM_REFERENCE_AUDIO_ENTRIES, promptListHash } from "../src/semantic/encoder-evaluation-contract";

export const FIXED_PROMPTS = EVALUATION_PROMPTS;
export const PINNED_MANIFEST = { embeddingSpace: "clap-htsat-unfused-512-v1", modelId: "Xenova/clap-htsat-unfused", revision: "c28f2883575e590e04d3146ff0713c2448d691ba", runtime: "@huggingface/transformers@3.8.1", architecture: "ClapTextModelWithProjection", dtype: "q8", device: "wasm" } as const;
type Vector = number[];
type Reference = { schemaVersion: 1; embeddingSpace: string; prompts: { text: string; vector512: Vector }[]; audio: { semanticId: string; vector512: Vector }[] };
type PromptMeasurement = { prompt: string; browserVector512: Vector; cosine?: number; browserTop20?: string[]; pythonTop20?: string[] };
type DeviceMeasurement = { device: string; browser: string; userAgent: string; hardwareConcurrency: number; cacheState: "cold" | "warm" | "memory_fallback"; cacheStorage: "available" | "unavailable"; cacheStorageError?: string; coldMs: number[]; warmMs: number[]; prompts: PromptMeasurement[] };
export type BrowserEvaluationReport = { schemaVersion: 1; status: "evaluated"; pinnedManifest: typeof PINNED_MANIFEST; referencePromptListHash: string; reference: Reference; desktop?: DeviceMeasurement; mobile?: DeviceMeasurement };
type GateResult = { status: "pass" | "fail" | "not_evaluated"; reasons: string[]; prompts?: Array<{ prompt: string; cosine: number; top20Retention: number }>; meanTop20Retention?: number; desktopP95Ms?: number; mobileP95Ms?: number };

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validVector(value: unknown): value is Vector { return isVector512(value); }
function normalized(value: Vector): boolean { return isNormalizedVector512(value); }
export function cosine(a: Vector, b: Vector): number { return a.reduce((sum, value, index) => sum + value * b[index], 0); }
export function top20(vector: Vector, audio: Reference["audio"]): string[] { return [...audio].map(({ semanticId, vector512 }) => ({ semanticId, score: cosine(vector, vector512) })).sort((a, b) => b.score - a.score || a.semanticId.localeCompare(b.semanticId)).slice(0, 20).map((item) => item.semanticId); }
export { promptListHash };
function p95(values: unknown): number | undefined { if (!Array.isArray(values) || !values.length || !values.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)) return undefined; const ordered = [...values].sort((a, b) => a - b); return ordered[Math.ceil(ordered.length * .95) - 1]; }
function sameArray(a: unknown[], b: readonly string[]): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }

export function evaluateBrowserReport(report: BrowserEvaluationReport): GateResult {
  const reasons: string[] = []; const raw: any = report;
  let missingMeasurement = false;
  if (!isRecord(raw) || raw.schemaVersion !== 1) reasons.push("schemaVersion must be 1");
  if (raw?.status !== "evaluated") reasons.push("status must be evaluated");
  if (!isRecord(raw?.pinnedManifest) || Object.entries(PINNED_MANIFEST).some(([field, value]) => raw.pinnedManifest[field] !== value)) reasons.push("pinnedManifest does not match approved encoder");
  const reference = raw?.reference as Reference;
  if (!isRecord(reference) || reference.schemaVersion !== 1 || reference.embeddingSpace !== PINNED_MANIFEST.embeddingSpace || !Array.isArray(reference.prompts) || !Array.isArray(reference.audio)) reasons.push("reference JSON is invalid");
  const promptTexts = Array.isArray(reference?.prompts) ? reference.prompts.map((item: any) => item?.text) : [];
  if (!sameArray(promptTexts, FIXED_PROMPTS) || raw?.referencePromptListHash !== promptListHash(FIXED_PROMPTS)) reasons.push("reference must contain the six fixed prompts in order with matching list hash");
  if (!Array.isArray(reference?.audio) || reference.audio.length < MINIMUM_REFERENCE_AUDIO_ENTRIES || new Set(reference?.audio?.map((item: any) => item?.semanticId)).size !== reference?.audio?.length || !reference?.audio?.every((item: any) => typeof item?.semanticId === "string" && item.semanticId && validVector(item.vector512) && normalized(item.vector512))) reasons.push(`reference must contain at least ${MINIMUM_REFERENCE_AUDIO_ENTRIES} unique normalized audio vectors`);
  if (!reference?.prompts?.every((item: any) => typeof item?.text === "string" && validVector(item.vector512) && normalized(item.vector512))) reasons.push("reference prompt vectors must be normalized finite 512D vectors");
  const checked: Array<{ prompt: string; cosine: number; top20Retention: number }> = [];
  for (const kind of ["desktop", "mobile"] as const) {
    const measurement = raw?.[kind] as DeviceMeasurement | undefined;
    if (!measurement) { missingMeasurement = true; reasons.push(`${kind} measurement is not_evaluated`); continue; }
    if (typeof measurement.device !== "string" || !measurement.device.trim() || typeof measurement.browser !== "string" || !measurement.browser.trim() || typeof measurement.userAgent !== "string" || !measurement.userAgent.trim() || !Number.isFinite(measurement.hardwareConcurrency) || measurement.hardwareConcurrency < 1) reasons.push(`${kind} device/browser metadata is incomplete`);
    if (measurement.cacheState !== "warm") reasons.push(`${kind} warm cache evidence is missing`);
    if (measurement.cacheStorage !== "available" && measurement.cacheStorage !== "unavailable") reasons.push(`${kind} CacheStorage probe evidence is missing`);
    else if (measurement.cacheState === "memory_fallback" && (measurement.cacheStorage !== "unavailable" || typeof measurement.cacheStorageError !== "string" || !measurement.cacheStorageError.trim())) reasons.push(`${kind} memory fallback must include the CacheStorage probe error`);
    else if (measurement.cacheState === "warm" && measurement.cacheStorage !== "available") reasons.push(`${kind} cannot claim warm cache evidence after a blocked CacheStorage probe`);
    const warm = p95(measurement.warmMs); const cold = p95(measurement.coldMs);
    if (warm === undefined || cold === undefined) reasons.push(`${kind} timings must be nonnegative finite raw values`);
    else if (warm > (kind === "desktop" ? 2000 : 5000)) reasons.push(`${kind} warm p95 exceeds ${kind === "desktop" ? 2000 : 5000}ms`);
    if (!Array.isArray(measurement.prompts) || measurement.prompts.length !== FIXED_PROMPTS.length) { reasons.push(`${kind} must include exactly six fixed prompt measurements`); continue; }
    for (const [index, measured] of measurement.prompts.entries()) {
      const ref = reference?.prompts?.[index];
      if (!ref || measured?.prompt !== ref.text || !validVector(measured?.browserVector512) || !normalized(measured.browserVector512)) { reasons.push(`${kind} prompt ${index + 1} is not a normalized fixed-prompt vector`); continue; }
      const actualCosine = cosine(measured.browserVector512, ref.vector512); const browserIds = top20(measured.browserVector512, reference.audio); const pythonIds = top20(ref.vector512, reference.audio);
      if (new Set(browserIds).size !== 20 || new Set(pythonIds).size !== 20) reasons.push(`${kind} ${measured.prompt}: top-20 must contain exactly 20 unique IDs`);
      if (measured.cosine !== undefined && (!Number.isFinite(measured.cosine) || Math.abs(measured.cosine - actualCosine) > 1e-9)) reasons.push(`${kind} ${measured.prompt}: asserted cosine does not match raw vectors`);
      if (measured.browserTop20 && !sameArray(measured.browserTop20, browserIds)) reasons.push(`${kind} ${measured.prompt}: browser top-20 does not match raw vectors`);
      if (measured.pythonTop20 && !sameArray(measured.pythonTop20, pythonIds)) reasons.push(`${kind} ${measured.prompt}: Python top-20 does not match reference vectors`);
      if (actualCosine < .98) reasons.push(`${kind} ${measured.prompt}: cosine below 0.98`);
      checked.push({ prompt: measured.prompt, cosine: actualCosine, top20Retention: browserIds.filter((id) => pythonIds.includes(id)).length / 20 });
    }
  }
  const meanTop20Retention = checked.length ? checked.reduce((sum, item) => sum + item.top20Retention, 0) / checked.length : undefined;
  if (meanTop20Retention !== undefined && meanTop20Retention < .9) reasons.push("mean top-20 retention below 0.90");
  const substantiveReasons = reasons.filter((reason) => !reason.endsWith("measurement is not_evaluated"));
  return { status: substantiveReasons.length ? "fail" : missingMeasurement ? "not_evaluated" : "pass", reasons, prompts: checked, meanTop20Retention, desktopP95Ms: p95(raw?.desktop?.warmMs), mobileP95Ms: p95(raw?.mobile?.warmMs) };
}
export async function runBrowserFeasibility(argv: string[]): Promise<GateResult> { const index = argv.indexOf("--report"); if (index < 0 || !argv[index + 1]) return { status: "not_evaluated", reasons: ["missing --report from a real Apricity browser run"] }; try { return evaluateBrowserReport(JSON.parse(await readFile(argv[index + 1], "utf8")) as BrowserEvaluationReport); } catch (error) { return { status: "not_evaluated", reasons: [`browser report unavailable: ${error instanceof Error ? error.message : String(error)}`] }; } }
if (import.meta.url === new URL(process.argv[1], "file:").href) { const result = await runBrowserFeasibility(process.argv.slice(2)); console.log(JSON.stringify(result)); if (result.status !== "pass") process.exitCode = 1; }
