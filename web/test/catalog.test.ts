// Library/Score data from records: the mappers, paging, and the signed-out state, on a stubbed client.
// Run: npx tsx --test web/test/catalog.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Catalog,
  SignedOut,
  excerptLabel,
  isUnauthorized,
  keyLabel,
  keysOverTime,
  listAll,
  planSlices,
  scoreKey,
  scorePath,
  sliceAnnotations,
  toManifest,
  toSummary,
  validateClips,
  type ClipRecord,
  type RecordingRecord,
  type SliceRecord,
} from "../src/data/catalog.ts";

const rec: RecordingRecord = { id: "rec_Thunderer", title: "The Thunderer", collection: "marine-band", credit: "Marine Band", rights: "Public domain" };
const source: ClipRecord = {
  id: "clp_src",
  recordingId: "rec_Thunderer",
  path: "marine-band/Thunderer.mp3",
  aliases: ["samples/marine-band/Thunderer.mp3"],
  collection: "marine-band",
  title: "Thunderer.mp3",
  role: "source",
  audio: { key: "audio/clp_src/Thunderer.mp3" },
  analysis: { key: "analysis/clp_src/aa.json" },
  duration: 180.5,
  bpm: 120,
  bpmStability: 0.9,
  meter: 2,
  key: "Bb major",
  camelot: "6B",
  keysOverTime: ["Bb major", "Bb major", "G minor", "Bb major"],
  tuningCents: -12,
  noteCount: 400,
};
const stem: ClipRecord = { ...source, id: "clp_drums", path: "marine-band/stems/Thunderer/drums.wav", aliases: [], role: "stem", stem: "drums", parentClipId: "clp_src", audio: { key: "audio/clp_drums/drums.wav" }, analysis: { key: "analysis/clp_drums/bb.json" }, key: "C minor" };
const excerpt: ClipRecord = { ...source, id: "clp_ex", recordingId: "rec_loc_1", path: "citizen-dj/loc-edison/march_001_00-01-55.wav", collection: "citizen-dj/loc-edison", excerptStart: 115, audio: { key: "audio/clp_ex/march.wav" }, analysis: { key: "analysis/clp_ex/cc.json" } };
const upload: ClipRecord = { ...source, id: "clp_up", recordingId: "rec_uploads_announcer", path: "uploads/announcer.wav", collection: "uploads", audio: { key: "audio/clp_up/announcer.wav" }, analysis: null };
const recs = new Map([rec, { id: "rec_loc_1", title: "The stars and stripes forever march", collection: "citizen-dj/loc-edison" }, { id: "rec_uploads_announcer", title: "uploads_announcer", collection: "uploads" }].map((r) => [r.id, r as RecordingRecord]));
const clipMap = new Map([source, stem, excerpt, upload].map((c) => [c.id, c]));
const counts = { slices: new Map([["clp_drums", 3]]), markers: new Map([["clp_drums", 1]]) };

const slice = (id: string, name: string, start: number, end: number, extra: Partial<SliceRecord> = {}): SliceRecord => ({ id, clipId: "clp_drums", name, start, end, source: "ml", ...extra });

test("key labels and keys over time", () => {
  assert.equal(keyLabel("Bb major"), "Bb");
  assert.equal(keyLabel("C minor"), "Cm");
  assert.equal(keyLabel(null), "");
  assert.deepEqual(keysOverTime(["Bb major", "Bb major", "G minor", null, "Bb major"]), ["Bb", "Gm", "Bb"]);
  assert.equal(excerptLabel(115), "00:01:55");
  assert.equal(excerptLabel(3725), "01:02:05");
  assert.equal(excerptLabel(null), undefined);
});

