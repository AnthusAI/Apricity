// A comment thread under a sample, a clip or a score, and on its Activity card. Anyone reads it. Writing needs a sign-in
// and, on the website, a handle (comments are signed with it); the composer says which is missing and opens the right
// dialog. Authors edit and delete their own; curators delete anyone's. Replies nest three deep, then stay there.

import { el } from "./dom";
import { me } from "../apricity";
import { mode } from "../data/client";
import { owns, type Me } from "../data/catalog";
import { handles, type Handles } from "../data/handles";
import { addComment, commentsOn, countOf, deleteComment, editComment, MAX_COMMENT, threadOf, type CommentNode, type CommentTarget } from "../data/comments";
import { timeAgo } from "./time";

const MAX_DEPTH = 3;

export class CommentThread {
  readonly root = el("section", { className: "comments" });
  private who: Me | null = null;
  private names: Handles | null = null;
  private nodes: CommentNode[] = [];
  private loaded = false;

  constructor(
    private target: { type: CommentTarget; id: string },
    private opts: { title?: boolean; onCount?: (n: number) => void } = {},
  ) {
    const reload = () => this.root.isConnected && this.loaded && void this.load();
    document.addEventListener("apricity:auth-changed", reload);
    document.addEventListener("apricity:handles-changed", reload);
  }

  /** Read (or re-read) the thread and draw it. */
  async load() {
    this.loaded = true;
    try {
      const [rows, who, names] = await Promise.all([commentsOn(this.target.id), me().catch(() => null), handles()]);
      this.nodes = threadOf(rows);
      this.who = who;
      this.names = names;
      this.render();
    } catch (e) {
      this.root.replaceChildren(el("p", { className: "hint" }, `Couldn't load the comments: ${(e as Error).message}`));
    }
    this.opts.onCount?.(countOf(this.nodes));
  }

  private get local() {
    return mode() === "local";
  }

  private myHandle() {
    return this.who ? this.names?.mine(this.who.owners) : undefined;
  }

  /** What stands between this reader and writing a comment: null when nothing does. */
  private blocker(): HTMLElement | null {
    if (!this.who) return el("button", { type: "button", className: "btn", onclick: () => document.dispatchEvent(new CustomEvent("apricity:sign-in")) }, "Sign in to comment");
    if (!this.local && !this.myHandle())
      return el("button", { type: "button", className: "btn", onclick: () => document.dispatchEvent(new CustomEvent("apricity:choose-handle")) }, "Choose a handle to comment");
    return null;
  }

  private render() {
    const n = countOf(this.nodes);
    this.root.replaceChildren(
      ...(this.opts.title === false ? [] : [el("h3", {}, n ? `Comments · ${n}` : "Comments")]),
      this.blocker() ?? this.composer("Add a comment…", "Comment", (body) => addComment(this.target.type, this.target.id, body)),
      ...(this.nodes.length ? [el("ol", { className: "cmt-list" }, ...this.nodes.map((x) => this.node(x, 1)))] : [el("p", { className: "hint" }, "No comments yet.")]),
    );
  }

  /** A text box and a button; `send` saves, then the thread reloads. */
  private composer(placeholder: string, label: string, send: (body: string) => Promise<void>, value = "", cancel?: () => void): HTMLElement {
    const box = el("textarea", { placeholder, rows: 2, maxLength: MAX_COMMENT, value, ariaLabel: placeholder }) as HTMLTextAreaElement;
    const go = el("button", { type: "button", className: "btn primary" }, label);
    const err = el("span", { className: "cmt-err", role: "alert" });
    const submit = async () => {
      go.disabled = true;
      err.textContent = "";
      try {
        await send(box.value);
        await this.load();
      } catch (e) {
        err.textContent = (e as Error).message;
        go.disabled = false;
      }
    };
    go.addEventListener("click", () => void submit());
    // ⌘/Ctrl-Enter sends.
    box.addEventListener("keydown", (e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void submit());
    const actions = el("div", { className: "cmt-actions" }, go, ...(cancel ? [el("button", { type: "button", className: "btn", onclick: cancel }, "Cancel")] : []), err);
    return el("div", { className: "cmt-compose" }, box, actions);
  }

  private node(n: CommentNode, depth: number): HTMLElement {
    const c = n.comment;
    const mine = !!this.who && (owns(this.who, c.owner) || (this.local && !!this.who));
    const curator = !!this.who?.curator;
    const handle = this.names?.of(c.owner);
    const edited = c.updatedAt && c.createdAt && Date.parse(c.updatedAt) - Date.parse(c.createdAt) > 60_000 && !c.deleted;
    // Locally there is one person: every comment is yours.
    const who = el("b", {}, this.local || owns(this.who, c.owner) ? "you" : handle ? `@${handle}` : "someone");
    const meta = el("div", { className: "cmt-meta" }, who, el("span", { title: c.createdAt ?? "" }, ` · ${timeAgo(c.createdAt)}${edited ? " · edited" : ""}`));
    const body = el("div", { className: `cmt-body${c.deleted ? " gone" : ""}` }, c.deleted ? "comment removed" : c.body);
    const slot = el("div", { className: "cmt-slot" });
    const actions = el("div", { className: "cmt-actions" });
    if (!c.deleted) {
      if (!this.blocker())
        actions.append(
          el("button", { type: "button", className: "link", onclick: () => slot.replaceChildren(this.composer(`Reply to ${handle ? `@${handle}` : "this"}…`, "Reply", (b) => addComment(this.target.type, this.target.id, b, c.id), "", () => slot.replaceChildren())) }, "Reply"),
        );
      if (mine)
        actions.append(
          el("button", { type: "button", className: "link", onclick: () => body.replaceWith(this.composer("Edit your comment", "Save", (b) => editComment(c.id, b), c.body, () => void this.load())) }, "Edit"),
        );
      if (mine || curator)
        actions.append(
          el("button", { type: "button", className: "link", onclick: () => confirm(mine ? "Delete your comment?" : "Remove this comment?") && void deleteComment(c.id).then(() => this.load(), (e) => alert((e as Error).message)) }, "Delete"),
        );
    }
    const li = el("li", { className: "cmt" }, meta, body, actions, slot);
    if (n.replies.length) {
      const replies = n.replies.map((r) => this.node(r, depth + 1));
      // Past the third level, replies line up with their parent instead of indenting further.
      if (depth < MAX_DEPTH) li.append(el("ol", { className: "cmt-list replies" }, ...replies));
      else return el("div", { className: "cmt-flat" }, li, ...replies);
    }
    return li;
  }
}
