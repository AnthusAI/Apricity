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
import { semanticUrl } from "../data/client";
import { createHybridSearchController, type HybridSearchController, type HybridSearchState } from "../semantic/hybrid-controller";
import { semanticGlobalHits } from "./semantic-sound";
import { SemanticSoundCard, semanticStatus } from "./semantic-sound-card";

/** Cards per section on the results page. */
const PER_SECTION = 6;

/**
 * The top bar's search box. Enter searches everything (/search?q=); on a section's page, `local` hands back how that
 * section narrows its own list, and the box does that as you type instead.
 */
export function mountSearch(host: HTMLElement, local: () => ((q: string, immediate?: boolean) => void) | null): HTMLInputElement {
  const input = el("input", { type: "search", className: "top-search-input", placeholder: "Search", ariaLabel: "Search", autocomplete: "off", spellcheck: false });
  const form = el("form", { className: "top-search", role: "search" }, el("span", { className: "top-search-icon", ariaHidden: "true" }), input);
  input.addEventListener("input", () => {
    const narrow = local();
    if (!narrow) return;
    narrow(input.value);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    const narrow = local();
    input.blur();
    if (narrow) return narrow(q, true);
    if (q) {
      document.dispatchEvent(new CustomEvent("apricity:global-search-submit", { detail: q }));
      go({ page: "search", q });
    }
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
  private semantic: HybridSearchController | null = null;
  private semanticState: HybridSearchState = { phase: "idle", query: "" };
  private semanticHost: HTMLElement | null = null;
  private query = "";
  private immediateQuery: string | null = null;
  private acceptsSemanticEvents = true;
  private cacheUnavailableQuery: string | null = null;
  constructor(private root: HTMLElement, private box: HTMLInputElement) {
    // No configured endpoint means no encoder import or model download.
    if (semanticUrl()) this.semantic = createHybridSearchController({ onState: (state) => {
      if (!this.acceptsSemanticEvents) return;
      this.semanticState = state;
      if (state.progress?.phase === "cache_unavailable") this.cacheUnavailableQuery = state.query;
      void this.paintSemantic();
    } });
  }

  search(q: string, immediate = false) { void this.show(q, immediate); }
  submitNext(q: string) { this.immediateQuery = q.trim(); }
  /** Invalidate both lexical awaits and semantic callbacks before a route transition. */
  cancelSemantic() {
    ++this.seq;
    this.acceptsSemanticEvents = false;
    this.semanticHost = null;
    this.query = "";
    this.semantic?.cancel();
  }

  async show(q: string | undefined, immediate = false) {
    const seq = ++this.seq;
    const words = (q ?? "").trim();
    this.acceptsSemanticEvents = true;
    immediate ||= this.immediateQuery === words;
    this.immediateQuery = null;
    // A new query must never share a host with work owned by the previous one.
    this.semanticHost = null;
    this.query = words;
    this.cacheUnavailableQuery = null;
    this.box.value = words;
    opened({ page: "search", ...(words ? { q: words } : {}) }, "auto", words ? `“${words}”` : undefined);
    const head = el("div", { className: "feed-bar" }, el("h1", { className: "feed-tag" }, words ? `“${words}”` : "Search"));
    if (!words) {
      this.semantic?.clear();
      this.root.replaceChildren(el("div", { className: "feed-page" }, head, el("div", { className: "empty" }, "Type in the box at the top: a title, a #tag, an @handle, a key or a tempo.")));
      return;
    }
    this.semantic?.setQuery(words, { immediate });
    const semanticHost = this.semanticHost = el("div", { className: "sound-results" });
    this.root.replaceChildren(el("div", { className: "feed-page" }, head, semanticHost, el("div", { className: "empty" }, "Searching…")));
    void this.paintSemantic();
    const [who, names] = await Promise.all([me().catch(() => null), handles()]);
    if (seq !== this.seq) return;
    const deps: FeedDeps = { who, names };
    // Each section as it comes in, in the top bar's order.
    const slots = new Map<Section, HTMLElement>(SECTIONS.map((s) => [s, el("section", { className: "search-section", hidden: true })]));
    const none = el("div", { className: "empty", hidden: true }, `No text matches “${words}”.`);
    this.root.replaceChildren(el("div", { className: "feed-page" }, head, semanticHost, ...slots.values(), none));
    void this.paintSemantic();
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

  private async paintSemantic() {
    const host = this.semanticHost;
    const state = this.semanticState;
    if (!host || !this.query || state.query !== this.query) return;
    const status = semanticStatus(state, () => this.semantic?.retry());
    if (state.phase !== "ready") return void host.replaceChildren(...(status ? [status] : []));
    try {
      const [clips, samples] = await Promise.all([load("clips"), load("samples")]);
      if (host !== this.semanticHost || state !== this.semanticState || state.query !== this.query) return;
      const groups = semanticGlobalHits(state.hits ?? [], clips.entries, samples.entries);
      const group = (title: string, matches: ReturnType<typeof semanticGlobalHits>["clips"]) => matches.length
        ? el("section", { className: "search-section sound-section" }, el("div", { className: "search-head" }, el("h2", {}, title, el("span", { className: "hint" }, ` ${matches.length}`))), feedGrid(matches.map((match) => new SemanticSoundCard(match).root)))
        : null;
      const empty = !groups.clips.length && !groups.passages.length ? el("div", { className: "empty sound-empty" }, `No sound matches “${state.query}”.`) : null;
      const warning = this.cacheUnavailableQuery === state.query ? el("div", { className: "sound-status", ariaLive: "polite" }, "Model cache unavailable; downloaded files will not persist in this browser.") : null;
      host.replaceChildren(...[warning, status, group("Sound clips", groups.clips), group("Sound passages", groups.passages), empty].filter((node): node is HTMLElement => !!node));
    } catch (error) {
      reportError("sound search cards", error);
      if (host === this.semanticHost && state === this.semanticState && state.query === this.query)
        host.replaceChildren(semanticStatus({ phase: "error", query: state.query, error }, () => void this.paintSemantic())!);
    }
  }
}
