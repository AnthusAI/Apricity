import { createHash } from "node:crypto";

import { documented, type Provenance } from "../../src/data/licenses";
import { SEMANTIC_EMBEDDING_SPACE, type SemanticIdentity, type SemanticSearchHit } from "../../src/semantic/contracts";

export interface CanonicalFileRef { key: string; sha256: string; }
export interface CanonicalSample {
  id: string;
  recordingId: string;
  path: string;
  title: string;
  status?: string | null;
  duration?: number | null;
  tags?: string[] | null;
  audio: CanonicalFileRef;
  analysis?: CanonicalFileRef | null;
}
export interface CanonicalRecording extends Provenance { id: string; }
export interface CanonicalClip {
  id: string;
  sampleId: string;
  name: string;
  start: number;
  end: number;
  kind?: string | null;
  tags?: string[] | null;
  retired?: boolean | null;
}
export interface CanonicalHydratorDependencies {
  readSample(id: string): Promise<CanonicalSample | null>;
  readRecording(id: string): Promise<CanonicalRecording | null>;
  readClip(id: string): Promise<CanonicalClip | null>;
  readAnalysis(fileRef: CanonicalFileRef): Promise<Uint8Array | null>;
  processingFingerprint: string;
}
export type CanonicalHydrator = (
  candidate: { identity: SemanticIdentity; revision: string },
  context?: unknown,
) => Promise<Omit<SemanticSearchHit, "score"> | null>;

const I64_MAX = 9_223_372_036_854_775_807n;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const isSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const safeKey = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
const compact = (value: unknown) => JSON.stringify(value);
const canonicalIdentityJson = (tuple: readonly [string, string, string, string | null, bigint, bigint, string, string, string]) => `[${JSON.stringify(tuple[0])},${JSON.stringify(tuple[1])},${JSON.stringify(tuple[2])},${tuple[3] === null ? "null" : JSON.stringify(tuple[3])},${tuple[4].toString()},${tuple[5].toString()},${JSON.stringify(tuple[6])},${JSON.stringify(tuple[7])},${JSON.stringify(tuple[8])}]`;

/** Python Decimal(str(seconds)) × 1e6, ROUND_HALF_UP, restricted to the Rust i64 identity domain. */
export function roundHalfUpMicroseconds(seconds: unknown): bigint | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds === 0) return 0n;
  const text = seconds.toString();
  const parts = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (!parts) return null;
  const digits = `${parts[1]}${parts[2] ?? ""}`.replace(/^0+/, "");
  if (!digits) return 0n;
  const coefficient = BigInt(digits);
  const exponent = Number(parts[3] ?? "0");
  const shift = exponent - (parts[2]?.length ?? 0) + 6;
  let rounded: bigint;
  if (shift >= 0) {
    // A shortest JS decimal has <=17 significant digits; scaling it by 10^18 cannot fit i64.
    if (shift > 18) return null;
    rounded = coefficient * (10n ** BigInt(shift));
  } else {
    const places = -shift;
    if (places > 18) return 0n;
    const divisor = 10n ** BigInt(places);
    rounded = coefficient / divisor + (coefficient % divisor >= divisor / 2n ? 1n : 0n);
  }
  return rounded <= I64_MAX ? rounded : null;
}

const bounds = (start: unknown, end: unknown): start is number => typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && roundHalfUpMicroseconds(start) !== null && roundHalfUpMicroseconds(end) !== null;
const sameBounds = (left: unknown, right: unknown) => {
  const a = roundHalfUpMicroseconds(left); const b = roundHalfUpMicroseconds(right);
  return a !== null && a === b;
};
const tags = (value: unknown): string[] | null => value === null || value === undefined ? [] : Array.isArray(value) && value.every((tag) => typeof tag === "string") ? [...value] : null;
const trustedCurator = (context: unknown) => !!context && typeof context === "object" && (context as { curator?: unknown }).curator === true;

/** JSON.parse discards the integer/float distinction that Python's json loader keeps. */
type JsonNumber = { value: number; integer: boolean; raw: string; };
type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | Map<string, JsonValue>;
const isJsonNumber = (value: JsonValue | undefined): value is JsonNumber => !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Map) && "integer" in value;
const isJsonObject = (value: JsonValue | undefined): value is Map<string, JsonValue> => value instanceof Map;

