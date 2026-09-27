// Tags: /tags shows every tag scores carry (most used first); /tags/<tag> is that tag's leaderboard, every kind of
// score tagged with it ranked by stars in a time window (the same ranking as the tabs' lists), as cards you can play.
// ?kind=beat narrows it to one kind; ?window=month picks the window.

import { el } from "./dom";
import { api, me } from "../apricity";
import { SCORE_KINDS, type ScoreItem, type ScoreKind } from "../data/catalog";
import { handles } from "../data/handles";
import { WINDOWS, WINDOW_LABEL, widenedNote, type Window } from "../data/rank-window";
import { rankedPage } from "../data/ranked-read";
import type { RankedRow } from "../data/ranked";
import { tagCounts } from "../data/tags";
import { opened } from "./at";
import { reportError } from "./notices";
import { tagLink } from "./tag-chips";
import { FeedCard, feedItemOf, type FeedDeps } from "./feed-card";
import { feedGrid } from "./feed-grid";

const KIND_CHIP: Record<ScoreKind, string> = { song: "Songs", beat: "Beats", chords: "Chords", melody: "Melodies" };

export class TagsView {
  private tag: string | null = null;
  private kind: ScoreKind | null = null;
  private window: Window = "all";
  private seq = 0;

  constructor(private root: HTMLElement) {}

  /** Show /tags (no tag) or a tag's leaderboard; `list` is its query (kind, window). */
  async show(tag: string | null, list?: string) {
    this.tag = tag;
    const q = new URLSearchParams(list ?? "");
    const k = q.get("kind") as ScoreKind | null;
    this.kind = k && SCORE_KINDS.includes(k) ? k : null;
    const w = q.get("window") as Window | null;
    this.window = w && WINDOWS.includes(w) ? w : "all";
    await this.render();
  }

  private query(): string {
    const q = new URLSearchParams();
    if (this.kind) q.set("kind", this.kind);
    if (this.window !== "all") q.set("window", this.window);
    return q.toString();
  }

  /** Change the kind or window: the address bar follows (no new history entry). */
  private change(kind: ScoreKind | null, window: Window) {
    this.kind = kind;
    this.window = window;
    const list = this.query();
    opened({ page: "tags", tag: this.tag!, ...(list ? { list } : {}) }, "auto", `#${this.tag}`);
    void this.render();
  }

  private async render() {
    const seq = ++this.seq;
    this.root.replaceChildren(el("div", { className: "feed-page" }, el("div", { className: "empty" }, "Loading…")));
    let scores: ScoreItem[], deps: FeedDeps, hidden: Set<string>;
    try {
      const [s, who, names, h] = await Promise.all([api.scores(), me().catch(() => null), handles(), api.hiddenIds().catch(() => new Set<string>())]);
      scores = s.scores;
      deps = { who, names };
      hidden = h;
    } catch (e) {
      reportError("load the scores", e);
      this.root.replaceChildren(el("div", { className: "feed-page" }, el("div", { className: "empty" }, `Couldn't load the scores: ${(e as Error).message}`)));
      return;
    }
    if (seq !== this.seq) return;
    if (!this.tag) return this.renderIndex(scores);

    const tagged = scores.filter((s) => s.tags.includes(this.tag!));
    // The tag's list in the window, a page at a time (design/scale.md); a window nobody has rated in yet steps out to
    // the next wider one, as the lists do.
    let window = this.window;
    let page = await rankedPage(`tag|${this.tag}|${window}`);
    while (window !== "all" && !page.rows.some((r) => r.ratings > 0)) {
      window = WINDOWS[WINDOWS.indexOf(window) + 1];
      page = await rankedPage(`tag|${this.tag}|${window}`);
    }
    if (seq !== this.seq) return;
    const list = `tag|${this.tag}|${window}`;
    const seg = el("div", { className: "seg", role: "tablist", ariaLabel: "Time range" });
    for (const w of WINDOWS) {
      const b = el("button", { type: "button", textContent: WINDOW_LABEL[w] });
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(w === this.window));
      b.addEventListener("click", () => this.change(this.kind, w));
      seg.append(b);
    }
    const kinds = el("div", { className: "act-chips", role: "group", ariaLabel: "Kind" });
    for (const k of [null, ...SCORE_KINDS]) {
      const n = k ? tagged.filter((s) => s.kind === k).length : tagged.length;
      if (k && !n) continue;
      const b = el("button", { type: "button" }, `${k ? KIND_CHIP[k] : "All"} · ${n}`);
      b.setAttribute("aria-pressed", String(k === this.kind));
      b.addEventListener("click", () => this.change(k, this.window));
      kinds.append(b);
    }
    const note = widenedNote({ asked: this.window, window, widened: window !== this.window });
    let place = 0;
    // One kind only (a chip): the rows of the others are skipped as the pages come.
    const cardsOf = (rows: RankedRow[]) =>
      rows.filter((r) => !hidden.has(r.targetId) && (!this.kind || r.kind === this.kind)).map((r) => new FeedCard(feedItemOf(r, deps, r.ratings > 0 ? ++place : undefined), deps).root);
    let next = page.next;
    const more = async (): Promise<HTMLElement[]> => {
      while (next && seq === this.seq) {
        const p = await rankedPage(list, next);
        next = p.next;
        const els = cardsOf(p.rows);
        if (els.length) return els;
      }
      return [];
    };
    let cards = cardsOf(page.rows);
    if (!cards.length) cards = await more();
    if (seq !== this.seq) return;
    this.root.replaceChildren(
      el(
        "div",
        { className: "feed-page" },
        el("div", { className: "feed-bar" }, el("h1", { className: "feed-tag" }, `#${this.tag}`), kinds, el("span", { style: "flex:1" }), seg),
        ...(note ? [el("div", { className: "rank-note" }, note)] : []),
        cards.length ? feedGrid(cards, more) : el("div", { className: "empty" }, tagged.length ? "Nothing of this kind with this tag." : `No scores are tagged #${this.tag} yet. Tag one from its page, under the title.`),
        el("div", { className: "feed-more-tags" }, el("span", { className: "hint" }, "Other tags: "), ...tagCounts(scores).filter((t) => t.tag !== this.tag).slice(0, 24).map((t) => tagLink(t.tag))),
      ),
    );
  }

  private renderIndex(scores: ScoreItem[]) {
    const counts = tagCounts(scores);
    this.root.replaceChildren(
      el(
        "div",
        { className: "feed-page" },
        el("div", { className: "feed-bar" }, el("h1", { className: "feed-tag" }, "Tags")),
        counts.length
          ? el("div", { className: "tag-cloud" }, ...counts.map((t) => el("span", { className: "tag-count" }, tagLink(t.tag), el("span", { className: "hint" }, ` ${t.count}`))))
          : el("div", { className: "empty" }, "No scores are tagged yet. Tag one from its page, under the title."),
      ),
    );
  }
}
