// A section's front page (/scores, /beats, /chords, /melodies, /clips, /samples): every item of its kind as cards, like
// home, under the one filter bar: Top in a time window (a quiet one widens, and says so) or Recent, Mine, the words
// typed in the top bar's search box, and Clips' own filters under More filters. Choosing a card opens that item's page.
// The view lives in the URL (/beats?window=month&mine=1&q=house).

import { el } from "./dom";
import { me, type SampleSummary } from "../apricity";
import { mode } from "../data/client";
import { handles } from "../data/handles";
import { owns, type ClipItem } from "../data/catalog";
import { rank, widenedNote, type DayTally, type Standing } from "../data/rank-window";
import { load, matches, rowOf, SECTION_LABEL, KIND_OF_SECTION, type Entry, type Section } from "../data/sections";
import { DEFAULT_VIEW, otherKeys, parseView, viewQuery, type ListView } from "../data/list-view";
import { applyClipFilter, CHOICES, DEFAULT_FILTER, filterQuery, parseFilter, type ClipFilter } from "../data/clip-filter";
import { ratings } from "../apricity";
import { opened } from "./at";
import { reportError } from "./notices";
import { FilterBar } from "./filter-bar";
import { FeedCard, feedItemOf, type FeedDeps } from "./feed-card";
import { feedGrid } from "./feed-grid";
import { semanticUrl } from "../data/client";
import { createHybridSearchController, type HybridSearchController, type HybridSearchState } from "../semantic/hybrid-controller";
import { semanticClipHits, semanticEntriesForView, semanticSampleHits, soundHostState } from "./semantic-sound";
import { SemanticSoundCard, semanticStatus } from "./semantic-sound-card";

const PAGE = 24;
const ONE: Record<Section, string> = { scores: "score", beats: "beat", chords: "chords", melodies: "melody", clips: "clip", samples: "sample" };

export interface SectionDeps {
  /** "+ New beat" (the score sections). */
  create(section: Section): void;
}

export class SectionView {
  private section: Section | null = null;
  private view: ListView = { ...DEFAULT_VIEW };
  private clipFilter: ClipFilter = { ...DEFAULT_FILTER };
  private seq = 0;
  private entries: Entry[] = [];
  private loadedFor: Section | null = null;
  private body = el("div", { className: "act-body", ariaLive: "polite" });
  /** Kept outside the lexical body so worker progress never rebuilds lexical cards. */
  private soundHost = el("div", { className: "sound-results" });
  private barHost = el("div");
  private strip = el("div", { className: "section-strip", hidden: true });
  private bar: FilterBar | null = null;
  private more = el("div");
  private semantic: HybridSearchController | null = null;
  private semanticState: HybridSearchState = { phase: "idle", query: "" };
  private soundCatalogError: unknown = null;
  private soundWho: Awaited<ReturnType<typeof me>> = null;
  private soundStars = new Map<string, number>();
  private soundTallies: DayTally[] = [];
  private cacheUnavailableQuery: string | null = null;
  private acceptsSemanticEvents = true;

  constructor(private root: HTMLElement, private deps: SectionDeps) {
    root.append(el("div", { className: "feed-page act" }, this.barHost, this.strip, this.body, this.soundHost));
    // Stars rated anywhere, a sign-in or out: what's listed may have changed.
    document.addEventListener("apricity:auth-changed", () => ((this.loadedFor = null), this.section && void this.render()));
    // Creating the controller is cheap; its encoder stays dynamically unloaded until a configured
    // audio-search surface receives nonempty text.
    if (semanticUrl()) this.semantic = createHybridSearchController({ onState: (state) => {
      if (!this.acceptsSemanticEvents) return;
      this.semanticState = state;
      if (state.progress?.phase === "cache_unavailable") this.cacheUnavailableQuery = state.query;
      this.paintSound();
    } });
  }