test("a clip record becomes the summary the Library list shows", () => {
  assert.deepEqual(toSummary(source, recs, clipMap, counts), {
    path: "samples/marine-band/Thunderer.mp3",
    title: "The Thunderer",
    group: "marine-band",
    excerpt_start: undefined,
    credit: "Marine Band",
    rights: "Public domain",
    duration: 180.5,
    bpm: 120,
    stability: 0.9,
    meter: 2,
    key: "Bb",
    camelot: "6B",
    keys_over_time: ["Bb", "Gm", "Bb"],
    tuning_cents: -12,
    notes: 400,
    clips: 0,
    markers: 0,
    stem: null,
  });
  const s = toSummary(stem, recs, clipMap, counts);
  assert.equal(s.title, "The Thunderer · drums");
  assert.equal(s.key, "Cm");
  assert.equal(s.stem, "drums");
  assert.deepEqual([s.clips, s.markers], [3, 1]);
  const e = toSummary(excerpt, recs, clipMap, counts);
  assert.equal(e.group, "citizen-dj");
  assert.equal(e.excerpt_start, "00:01:55");
  assert.equal(e.title, "The stars and stripes forever march");
  assert.equal(toSummary(upload, recs, clipMap, counts).title, "announcer", "an invented recording title falls back to the file name");
});

test("slices and markers become the manifest's annotations, in time order", () => {
  const analysis = { source: { path: "x", duration: 10, sample_rate: 44100, channels: 2 }, rhythm: { bpm: 120, beats: [0, 0.5], downbeats: [0], meter: 4 }, tonal: { key: { tonic: "C", mode: "minor", strength: 0.5 }, tuning_hz: 440, pitch_class_profile: [] } };
  const m = toManifest(analysis as any, [slice("s2", "loop-2", 4, 6, { tags: ["loop", "2 beats"] }), slice("s1", "mine", 1, 2, { source: "user" }), slice("s3", "old", 7, 8, { retired: true, candidateId: "cand_1" })], [
    { id: "m2", clipId: "clp_drums", name: "b", seconds: 5, source: "ml" },
    { id: "m1", clipId: "clp_drums", name: "a", seconds: 2, note: "hi" },
  ]);
  assert.deepEqual(m.rhythm, analysis.rhythm, "the analysis is passed through");
  assert.deepEqual(m.annotations, {
    clips: [
      { id: "s1", name: "mine", start: 1, end: 2, source: "user" },
      { id: "s2", name: "loop-2", start: 4, end: 6, source: "ml", tags: ["loop", "2 beats"] },
      { id: "s3", name: "old", start: 7, end: 8, source: "ml", retired: true, candidate: "cand_1" },
    ],
    markers: [
      { name: "a", seconds: 2, note: "hi" },
      { name: "b", seconds: 5, source: "ml" },
    ],
  });
  assert.equal(sliceAnnotations([slice("c", "cur", 0, 1, { source: "curated" })])[0].source, "user", "curated slices are yours in the editor");
});

test("score paths and ids follow the migration's scheme", () => {
  assert.equal(scorePath({ folder: "examples", title: "chop-shop", format: "apr" }), "examples/chop-shop.apr");
  assert.deepEqual(scoreKey("examples/chop-shop.apr"), { id: "scr_examples_chop-shop_apr", title: "chop-shop", folder: "examples", format: "apr" });
  assert.equal(scoreKey("scores/sub/x.yaml").id, "scr_scores_sub_x_yaml");
  assert.throws(() => scoreKey("x.txt"), /folder/);
});

