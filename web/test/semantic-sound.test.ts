import assert from "node:assert/strict";
import { test } from "node:test";

import { semanticClipHits, semanticEntriesForView, semanticGlobalHits, semanticSampleHits, semanticSoundRoutes, soundHostState } from "../src/ui/semantic-sound.ts";
import { href } from "../src/route.ts";
import type { ClipItem } from "../src/data/catalog.ts";
import type { Entry } from "../src/data/sections.ts";
import { DEFAULT_FILTER } from "../src/data/clip-filter.ts";
import type { SemanticSearchHit } from "../src/semantic/contracts.ts";

const sha = "a".repeat(64);
const hit = (semanticId: string, kind: "saved_clip" | "window", sampleId: string, clipId?: string): SemanticSearchHit => ({
  score: 0.9,
  identity: { semanticId, sampleId, recordingId: "rec-1", kind, ...(clipId ? { clipId } : {}), start: 1, end: 3, audioSha256: sha, embeddingSpace: "clap-htsat-unfused-512-v1", processingFingerprint: "v1" },
  parent: { sampleId, recordingId: "rec-1", samplePath: "samples/drums.wav", sampleTitle: "Drums" },
  timeRange: { start: 1, end: 3 }, card: { ...(clipId ? { clipId, clipName: "loop-1", clipKind: "loop" } : {}), tags: [] }, playback: { fileKey: "samples/drums.wav", start: 1, end: 3 },
});
const clip = (id: string, name = "loop-1"): ClipItem => ({ id, name, sampleId: "sample-a", samplePath: "samples/drums.wav", sampleTitle: "Drums", start: 1, end: 3, source: "ml", kind: "loop", owner: null, createdAt: "2026-09-01T00:00:00Z" });
const clipEntry = (item: ClipItem): Entry => ({ id: item.id, createdAt: item.createdAt, owner: item.owner, text: "unrelated lexical words", base: { targetType: "clip", targetId: item.id, kind: "clip", title: item.name, owner: item.owner, path: item.samplePath, samplePath: item.samplePath, clipStart: item.start, clipEnd: item.end, tags: [], lastAt: item.createdAt! }, clip: item });
const sampleEntry = (id: string): Entry => ({ id, createdAt: null, owner: null, text: "unrelated lexical words", base: { targetType: "sample", targetId: id, kind: "sample", title: "Drums", owner: null, path: "samples/drums.wav", tags: [], lastAt: "2026-09-01T00:00:00Z" }, sample: { id, path: "drums.wav", title: "Drums", group: "kit", duration: 10, bpm: null, key: "", keys_over_time: [], notes: 0, clips: 0, markers: 0 } });
const standing = { average: 1, count: 1, sum: 1, score: 1 };

test("semantic clips keep retrieval order, use current clip metadata, and do not require lexical text matches", () => {
  const first = hit("1".repeat(64), "saved_clip", "sample-a", "clip-a");
  const second = hit("2".repeat(64), "saved_clip", "sample-a", "clip-b");
  const result = semanticClipHits([first, second], [clipEntry(clip("clip-a")), clipEntry(clip("clip-b", "hit-1"))], DEFAULT_FILTER, { me: null, mine: new Map(), now: new Date("2026-09-30T00:00:00Z") }, new Map([["clip-a", standing], ["clip-b", standing]]));
  assert.deepEqual(result.map((x) => x.hit.identity.semanticId), [first.identity.semanticId, second.identity.semanticId]);
  assert.deepEqual(result.map((x) => x.entry.clip!.id), ["clip-a", "clip-b"]);
});

test("clip filters apply to semantic hits without re-sorting by ratings, and windows never appear in Clips", () => {
  const saved = hit("3".repeat(64), "saved_clip", "sample-a", "clip-a");
  const window = hit("4".repeat(64), "window", "sample-a");
  const result = semanticClipHits([saved, window], [clipEntry(clip("clip-a"))], { ...DEFAULT_FILTER, kind: "loop", sort: "newest" }, { me: null, mine: new Map(), now: new Date("2026-09-30T00:00:00Z") }, new Map([["clip-a", standing]]));
  assert.deepEqual(result.map((x) => x.hit.identity.semanticId), [saved.identity.semanticId]);
});

test("Samples retain one highest-scoring passage per canonical parent in retrieval order", () => {
  const first = hit("5".repeat(64), "window", "sample-a");
  const duplicateParent = { ...hit("6".repeat(64), "saved_clip", "sample-a", "clip-a"), score: 0.8 };
  const second = hit("7".repeat(64), "window", "sample-b");
  const result = semanticSampleHits([first, duplicateParent, second], [sampleEntry("sample-a"), sampleEntry("sample-b")]);
  assert.deepEqual(result.map((x) => [x.entry.id, x.hit.identity.semanticId]), [["sample-a", first.identity.semanticId], ["sample-b", second.identity.semanticId]]);
});