  /** Whether a section's front page is on show (the top bar's search then narrows it as you type). */
  get shown(): boolean {
    return !!this.section && !this.root.hidden;
  }

  /** Show a section with its view from the URL. */
  async show(section: Section, list = "") {
    const changed = section !== this.section;
    if (changed) this.cancelSemantic();
    this.acceptsSemanticEvents = true;
    this.section = section;
    this.soundCatalogError = null;
    this.cacheUnavailableQuery = null;
    this.view = parseView(list);
    this.clipFilter = section === "clips" ? parseFilter(otherKeys(list)) : { ...DEFAULT_FILTER };
    if (changed || !this.bar) this.makeBar(section);
    this.bar!.set(this.view);
    this.setSemanticSearch(false);
    this.paintSound();
    await this.render();
  }

  /** The words in the top bar's box, as they're typed. */
  search(q: string, immediate = false) {
    if (!this.section) return;
    this.view = { ...this.view, q: q.trim() };
    this.cacheUnavailableQuery = null;
    this.bar?.set(this.view);
    this.report();
    this.setSemanticSearch(immediate);
    this.paintSound();
    void this.render();
  }

  /** Route transitions must not let an idle cancellation repaint the outgoing section. */
  cancelSemantic() {
    ++this.seq;
    this.acceptsSemanticEvents = false;
    this.semantic?.cancel();
    this.soundHost.replaceChildren();
  }

  get query(): string {
    return this.view.q;
  }

  private makeBar(section: Section) {
    const create = KIND_OF_SECTION[section] ? { label: `New ${ONE[section]}`, run: () => this.deps.create(section) } : undefined;
    this.bar = new FilterBar(
      this.view,
      { window: true, mine: section !== "samples", ...(section === "clips" ? { more: { panel: this.more, active: () => !!filterQuery({ ...this.clipFilter, sort: "top" }) || this.clipFilter.sort !== "top" } } : {}), ...(create ? { create } : {}) },
      (v) => {
        const typed = v.q !== this.view.q;
        this.view = v;
        if (typed) this.cacheUnavailableQuery = null;
        this.report();
        // Clearing the chip is a semantic cancellation too, and happens before its next list load.
        if (typed) this.setSemanticSearch(false);
        void this.render();
        if (typed) document.dispatchEvent(new CustomEvent("apricity:search-cleared"));
      },
    );
    this.barHost.replaceChildren(this.bar.el);
  }

  /** The address bar follows the view. */
  private report() {
    if (!this.section) return;
    const list = viewQuery(this.view, this.section === "clips" ? filterQuery(this.clipFilter) : "");
    opened({ page: this.section, ...(list ? { list } : {}) }, "auto", this.view.q ? `“${this.view.q}”` : undefined);
  }

