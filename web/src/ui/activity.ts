// The Activity page: what's happening, one card per item (a score, a beat, a sample, a clip…), newest activity first.
// Anything new about an item moves its card to the top: it was made, changed, rated or commented on. A card shows the
// item's latest lines ("@ann rated it ★★★★☆ · 5m ago"), its stars and comment count, and its thread on request.
// The cards are kept by a Lambda from the tables' streams, so locally (no streams) the page only says so.

import { el } from "./dom";
import { api, me } from "../apricity";
import { mode } from "../data/client";
import { owns, type Me } from "../data/catalog";
import { handles, type Handles } from "../data/handles";
import { cards, FILTERS, kindName, lineText, linesOf, newestComment, starsOf, type Card } from "../data/activity";
import { CommentThread } from "./comments";
import { starSummary } from "./stars";
import { timeAgo } from "./time";

const POLL_MS = 60_000;

export class ActivityView {
  private chips = el("div", { className: "act-chips", role: "group", ariaLabel: "Show" });
  private list = el("div", { className: "act-list", ariaLive: "polite" });
  private more = el("button", { type: "button", className: "btn act-more", hidden: true }, "Load more");
  private fresh = el("button", { type: "button", className: "act-fresh", hidden: true }, "New activity · show");
  private kind: string | null = null;
  private next: string | null = null;
  private top: string | null = null; // the newest card's id and time, to notice new activity
  private who: Me | null = null;
  private names: Handles | null = null;
  private timer = 0;
  private shown = false;

  constructor(private root: HTMLElement) {
    for (const f of FILTERS) {
      const b = el("button", { type: "button" }, f.label);
      b.setAttribute("aria-pressed", String(f.kind === this.kind));
      b.addEventListener("click", () => {
        this.kind = f.kind;
        for (const x of this.chips.children) x.setAttribute("aria-pressed", String(x === b));
        void this.load();
      });
      this.chips.append(b);
    }
    this.more.addEventListener("click", () => void this.load(true));
    this.fresh.addEventListener("click", () => void this.load());
    root.append(
      el("div", { className: "act" }, el("header", { className: "act-head" }, el("h1", {}, "Activity"), el("p", { className: "hint" }, "What people are making, rating and talking about. Anything new moves to the top.")), this.chips, this.fresh, this.list, this.more),
    );
    document.addEventListener("apricity:auth-changed", () => this.shown && void this.load());
  }

  /** The tab was shown (or hidden): load, and look for new activity every minute while it's up. */
  show(visible: boolean) {
    this.shown = visible;
    clearInterval(this.timer);
    if (!visible) return;
    void this.load();
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
  }

  private async poll() {
    if (document.hidden || mode() === "local") return;
    try {
      const { items } = await cards(this.kind);
      const t = items[0] ? `${items[0].id}@${items[0].lastAt}` : null;
      this.fresh.hidden = !t || t === this.top;
    } catch {
      /* try again next minute */
    }
  }

  private async load(append = false) {
    if (mode() === "local") {
      this.list.replaceChildren(el("div", { className: "empty" }, "Activity is shown on the website, where it is kept as things happen. Comments work here too."));
      return;
    }
    this.fresh.hidden = true;
    if (!append) this.next = null;
    this.more.disabled = true;
    try {
      const [page, who, names, hidden] = await Promise.all([cards(this.kind, append ? this.next : null), me().catch(() => null), handles(), api.hiddenIds().catch(() => new Set<string>())]);
      this.who = who;
      this.names = names;
      this.next = page.nextToken;
      if (!append) this.top = page.items[0] ? `${page.items[0].id}@${page.items[0].lastAt}` : null;
      // Samples without a documented license (and what uses them) stay off the page for anyone but curators.
      const els = page.items.filter((c) => !hidden.has(c.targetId)).map((c) => this.card(c));
      if (append) this.list.append(...els);
      else this.list.replaceChildren(...(els.length ? els : [el("div", { className: "empty" }, this.kind ? "Nothing of this kind yet." : "Nothing yet. Make something, rate something, or say something about it.")]));
    } catch (e) {
      if (!append) this.list.replaceChildren(el("div", { className: "empty" }, `Couldn't load the activity: ${(e as Error).message}`));
    } finally {
      this.more.hidden = !this.next;
      this.more.disabled = false;
    }
  }

  /** "you", "@ann" or "someone". */
  private whoLabel(owner: string | null | undefined): string {
    if (owner && owns(this.who, owner)) return "you";
    const h = this.names?.of(owner);
    return h ? `@${h}` : "someone";
  }

  private card(c: Card): HTMLElement {
    const open = el("button", { type: "button", className: "act-title", title: "Open it" }, c.title || "(untitled)");
    open.addEventListener("click", () => document.dispatchEvent(new CustomEvent("apricity:open-item", { detail: { type: c.targetType, id: c.targetId } })));
    const stars = el("span", { className: "act-stars" });
    const lines = el("ul", { className: "act-lines" });
    const preview = el("div", { className: "act-preview" });
    const threadHost = el("div", { className: "act-thread", hidden: true });
    const n = c.comments ?? 0;
    const talk = el("button", { type: "button", className: "link act-talk" }, n ? `${n} comment${n === 1 ? "" : "s"}` : "Comment");
    let thread: CommentThread | null = null;
    talk.addEventListener("click", () => {
      threadHost.hidden = !threadHost.hidden;
      preview.hidden = !threadHost.hidden;
      if (!threadHost.hidden && !thread) {
        thread = new CommentThread({ type: c.targetType, id: c.targetId }, { title: false, onCount: (k) => (talk.textContent = k ? `${k} comment${k === 1 ? "" : "s"}` : "Comment") });
        threadHost.append(thread.root);
        void thread.load();
      }
    });
    const by = c.owner ? el("span", { className: "act-by" }, `by ${this.whoLabel(c.owner)}`) : el("span", {});
    const card = el(
      "article",
      { className: "act-card" },
      el("div", { className: "act-top" }, el("span", { className: `act-kind k-${c.kind ?? c.targetType}` }, kindName(c)), open, by, el("span", { style: "flex:1" }), stars),
      lines,
      preview,
      el("div", { className: "act-foot" }, talk, ...(c.forks ? [el("span", { className: "act-forks" }, `${c.forks} ${c.targetType === "clip" ? "cop" : "fork"}${c.forks === 1 ? (c.targetType === "clip" ? "y" : "") : c.targetType === "clip" ? "ies" : "s"}`)] : []), el("span", { style: "flex:1" }), el("span", { className: "act-when", title: c.lastAt }, timeAgo(c.lastAt))),
      threadHost,
    );
    // The details arrive after the card is on the page.
    void starsOf(c.targetType, c.targetId).then((s) => stars.replaceChildren(starSummary(s.average, s.count)), () => undefined);
    void linesOf(c.id).then(
      (ls) =>
        lines.replaceChildren(
          ...ls.map((l) => el("li", {}, el("b", {}, this.whoLabel(l.by)), ` ${lineText(l, c.targetType)}`, el("span", { className: "act-ago", title: l.at }, ` · ${timeAgo(l.at)}`))),
        ),
      () => undefined,
    );
    if (n)
      void newestComment(c.targetId).then((m) => {
        if (!m) return;
        const text = m.body.length > 180 ? `${m.body.slice(0, 180)}…` : m.body;
        preview.replaceChildren(el("b", {}, this.whoLabel(m.owner)), ": ", text);
      }, () => undefined);
    return card;
  }
}
