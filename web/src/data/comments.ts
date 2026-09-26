// Comments on samples, clips and scores: read by anyone, written by their authors (the app asks for a handle first),
// moderated by curators. `parentId` threads replies. Deleting keeps the comment, blank and flagged, so its replies
// keep their place; `threadOf` hides a deleted comment nobody replied to.

import { client } from "./client.js";
import { listAll } from "./catalog.js";

export type CommentTarget = "sample" | "clip" | "score";

export interface CommentRow {
  id: string;
  targetType: CommentTarget;
  targetId: string;
  parentId?: string | null;
  body: string;
  deleted?: boolean | null;
  owner?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CommentNode {
  comment: CommentRow;
  replies: CommentNode[];
}

export const MAX_COMMENT = 2000;

/**
 * The comments as threads, oldest first at every level. A reply whose parent is missing goes to the top level; a
 * deleted comment stays only while a reply below it is still there.
 */
export function threadOf(rows: CommentRow[]): CommentNode[] {
  const byTime = [...rows].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id));
  const nodes = new Map(byTime.map((c) => [c.id, { comment: c, replies: [] as CommentNode[] }]));
  const top: CommentNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.comment.parentId ? nodes.get(n.comment.parentId) : undefined;
    (parent && parent !== n ? parent.replies : top).push(n);
  }
  const keep = (list: CommentNode[]): CommentNode[] =>
    list.flatMap((n) => {
      const replies = keep(n.replies);
      return n.comment.deleted && !replies.length ? [] : [{ ...n, replies }];
    });
  return keep(top);
}

/** How many comments a thread shows (deleted ones with replies don't count). */
export const countOf = (nodes: CommentNode[]): number => nodes.reduce((n, x) => n + (x.comment.deleted ? 0 : 1) + countOf(x.replies), 0);

export async function commentsOn(targetId: string): Promise<CommentRow[]> {
  const m = client().models.Comment;
  return listAll<CommentRow>((nextToken) => m.commentsByTarget({ targetId }, { limit: 500, nextToken }));
}

const clean = (body: string) => {
  const b = body.trim();
  if (!b) throw new Error("Write something first.");
  if (b.length > MAX_COMMENT) throw new Error(`Comments are at most ${MAX_COMMENT} characters.`);
  return b;
};

const check = (r: { errors?: { message?: string }[] }) => {
  if (r.errors?.length) throw new Error(r.errors[0].message ?? "Couldn't save the comment.");
};

export async function addComment(targetType: CommentTarget, targetId: string, body: string, parentId?: string): Promise<void> {
  check(await client().models.Comment.create({ id: `cmt_${crypto.randomUUID()}`, targetType, targetId, body: clean(body), ...(parentId ? { parentId } : {}) }));
}

export async function editComment(id: string, body: string): Promise<void> {
  check(await client().models.Comment.update({ id, body: clean(body) }));
}

/** Blank and flag it: replies keep their place ("comment removed"). */
export async function deleteComment(id: string): Promise<void> {
  check(await client().models.Comment.update({ id, body: "", deleted: true }));
}
