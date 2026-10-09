import assert from "node:assert/strict";
import { test } from "node:test";

import { CuratorClientError, curatorEndpoint, parseCuratorPreview } from "../src/data/cluster-curator.ts";

const run = "a".repeat(64);
const card = { semanticId: "b".repeat(64), sampleId: "sample-1", recordingId: "recording-1", kind: "window", start: 1, end: 3, sampleTitle: "Drums", playback: { fileKey: "audio/drums.wav", start: 1, end: 3 }, parentLink: "/samples/drums", link: "/samples/drums" };

test("curator bridge preserves the semantic base but is a distinct private endpoint", () => {
  assert.equal(curatorEndpoint("/semantic"), "/semantic/cluster-curator");
  assert.equal(curatorEndpoint("https://api.example.test/semantic"), "https://api.example.test/semantic/cluster-curator");
});

test("draft preview permits playable representatives but rejects vectors and untrusted fields", () => {
  const preview = parseCuratorPreview({ runId: run, preset: "useful", state: "draft", runRevision: 2, pointerRevision: null, review: null, clusters: [{ clusterId: `${run}:2`, suggestedLabel: "Hand drums", curatedLabel: null, representatives: [card] }] });
  assert.equal(preview.clusters[0]!.representatives[0]!.semanticId, card.semanticId);
  assert.throws(() => parseCuratorPreview({ runId: run, preset: "useful", state: "draft", runRevision: 2, pointerRevision: null, review: null, clusters: [{ clusterId: `${run}:2`, suggestedLabel: "Hand drums", curatedLabel: null, representatives: [{ ...card, vector: [1] }] }] }), CuratorClientError);
  assert.throws(() => parseCuratorPreview({ runId: run, preset: "useful", state: "draft", runRevision: 2, pointerRevision: null, review: null, clusters: [{ clusterId: `${run}:2`, suggestedLabel: "Hand drums", curatedLabel: null, representatives: [], reviewAudit: {} }] }), CuratorClientError);
});