  /** Clips' own filters: one menu each, and Reset when any is set. */
  private renderClipFilters() {
    const f = this.clipFilter;
    const menu = <K extends keyof ClipFilter>(key: K, label: string, options: readonly (readonly [string, string])[]) => {
      const s = el("select", { ariaLabel: label, title: label }, ...options.map(([v, text]) => el("option", { value: v, textContent: text })));
      s.value = f[key];
      s.classList.toggle("set", f[key] !== DEFAULT_FILTER[key]);
      s.addEventListener("change", () => this.setClipFilter({ ...this.clipFilter, [key]: s.value }));
      return s;
    };
    const samples = [...new Map(this.entries.map((e) => [e.clip!.samplePath, e.clip!.sampleTitle])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (f.sample && !samples.some(([p]) => p === f.sample)) samples.unshift([f.sample, f.sample]);
    const sample = el("select", { ariaLabel: "Sample", title: "Sample" }, el("option", { value: "", textContent: "Every sample" }), ...samples.map(([p, t]) => el("option", { value: p, textContent: t })));
    sample.value = f.sample;
    sample.classList.toggle("set", !!f.sample);
    sample.addEventListener("change", () => this.setClipFilter({ ...this.clipFilter, sample: sample.value }));
    const reset = el("button", { type: "button", className: "btn link", hidden: !filterQuery(f) }, "Reset");
    reset.addEventListener("click", () => this.setClipFilter({ ...DEFAULT_FILTER }));
    this.more.replaceChildren(menu("sort", "Sort by", CHOICES.sort), menu("stars", "Stars", CHOICES.stars), menu("kind", "Kind", CHOICES.kind), menu("origin", "Made by", CHOICES.origin), menu("length", "Length", CHOICES.length), menu("added", "Added", CHOICES.added), sample, reset);
    this.bar?.refresh();
  }

  private setClipFilter(f: ClipFilter) {
    this.clipFilter = f;
    this.report();
    void this.render();
  }

  private async render() {
    const section = this.section;
    if (!section) return;
    const seq = ++this.seq;
    if (this.loadedFor !== section) this.body.replaceChildren(el("div", { className: "empty" }, "Loading…"));
    try {
      const [loaded, who, names] = await Promise.all([load(section), me().catch(() => null), handles()]);
      if (seq !== this.seq) return;
      this.entries = loaded.entries;
      this.loadedFor = section;
      const tallies = await loaded.tallies().catch(() => []);
      const myStars = section === "clips" ? await (await ratings()).mineOf("clip").catch(() => new Map<string, number>()) : new Map<string, number>();
      if (seq !== this.seq) return;
      if (section === "clips") this.renderClipFilters();
      if (section === "samples") void this.renderStrip(who?.curator ?? mode() === "local");
      this.soundWho = who;
      this.soundStars = myStars;
      this.soundTallies = tallies;
      const deps: FeedDeps = { who, names };
      const v = this.view;
      const mine = v.mine && mode() !== "local"; // a local library is all yours
      const picked = this.entries.filter((e) => (!v.q || matches(e, v.q)) && (!mine || owns(who, e.owner)));
      let rows: Array<{ item: Entry; standing: Standing }>;
      if (v.order === "top") {
        const ranked = rank(picked, tallies, v.window, new Date());
        this.bar?.note(widenedNote(ranked));
        rows = ranked.rows;
      } else {
        this.bar?.note(null);
        const all = rank(picked, tallies, "all", new Date());
        rows = all.rows.sort((a, b) => b.item.base.lastAt.localeCompare(a.item.base.lastAt));
      }
      if (section === "clips") {
        const filtered = applyClipFilter(
          rows.map((r) => ({ item: r.item.clip! as ClipItem, standing: r.standing, entry: r.item })),
          this.clipFilter,
          { me: who, mine: myStars, now: new Date() },
        );
        rows = filtered.map((r) => ({ item: r.entry, standing: r.standing }));
      }
      const label = SECTION_LABEL[section];
      const count = el("div", { className: "hint section-count" }, `${rows.length} ${rows.length === 1 ? ONE[section] : label.toLowerCase()}${v.q ? ` matching “${v.q}”` : ""}`);
      this.soundCatalogError = null;
      if (!rows.length) {
        const lexicalEmpty = el("div", { className: "empty" }, v.q ? `No text matches in ${label.toLowerCase()} for “${v.q}”.` : mine ? `You haven't made any ${label.toLowerCase()} yet.` : `No ${label.toLowerCase()} here yet.`);
        this.body.replaceChildren(lexicalEmpty);
        this.paintSound();
        return;
      }
      // Cards are made a page at a time as the grid asks for them (Clips has well over a thousand).
      let at = 0;
      const next = async () => {
        const page = rows.slice(at, (at += PAGE));
        return page.map(({ item, standing }) => new FeedCard(feedItemOf(rowOf(item, standing), deps), deps).root);
      };
      this.body.replaceChildren(count, feedGrid([], next));
      this.paintSound();
    } catch (e) {
      if (seq !== this.seq) return;
      reportError(`load ${SECTION_LABEL[section]}`, e);
      this.soundCatalogError = e;
      this.body.replaceChildren(el("div", { className: "empty" }, `Couldn't load ${SECTION_LABEL[section].toLowerCase()}: ${(e as Error).message}`));
      this.paintSound();
    }
  }

  private setSemanticSearch(immediate: boolean) {
    if (this.section !== "clips" && this.section !== "samples") return;
    if (this.view.q) this.semantic?.setQuery(this.view.q, { immediate, ...(this.section === "clips" ? { kind: "saved_clip" as const } : {}) });
    else this.semantic?.clear();
  }

  private paintSound() {
    const section = this.section;
    const query = this.view.q;
    if ((section !== "clips" && section !== "samples") || !query || this.semanticState.query !== query) return this.soundHost.replaceChildren();
    const catalogReady = this.loadedFor === section;
    const display = soundHostState(query, this.semanticState, catalogReady, this.soundCatalogError);
    if (display.kind === "hidden") return this.soundHost.replaceChildren();
    if (display.kind === "status" || display.kind === "waiting") return this.soundHost.replaceChildren(el("div", { className: "sound-status", ariaLive: "polite" }, display.text));
    if (display.kind === "error") return this.soundHost.replaceChildren(semanticStatus({ phase: "error", query, error: this.soundCatalogError ?? this.semanticState.error }, () => {
      if (this.soundCatalogError) void this.render(); else this.semantic?.retry();
    })!);
    if (this.semanticState.phase !== "ready") return;
    const semanticEntries = semanticEntriesForView(this.entries, this.view.mine, mode() === "local", (entry) => owns(this.soundWho, entry.owner));
    // Mine is independent of lexical text; local libraries are all yours.
    const matches = section === "clips"
      ? semanticClipHits(this.semanticState.hits ?? [], semanticEntries, this.clipFilter, { me: this.soundWho, mine: this.soundStars, now: new Date() }, new Map(rank(semanticEntries, this.soundTallies, "all", new Date()).rows.map((row) => [row.item.id, row.standing])))
      : semanticSampleHits(this.semanticState.hits ?? [], this.entries);
    const warning = this.cacheUnavailableQuery === query ? el("div", { className: "sound-status", ariaLive: "polite" }, "Model cache unavailable; downloaded files will not persist in this browser.") : null;
    if (!matches.length) return this.soundHost.replaceChildren(...[warning, el("section", { className: "sound-section" }, el("div", { className: "empty sound-empty" }, `No sound matches “${query}”.`))].filter(Boolean) as HTMLElement[]);
    this.soundHost.replaceChildren(...[warning, el("section", { className: "sound-section" }, el("div", { className: "search-head" }, el("h2", {}, "Sound matches", el("span", { className: "hint" }, ` ${matches.length}`))), feedGrid(matches.map((match) => new SemanticSoundCard(match).root)))].filter(Boolean) as HTMLElement[]);
  }

  /** Samples, for curators: what's still being analyzed. */
  private async renderStrip(curator: boolean) {
    this.strip.hidden = true;
    if (!curator) return;
    try {
      const { api } = await import("../apricity");
      const r: { samples: SampleSummary[]; unanalyzed: string[]; jobs: { path: string; state: string; error?: string }[] } = await api.samples();
      const running = r.jobs.filter((j) => j.state !== "done");
      const parts = [
        ...(r.unanalyzed.length ? [`${r.unanalyzed.length} sample${r.unanalyzed.length > 1 ? "s" : ""} not analyzed yet`] : []),
        ...running.map((j) => `${j.path.split("/").pop()}: ${j.state === "failed" ? `failed${j.error ? ` (${j.error})` : ""}` : "analyzing…"}`),
      ];
      if (!parts.length) return;
      this.strip.replaceChildren(el("span", { className: "section-strip-label" }, "Curators"), ...parts.map((p) => el("span", {}, p)));
      this.strip.hidden = false;
    } catch {
      /* the strip is a courtesy */
    }
  }
}
