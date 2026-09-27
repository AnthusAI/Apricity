// Search: the box in the top bar, and /search?q=…, what matches in every section: a row of cards per kind (the best
// rated first), each with the way to the whole section narrowed to the same words. It searches in the browser, over the
// lists the sections load; a search index later changes how it finds things, not how it looks (design/scale.md §2.4).

import { el } from "./dom";
import { me } from "../apricity";
import { handles } from "../data/handles";
import { rank } from "../data/rank-window";
import { load, matches, rowOf, SECTIONS, SECTION_LABEL, type Section } from "../data/sections";
import { go, opened } from "./at";
import { href, type Route } from "../route";
import { reportError } from "./notices";
import { FeedCard, feedItemOf, type FeedDeps } from "./feed-card";
import { feedGrid } from "./feed-grid";

/** Cards per section on the results page. */
const PER_SECTION = 6;

/**
 * The top bar's search box. Enter searches everything (/search?q=); on a section's page, `local` hands back how that
 * section narrows its own list, and the box does that as you type instead.
 */
export function mountSearch(host: HTMLElement, local: () => ((q: string) => void) | null): HTMLInputElement {
  const input = el("input", { type: "search", className: "top-search-input", placeholder: "Search", ariaLabel: "Search", autocomplete: "off", spellcheck: false });
  const form = el("form", { className: "top-search", role: "search" }, el("span", { className: "top-search-icon", ariaHidden: "true" }), input);
  let timer = 0;
  input.addEventListener("input", () => {
    const narrow = local();
    if (!narrow) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => narrow(input.value), 150);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    const narrow = local();
    input.blur();
    if (narrow) return (clearTimeout(timer), narrow(q));
    if (q) go({ page: "search", q });
  });
  // The section's chip cleared the words.
  document.addEventListener("apricity:search-cleared", () => (input.value = ""));
  // "/" puts you in the box from anywhere that isn't already taking text.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable], .cm-editor")) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
  host.append(form);
  return input;
}

const link = (route: Route, text: string, className = "") => {
  const a = el("a", { href: href(route), textContent: text, className });
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(route);
  });
  return a;
};

export class SearchView {
  private seq = 0;
  constructor(private root: HTMLElement, private box: HTMLInputElement) {}

  async show(q: string | undefined) {
    const seq = ++this.seq;
    const words = (q ?? "").trim();
    this.box.value = words;
    opened({ page: "search", ...(words ? { q: words } : {}) }, "auto", words ? `“${words}”` : undefined);
    const head = el("div", { className: "feed-bar" }, el("h1", { className: "feed-tag" }, words ? `“${words}”` : "Search"));
    if (!words) {
      this.root.replaceChildren(el("div", { className: "feed-page" }, head, el("div", { className: "empty" }, "Type in the box at the top: a title, a #tag, an @handle, a key or a tempo.")));
      return;
    }
    this.root.replaceChildren(el("div", { className: "feed-page" }, head, el("div", { className: "empty" }, "Searching…")));
    const [who, names] = await Promise.all([me().catch(() => null), handles()]);
    const deps: FeedDeps = { who, names };
    // Each section as it comes in, in the top bar's order.
    const slots = new Map<Section, HTMLElement>(SECTIONS.map((s) => [s, el("section", { className: "search-section", hidden: true })]));
    const none = el("div", { className: "empty", hidden: true }, `Nothing matches “${words}”.`);
    this.root.replaceChildren(el("div", { className: "feed-page" }, head, ...slots.values(), none));
    let found = 0;
    let done = 0;
    await Promise.all(
      SECTIONS.map(async (section) => {
        try {
          const { entries, tallies } = await load(section);
          const hits = entries.filter((e) => matches(e, words));
          if (seq !== this.seq || !hits.length) return;
          const ranked = rank(hits, await tallies().catch(() => []), "all", new Date());
          if (seq !== this.seq) return;
          found += hits.length;
          const slot = slots.get(section)!;
          slot.hidden = false;
          slot.replaceChildren(
            el(
              "div",
              { className: "search-head" },
              el("h2", {}, SECTION_LABEL[section], el("span", { className: "hint" }, ` ${hits.length}`)),
              ...(hits.length > PER_SECTION ? [link({ page: section, list: new URLSearchParams({ q: words }).toString() }, `All ${hits.length} in ${SECTION_LABEL[section]} →`)] : []),
            ),
            feedGrid(ranked.rows.slice(0, PER_SECTION).map(({ item, standing }) => new FeedCard(feedItemOf(rowOf(item, standing), deps), deps).root)),
          );
        } catch (e) {
          reportError(`search ${SECTION_LABEL[section]}`, e);
        } finally {
          if (seq === this.seq && ++done === SECTIONS.length && !found) none.hidden = false;
        }
      }),
    );
  }
}
