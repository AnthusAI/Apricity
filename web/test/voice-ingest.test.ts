// A finished render becomes library records: the plan the voice-ingest function carries out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planIngest, planFailure, GENERATED_RECORDING_ID } from "../amplify/functions/voice-ingest/ingest.ts";

function wav(sampleRate: number, spans: [number, number][]): Uint8Array {
  const samples: number[] = [];
  for (const [seconds, amp] of spans) {
    const n = Math.round(seconds * sampleRate);
    for (let i = 0; i < n; i++) samples.push(amp * Math.sin((2 * Math.PI * 220 * samples.length) / sampleRate));
  }
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0, "ascii"); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii"); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2));
  return new Uint8Array(buf);
}

const audio = wav(24000, [[0.5, 0], [1.0, 0.5], [0.6, 0], [1.0, 0.5], [0.5, 0]]);
const speech = {
  sample_rate: 24000,
  duration: 3.6,
  segments: [{ text: "Hi. There.", voice: "am_adam", start: 0, end: 3.6 }],
  provenance: { engine: "auritus", version: "0.27.0", backend: "kokoro", model: "hexgrad/Kokoro-82M", voice: "kokoro:am_adam", options: { speed: 1.1, seed: null } },
  request_key: "k".repeat(64),
  request: { text: "Hi. [[auritus:pause]] There.", voice: "kokoro:am_adam", speed: 1.1, seed: null },
};
const job = { id: "job-1", input: { name: "intro", text: "Hi. [[auritus:pause]] There.", voice: "kokoro:am_adam", speed: 1.1, requester: "alice" } };
const now = "2026-09-26T20:00:00.000Z";

test("the sample's id is its audio's hash, as for every sample", () => {
  const plan = planIngest({ job, wav: audio, speech, now });
  const sha = createHash("sha256").update(audio).digest("hex");
  assert.equal(plan.sampleId, `smp_${sha.slice(0, 20)}`);
});

test("audio and analysis are stored where the library keeps them", () => {
  const plan = planIngest({ job, wav: audio, speech, now });
  const keys = plan.files.map((f) => f.key);
  assert.ok(keys.includes(`files/audio/${plan.sampleId}/intro.wav`));
  const analysis = plan.files.find((f) => f.key.startsWith(`files/analysis/${plan.sampleId}/`))!;
  const body = new TextDecoder().decode(analysis.body);
  assert.equal(analysis.key, `files/analysis/${plan.sampleId}/${createHash("sha256").update(analysis.body).digest("hex")}.json`);
  const manifest = JSON.parse(body);
  assert.equal(manifest.generated_by.engine, "auritus");
  assert.equal(manifest.generated_by.requester, "alice");
  assert.deepEqual(Object.keys(manifest), [...Object.keys(manifest)].sort(), "canonical: sorted keys");
});

test("a generated Sample with its generator, in the generated collection", () => {
  const plan = planIngest({ job, wav: audio, speech, now });
  const sample = plan.records.find((r) => r.model === "Sample")!.item;
  assert.equal(sample.role, "generated");
  assert.equal(sample.path, "voice/intro.wav");
  assert.deepEqual(sample.aliases, ["samples/voice/intro.wav"]);
  assert.equal(sample.collection, "generated");
  assert.equal(sample.recordingId, GENERATED_RECORDING_ID);
  assert.equal(sample.status, "ready");
  assert.equal(sample.audio.key, `audio/${plan.sampleId}/intro.wav`);
  const generator = JSON.parse(sample.generator);
  assert.equal(generator.text, "Hi. [[auritus:pause]] There.");
  assert.equal(generator.requester, "alice");
  assert.equal(generator.model, "hexgrad/Kokoro-82M");
  assert.equal(JSON.parse(sample.nameCounters).phrase, 2);
});

test("the recording credits the voice model and is public domain", () => {
  const plan = planIngest({ job, wav: audio, speech, now });
  const rec = plan.records.find((r) => r.model === "Recording")!;
  assert.equal(rec.onlyIfMissing, true);
  assert.equal(rec.item.license, "cc0-1.0");
  assert.match(rec.item.credit, /Generated with Auritus/);
});

test("phrases become ML clips with the migration's ids", () => {
  const plan = planIngest({ job, wav: audio, speech, now });
  const clips = plan.records.filter((r) => r.model === "Clip").map((r) => r.item);
  assert.deepEqual(clips.map((c) => c.name), ["phrase-1", "phrase-2"]);
  const id = (name: string) => `clp_${createHash("sha1").update(`${plan.sampleId}|${name}`).digest("hex").slice(0, 20)}`;
  assert.equal(clips[0].id, id("phrase-1"));
  assert.equal(clips[0].source, "ml");
  assert.equal(clips[0].sampleId, plan.sampleId);
});

test("every record is written to the table and mirrored to the bucket as the library stores it", () => {
  const plan = planIngest({ job, wav: audio, speech, now });
  for (const r of plan.records) {
    assert.equal(r.item.__typename, r.model);
    assert.equal(r.item.createdAt, now);
    const mirror = plan.files.find((f) => f.key === `${r.model}/${r.item.id}.json`);
    assert.ok(mirror, `no mirror for ${r.model}/${r.item.id}`);
  }
  assert.deepEqual(plan.job, { id: "job-1", state: "done", sampleId: plan.sampleId, error: null, updatedAt: now });
});

test("a failed render marks the job failed with the renderer's reason", () => {
  assert.deepEqual(planFailure({ jobId: "job-1", error: { error: "BackendUnavailable", message: "no GPU" }, now }), {
    id: "job-1", state: "failed", error: "BackendUnavailable: no GPU", updatedAt: now,
  });
  assert.equal(planFailure({ jobId: "job-2", error: null, now }).error, "The render failed before writing a reason; see the job's logs.");
});
