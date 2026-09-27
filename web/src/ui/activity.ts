// The home page: what's happening, as things to hear. One card per item (a score, a beat, a sample, a clip…) in a grid
// that fills the width: each card plays (a score's strip, a sample's envelope), shows its latest news in a line, and puts
// what people say up front. "Top" (the default) puts the best-rated songs first, fresh ones lifted, everything else
// far below (data/home-feed.ts); "Recent" is the newest activity first. Someone signed out gets a line on what Apricity
// is, with the way to sign in and to the About page.
// The cards are kept by a Lambda from the tables' streams; a local library has no streams, so locally the page shows
// your scores, most recently changed first.

import { el } from "./dom";
import { api, me } from "../apricity";
import { mode } from "../data/client";
import { handles } from "../data/handles";
import { cards } from "../data/activity";
import { owns } from "../data/catalog";
import { DEFAULT_VIEW, parseView, viewQuery, type ListView } from "../data/list-view";
import { FilterBar } from "./filter-bar";
import { rankedPage, tagTotals } from "../data/ranked-read";
import type { RankedRow } from "../data/ranked";
import { href, sampleKey, type Route } from "../route";
import { tagLink } from "./tag-chips";
import { go, opened } from "./at";
import { FeedCard, feedItemOf, type FeedDeps } from "./feed-card";
import { feedGrid } from "./feed-grid";

const POLL_MS = 60_000;

/** An in-app link (a plain click stays in the app; a middle click opens a tab). */
function link(route: Route, text: string, className = ""): HTMLAnchorElement {
  const a = el("a", { href: href(route), textContent: text, className });
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(route);
  });
  return a;
}

/** The About card: what this is, and the way to the About page (its tour of how a groove is made). */
function aboutCard(): HTMLElement {
  const card = el(
    "article",
    { className: "feed-card about-card" },
    el("div", { className: "about-card-stage" }, el("span", { className: "about-card-sun", ariaHidden: "true" }), el("span", { className: "about-card-word" }, "Apricity"), el("span", { className: "about-card-kicker" }, "The social mashup machine")),
    el(
      "div",
      { className: "feed-body" },
      el("p", {}, "Music made from public-domain and openly licensed recordings: every sound is cleared. Make beats, chords and melodies, remix what others make, and rate the best."),
      link({ page: "about" }, "See how it works →", "btn primary about-card-go"),
    ),
  );
  return card;
}

/** "All tags", to /tags. */
const allTags = () => link({ page: "tags" }, "All tags", "act-all-tags");

export class ActivityView {
  private tags = el("div", { className: "act-tags" });
  /** For someone signed out: what this is, Sign in, and What is this? (the About page). */
  private intro = el("div", { className: "home-intro", hidden: true });
  private body = el("div", { className: "act-body", ariaLive: "polite" });
  private fresh = el("button", { type: "button", className: "act-fresh", hidden: true }, "New activity · show");
  /** Top (best rated, fresh things lifted) or Recent, and Mine: the one filter bar, kept in the URL (/?order=recent&mine=1). */
  private bar: FilterBar;
  private view: ListView = { ...DEFAULT_VIEW };
  private top: string | null = null; // the newest card's id and time, to notice new activity
  private timer = 0;
  private shown = false;
  private seq = 0;

  constructor(private root: HTMLElement) {
    this.bar = new FilterBar(this.view, { mine: true, tail: [this.fresh, this.tags] }, (v) => {
      this.view = v;
      const list = viewQuery(v);
      opened({ page: "home", ...(list ? { list } : {}) }, "auto");
      void this.load();
    });
    this.fresh.addEventListener("click", () => void this.load());
    root.append(
      el(
        "div",
        { className: "feed-page act" },
        this.intro,
        this.bar.el,
        this.body,
        el("footer", { className: "home-foot" }, link({ page: "about" }, "About Apricity"), link({ page: "tags" }, "Tags"), link({ page: "help" }, "Help")),
      ),
    );
    document.addEventListener("apricity:auth-changed", () => this.shown && void this.load());
  }

