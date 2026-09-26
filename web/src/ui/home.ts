// The home page: the best of Apricity to listen to. Scores ranked by their stars with freshness blended in, songs
// first and the rest (beats, chords, melodies) far below (data/home-feed.ts), as cards that play. Someone not signed in
// gets a line on what this is, and the way to the About page (the old landing page) and to sign in.

import { el } from "./dom";
import { api, me, ratings } from "../apricity";
import { handles } from "../data/handles";
import { homeRank } from "../data/home-feed";
import { widenedNote, WINDOW_LABEL } from "../data/rank-window";
import { go } from "./at";
import { href, type Route } from "../route";
import { reportError } from "./notices";
import { FeedCard, scoreFeedItem } from "./feed-card";
import { feedGrid } from "./feed-grid";

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

export class HomeView {
  private seq = 0;

  constructor(private root: HTMLElement) {
    document.addEventListener("apricity:auth-changed", () => this.root.isConnected && !this.root.hidden && void this.show());
  }

  async show() {
    const seq = ++this.seq;
    performance.mark("home:start");
    const page = el("div", { className: "feed-page home" });
    this.root.replaceChildren(page);
    try {
      const [who, names, { scores }, tallies] = await Promise.all([me().catch(() => null), handles(), api.scores(), ratings().then((r) => r.tallies("score")).catch(() => [])]);
      if (seq !== this.seq) return;
      const ranked = homeRank(scores, tallies, "week", new Date());
      const deps = { who, names };
      let place = 0;
      const cards = ranked.rows.map(({ item, standing }) => new FeedCard(scoreFeedItem(item, { average: standing.average, count: standing.count }, standing.count ? ++place : undefined), deps).root);
      const note = widenedNote(ranked);
      const signIn = el("button", { type: "button", className: "btn primary" }, "Sign in");
      signIn.addEventListener("click", () => document.dispatchEvent(new CustomEvent("apricity:sign-in")));
      page.replaceChildren(
        ...(who
          ? []
          : [
              el(
                "div",
                { className: "home-intro" },
                el("p", {}, el("b", {}, "Apricity is the social mashup machine."), " Music made from public-domain recordings, remixed by everyone. Listen to the best of it below, rate what you like, and make your own."),
                el("div", { className: "home-intro-actions" }, signIn, link({ page: "about" }, "What is this?", "btn")),
              ),
            ]),
        el("div", { className: "feed-bar" }, el("h1", { className: "feed-tag" }, `Top of the ${ranked.window === "all" ? "year and beyond" : WINDOW_LABEL[ranked.window].toLowerCase()}`), el("span", { style: "flex:1" }), link({ page: "activity" }, "Everything new →", "home-more")),
        ...(note ? [el("div", { className: "rank-note" }, note)] : []),
        cards.length ? feedGrid(cards) : el("div", { className: "empty" }, "Nothing here yet. Make a score and it will show up."),
        el("footer", { className: "home-foot" }, link({ page: "about" }, "About Apricity"), link({ page: "activity" }, "Activity"), link({ page: "tags" }, "Tags"), link({ page: "help" }, "Help")),
      );
      performance.mark("home:shown");
    } catch (e) {
      reportError("load the home page", e);
      if (seq === this.seq) page.replaceChildren(el("div", { className: "empty" }, `Couldn't load the scores: ${(e as Error).message}`));
    }
  }
}