test("edited clips: validated, then planned as slice creates, updates and deletes", () => {
  assert.deepEqual(validateClips([{ name: "ok", start: 0, end: 1 }], 10), []);
  const problems = validateClips([{ name: "a b", start: 0, end: 1 }, { name: "x", start: 2, end: 1 }, { name: "x", start: 0, end: 11 }], 10);
  assert.equal(problems.length, 4);
  const existing = [slice("s1", "loop-1", 0, 2), slice("s2", "loop-2", 2, 4), slice("s3", "gone", 4, 5, { retired: true })];
  const plan = planSlices("clp_drums", existing, [
    { id: "s1", name: "loop-1", start: 0, end: 2, source: "ml" },
    { id: "s2", name: "verse", start: 2, end: 4, source: "user" },
    { name: "clip-3", start: 5, end: 6, source: "user" },
  ]);
  assert.deepEqual(plan, {
    create: [{ clipId: "clp_drums", name: "clip-3", start: 5, end: 6, source: "user" }],
    update: [{ id: "s2", name: "verse", start: 2, end: 4, source: "user" }],
    delete: [],
  });
  assert.deepEqual(planSlices("clp_drums", existing, []).delete, ["s1", "s2"], "retired slices stay for the scores using them");
});

test("listAll follows nextToken and surfaces errors", async () => {
  const pages: Record<string, { data: number[]; nextToken: string | null }> = { start: { data: [1, 2], nextToken: "b" }, b: { data: [], nextToken: "c" }, c: { data: [3], nextToken: null } };
  const seen: (string | null)[] = [];
  assert.deepEqual(await listAll((t) => (seen.push(t), Promise.resolve(pages[t ?? "start"]))), [1, 2, 3]);
  assert.deepEqual(seen, [null, "b", "c"]);
  await assert.rejects(listAll(() => Promise.resolve({ data: null, errors: [{ message: "boom", errorType: "Internal" }] })), /boom/);
  await assert.rejects(listAll(() => Promise.resolve({ data: null, errors: [{ message: "Not Authorized to access listClips on type Query", errorType: "Unauthorized" }] })), SignedOut);
  await assert.rejects(listAll(() => Promise.reject(Object.assign(new Error("No current user"), { name: "NoValidAuthTokens" }))), SignedOut);
  assert.ok(isUnauthorized({ errors: [{ errorType: "Unauthorized" }] }));
  assert.ok(!isUnauthorized(new Error("network down")));
});

/** A stub of the generated client: one page per list call, index queries by clipId. */
function stubClient(state: { signedIn: boolean; clips: ClipRecord[]; slices: SliceRecord[]; scores: any[] }, calls: string[] = []) {
  const guard = <T>(name: string, v: () => T) => {
    calls.push(name);
    if (!state.signedIn) return Promise.reject(Object.assign(new Error("No current user"), { name: "NoValidAuthTokens" }));
    return Promise.resolve(v());
  };
  const list = (name: string, items: () => unknown[]) => ({ list: () => guard(`${name}.list`, () => ({ data: items(), nextToken: null })) });
  return {
    models: {
      Clip: list("Clip", () => state.clips),
      Recording: list("Recording", () => [...recs.values()]),
      Slice: {
        ...list("Slice", () => state.slices),
        slicesByClip: ({ clipId }: { clipId: string }) => guard("Slice.slicesByClip", () => ({ data: state.slices.filter((s) => s.clipId === clipId), nextToken: null })),
        create: (s: SliceRecord) => guard("Slice.create", () => (state.slices.push(s), { data: s })),
        update: (u: SliceRecord) => guard("Slice.update", () => (Object.assign(state.slices.find((s) => s.id === u.id)!, u), { data: u })),
        delete: ({ id }: { id: string }) => guard("Slice.delete", () => ((state.slices = state.slices.filter((s) => s.id !== id)), { data: { id } })),
      },
      Marker: { ...list("Marker", () => []), markersByClip: () => guard("Marker.markersByClip", () => ({ data: [], nextToken: null })) },
      Job: list("Job", () => []),
      Score: {
        ...list("Score", () => state.scores),
        get: ({ id }: { id: string }) => guard("Score.get", () => ({ data: state.scores.find((s) => s.id === id) ?? null })),
        create: (s: any) => guard("Score.create", () => (state.scores.push(s), { data: s })),
      },
    },
  };
}

