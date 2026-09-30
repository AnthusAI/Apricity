import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import type { SemanticIdentity } from "../../src/semantic/contracts";
import { canonicalSemanticId, createCanonicalHydrator } from "./canonical";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const audioSha = "a".repeat(64);
const space = "clap-htsat-unfused-512-v1" as const;
const fingerprint = "fp-v1";
const identity = (overrides: Partial<SemanticIdentity> = {}): SemanticIdentity => {
  const value = { sampleId: "smp_A", recordingId: "rec_A", kind: "saved_clip" as const, clipId: "clp_A", start: 0, end: 4, audioSha256: audioSha, embeddingSpace: space, processingFingerprint: fingerprint, ...overrides };
  const semanticId = canonicalSemanticId(value as Omit<SemanticIdentity, "semanticId">)!;
  return { ...value, semanticId } as SemanticIdentity;
};
const grid = { bpm: 120, meter: 4, beats: [0, 1, 2, 3, 4, 5, 6, 7, 8], downbeats: [0, 4, 8, 12, 16] };
const analysisBytes = () => new Uint8Array(Buffer.from(JSON.stringify({ source: { sha256: audioSha }, rhythm: grid })));
const gridSha = () => sha(JSON.stringify({ beats: grid.beats, bpm: grid.bpm, downbeats: grid.downbeats, meter: grid.meter }));
const revision = (value: SemanticIdentity) => sha(JSON.stringify([value.semanticId, value.kind === "window" ? gridSha() : ""]));
const pythonAnalysisBytes = () => new Uint8Array(Buffer.from(`{"source":{"sha256":"${audioSha}","note":"雪🎵"},"rhythm":{"bpm":125.0,"meter":4,"beats":[0.0,1.25,2.5,3.75,5.0],"downbeats":[0.0,1.25,2.5,3.75,5.0]}}`));
const pythonGridSha = "43bf614a28574c711204d102d7a531e7f358086294feacb757d71d749fc2004a";
const pythonIntegerAnalysisBytes = () => new Uint8Array(Buffer.from(`{"source":{"sha256":"${audioSha}"},"rhythm":{"bpm":125,"meter":4,"beats":[0,1,2,3,5],"downbeats":[0,1,2,3,5]}}`));
const pythonIntegerGridSha = "ea318fef31e89ea37756139510f20d88e7ee63385d1d6edc97cc791116310980";
const pythonScientificAnalysisBytes = () => new Uint8Array(Buffer.from(`{"source":{"sha256":"${audioSha}","note":"雪🎵"},"rhythm":{"bpm":-0.0,"meter":4,"beats":[-1.0e-7,1.0e-6,1.0e16,1.25],"downbeats":[0.0,1.25,2.5,3.75,5.0]}}`));
const pythonScientificGridSha = "41e281c1cbd4a789b1102be067797dc872d88ae6e55047397b319a937a47cdd1";
const pythonRevision = (value: SemanticIdentity, fingerprint: string) => sha(JSON.stringify([value.semanticId, fingerprint]));

const fixture = () => {
  const state: any = {
    sample: { id: "smp_A", recordingId: "rec_A", path: "current/a.wav", title: "Current A", status: "ready", duration: 16, tags: ["sample"], audio: { key: "audio/a.wav", sha256: audioSha }, analysis: { key: "analysis/a.json", sha256: sha(analysisBytes()) } },
    recording: { id: "rec_A", title: "Recorded", license: "cc0-1.0" },
    clip: { id: "clp_A", sampleId: "smp_A", name: "Current clip", kind: "loop", tags: ["clip"], start: 0, end: 4, retired: false },
    analysis: analysisBytes(),
  };
  const hydrator = createCanonicalHydrator({
    processingFingerprint: fingerprint,
    readSample: async (id) => id === state.sample?.id ? state.sample : null,
    readRecording: async (id) => id === state.recording?.id ? state.recording : null,
    readClip: async (id) => id === state.clip?.id ? state.clip : null,
    readAnalysis: async (ref) => ref.key === state.sample?.analysis?.key ? state.analysis : null,
  });
  return { state, hydrator };
};

