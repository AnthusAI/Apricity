import { CLAP_BROWSER_MANIFEST, type EncoderEvent } from "../src/semantic/encoder";
import { probeCacheStorage } from "../src/semantic/encoder-evaluation-cache";
import { EVALUATION_PROMPTS, isNormalizedVector512, isVector512, MINIMUM_REFERENCE_AUDIO_ENTRIES, promptListHash } from "../src/semantic/encoder-evaluation-contract";
import { requestWorkerEncoding } from "../src/semantic/encoder-evaluation-worker-request";

const PROMPTS = EVALUATION_PROMPTS;
type Vector = number[];
type Reference = { schemaVersion: 1; embeddingSpace: string; prompts: { text: string; vector512: Vector }[]; audio: { semanticId: string; vector512: Vector }[] };
type Evidence = Record<string, unknown>;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const referenceInput = $<HTMLInputElement>("reference"), previousInput = $<HTMLInputElement>("previous"), deviceInput = $<HTMLSelectElement>("device");
const runButton = $<HTMLButtonElement>("run"), downloadButton = $<HTMLButtonElement>("download"), progress = $("progress"), result = $("result"), warning = $("cache-warning");
let reference: Reference | undefined, evidence: Evidence | undefined;

function vector(value: unknown): value is Vector { return isVector512(value); }
function normalized(value: Vector) { return isNormalizedVector512(value); }
function cosine(a: Vector, b: Vector) { return a.reduce((sum, value, index) => sum + value * b[index], 0); }
function top20(query: Vector, audio: Reference["audio"]) { return [...audio].map((item) => ({ id: item.semanticId, score: cosine(query, item.vector512) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 20).map((item) => item.id); }
function requireReference(value: unknown): Reference {
  const ref = value as Reference;
  if (!ref || ref.schemaVersion !== 1 || ref.embeddingSpace !== CLAP_BROWSER_MANIFEST.embeddingSpace || !Array.isArray(ref.prompts) || !Array.isArray(ref.audio) || ref.audio.length < MINIMUM_REFERENCE_AUDIO_ENTRIES || new Set(ref.audio.map((item) => item?.semanticId)).size !== ref.audio.length || !ref.audio.every((item) => typeof item?.semanticId === "string" && vector(item.vector512) && normalized(item.vector512)) || ref.prompts.length !== PROMPTS.length || !ref.prompts.every((item, index) => item?.text === PROMPTS[index] && vector(item.vector512) && normalized(item.vector512))) throw new Error(`Reference must be schema v1, have the six fixed prompts in order, and at least ${MINIMUM_REFERENCE_AUDIO_ENTRIES} unique normalized audio vectors.`);
  return ref;
}
async function jsonFile(input: HTMLInputElement) { const file = input.files?.[0]; return file ? JSON.parse(await file.text()) : undefined; }
function browserLabel() { const ua = navigator.userAgent; if (/Firefox\//.test(ua)) return "Firefox"; if (/Edg\//.test(ua)) return "Edge"; if (/Chrome\//.test(ua)) return "Chrome"; if (/Safari\//.test(ua)) return "Safari"; return "Unknown browser"; }
function setProgress(message: string) { progress.textContent = message; }

referenceInput.addEventListener("change", async () => {
  try { reference = requireReference(await jsonFile(referenceInput)); runButton.disabled = false; result.textContent = "Reference accepted. Run explicitly to collect browser evidence."; }
  catch (error) { reference = undefined; runButton.disabled = true; result.textContent = error instanceof Error ? error.message : String(error); }
});
previousInput.addEventListener("change", async () => { try { evidence = await jsonFile(previousInput); setProgress("Prior evidence loaded; the new device measurement will be combined."); } catch { evidence = undefined; setProgress("Prior evidence could not be read; a fresh evidence file will be created."); } });

function workerRequest(worker: Worker, text: string, bypassCache: boolean, onProgress: (event: Extract<EncoderEvent, { type: "progress" }>) => void): Promise<{ vector: Vector; ms: number }> {
  return requestWorkerEncoding(worker, { requestId: crypto.randomUUID(), text, bypassCache }, onProgress);
}

runButton.addEventListener("click", async () => {
  if (!reference) return;
  runButton.disabled = true; downloadButton.hidden = true;
  const cacheProbe = await probeCacheStorage(typeof caches === "undefined" ? undefined : caches);
  const cache = cacheProbe.available ? "warm" as const : "memory_fallback" as const;
  warning.hidden = cacheProbe.available;
  warning.textContent = cacheProbe.available ? "" : `CacheStorage could not be used (${cacheProbe.error}); continuing with the bounded in-memory query cache. Persistent cache evidence is unavailable.`;
  const worker = new Worker(new URL("../src/semantic/encoder-worker.ts", import.meta.url), { type: "module" });
  try {
    setProgress("Cold run: loading the pinned encoder and collecting six vectors…");
    const coldMs: number[] = [], measurements: Array<{ prompt: string; browserVector512: Vector; cosine: number; browserTop20: string[]; pythonTop20: string[] }> = [];
    for (const prompt of reference.prompts) {
      const encoded = await workerRequest(worker, prompt.text, false, (event) => setProgress(`Cold run ${prompt.text}: ${event.phase} ${event.loaded}${event.total ? `/${event.total}` : ""}`));
      if (!vector(encoded.vector) || !normalized(encoded.vector)) throw new Error(`Worker returned an invalid vector for ${prompt.text}`);
      coldMs.push(encoded.ms); measurements.push({ prompt: prompt.text, browserVector512: encoded.vector, cosine: cosine(encoded.vector, prompt.vector512), browserTop20: top20(encoded.vector, reference.audio), pythonTop20: top20(prompt.vector512, reference.audio) });
    }
    const warmMs: number[] = [];
    for (let index = 0; index < 20; index++) {
      const prompt = PROMPTS[index % PROMPTS.length]; setProgress(`Warm inference ${index + 1}/20 (query cache bypassed)…`);
      warmMs.push((await workerRequest(worker, prompt, true, () => {})).ms);
    }
    const kind = deviceInput.value as "desktop" | "mobile";
    const base = evidence && typeof evidence === "object" ? evidence : {};
    evidence = { ...base, schemaVersion: 1, status: "evaluated", pinnedManifest: CLAP_BROWSER_MANIFEST, referencePromptListHash: promptListHash(PROMPTS), reference, [kind]: { device: kind, browser: browserLabel(), userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency || 1, cacheState: cache, cacheStorage: cacheProbe.available ? "available" : "unavailable", ...(cacheProbe.available ? {} : { cacheStorageError: cacheProbe.error }), coldMs, warmMs, prompts: measurements } };
    result.textContent = JSON.stringify({ status: "evaluated", device: kind, coldSamples: coldMs.length, warmSamples: warmMs.length, cacheState: cache }, null, 2);
    setProgress("Evidence captured. Download the raw JSON; run the other device later with this file selected to combine.");
    downloadButton.hidden = false;
  } catch (error) { result.textContent = JSON.stringify({ status: "fail", reason: error instanceof Error ? error.message : String(error) }, null, 2); setProgress("Inference failed. No substitute model was used; use Run browser inference to retry."); }
  finally { worker.terminate(); runButton.disabled = false; }
});
downloadButton.addEventListener("click", () => { const blob = new Blob([JSON.stringify(evidence, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `apricity-semantic-evidence-${deviceInput.value}.json`; link.click(); URL.revokeObjectURL(link.href); });
