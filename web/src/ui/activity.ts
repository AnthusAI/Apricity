// The Activity page: what's happening, as things to hear. One card per item (a score, a beat, a sample, a clip…),
// newest activity first, in a grid that fills the width: each card plays (a score's strip, a sample's envelope), shows
// its latest news in a line, and puts what people say up front. Anything new about an item moves its card to the top.
// The cards are kept by a Lambda from the tables' streams; a local library has no streams, so locally the page shows
// your scores, most recently changed first.

import { el } from "./dom";
import { api, me, ratings } from "../apricity";
import { mode } from "../data/client";
import type { ScoreItem } from "../data/catalog";
import { handles } from "../data/handles";
import { cards, FILTERS, kindName, lineText, linesOf, starsOf, type Card } from "../data/activity";
import { totals } from "../data/rank-window";
import { tagCounts } from "../data/tags";
import { sampleKey } from "../route";
import { tagLink } from "./tag-chips";
import { go } from "./at";
import { timeAgo } from "./time";
import { FeedCard, scoreFeedItem, whoLabel, type FeedDeps, type FeedItem } from "./feed-card";
import { feedGrid } from "./feed-grid";

const POLL_MS = 60_000;

/** "All tags", to /tags (a plain click stays in the app). */
function allTags() {
  const a = el("a", { className: "act-all-tags", href: "/tags", textContent: "All tags" });
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go({ page: "tags" });
  });
  return a;
}

export class ActivityView {
  private chips = el("div", { className: "act-chips", role: "group", ariaLabel: "Show" });
  private tags = el("div", { className: "act-tags" });
  private body = el("div", { className: "act-body", ariaLive: "polite" });
  private fresh = el("button", { type: "button", className: "act-fresh", hidden: true }, "New activity · show");
  private kind: string | null = null;
  private top: string | null = null; // the newest card's id and time, to notice new activity
  private timer = 0;
  private shown = false;
  private seq = 0;

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
    this.fresh.addEventListener("click", () => void this.load());
    root.append(el("div", { className: "feed-page act" }, el("div", { className: "feed-bar act-bar" }, this.chips, this.fresh, el("span", { style: "flex:1" }), this.tags), this.body));
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

  private async load() {
    const seq = ++this.seq;
    this.fresh.hidden = true;
    // Timings for the browser's performance panel: activity:start … activity:shown.
    performance.mark("activity:start");
    // The top tags fill in when the scores have listed; nothing waits for them.
    void api
      .scores()
      .then(({ scores }) => seq === this.seq && this.tags.replaceChildren(...tagCounts(scores).slice(0, 10).map((t) => tagLink(t.tag)), ...(scores.some((s) => s.tags.length) ? [allTags()] : [])))
      .catch(() => undefined);
    try {
      if (mode() === "local") {
        const [who, names, { scores }] = await Promise.all([me().catch(() => null), handles(), api.scores()]);
        if (seq === this.seq) await this.localFeed(scores, { who, names });
        return;
      }
      // The first page of cards comes with who is looking; each card then looks up only its own score or sample, all at
      // once. (Listing every score and sample first took the page seconds to start.)
      let next: string | null = null;
      const first = cards(this.kind);
      const [who, names, hidden] = await Promise.all([
        me().catch(() => null).finally(() => performance.mark("activity:me")),
        handles().finally(() => performance.mark("activity:handles")),
        api.hiddenIds().catch(() => new Set<string>()).finally(() => performance.mark("activity:hidden")),
      ]);
      const deps: FeedDeps = { who, names };
      const page = async (got: Promise<{ items: Card[]; nextToken: string | null }>, isFirst: boolean) => {
        const { items, nextToken } = await got;
        performance.mark("activity:cards");
        next = nextToken;
        if (isFirst) this.top = items[0] ? `${items[0].id}@${items[0].lastAt}` : null;
        // Samples without a documented license (and what uses them) stay off the page for anyone but curators.
        const made = await Promise.all(items.filter((c) => !hidden.has(c.targetId)).map((c) => this.item(c, deps).catch(() => null)));
        performance.mark("activity:items");
        return made.filter((x): x is FeedItem => !!x).map((x) => new FeedCard(x, deps).root);
      };
      const els = await page(first, true);
      if (seq !== this.seq) return;
      performance.mark("activity:shown");
      this.body.replaceChildren(
        els.length
          ? feedGrid(els, async () => (next && seq === this.seq ? page(cards(this.kind, next), false) : []))
          : el("div", { className: "empty" }, this.kind ? "Nothing of this kind yet." : "Nothing yet. Make something, rate something, or say something about it."),
      );
    } catch (e) {
      if (seq === this.seq) this.body.replaceChildren(el("div", { className: "empty" }, `Couldn't load the activity: ${(e as Error).message}`));
    }
  }

  /** A card as something to hear; null when what it's about is gone. */
  private async item(c: Card, deps: FeedDeps): Promise<FeedItem | null> {
    // Its stars and latest line arrive once it's in view.
    const later = async () => {
      const [stars, lines] = await Promise.all([starsOf(c.targetType, c.targetId), linesOf(c.id, 1)]);
      const l = lines[0];
      return { stars, ...(l ? { note: `${whoLabel(deps, l.by)} ${lineText(l, c.targetType)} · ${timeAgo(l.at)}` } : {}) };
    };
    const base = { id: c.targetId, owner: c.owner ?? null, stars: { average: null, count: 0 }, tags: [] as string[], later };
    if (c.targetType === "score") {
      const s = await api.scoreById(c.targetId);
      return s ? { ...scoreFeedItem(s, base.stars), later } : null;
    }
    if (c.targetType === "sample") {
      const s = await api.sampleById(c.targetId);
      if (!s) return null;
      return { ...base, type: "sample", title: c.title || s.title, kindLabel: kindName(c), kindKey: "sample", route: { page: "samples", sample: sampleKey(s.path) }, sample: { path: s.path } };
    }
    if (!c.samplePath) return null;
    const path = `samples/${c.samplePath}`;
    return { ...base, type: "clip", title: c.title || "clip", kindLabel: kindName(c), kindKey: "clip", route: { page: "clips", clip: { sample: sampleKey(path), name: c.title ?? "" } }, sample: { path, clipId: c.targetId } };
  }

  /** Locally (no activity kept): your scores, most recently changed first, with their stars. */
  private async localFeed(scores: ScoreItem[], deps: FeedDeps) {
    const shown = this.kind && this.kind !== "sample" && this.kind !== "clip" ? scores.filter((s) => s.kind === this.kind) : this.kind ? [] : scores;
    const t = totals(await ratings().then((r) => r.tallies("score")).catch(() => []), "all", new Date());
    const items = [...shown]
      .sort((a, b) => b.modified - a.modified)
      .map((s) => {
        const x = t.get(s.id);
        return new FeedCard(scoreFeedItem(s, { average: x?.count ? x.sum / x.count : null, count: x?.count ?? 0 }, undefined, s.modified ? `changed ${timeAgo(new Date(s.modified * 1000).toISOString())}` : undefined), deps).root;
      });
    this.body.replaceChildren(
      el("p", { className: "hint act-local" }, "This is your local library: your scores, most recently changed first. The website's Activity shows what everyone is making, rating and saying."),
      items.length ? feedGrid(items) : el("div", { className: "empty" }, "Nothing of this kind here."),
    );
  }
}
