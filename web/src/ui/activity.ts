// The Activity page: what's happening, as things to hear. One card per item (a score, a beat, a sample, a clip…),
// newest activity first, in a grid that fills the width: each card plays (a score's strip, a sample's envelope), shows
// its latest news in a line, and puts what people say up front. Anything new about an item moves its card to the top.
// The cards are kept by a Lambda from the tables' streams; a local library has no streams, so locally the page shows
// your scores, most recently changed first.

import { el } from "./dom";
import { api, me, ratings } from "../apricity";
import { mode } from "../data/client";
import type { SampleSummary } from "../apricity";
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
    try {
      const [who, names, scores, hidden] = await Promise.all([me().catch(() => null), handles(), api.scores().then((s) => s.scores), api.hiddenIds().catch(() => new Set<string>())]);
      if (seq !== this.seq) return;
      const deps: FeedDeps = { who, names };
      // The tags most used, each a way to its leaderboard.
      this.tags.replaceChildren(...tagCounts(scores).slice(0, 10).map((t) => tagLink(t.tag)), ...(scores.some((s) => s.tags.length) ? [allTags()] : []));
      if (mode() === "local") return this.localFeed(scores, deps);
      const byId = new Map(scores.map((s) => [s.id, s]));
      let samples: Promise<Map<string, SampleSummary>> | null = null;
      const sampleOf = (id: string) => (samples ??= api.samples().then((r) => new Map(r.samples.map((x) => [x.id, x])))).then((m) => m.get(id));
      let next: string | null = null;
      const page = async (token: string | null) => {
        const got = await cards(this.kind, token);
        next = got.nextToken;
        if (!token) this.top = got.items[0] ? `${got.items[0].id}@${got.items[0].lastAt}` : null;
        // Samples without a documented license (and what uses them) stay off the page for anyone but curators.
        const items = await Promise.all(got.items.filter((c) => !hidden.has(c.targetId)).map((c) => this.item(c, byId, sampleOf, deps)));
        return items.filter((x): x is FeedItem => !!x).map((x) => new FeedCard(x, deps).root);
      };
      const first = await page(null);
      if (seq !== this.seq) return;
      this.body.replaceChildren(
        first.length
          ? feedGrid(first, async () => (next && seq === this.seq ? page(next) : []))
          : el("div", { className: "empty" }, this.kind ? "Nothing of this kind yet." : "Nothing yet. Make something, rate something, or say something about it."),
      );
    } catch (e) {
      if (seq === this.seq) this.body.replaceChildren(el("div", { className: "empty" }, `Couldn't load the activity: ${(e as Error).message}`));
    }
  }

  /** A card as something to hear; null when what it's about is gone (or hidden). */
  private async item(c: Card, scores: Map<string, ScoreItem>, sampleOf: (id: string) => Promise<SampleSummary | undefined>, deps: FeedDeps): Promise<FeedItem | null> {
    // Its stars and latest line arrive once it's in view.
    const later = async () => {
      const [stars, lines] = await Promise.all([starsOf(c.targetType, c.targetId), linesOf(c.id, 1)]);
      const l = lines[0];
      return { stars, ...(l ? { note: `${whoLabel(deps, l.by)} ${lineText(l, c.targetType)} · ${timeAgo(l.at)}` } : {}) };
    };
    const base = { id: c.targetId, owner: c.owner ?? null, stars: { average: null, count: 0 }, tags: [] as string[], later };
    if (c.targetType === "score") {
      const s = scores.get(c.targetId);
      return s ? { ...scoreFeedItem(s, base.stars), later } : null;
    }
    if (c.targetType === "sample") {
      const s = await sampleOf(c.targetId);
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
