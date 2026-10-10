import assert from "node:assert/strict";
import { test } from "node:test";

import { ClusterClientError, clusterEndpoint, parseClusterDetail, parseClusterLeaderboard, parseClusterMap } from "../src/data/audio-clusters.ts";

const run = "a".repeat(64);
const card = { semanticId: "b".repeat(64), sampleId: "sample-1", recordingId: "recording-1", kind: "window", start: 1, end: 3, sampleTitle: "Drums", playback: { fileKey: "audio/drums.wav", start: 1, end: 3 }, parentLink: "/samples/drums", link: "/samples/drums" };

test("cluster requests retain the configured /semantic base and only use public GET fields", () => {
  assert.equal(clusterEndpoint("/semantic", { view: "leaderboard", run, preset: "fine", order: "clips" }), `/semantic/clusters?view=leaderboard&run=${run}&preset=fine&order=clips`);
  assert.equal(clusterEndpoint("https://api.example.test/semantic", { view: "detail", cluster: `${run}:2`, preset: "useful", order: "similarity" }), `https://api.example.test/semantic/clusters?view=detail&cluster=${encodeURIComponent(`${run}:2`)}&preset=useful&order=similarity`);
  assert.equal(clusterEndpoint("/semantic", { view: "map", run, preset: "broad", limit: 10_000 }), `/semantic/clusters?view=map&run=${run}&preset=broad&limit=10000`);
});

test("map payloads cap public finite points and reject vectors or audit fields", () => {
  const point = { semanticId: "c".repeat(64), clusterId: `${run}:2`, membership: 0.9, x: -1.5, y: 2, cards: [{ ...card, semanticId: "c".repeat(64) }] };
  const map = parseClusterMap({ runId: run, displayedCount: 1, totalVisibleCount: 4, truncated: true, points: [point] });
  assert.deepEqual(map.points[0], point);
  assert.throws(() => parseClusterMap({ runId: run, displayedCount: 1, totalVisibleCount: 1, truncated: false, points: [{ ...point, vector: [1] }] }), ClusterClientError);
  assert.throws(() => parseClusterMap({ runId: run, displayedCount: 10_001, totalVisibleCount: 10_001, truncated: false, points: Array(10_001).fill(point) }), ClusterClientError);
  assert.throws(() => parseClusterMap({ runId: run, displayedCount: 1, totalVisibleCount: 2, truncated: false, points: [point] }), ClusterClientError);
  assert.throws(() => parseClusterMap({ runId: run, displayedCount: 1, totalVisibleCount: 1, truncated: false, audit: {}, points: [point] }), ClusterClientError);
});

test("cluster payloads are exact, finite public card shapes with no vectors or audit fields", () => {
  const leaderboard = parseClusterLeaderboard({ runId: run, preset: "useful", algorithmVersions: { clusters: "v1" }, clusters: [{ clusterId: `${run}:2`, distinctSampleCount: 2, savedClipCount: 1, representatives: [card], suggestedLabel: "Breaks" }] });
  assert.equal(leaderboard.clusters[0]!.representatives[0]!.semanticId, card.semanticId);
  const detail = parseClusterDetail({ runId: run, clusterId: `${run}:2`, order: "similarity", representatives: [card], members: [{ ...card, score: 0.5 }] });
  assert.equal(detail.members[0]!.score, 0.5);
  assert.throws(() => parseClusterDetail({ runId: run, clusterId: `${run}:2`, order: "similarity", representatives: [{ ...card, vector: [1] }], members: [] }), ClusterClientError);
  assert.throws(() => parseClusterLeaderboard({ runId: run, preset: "useful", algorithmVersions: {}, clusters: [{ clusterId: `${run}:2`, distinctSampleCount: Infinity, savedClipCount: 0, representatives: [] }] }), ClusterClientError);
});
