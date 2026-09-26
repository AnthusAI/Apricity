// Tags as chips: "#techno" links to its leaderboard (/tags/techno). The editor adds (Enter, comma, or picking a
// suggestion) and removes (× or Backspace in the empty box) for a score's owner; everyone else sees the links.

import { el } from "./dom";
import { go } from "./at";
import { href } from "../route";
import { MAX_TAGS, parseTags, withTags } from "../data/tags";
import { reportError } from "./notices";

/** One tag, a link to its leaderboard (a plain click stays in the app; a middle click opens a tab). */
export function tagLink(tag: string): HTMLAnchorElement {
  const a = el("a", { className: "tag", href: href({ page: "tags", tag }), textContent: `#${tag}` });
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    go({ page: "tags", tag });
  });
  return a;
}

/** A row of tag links (empty when there are none). */
export const tagRow = (tags: readonly string[]) => el("span", { className: "tags" }, ...tags.map(tagLink));

let datalistN = 0;

export class TagEditor {
  readonly root = el("div", { className: "tags tag-editor" });
  private tags: string[] = [];
  private editable = false;
  private input = el("input", { type: "text", className: "tag-input", placeholder: "+ tag", ariaLabel: "Add a tag", spellcheck: false });
  private list = el("datalist", { id: `tag-suggest-${++datalistN}` });

  constructor(private save: (tags: string[]) => Promise<void>) {
    this.input.setAttribute("list", this.list.id);
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        void this.add(this.input.value);
      } else if (e.key === "Backspace" && !this.input.value && this.tags.length) void this.set(this.tags.slice(0, -1));
    });
    // Picking a suggestion fills the box: take it at once.
    this.input.addEventListener("input", () => {
      if ([...this.list.options].some((o) => o.value === this.input.value)) void this.add(this.input.value);
    });
    this.input.addEventListener("blur", () => this.input.value.trim() && void this.add(this.input.value));
  }

  /** Show `tags`; `editable` for its owner; `suggest` are tags in use elsewhere, most used first. */
  show(tags: readonly string[], editable: boolean, suggest: readonly string[] = []) {
    this.tags = [...tags];
    this.editable = editable;
    this.list.replaceChildren(...suggest.filter((t) => !tags.includes(t)).map((t) => el("option", { value: t })));
    this.render();
  }

  private render() {
    const chips = this.tags.map((t) => {
      const link = tagLink(t);
      if (!this.editable) return link;
      const x = el("button", { type: "button", className: "tag-x", ariaLabel: `Remove #${t}`, textContent: "×" });
      x.addEventListener("click", () => void this.set(this.tags.filter((o) => o !== t)));
      return el("span", { className: "tag-chip" }, link, x);
    });
    const room = this.editable && this.tags.length < MAX_TAGS;
    this.input.hidden = !room;
    this.root.replaceChildren(...chips, ...(this.editable ? [this.input, this.list] : []));
    this.root.hidden = !this.tags.length && !this.editable;
  }

  private add(text: string) {
    this.input.value = "";
    const add = parseTags(text);
    return add.length ? this.set(withTags(this.tags, add)) : undefined;
  }

  private async set(tags: string[]) {
    const before = this.tags;
    this.tags = tags;
    this.render();
    this.input.focus();
    try {
      await this.save(tags);
    } catch (e) {
      this.tags = before; // put them back
      this.render();
      reportError("save the tags", e);
    }
  }
}