test("global sound groups retain retrieval order and give windows their canonical sample parent", () => {
  const saved = hit("8".repeat(64), "saved_clip", "sample-a", "clip-a");
  const window = hit("9".repeat(64), "window", "sample-a");
  const result = semanticGlobalHits([saved, window], [clipEntry(clip("clip-a"))], [sampleEntry("sample-a")]);
  assert.deepEqual(result.clips.map((x) => [x.entry.id, x.hit.identity.semanticId]), [["clip-a", saved.identity.semanticId]]);
  assert.deepEqual(result.passages.map((x) => [x.entry.id, x.hit.identity.semanticId]), [["sample-a", window.identity.semanticId]]);
});

test("pending catalog progress and semantic failure have independently visible sound states", () => {
  assert.deepEqual(soundHostState("drums", { phase: "encoding", query: "drums", progress: { phase: "download", loaded: 10, total: 100 } }, false), { kind: "status", text: "Loading sound model 10%…" });
  assert.deepEqual(soundHostState("drums", { phase: "ready", query: "drums", hits: [] }, false), { kind: "waiting", text: "Preparing sound matches…" });
  assert.deepEqual(soundHostState("drums", { phase: "ready", query: "drums", hits: [] }, true, new Error("catalog offline")), { kind: "error", text: "Sound cards unavailable. Retry" });
});

test("ready nonempty sound hits enter card rendering instead of an empty waiting status", () => {
  const matches = [hit("0".repeat(64), "window", "sample-a")];
  assert.deepEqual(soundHostState("drums", { phase: "ready", query: "drums", hits: matches }, true), { kind: "results" });
});

test("clear or navigation rejects a stale semantic reply before it reaches the sound host", () => {
  assert.deepEqual(soundHostState("", { phase: "ready", query: "drums", hits: [] }, true), { kind: "hidden" });
  assert.deepEqual(soundHostState("bass", { phase: "ready", query: "drums", hits: [] }, true), { kind: "hidden" });
});

test("ready semantic empty and Mine filtering are explicit rather than lexical fallbacks", () => {
  assert.deepEqual(soundHostState("drums", { phase: "ready", query: "drums", hits: [] }, true), { kind: "empty", text: "No sound matches “drums”." });
  const mine = hit("b".repeat(64), "saved_clip", "sample-a", "clip-a");
  const other = hit("c".repeat(64), "saved_clip", "sample-a", "clip-b");
  const owned = { ...clip("clip-a"), owner: "me" };
  const foreign = { ...clip("clip-b"), owner: "them" };
  const entries = semanticEntriesForView([clipEntry(owned), clipEntry(foreign)], true, false, (entry) => entry.owner === "me");
  const result = semanticClipHits([mine, other], entries, DEFAULT_FILTER, { me: { sub: "me" } as never, mine: new Map(), now: new Date("2026-09-30T00:00:00Z") }, new Map([["clip-a", standing], ["clip-b", standing]]));
  assert.deepEqual(result.map((item) => item.entry.id), ["clip-a"]);
});

test("clip sound cards expose an encoded canonical parent sample href", () => {
  const match = { hit: hit("f".repeat(64), "saved_clip", "sample-a", "clip-a"), entry: clipEntry(clip("clip-a")) };
  assert.equal(href(semanticSoundRoutes(match).parent), "/samples/drums");
});

test("clip semantic hits require the current canonical parent and exact boundaries", () => {
  const staleParent = hit("d".repeat(64), "saved_clip", "other-sample", "clip-a");
  const staleRange = { ...hit("e".repeat(64), "saved_clip", "sample-a", "clip-a"), identity: { ...hit("e".repeat(64), "saved_clip", "sample-a", "clip-a").identity, start: 0, end: 4 } };
  const result = semanticClipHits([staleParent, staleRange], [clipEntry(clip("clip-a"))], DEFAULT_FILTER, { me: null, mine: new Map(), now: new Date() }, new Map([["clip-a", standing]]));
  assert.deepEqual(result, []);
});

test("section grouping and filters expose best sample passages and Mine-only saved clips", () => {
  const window = hit("1".repeat(64), "window", "sample-a");
  const second = hit("2".repeat(64), "window", "sample-b");
  assert.deepEqual(semanticSampleHits([window, second], [sampleEntry("sample-a"), sampleEntry("sample-b")]).map((match) => match.entry.id), ["sample-a", "sample-b"]);
  const own = clipEntry({ ...clip("clip-a"), owner: "me" });
  const foreign = clipEntry({ ...clip("clip-b"), owner: "them" });
  const visible = semanticEntriesForView([own, foreign], true, false, (entry) => entry.owner === "me");
  assert.deepEqual(semanticClipHits([hit("3".repeat(64), "saved_clip", "sample-a", "clip-a"), hit("4".repeat(64), "saved_clip", "sample-a", "clip-b")], visible, DEFAULT_FILTER, { me: null, mine: new Map(), now: new Date() }, new Map([["clip-a", standing], ["clip-b", standing]])).map((match) => match.entry.id), ["clip-a"]);
});
