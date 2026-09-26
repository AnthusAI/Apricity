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
  planClips,
  scoreKey,
  scorePath,
  clipAnnotations,
  toManifest,
  toSummary,
  validateClips,
  type SampleRecord,
  type RecordingRecord,
  type ClipRecord,
} from "../src/data/catalog.ts";

const rec: RecordingRecord = { id: "rec_Thunderer", title: "The Thunderer", collection: "marine-band", credit: "Marine Band", rights: "Public domain" };
const source: SampleRecord = {
  id: "smp_src",
  recordingId: "rec_Thunderer",
  path: "marine-band/Thunderer.mp3",
  aliases: ["samples/marine-band/Thunderer.mp3"],
  collection: "marine-band",
  title: "Thunderer.mp3",
  role: "source",
  audio: { key: "audio/smp_src/Thunderer.mp3" },
  analysis: { key: "analysis/smp_src/aa.json" },
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
const stem: SampleRecord = { ...source, id: "smp_drums", path: "marine-band/stems/Thunderer/drums.wav", aliases: [], role: "stem", stem: "drums", parentSampleId: "smp_src", audio: { key: "audio/smp_drums/drums.wav" }, analysis: { key: "analysis/smp_drums/bb.json" }, key: "C minor" };
const excerpt: SampleRecord = { ...source, id: "smp_ex", recordingId: "rec_loc_1", path: "citizen-dj/loc-edison/march_001_00-01-55.wav", collection: "citizen-dj/loc-edison", excerptStart: 115, audio: { key: "audio/smp_ex/march.wav" }, analysis: { key: "analysis/smp_ex/cc.json" } };
const upload: SampleRecord = { ...source, id: "smp_up", recordingId: "rec_uploads_announcer", path: "uploads/announcer.wav", collection: "uploads", audio: { key: "audio/smp_up/announcer.wav" }, analysis: null };
const recs = new Map([rec, { id: "rec_loc_1", title: "The stars and stripes forever march", collection: "citizen-dj/loc-edison" }, { id: "rec_uploads_announcer", title: "uploads_announcer", collection: "uploads" }].map((r) => [r.id, r as RecordingRecord]));
const sampleMap = new Map([source, stem, excerpt, upload].map((c) => [c.id, c]));
const counts = { clips: new Map([["smp_drums", 3]]), markers: new Map([["smp_drums", 1]]) };

const clip = (id: string, name: string, start: number, end: number, extra: Partial<ClipRecord> = {}): ClipRecord => ({ id, sampleId: "smp_drums", name, start, end, source: "ml", ...extra });

test("key labels and keys over time", () => {
  assert.equal(keyLabel("Bb major"), "Bb");
  assert.equal(keyLabel("C minor"), "Cm");
  assert.equal(keyLabel(null), "");
  assert.deepEqual(keysOverTime(["Bb major", "Bb major", "G minor", null, "Bb major"]), ["Bb", "Gm", "Bb"]);
  assert.equal(excerptLabel(115), "00:01:55");
  assert.equal(excerptLabel(3725), "01:02:05");
  assert.equal(excerptLabel(null), undefined);
});

test("a sample record becomes the summary the Library list shows", () => {
  assert.deepEqual(toSummary(source, recs, sampleMap, counts), {
    id: "smp_src",
    createdAt: null,
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
  const s = toSummary(stem, recs, sampleMap, counts);
  assert.equal(s.title, "The Thunderer · drums");
  assert.equal(s.key, "Cm");
  assert.equal(s.stem, "drums");
  assert.deepEqual([s.clips, s.markers], [3, 1]);
  const e = toSummary(excerpt, recs, sampleMap, counts);
  assert.equal(e.group, "citizen-dj");
  assert.equal(e.excerpt_start, "00:01:55");
  assert.equal(e.title, "The stars and stripes forever march");
  assert.equal(toSummary(upload, recs, sampleMap, counts).title, "announcer", "an invented recording title falls back to the file name");
});

test("clips and markers become the manifest's annotations, in time order", () => {
  const analysis = { source: { path: "x", duration: 10, sample_rate: 44100, channels: 2 }, rhythm: { bpm: 120, beats: [0, 0.5], downbeats: [0], meter: 4 }, tonal: { key: { tonic: "C", mode: "minor", strength: 0.5 }, tuning_hz: 440, pitch_class_profile: [] } };
  const m = toManifest(analysis as any, [clip("s2", "loop-2", 4, 6, { tags: ["loop", "2 beats"] }), clip("s1", "mine", 1, 2, { source: "user" }), clip("s3", "old", 7, 8, { retired: true, candidateId: "cand_1" })], [
    { id: "m2", sampleId: "smp_drums", name: "b", seconds: 5, source: "ml" },
    { id: "m1", sampleId: "smp_drums", name: "a", seconds: 2, note: "hi" },
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
  assert.equal(clipAnnotations([clip("c", "cur", 0, 1, { source: "curated" })])[0].source, "user", "curated clips are yours in the editor");
});

test("score paths and ids follow the migration's scheme", () => {
  assert.equal(scorePath({ folder: "examples", title: "chop-shop", format: "apr" }), "examples/chop-shop.apr");
  assert.deepEqual(scoreKey("examples/chop-shop.apr"), { id: "scr_examples_chop-shop_apr", title: "chop-shop", folder: "examples", format: "apr" });
  assert.equal(scoreKey("scores/sub/x.yaml").id, "scr_scores_sub_x_yaml");
  assert.throws(() => scoreKey("x.txt"), /folder/);
});

test("edited clips: validated, then planned as clip creates, updates and deletes", () => {
  assert.deepEqual(validateClips([{ name: "ok", start: 0, end: 1 }], 10), []);
  const problems = validateClips([{ name: "a b", start: 0, end: 1 }, { name: "x", start: 2, end: 1 }, { name: "x", start: 0, end: 11 }], 10);
  assert.equal(problems.length, 3, "names and times; clashes are planClips' job");
  const existing = [clip("s1", "loop-1", 0, 2), clip("s2", "loop-2", 2, 4), clip("s3", "gone", 4, 5, { retired: true })];
  const plan = planClips("smp_drums", existing, [
    { id: "s1", name: "loop-1", start: 0, end: 2, source: "ml" },
    { id: "s2", name: "verse", start: 2, end: 4, source: "user" },
    { name: "clip-3", start: 5, end: 6, source: "user" },
  ]);
  assert.deepEqual(plan, {
    create: [{ sampleId: "smp_drums", name: "clip-3", start: 5, end: 6, source: "user" }],
    update: [{ id: "s2", name: "verse", start: 2, end: 4, source: "user" }],
    delete: [],
  });
  assert.deepEqual(planClips("smp_drums", existing, []).delete, ["s1", "s2"], "retired clips stay for the scores using them");
});

test("planClips only changes your own clips", () => {
  const theirs: ClipRecord = { id: "t1", sampleId: "smp_drums", name: "break", start: 0, end: 2, source: "user", owner: "u2::bob" };
  const ml: ClipRecord = { id: "m1", sampleId: "smp_drums", name: "loop-1", start: 2, end: 4, source: "ml", owner: "u0::importer" };
  const yours: ClipRecord = { id: "y1", sampleId: "smp_drums", name: "fill", start: 4, end: 5, source: "user", owner: "u1::ann" };
  const mine = (r: ClipRecord) => r.owner === "u1::ann";
  // Nothing changed: nothing to do, and other people's clips are never deleted by leaving them out.
  assert.deepEqual(planClips("smp_drums", [theirs, ml, yours], [], mine), { create: [], update: [], delete: ["y1"] });
  // Editing someone else's clip, or an automatic one, saves your own copy.
  assert.deepEqual(
    planClips("smp_drums", [theirs, ml, yours], [
      { id: "t1", name: "break-2", start: 0, end: 2, source: "user" },
      { id: "m1", name: "loop-1", start: 2, end: 3.5, source: "ml" },
      { id: "y1", name: "fill", start: 4, end: 5, source: "user" },
    ], mine, "ann"),
    {
      create: [
        { sampleId: "smp_drums", name: "break-2", start: 0, end: 2, source: "user" },
        { sampleId: "smp_drums", name: "loop-1-ann", start: 2, end: 3.5, source: "user" },
      ],
      update: [],
      delete: [],
    },
  );
});

test("clip names are unique on a sample", () => {
  const theirs: ClipRecord = { id: "t1", sampleId: "smp_drums", name: "loop-1", start: 0, end: 2, source: "user", owner: "u2::bob" };
  const taken: ClipRecord = { id: "t2", sampleId: "smp_drums", name: "loop-1-ann", start: 3, end: 4, source: "user", owner: "u2::bob" };
  const old: ClipRecord = { id: "r1", sampleId: "smp_drums", name: "fill", start: 5, end: 6, source: "user", owner: "u1::ann", retired: true };
  const yours: ClipRecord = { id: "y1", sampleId: "smp_drums", name: "hit", start: 7, end: 8, source: "user", owner: "u1::ann" };
  const mine = (r: ClipRecord) => r.owner === "u1::ann";
  const all = [theirs, taken, old, yours];
  // A copy of someone's clip gets your handle, and a number when that is taken too.
  assert.deepEqual(
    planClips("smp_drums", all, [{ id: "t1", name: "loop-1", start: 0, end: 1.5, source: "user" }, { id: "y1", name: "hit", start: 7, end: 8 }], mine, "ann").create.map((c) => c.name),
    ["loop-1-ann-2"],
  );
  // A new or renamed clip may not take a name someone else's (or a retired) clip keeps.
  assert.throws(() => planClips("smp_drums", all, [{ name: "loop-1", start: 9, end: 10 }], mine, "ann"), /"loop-1" is already a clip on this sample; try "loop-1-ann-2"/);
  assert.throws(() => planClips("smp_drums", all, [{ id: "y1", name: "fill", start: 7, end: 8 }], mine, "ann"), /"fill" is already/);
  assert.throws(() => planClips("smp_drums", [yours], [{ name: "a", start: 0, end: 1 }, { name: "a", start: 1, end: 2 }], mine), /"a" is already a clip on this sample; try "a-copy"/);
  // Clashes already in the records don't block anyone's save.
  const dup: ClipRecord = { ...theirs, id: "t3", owner: "u3::cy" };
  const dupMine: ClipRecord = { ...yours, id: "y2", name: "loop-1" };
  assert.deepEqual(planClips("smp_drums", [theirs, dup, dupMine], [{ id: "y2", name: "loop-1", start: 7, end: 9 }], mine, "ann").update, [
    { id: "y2", name: "loop-1", start: 7, end: 9, source: "user" },
  ]);
});

test("listAll follows nextToken and surfaces errors", async () => {
  const pages: Record<string, { data: number[]; nextToken: string | null }> = { start: { data: [1, 2], nextToken: "b" }, b: { data: [], nextToken: "c" }, c: { data: [3], nextToken: null } };
  const seen: (string | null)[] = [];
  assert.deepEqual(await listAll((t) => (seen.push(t), Promise.resolve(pages[t ?? "start"]))), [1, 2, 3]);
  assert.deepEqual(seen, [null, "b", "c"]);
  await assert.rejects(listAll(() => Promise.resolve({ data: null, errors: [{ message: "boom", errorType: "Internal" }] })), /boom/);
  await assert.rejects(listAll(() => Promise.resolve({ data: null, errors: [{ message: "Not Authorized to access listSamples on type Query", errorType: "Unauthorized" }] })), SignedOut);
  await assert.rejects(listAll(() => Promise.reject(Object.assign(new Error("No current user"), { name: "NoValidAuthTokens" }))), SignedOut);
  assert.ok(isUnauthorized({ errors: [{ errorType: "Unauthorized" }] }));
  assert.ok(!isUnauthorized(new Error("network down")));
});

/** A stub of the generated client: one page per list call, index queries by sampleId. */
function stubClient(state: { signedIn: boolean; samples: SampleRecord[]; clips: ClipRecord[]; scores: any[] }, calls: string[] = []) {
  const guard = <T>(name: string, v: () => T) => {
    calls.push(name);
    if (!state.signedIn) return Promise.reject(Object.assign(new Error("No current user"), { name: "NoValidAuthTokens" }));
    return Promise.resolve(v());
  };
  const list = (name: string, items: () => unknown[]) => ({ list: () => guard(`${name}.list`, () => ({ data: items(), nextToken: null })) });
  return {
    models: {
      Sample: list("Sample", () => state.samples),
      Recording: list("Recording", () => [...recs.values()]),
      Clip: {
        ...list("Clip", () => state.clips),
        clipsBySample: ({ sampleId }: { sampleId: string }) => guard("Clip.clipsBySample", () => ({ data: state.clips.filter((s) => s.sampleId === sampleId), nextToken: null })),
        create: (s: ClipRecord) => guard("Clip.create", () => (state.clips.push(s), { data: s })),
        update: (u: ClipRecord) => guard("Clip.update", () => (Object.assign(state.clips.find((s) => s.id === u.id)!, u), { data: u })),
        delete: ({ id }: { id: string }) => guard("Clip.delete", () => ((state.clips = state.clips.filter((s) => s.id !== id)), { data: { id } })),
      },
      Marker: { ...list("Marker", () => []), markersBySample: () => guard("Marker.markersBySample", () => ({ data: [], nextToken: null })) },
      Job: list("Job", () => []),
      Score: {
        ...list("Score", () => state.scores),
        get: ({ id }: { id: string }) => guard("Score.get", () => ({ data: state.scores.find((s) => s.id === id) ?? null })),
        create: (s: any) => guard("Score.create", () => (state.scores.push(s), { data: s })),
        update: (u: any) => guard("Score.update", () => (Object.assign(state.scores.find((s) => s.id === u.id)!, u), { data: u })),
      },
    },
  };
}

const analysisJson = JSON.stringify({ source: { path: "d.wav", duration: 180.5, sample_rate: 44100, channels: 2 }, rhythm: { bpm: 120, beats: [0], downbeats: [0], meter: 2 }, tonal: { key: { tonic: "C", mode: "minor", strength: 1 }, tuning_hz: 440, pitch_class_profile: [] } });

test("signed out: the views get SignedOut (their empty state), and reload after sign-in", async () => {
  const state = { signedIn: false, samples: [source, stem], clips: [clip("s1", "loop-1", 0, 2)], scores: [{ id: "scr_examples_a_apr", title: "a", folder: "examples", format: "apr", text: "tempo 90" }] };
  const cat = new Catalog({ client: () => stubClient(state), readText: async () => analysisJson, url: async (k) => `/files/${k}` });
  await assert.rejects(cat.samples(), SignedOut);
  await assert.rejects(cat.scores(), SignedOut);
  await assert.rejects(cat.manifest("samples/marine-band/stems/Thunderer/drums.wav"), SignedOut);
  state.signedIn = true; // apricity:auth-changed -> reset()
  cat.reset();
  const { samples } = await cat.samples();
  assert.deepEqual(samples.map((s) => s.path), ["samples/marine-band/Thunderer.mp3", "samples/marine-band/stems/Thunderer/drums.wav"]);
  assert.deepEqual((await cat.scores()).scores, [{ id: "scr_examples_a_apr", path: "examples/a.apr", title: "a", kind: "song", owner: null, createdAt: null, modified: 0 }]);
  assert.equal(await cat.score("examples/a.apr"), "tempo 90");
});

test("manifests, audio urls and saves go through the records", async () => {
  const state = { signedIn: true, samples: [source, stem], clips: [clip("s1", "loop-1", 0, 2), clip("s2", "loop-2", 2, 4)], scores: [] as any[] };
  const reads: string[] = [];
  const cat = new Catalog({ client: () => stubClient(state), readText: async (k) => (reads.push(k), analysisJson), url: async (k) => `https://bucket/files/${k}?sig` });
  const m = (await cat.manifest("marine-band/stems/Thunderer/drums.wav"))!; // a catalog alias works too
  assert.deepEqual(reads, ["analysis/smp_drums/bb.json"]);
  assert.deepEqual(m.annotations!.clips!.map((c) => c.name), ["loop-1", "loop-2"]);
  assert.equal(await cat.audioUrl("samples/marine-band/Thunderer.mp3"), "https://bucket/files/audio/smp_src/Thunderer.mp3?sig");
  await assert.rejects(cat.audioUrl("samples/nope.wav"), /not in the library/);

  await cat.saveClips("samples/marine-band/stems/Thunderer/drums.wav", [{ id: "s1", name: "intro", start: 0, end: 2, source: "user" }, { name: "clip-2", start: 5, end: 6, source: "user" }]);
  assert.deepEqual(state.clips.map((s) => [s.name, s.source]).sort(), [["clip-2", "user"], ["intro", "user"]]);
  assert.match(state.clips.find((s) => s.name === "clip-2")!.id, /^clp_/);
  await assert.rejects(cat.saveClips("samples/marine-band/stems/Thunderer/drums.wav", [{ name: "bad name", start: 0, end: 1 }]), /letters, digits/);

  const saved: [string, string][] = [];
  await cat.saveScore("scores/new-one.apr", "tempo 100", async (id, text) => (saved.push([id, text]), {}));
  assert.deepEqual(state.scores.map((s) => [s.id, s.title, s.folder, s.format]), [["scr_scores_new-one_apr", "new-one", "scores", "apr"]]);
  assert.deepEqual(saved, [["scr_scores_new-one_apr", "tempo 100"]]);
  await assert.rejects(cat.saveScore("scores/new-one.apr", "x", async () => ({ errors: [{ message: "Not Authorized to access updateScore", errorType: "Unauthorized" }] })), (e: Error) => !(e instanceof SignedOut) && /updateScore/.test(e.message), "a refused write says why, not 'sign in'");
});

test("the Clips list: every live clip with its sample, and score kinds", async () => {
  const state = {
    signedIn: true,
    samples: [source, stem],
    clips: [clip("s1", "loop-1", 0, 2, { owner: "google_1", createdAt: "2026-09-25T00:00:00Z" } as any), clip("s2", "gone", 2, 4, { retired: true }), clip("s3", "orphan", 0, 1, { sampleId: "smp_missing" })],
    scores: [{ id: "scr_examples_a_apr", title: "a", folder: "examples", format: "apr", text: "tempo 90", kind: "beat", owner: "google_1" }] as any[],
  };
  const cat = new Catalog({ client: () => stubClient(state), readText: async () => analysisJson, url: async (k) => `/files/${k}` });
  assert.deepEqual(await cat.clips(), [
    { id: "s1", name: "loop-1", sampleId: "smp_drums", samplePath: "samples/marine-band/stems/Thunderer/drums.wav", sampleTitle: "The Thunderer · drums", start: 0, end: 2, source: "ml", owner: "google_1", createdAt: "2026-09-25T00:00:00Z" },
  ]);
  assert.equal((await cat.scores()).scores[0].kind, "beat");
  await cat.setScoreKind("examples/a.apr", "chords");
  assert.equal(state.scores[0].kind, "chords");
  assert.equal((await cat.scores()).scores[0].kind, "chords", "the list is reloaded after a change");
  await assert.rejects(cat.setScoreKind("examples/nope.apr", "beat"), /no such score/);
});
