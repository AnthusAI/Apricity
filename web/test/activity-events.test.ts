import { test } from "node:test";
import assert from "node:assert/strict";

import { changesOf, modelOf, type Image } from "../amplify/functions/activity/events.ts";

const img = (o: Record<string, string | number | boolean>): Image =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? { N: String(v) } : typeof v === "boolean" ? { BOOL: v } : { S: v }]));
const NOW = "2026-09-26T15:00:00.000Z";

test("the model comes from the stream's table", () => {
  assert.equal(modelOf("arn:aws:dynamodb:us-east-1:1:table/Score-abc-NONE/stream/2026"), "Score");
  assert.equal(modelOf("Comment-abc-NONE"), "Comment");
});

test("new scores, samples and people's clips are made; ML clips and repeats are not news", () => {
  const score = img({ id: "scr_1", title: "funk", kind: "beat", owner: "u1", text: "tempo 90", createdAt: "2026-09-26T10:00:00Z" });
  const [c] = changesOf("Score", "INSERT", null, score, NOW);
  assert.equal(c.key, "score#scr_1");
  assert.deepEqual(c.card, { title: "funk", kind: "beat", owner: "u1" });
  assert.deepEqual(c.line, { id: "made#score#scr_1", op: "put", what: "made", at: "2026-09-26T10:00:00Z", by: "u1" });
  assert.equal(c.bump, true);
  assert.equal(changesOf("Sample", "INSERT", null, img({ id: "smp_1", title: "horns", owner: "u0" }), NOW)[0].line.id, "made#sample#smp_1");
  assert.equal(changesOf("Sample", "MODIFY", img({ id: "smp_1" }), img({ id: "smp_1", title: "x" }), NOW).length, 0, "an import re-run");
  assert.equal(changesOf("Clip", "INSERT", null, img({ id: "clp_1", name: "loop-1", source: "ml", sampleId: "smp_1" }), NOW).length, 0);
  const clip = changesOf("Clip", "INSERT", null, img({ id: "clp_2", name: "hook", source: "user", sampleId: "smp_1", owner: "u2" }), NOW)[0];
  assert.deepEqual(clip.card, { title: "hook", kind: "clip", owner: "u2", sampleId: "smp_1" });
});

test("a changed score is news only when its text changed; saves in one hour are one line", () => {
  const before = img({ id: "scr_1", title: "funk", owner: "u1", text: "tempo 90" });
  const same = img({ id: "scr_1", title: "funk", owner: "u1", text: "tempo 90", kind: "beat" });
  assert.equal(changesOf("Score", "MODIFY", before, same, NOW).length, 0, "a kind change, or an import re-run");
  const after = img({ id: "scr_1", title: "funk", owner: "u1", text: "tempo 96", updatedAt: "2026-09-26T14:25:00Z" });
  const [c] = changesOf("Score", "MODIFY", before, after, NOW);
  assert.deepEqual(c.line, { id: "changed#score#scr_1#u1#2026-09-26T14", op: "put", overwrite: true, what: "changed", at: "2026-09-26T14:25:00Z", by: "u1" });
});

test("ratings: new ones count, changed ones replace their line, taken-back ones uncount without moving the card", () => {
  const r = (stars: number) => img({ id: "score#scr_1#u9", owner: "u9", targetType: "score", targetId: "scr_1", stars, ratedAt: "2026-09-26T12:00:00Z" });
  const [add] = changesOf("Rating", "INSERT", null, r(4), NOW);
  assert.deepEqual([add.key, add.counts, add.bump, add.line.id, add.line.stars, add.line.overwrite], ["score#scr_1", { ratings: 1 }, true, "rated#score#scr_1#u9", 4, false]);
  const [change] = changesOf("Rating", "MODIFY", r(4), r(2), NOW);
  assert.deepEqual([change.counts, change.line.overwrite, change.line.stars], [undefined, true, 2]);
  const [gone] = changesOf("Rating", "REMOVE", r(2), null, NOW);
  assert.deepEqual([gone.counts, gone.bump, gone.line.op], [{ ratings: -1 }, false, "remove"]);
  assert.equal(changesOf("Rating", "INSERT", null, img({ id: "score#scr_1#someone-else", owner: "u9", targetType: "score", targetId: "scr_1", stars: 5, ratedAt: NOW }), NOW).length, 0, "an id that isn't the rater's");
});

test("comments count and bump; deleting one removes its line and uncounts", () => {
  const c = (extra: Record<string, string | boolean> = {}) => img({ id: "cmt_1", targetType: "sample", targetId: "smp_1", owner: "u3", body: "nice", createdAt: "2026-09-26T13:00:00Z", ...extra });
  const [add] = changesOf("Comment", "INSERT", null, c(), NOW);
  assert.deepEqual([add.key, add.counts, add.bump, add.line.id, add.line.commentId, add.line.by], ["sample#smp_1", { comments: 1 }, true, "comment#cmt_1", "cmt_1", "u3"]);
  assert.equal(changesOf("Comment", "MODIFY", c(), c({ body: "nicer" }), NOW).length, 0, "an edit isn't news");
  const [del] = changesOf("Comment", "MODIFY", c(), c({ deleted: true, body: "" }), NOW);
  assert.deepEqual([del.counts, del.bump, del.line], [{ comments: -1 }, false, { id: "comment#cmt_1", op: "remove", at: NOW }]);
  assert.equal(changesOf("Comment", "REMOVE", c({ deleted: true }), null, NOW).length, 0, "already counted out");
  assert.equal(changesOf("Comment", "REMOVE", c(), null, NOW)[0].counts!.comments, -1);
});

test("a fork is news twice: on its own card and on the original's, which it moves up and counts", () => {
  const fork = img({ id: "scr_2", title: "funk-2", kind: "beat", owner: "u2", text: "tempo 96", forkOf: "scr_1", forkRoot: "scr_1", createdAt: "2026-09-26T16:00:00Z" });
  const [own, parent] = changesOf("Score", "INSERT", null, fork, NOW);
  assert.deepEqual([own.key, own.line.id, own.line.what, own.line.otherId, own.bump], ["score#scr_2", "forked#score#scr_2", "forked", "scr_1", true]);
  assert.deepEqual([parent.key, parent.line.id, parent.line.otherId, parent.line.otherTitle, parent.bump, parent.counts], ["score#scr_1", "fork#score#scr_1#scr_2", "scr_2", "funk-2", true, { forks: 1 }]);
  assert.equal(parent.card, undefined, "the original's card keeps its own facts");
  const copy = img({ id: "clp_2", name: "loop-1-bo", source: "user", sampleId: "smp_1", owner: "u2", copyOf: "clp_1" });
  const [c1, c2] = changesOf("Clip", "INSERT", null, copy, NOW);
  assert.deepEqual([c1.line.id, c1.line.what, c2.key, c2.line.id], ["copied#clip#clp_2", "copied", "clip#clp_1", "copy#clip#clp_1#clp_2"]);
});