const parseTypedJson = (bytes: Uint8Array): JsonValue | null => {
  const text = Buffer.from(bytes).toString("utf8");
  let offset = 0;
  const whitespace = () => { while (offset < text.length && /[ \n\r\t]/.test(text[offset])) offset += 1; };
  const fail = (): never => { throw new Error("invalid JSON"); };
  const string = (): string => {
    const start = offset;
    if (text[offset++] !== "\"") return fail();
    while (offset < text.length) {
      const code = text.charCodeAt(offset++);
      if (code === 34) return JSON.parse(text.slice(start, offset)) as string;
      if (code < 32) return fail();
      if (code === 92) {
        const escape = text[offset++];
        if (!escape) return fail();
        if (escape === "u") offset += 4;
      }
    }
    return fail();
  };
  const value = (): JsonValue => {
    whitespace();
    const current = text[offset];
    if (current === "\"") return string();
    if (current === "{") {
      offset += 1; whitespace();
      const result = new Map<string, JsonValue>();
      if (text[offset] === "}") { offset += 1; return result; }
      for (;;) {
        whitespace(); const key = string(); whitespace();
        if (text[offset++] !== ":") return fail();
        result.set(key, value()); whitespace();
        if (text[offset] === "}") { offset += 1; return result; }
        if (text[offset++] !== ",") return fail();
      }
    }
    if (current === "[") {
      offset += 1; whitespace();
      const result: JsonValue[] = [];
      if (text[offset] === "]") { offset += 1; return result; }
      for (;;) {
        result.push(value()); whitespace();
        if (text[offset] === "]") { offset += 1; return result; }
        if (text[offset++] !== ",") return fail();
      }
    }
    if (text.startsWith("true", offset)) { offset += 4; return true; }
    if (text.startsWith("false", offset)) { offset += 5; return false; }
    if (text.startsWith("null", offset)) { offset += 4; return null; }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(offset));
    if (!match) return fail();
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) return fail();
    return { value: number, integer: !/[.eE]/.test(match[0]), raw: match[0] };
  };
  try {
    const parsed = value(); whitespace();
    return offset === text.length ? parsed : null;
  } catch { return null; }
};