const analysisJson = JSON.stringify({ source: { path: "d.wav", duration: 180.5, sample_rate: 44100, channels: 2 }, rhythm: { bpm: 120, beats: [0], downbeats: [0], meter: 2 }, tonal: { key: { tonic: "C", mode: "minor", strength: 1 }, tuning_hz: 440, pitch_class_profile: [] } });

test("signed out: the views get SignedOut (their empty state), and reload after sign-in", async () => {
  const state = { signedIn: false, clips: [source, stem], slices: [slice("s1", "loop-1", 0, 2)], scores: [{ id: "scr_examples_a_apr", title: "a", folder: "examples", format: "apr", text: "tempo 90" }] };
  const cat = new Catalog({ client: () => stubClient(state), readText: async () => analysisJson, url: async (k) => `/files/${k}` });
  await assert.rejects(cat.samples(), SignedOut);
  await assert.rejects(cat.scores(), SignedOut);
  await assert.rejects(cat.manifest("samples/marine-band/stems/Thunderer/drums.wav"), SignedOut);
  state.signedIn = true; // apricity:auth-changed -> reset()
  cat.reset();
  const { samples } = await cat.samples();
  assert.deepEqual(samples.map((s) => s.path), ["samples/marine-band/Thunderer.mp3", "samples/marine-band/stems/Thunderer/drums.wav"]);
  assert.deepEqual((await cat.scores()).scores, [{ path: "examples/a.apr", modified: 0 }]);
  assert.equal(await cat.score("examples/a.apr"), "tempo 90");
});

test("manifests, audio urls and saves go through the records", async () => {
  const state = { signedIn: true, clips: [source, stem], slices: [slice("s1", "loop-1", 0, 2), slice("s2", "loop-2", 2, 4)], scores: [] as any[] };
  const reads: string[] = [];
  const cat = new Catalog({ client: () => stubClient(state), readText: async (k) => (reads.push(k), analysisJson), url: async (k) => `https://bucket/files/${k}?sig` });
  const m = (await cat.manifest("marine-band/stems/Thunderer/drums.wav"))!; // a catalog alias works too
  assert.deepEqual(reads, ["analysis/clp_drums/bb.json"]);
  assert.deepEqual(m.annotations!.clips!.map((c) => c.name), ["loop-1", "loop-2"]);
  assert.equal(await cat.audioUrl("samples/marine-band/Thunderer.mp3"), "https://bucket/files/audio/clp_src/Thunderer.mp3?sig");
  await assert.rejects(cat.audioUrl("samples/nope.wav"), /not in the library/);

  await cat.saveClips("samples/marine-band/stems/Thunderer/drums.wav", [{ id: "s1", name: "intro", start: 0, end: 2, source: "user" }, { name: "clip-2", start: 5, end: 6, source: "user" }]);
  assert.deepEqual(state.slices.map((s) => [s.name, s.source]).sort(), [["clip-2", "user"], ["intro", "user"]]);
  assert.match(state.slices.find((s) => s.name === "clip-2")!.id, /^slc_/);
  await assert.rejects(cat.saveClips("samples/marine-band/stems/Thunderer/drums.wav", [{ name: "bad name", start: 0, end: 1 }]), /letters, digits/);

  const saved: [string, string][] = [];
  await cat.saveScore("scores/new-one.apr", "tempo 100", async (id, text) => (saved.push([id, text]), {}));
  assert.deepEqual(state.scores.map((s) => [s.id, s.title, s.folder, s.format]), [["scr_scores_new-one_apr", "new-one", "scores", "apr"]]);
  assert.deepEqual(saved, [["scr_scores_new-one_apr", "tempo 100"]]);
  await assert.rejects(cat.saveScore("scores/new-one.apr", "x", async () => ({ errors: [{ message: "Not Authorized to access updateScore", errorType: "Unauthorized" }] })), (e: Error) => !(e instanceof SignedOut) && /updateScore/.test(e.message), "a refused write says why, not 'sign in'");
});