describe("canonical semantic hydrator", () => {
  it("returns only freshly hydrated metadata and never assigns a score", async () => {
    const { hydrator } = fixture();
    const current = identity();
    assert.deepEqual(await hydrator({ identity: current, revision: revision(current) }), {
      identity: current,
      parent: { sampleId: "smp_A", recordingId: "rec_A", samplePath: "current/a.wav", sampleTitle: "Current A" },
      timeRange: { start: 0, end: 4 },
      card: { clipId: "clp_A", clipName: "Current clip", clipKind: "loop", tags: ["clip"] },
      playback: { fileKey: "audio/a.wav", start: 0, end: 4 },
    });
  });

  it("fails closed on tampering, deletion, unsafe keys, changed bounds/hash, and changed current records", async () => {
    const cases: Array<(state: any, candidate: SemanticIdentity) => void> = [
      (s) => s.sample = null,
      (s) => s.recording = null,
      (s) => s.clip = null,
      (s) => s.sample.audio.key = "../escape.wav",
      (s) => s.sample.audio.sha256 = "b".repeat(64),
      (s) => s.clip.end = 3,
      (s) => s.clip.retired = true,
      (s) => s.sample.duration = 3,
      (_s, candidate) => candidate.semanticId = "b".repeat(64),
      (_s, candidate) => candidate.processingFingerprint = "other",
      (_s, candidate) => candidate.embeddingSpace = "other" as typeof space,
    ];
    for (const mutate of cases) {
      const { state, hydrator } = fixture(); const candidate = identity(); mutate(state, candidate);
      assert.equal(await hydrator({ identity: candidate, revision: revision(candidate) }), null);
    }
  });

  it("uses documented provenance for public reads but permits only trusted curator context to bypass it", async () => {
    const { state, hydrator } = fixture(); const current = identity();
    state.recording = { id: "rec_A", title: "No documented license" };
    assert.equal(await hydrator({ identity: current, revision: revision(current) }), null);
    assert.ok(await hydrator({ identity: current, revision: revision(current) }, { curator: true }));
    assert.equal(await hydrator({ identity: current, revision: revision(current) }, { curator: "true" }), null);
  });

  it("rehydrates every call instead of retaining stale canonical entities", async () => {
    const { state, hydrator } = fixture(); const current = identity(); const candidate = { identity: current, revision: revision(current) };
    assert.ok(await hydrator(candidate));
    state.clip.name = "Renamed after indexing";
    assert.equal((await hydrator(candidate))?.card.clipName, "Renamed after indexing");
    state.sample = null;
    assert.equal(await hydrator(candidate), null);
  });

  it("validates window bytes, source hash, canonical sorted grid, four-bar bounds, and revision", async () => {
    const current = identity({ kind: "window", clipId: undefined, start: 0, end: 16 });
    const good = fixture();
    assert.ok(await good.hydrator({ identity: current, revision: revision(current) }));
    for (const mutate of [
      (s: any) => s.analysis = new Uint8Array([1]),
      (s: any) => s.sample.analysis.sha256 = "b".repeat(64),
      (s: any) => s.analysis = new Uint8Array(Buffer.from(JSON.stringify({ source: { sha256: "b".repeat(64) }, rhythm: grid }))),
      (s: any) => s.analysis = new Uint8Array(Buffer.from(JSON.stringify({ source: { sha256: audioSha }, rhythm: { ...grid, downbeats: [0, 3, 6, 9, 12] } }))),
      (s: any) => { s.analysis = new Uint8Array(Buffer.from(JSON.stringify({ source: { sha256: audioSha }, rhythm: { ...grid, bpm: 121 } }))); s.sample.analysis.sha256 = sha(s.analysis); },
    ]) {
      const { state, hydrator } = fixture(); mutate(state);
      assert.equal(await hydrator({ identity: current, revision: revision(current) }), null);
    }
  });

  it("accepts true Python analysis bytes and rejects a current altered grid using the frozen Python revision", async () => {
    const current = identity({ kind: "window", clipId: undefined, start: 0, end: 5 });
    const { state, hydrator } = fixture();
    state.sample.duration = 5;
    state.sample.tags = null;
    state.analysis = pythonAnalysisBytes();
    state.sample.analysis.sha256 = sha(state.analysis);
    const frozenRevision = pythonRevision(current, pythonGridSha);
    assert.ok(await hydrator({ identity: current, revision: frozenRevision }));
    state.analysis = new Uint8Array(Buffer.from(Buffer.from(pythonAnalysisBytes()).toString("utf8").replace("1.25", "1.5")));
    state.sample.analysis.sha256 = sha(state.analysis);
    assert.equal(await hydrator({ identity: current, revision: frozenRevision }), null);
  });

  it("matches Python float serialization for signed zero, scientific notation, integer types, and Unicode raw analysis", async () => {
    const current = identity({ kind: "window", clipId: undefined, start: 0, end: 5 });
    const { state, hydrator } = fixture();
    state.sample.duration = 5;
    state.analysis = pythonScientificAnalysisBytes();
    state.sample.analysis.sha256 = sha(state.analysis);
    assert.ok(await hydrator({ identity: current, revision: pythonRevision(current, pythonScientificGridSha) }));
    const integers = fixture();
    integers.state.sample.duration = 5;
    integers.state.analysis = pythonIntegerAnalysisBytes();
    integers.state.sample.analysis.sha256 = sha(integers.state.analysis);
    assert.notEqual(pythonGridSha, pythonIntegerGridSha, "Python keeps whole-valued floats distinct from integers");
    assert.ok(await integers.hydrator({ identity: current, revision: pythonRevision(current, pythonIntegerGridSha) }));
  });

  it("keeps samples distinct when they share a documented recording", async () => {
    const { state } = fixture();
    const second = { ...state.sample, id: "smp_B", path: "current/b.wav", title: "Current B", audio: { key: "audio/b.wav", sha256: audioSha } };
    const hydrator = createCanonicalHydrator({ processingFingerprint: fingerprint, readSample: async (id) => id === "smp_A" ? state.sample : id === "smp_B" ? second : null, readRecording: async (id) => id === "rec_A" ? state.recording : null, readClip: async () => null, readAnalysis: async () => null });
    const current = identity({ sampleId: "smp_B", kind: "window", clipId: undefined, start: 0, end: 4 });
    assert.equal(await hydrator({ identity: current, revision: revision(current) }), null, "a shared recording cannot make a missing B analysis or invalid B window visible");
  });

  it("does not convert unavailable canonical reads into a stale fallback", async () => {
    const { hydrator } = fixture(); const current = identity();
    const unavailable = createCanonicalHydrator({ processingFingerprint: fingerprint, readSample: async () => { throw new Error("dependency unavailable"); }, readRecording: async () => null, readClip: async () => null, readAnalysis: async () => null });
    await assert.rejects(unavailable({ identity: current, revision: revision(current) }), /dependency unavailable/);
    assert.ok(await hydrator({ identity: current, revision: revision(current) }));
  });

  it("matches the Python/Rust Unicode half-up identity golden and rejects unrepresentable microseconds", async () => {
    const { hydrator } = fixture();
    const current = identity({ sampleId: "sämp🎵", recordingId: "録音", clipId: "clíp/雪", start: 0.0000005, end: 4.0000005, processingFingerprint: "fp-β" });
    assert.equal(current.semanticId, "5f55e9b2a87f472906a911412375413127ee204844eba0aada608ffc87a9b9d3");
    const impossible = identity({ start: 0, end: 1e308 });
    assert.equal(await hydrator({ identity: impossible, revision: revision(impossible) }), null);
  });
});