  /** The tab was shown (or hidden), with its view from the URL: load, and look for new activity every minute while it's up. */
  show(visible: boolean, list = "") {
    this.shown = visible;
    clearInterval(this.timer);
    if (!visible) return;
    this.view = parseView(list);
    this.bar.set(this.view);
    void this.load();
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
  }

  private async poll() {
    if (document.hidden || mode() === "local") return;
    try {
      const { items } = await cards(null);
      const t = items[0] ? `${items[0].id}@${items[0].lastAt}` : null;
      // The first look after a load notes where the feed is; a later one that finds something newer offers it.
      if (this.top === null) this.top = t;
      else this.fresh.hidden = !t || t === this.top;
    } catch {
      /* try again next minute */
    }
  }

  private async load() {
    const seq = ++this.seq;
    this.fresh.hidden = true;
    this.top = null;
    void this.poll();
    // Timings for the browser's performance panel: activity:start … activity:shown.
    performance.mark("activity:start");
    void me()
      .catch(() => null)
      .then((who) => seq === this.seq && this.showIntro(!who && mode() !== "local"));
    // The top tags fill in when the scores have listed; nothing waits for them.
    void tagTotals()
      .then((totals) => seq === this.seq && this.tags.replaceChildren(...totals.slice(0, 10).map((t) => tagLink(t.tag)), ...(totals.length ? [allTags()] : [])))
      .catch(() => undefined);
    try {
      // One page of the ranked list (design/scale.md): each row carries its card, so a page is one query.
      const list = `feed|${this.view.order}|all`;
      const [first, who, names, hidden] = await Promise.all([
        rankedPage(list).finally(() => performance.mark("activity:cards")),
        me().catch(() => null),
        handles(),
        api.hiddenIds().catch(() => new Set<string>()),
      ]);
      if (seq !== this.seq) return;
      const deps: FeedDeps = { who, names };
      // Samples without a documented license (and what uses them) stay off the page for anyone but curators.
      // Mine: what you made (a local library is all yours).
      const mine = this.view.mine && mode() !== "local";
      const cardsOf = (rows: RankedRow[]) => rows.filter((r) => !hidden.has(r.targetId) && (!mine || owns(who, r.owner))).map((r) => new FeedCard(feedItemOf(r, deps), deps).root);
      let next = first.next;
      const more = async (): Promise<HTMLElement[]> => {
        while (next && seq === this.seq) {
          const p = await rankedPage(list, next);
          next = p.next;
          const els = cardsOf(p.rows);
          if (els.length) return els;
        }
        return [];
      };
      let els = cardsOf(first.rows);
      if (!els.length) els = await more();
      if (seq !== this.seq) return;
      performance.mark("activity:shown");
      const local = mode() === "local" ? [el("p", { className: "hint act-local" }, `This is your local library: your scores, ${this.view.order === "top" ? "best rated first" : "most recently changed first"}. On the website, this page shows what everyone is making, rating and saying.`)] : [];
      this.body.replaceChildren(
        ...local,
        // What Apricity is, always the first card on the home page; then the feed, or a word that it's empty.
        feedGrid([aboutCard(), ...els], more),
        ...(els.length ? [] : [el("div", { className: "empty" }, this.view.mine && mode() !== "local" ? "Nothing of yours here yet. Make something, rate something, or say something about it." : "Nothing yet. Make something, rate something, or say something about it.")]),
      );
    } catch (e) {
      if (seq === this.seq) this.body.replaceChildren(el("div", { className: "empty" }, `Couldn't load the activity: ${(e as Error).message}`));
    }
  }

  private showIntro(show: boolean) {
    this.intro.hidden = !show;
    if (!show || this.intro.childElementCount) return;
    const signIn = el("button", { type: "button", className: "btn primary" }, "Sign in");
    signIn.addEventListener("click", () => document.dispatchEvent(new CustomEvent("apricity:sign-in")));
    this.intro.append(
      el("p", {}, el("b", {}, "Apricity is the social mashup machine."), " Music made from public-domain recordings, remixed by everyone. Listen to the best of it below, rate what you like, and make your own."),
      el("div", { className: "home-intro-actions" }, signIn, link({ page: "about" }, "What is this?", "btn")),
    );
  }
}
