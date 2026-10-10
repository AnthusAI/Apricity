import { test } from "node:test";
import assert from "node:assert/strict";

import { clipEntry, matches, rowOf, sampleEntry, scoreEntry } from "../src/data/sections.ts";
import { Handles } from "../src/data/handles.ts";

const names = new Handles([{ id: "ann", owner: "u1::u1" }]);
const score = { id: "scr_1", path: "scores/u1/groove.apr", title: "Deep Groove", kind: "beat" as const, tags: ["techno", "deep-house"], owner: "u1::u1", createdAt: "2026-09-20T00:00:00Z", modified: 0 };
const clip = { id: "clp_1", name: "loop-2", sampleId: "smp_1", samplePath: "ccmixter/x.mp3", sampleTitle: "Remixing is Okay", start: 1, end: 3, source: "ml" as const, kind: "loop", owner: null, createdAt: null };

test("search matches every word, in any case: titles, #tags with or without the #, @handles, a clip's sample", () => {
  const s = scoreEntry(score, names);
  for (const q of ["deep", "GROOVE deep", "#techno", "techno", "#deep-house", "@ann", "ann groove"]) assert.ok(matches(s, q), q);
  for (const q of ["lounge", "groove lounge", "@bob"]) assert.ok(!matches(s, q), q);
  const c = clipEntry(clip, names);
  assert.ok(matches(c, "remixing loop"));
  assert.ok(matches(sampleEntry({ id: "smp_1", path: "marine-band/Thunderer.mp3", title: "The Thunderer", group: "marine-band", duration: 1, bpm: 120.2, key: "C major", camelot: "8B", keys_over_time: [], notes: 0, clips: 0, markers: 0 }), "thunderer 120 bpm 8b"));
});

test("an entry's card row: a clip says its sample and where it sits in it; stars come from its standing", () => {
  const r = rowOf(clipEntry(clip, names), { count: 2, sum: 8, average: 4, score: 3.3 });
  assert.deepEqual([r.targetType, r.title, r.from, r.samplePath, r.clipStart, r.clipEnd, r.stars, r.ratings], ["clip", "loop-2", "Remixing is Okay", "ccmixter/x.mp3", 1, 3, 4, 2]);
  assert.equal(sampleEntry({ id: "smp_2", path: "a/b.flac", title: "B", group: "a", duration: 1, bpm: null, key: "", keys_over_time: [], notes: 0, clips: 0, markers: 0 }).base.path, "samples/a/b.flac");
});
