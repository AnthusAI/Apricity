// What a finished voice render becomes: a plan of the files and records to write, kept pure so it
// is tested without AWS. The handler carries it out. Ids, keys and record shapes are the library's
// own (crates/apricity-data: ids.rs, migration.rs), so `apricity sync pull` brings the same sample
// down that a migration would have made.
import { createHash } from "node:crypto";
import { buildSpeechAnalysis, type GeneratedBy } from "./speech";

/** The one Recording every generated voice line belongs to. */
export const GENERATED_RECORDING_ID = "rec_generated_voice";
export const GENERATED_COLLECTION = "generated";

/** What `requestVoiceLine` stored on the Job. */
export interface VoiceJobInput {
  name: string;
  text: string;
  voice: string;
  speed?: number | null;
  seed?: number | null;
  requester?: string;
}

/** The renderer's `speech.json`. */
export interface SpeechMeta {
  sample_rate: number;
  duration: number;
  provenance: { engine: string; version?: string; backend: string; model?: string; voice: string; options?: Record<string, unknown> };
  request_key: string;
}

export interface FileWrite {
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface RecordWrite {
  model: "Recording" | "Sample" | "Clip";
  item: Record<string, any>;
  /** Write only when no record has this id (shared records such as the Recording). */
  onlyIfMissing?: boolean;
}

export interface IngestPlan {
  sampleId: string;
  files: FileWrite[];
  records: RecordWrite[];
  job: { id: string; state: "done"; sampleId: string; error: null; updatedAt: string };
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const encode = (s: string) => new TextEncoder().encode(s);

/** JSON with every object's keys sorted: the library's canonical form. */
export function canonicalJson(value: unknown): string {
  const sort = (v: any): any =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
        : v;
  return JSON.stringify(sort(value));
}

/** `clp_` + sha1(sampleId|name)[:20], as `ids::migrated_clip_id`. */
export function clipId(sampleId: string, name: string): string {
  return `clp_${createHash("sha1").update(`${sampleId}|${name}`).digest("hex").slice(0, 20)}`;
}

/** Plan the files and records a successful render becomes. */
export function planIngest(args: {
  job: { id: string; input: VoiceJobInput };
  wav: Uint8Array;
  speech: SpeechMeta;
  now: string;
}): IngestPlan {
  const { job, wav, speech, now } = args;
  const { name, text, requester } = job.input;
  const audioSha = sha256(wav);
  const sampleId = `smp_${audioSha.slice(0, 20)}`;
  const filename = `${name}.wav`;
  const generatedBy: GeneratedBy = {
    engine: speech.provenance.engine,
    version: speech.provenance.version,
    backend: speech.provenance.backend,
    model: speech.provenance.model,
    voice: speech.provenance.voice,
    text,
    options: speech.provenance.options,
    request_key: speech.request_key,
    requester,
  };
  const { analysis, phraseClips } = buildSpeechAnalysis(wav, { path: filename, sha256: audioSha, generatedBy });
  const analysisBytes = encode(canonicalJson({ ...analysis, analysis: { analyzed_at: now, tools: { "apricity-voice-ingest": "1" } } }));
  const analysisSha = sha256(analysisBytes);
  const audioKey = `audio/${sampleId}/${filename}`;
  const analysisKey = `analysis/${sampleId}/${analysisSha}.json`;

  const stamp = (model: RecordWrite["model"], item: Record<string, any>) => ({ __typename: model, ...item, createdAt: now, updatedAt: now });
  const model = speech.provenance.model ? ` (${speech.provenance.model})` : "";
  const records: RecordWrite[] = [
    {
      model: "Recording",
      onlyIfMissing: true,
      item: stamp("Recording", {
        id: GENERATED_RECORDING_ID,
        title: "Generated voice lines",
        collection: GENERATED_COLLECTION,
        license: "cc0-1.0",
        credit: "Generated with Auritus (Kokoro-82M, Apache-2.0).",
        rights: "CC0 1.0: spoken by a speech model, dedicated to the public domain.",
      }),
    },
    {
      model: "Sample",
      item: stamp("Sample", {
        id: sampleId,
        recordingId: GENERATED_RECORDING_ID,
        path: `voice/${filename}`,
        aliases: [`samples/voice/${filename}`],
        collection: GENERATED_COLLECTION,
        title: filename,
        role: "generated",
        generator: JSON.stringify({ ...generatedBy, credit: `Generated with Auritus${model}` }),
        status: "ready",
        audio: { key: audioKey, sha256: audioSha, size: wav.length, contentType: "audio/wav" },
        analysis: { key: analysisKey, sha256: analysisSha, size: analysisBytes.length, contentType: "application/json" },
        analysisVersion: analysis.apricity_manifest,
        analyzedAt: now,
        duration: analysis.source.duration,
        sampleRate: analysis.source.sample_rate,
        channels: analysis.source.channels,
        bpm: null,
        meter: null,
        nameCounters: JSON.stringify({ phrase: phraseClips.length }),
      }),
    },
    ...phraseClips.map(
      (c): RecordWrite => ({
        model: "Clip",
        item: stamp("Clip", { id: clipId(sampleId, c.name), sampleId, name: c.name, start: c.start, end: c.end, source: c.source, tags: c.tags }),
      }),
    ),
  ];

  const files: FileWrite[] = [
    { key: `files/${audioKey}`, body: wav, contentType: "audio/wav" },
    { key: `files/${analysisKey}`, body: analysisBytes, contentType: "application/json" },
    // Mirror each record where the library keeps it, so the bucket stays a library.
    ...records.map((r) => ({ key: `${r.model}/${r.item.id}.json`, body: encode(canonicalJson(r.item)), contentType: "application/json" })),
  ];

  return { sampleId, files, records, job: { id: job.id, state: "done", sampleId, error: null, updatedAt: now } };
}

/** Plan the Job update for a render that failed. */
export function planFailure(args: { jobId: string; error: { error?: string; message?: string } | null; now: string }) {
  const reason = args.error
    ? [args.error.error, args.error.message].filter(Boolean).join(": ")
    : "The render failed before writing a reason; see the job's logs.";
  return { id: args.jobId, state: "failed" as const, error: reason, updatedAt: args.now };
}
