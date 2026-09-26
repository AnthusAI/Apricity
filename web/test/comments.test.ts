import { test } from "node:test";
import assert from "node:assert/strict";

import { countOf, threadOf, type CommentRow } from "../src/data/comments.ts";
import { timeAgo } from "../src/ui/time.ts";

const c = (id: string, at: string, parentId?: string, extra: Partial<CommentRow> = {}): CommentRow => ({ id, targetType: "score", targetId: "scr_1", body: id, createdAt: `2026-09-26T10:${at}:00Z`, ...(parentId ? { parentId } : {}), ...extra });
const shape = (nodes: ReturnType<typeof threadOf>): unknown => nodes.map((n) => (n.replies.length ? [n.comment.id, shape(n.replies)] : n.comment.id));

test("threads nest oldest first; a reply whose parent is gone goes to the top", () => {
  const rows = [c("b", "05"), c("a", "01"), c("a2", "07", "a"), c("a1", "03", "a"), c("a1x", "04", "a1"), c("stray", "09", "missing")];
  assert.deepEqual(shape(threadOf(rows)), [["a", [["a1", ["a1x"]], "a2"]], "b", "stray"]);
  assert.equal(countOf(threadOf(rows)), 6);
});

test("a deleted comment stays only while a reply below it does", () => {
  const rows = [c("a", "01", undefined, { deleted: true, body: "" }), c("a1", "02", "a"), c("b", "03", undefined, { deleted: true, body: "" }), c("b1", "04", "b", { deleted: true, body: "" })];
  assert.deepEqual(shape(threadOf(rows)), [["a", ["a1"]]]);
  assert.equal(countOf(threadOf(rows)), 1, "the removed one doesn't count");
});

test("time ago", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(timeAgo("2026-09-26T11:59:40Z", now), "just now");
  assert.equal(timeAgo("2026-09-26T11:55:00Z", now), "5m ago");
  assert.equal(timeAgo("2026-09-26T09:00:00Z", now), "3h ago");
  assert.equal(timeAgo("2026-09-24T12:00:00Z", now), "2d ago");
  assert.match(timeAgo("2026-08-01T12:00:00Z", now), /Aug/);
  assert.equal(timeAgo(null, now), "");
});