const pythonFloat = (value: number): string => {
  if (Object.is(value, -0)) return "-0.0";
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  let text = magnitude.toString();
  if (!/[eE]/.test(text) && magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) {
    const [whole, fraction = ""] = text.split(".");
    let digits: string; let exponent: number;
    if (whole !== "0") { digits = `${whole}${fraction}`.replace(/0+$/, ""); exponent = whole.length - 1; }
    else { const zeros = fraction.match(/^0*/)![0].length; digits = fraction.slice(zeros).replace(/0+$/, ""); exponent = -(zeros + 1); }
    text = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ""}e${exponent >= 0 ? "+" : "-"}${Math.abs(exponent).toString().padStart(exponent < 0 ? 2 : 1, "0")}`;
  } else if (/[eE]/.test(text)) {
    const [mantissa, exponent] = text.toLowerCase().split("e");
    const parsedExponent = Number(exponent);
    text = `${mantissa}e${parsedExponent >= 0 ? "+" : "-"}${Math.abs(parsedExponent).toString().padStart(parsedExponent < 0 ? 2 : 1, "0")}`;
  } else if (!text.includes(".")) text = `${text}.0`;
  return `${sign}${text}`;
};
const pythonNumber = (value: JsonNumber) => value.integer ? BigInt(value.raw).toString() : pythonFloat(value.value);

type Meter = JsonNumber | [JsonNumber, JsonNumber];
const isMeter = (value: JsonValue | undefined): value is Meter => isJsonNumber(value)
  || (Array.isArray(value) && value.length === 2 && value.every(isJsonNumber));
const pythonMeter = (meter: Meter) => Array.isArray(meter)
  ? `[${meter.map(pythonNumber).join(",")}]` : pythonNumber(meter);
type Grid = { beats: JsonNumber[]; bpm: JsonNumber; downbeats: JsonNumber[]; meter: Meter; };
const parseGrid = (bytes: Uint8Array, audioSha256: string): Grid | null => {
  const parsed = parseTypedJson(bytes);
  if (!isJsonObject(parsed)) return null;
  const source = parsed.get("source"); const rhythm = parsed.get("rhythm");
  if (!isJsonObject(source) || source.get("sha256") !== audioSha256 || !isJsonObject(rhythm)) return null;
  const bpm = rhythm.get("bpm"); const meter = rhythm.get("meter"); const beats = rhythm.get("beats"); const downbeats = rhythm.get("downbeats");
  if (!isJsonNumber(bpm) || !isMeter(meter) || !Array.isArray(beats) || !Array.isArray(downbeats) || !beats.every(isJsonNumber) || !downbeats.every(isJsonNumber)) return null;
  return { beats, bpm, downbeats, meter };
};
const gridFingerprint = (grid: Grid) => sha(`{"beats":[${grid.beats.map(pythonNumber).join(",")}],"bpm":${pythonNumber(grid.bpm)},"downbeats":[${grid.downbeats.map(pythonNumber).join(",")}],"meter":${pythonMeter(grid.meter)}}`);
const currentWindow = (grid: Grid, start: number, end: number) => {
  for (let index = 0; index + 4 < grid.downbeats.length; index += 4) if (sameBounds(grid.downbeats[index].value, start) && sameBounds(grid.downbeats[index + 4].value, end)) return true;
  return false;
};

const validIdentity = (identity: SemanticIdentity, processingFingerprint: string): boolean => {
  if (!nonempty(identity.sampleId) || !nonempty(identity.recordingId) || !isSha(identity.semanticId) || !isSha(identity.audioSha256) || identity.embeddingSpace !== SEMANTIC_EMBEDDING_SPACE || identity.processingFingerprint !== processingFingerprint || !nonempty(processingFingerprint) || !bounds(identity.start, identity.end)) return false;
  if ((identity.kind === "saved_clip" && !nonempty(identity.clipId)) || (identity.kind === "window" && identity.clipId !== undefined) || (identity.kind !== "saved_clip" && identity.kind !== "window")) return false;
  return canonicalSemanticId(identity) === identity.semanticId;
};

export function canonicalSemanticId(identity: Omit<SemanticIdentity, "semanticId">): string | null {
  const start = roundHalfUpMicroseconds(identity.start); const end = roundHalfUpMicroseconds(identity.end);
  if (start === null || end === null || !nonempty(identity.sampleId) || !nonempty(identity.recordingId) || !isSha(identity.audioSha256) || !nonempty(identity.processingFingerprint) || (identity.kind !== "saved_clip" && identity.kind !== "window") || (identity.kind === "saved_clip" && !nonempty(identity.clipId)) || (identity.kind === "window" && identity.clipId !== undefined)) return null;
  return sha(canonicalIdentityJson([identity.sampleId, identity.recordingId, identity.kind, identity.kind === "saved_clip" ? identity.clipId! : null, start, end, identity.audioSha256, identity.embeddingSpace, identity.processingFingerprint]));
}

/**
 * Re-reads canonical entities on every invocation. Dependency errors intentionally propagate so
 * the handler can return a retryable service failure; only stale or invalid records become null.
 */
export function createCanonicalHydrator(dependencies: CanonicalHydratorDependencies): CanonicalHydrator {
  return async ({ identity, revision }, context) => {
    if (!validIdentity(identity, dependencies.processingFingerprint) || !isSha(revision)) return null;
    const [sample, recording, clip] = await Promise.all([
      dependencies.readSample(identity.sampleId),
      dependencies.readRecording(identity.recordingId),
      identity.kind === "saved_clip" ? dependencies.readClip(identity.clipId!) : Promise.resolve(null),
    ]);
    if (!sample || !recording || sample.id !== identity.sampleId || recording.id !== identity.recordingId || sample.recordingId !== identity.recordingId || sample.status !== "ready" || !sample.audio || sample.audio.sha256 !== identity.audioSha256 || !safeKey(sample.audio.key) || (!trustedCurator(context) && !documented(recording))) return null;
    if (sample.duration !== undefined && sample.duration !== null && (typeof sample.duration !== "number" || !Number.isFinite(sample.duration) || sample.duration <= 0 || identity.end > sample.duration)) return null;
    if (identity.kind === "saved_clip" && (!clip || clip.id !== identity.clipId || clip.sampleId !== identity.sampleId || clip.retired === true || !sameBounds(clip.start, identity.start) || !sameBounds(clip.end, identity.end))) return null;

    let grid = "";
    if (identity.kind === "window") {
      if (!sample.analysis || !safeKey(sample.analysis.key) || !isSha(sample.analysis.sha256)) return null;
      const bytes = await dependencies.readAnalysis(sample.analysis);
      if (!bytes || sha(bytes) !== sample.analysis.sha256) return null;
      const parsed = parseGrid(bytes, sample.audio.sha256);
      if (!parsed || !currentWindow(parsed, identity.start, identity.end)) return null;
      grid = gridFingerprint(parsed);
    }
    if (sha(compact([identity.semanticId, grid])) !== revision) return null;
    const currentTags = identity.kind === "saved_clip" ? tags(clip!.tags) : tags(sample.tags);
    if (!currentTags || !nonempty(sample.path) || !nonempty(sample.title) || (identity.kind === "saved_clip" && !nonempty(clip!.name))) return null;
    return {
      identity,
      parent: { sampleId: identity.sampleId, recordingId: identity.recordingId, samplePath: sample.path, sampleTitle: sample.title },
      timeRange: { start: identity.start, end: identity.end },
      card: identity.kind === "saved_clip" ? { clipId: clip!.id, clipName: clip!.name, ...(typeof clip!.kind === "string" ? { clipKind: clip!.kind } : {}), tags: currentTags } : { tags: currentTags },
      playback: { fileKey: sample.audio.key, start: identity.start, end: identity.end },
    };
  };
}
