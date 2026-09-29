// A section's front page (/scores, /beats, /chords, /melodies, /clips, /samples): every item of its kind as cards, like
// home, under the one filter bar: Top in a time window (a quiet one widens, and says so) or Recent, Mine, the words
// typed in the top bar's search box, and Clips' own filters under More filters. Choosing a card opens that item's page.
// The view lives in the URL (/beats?window=month&mine=1&q=house).

import { el } from "./dom";
import { me, type SampleSummary } from "../apricity";
import { mode } from "../data/client";
import { handles } from "../data/handles";
import { owns, type ClipItem } from "../data/catalog";
import { rank, widenedNote, type Standing } from "../data/rank-window";
import { load, matches, rowOf, SECTION_LABEL, KIND_OF_SECTION, type Entry, type Section } from "../data/sections";
import { DEFAULT_VIEW, otherKeys, parseView, viewQuery, type ListView } from "../data/list-view";
import { applyClipFilter, CHOICES, DEFAULT_FILTER, filterQuery, parseFilter, type ClipFilter } from "../data/clip-filter";
import { ratings } from "../apricity";
import { opened } from "./at";
import { reportError } from "./notices";
import { FilterBar } from "./filter-bar";
import { FeedCard, feedItemOf, type FeedDeps } from "./feed-card";
import { feedGrid } from "./feed-grid";

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
  private barHost = el("div");
  private strip = el("div", { className: "section-strip", hidden: true });
  private bar: FilterBar | null = null;
  private more = el("div");

  constructor(private root: HTMLElement, private deps: SectionDeps) {
    root.append(el("div", { className: "feed-page act" }, this.barHost, this.strip, this.body));
    // Stars rated anywhere, a sign-in or out: what's listed may have changed.
    document.addEventListener("apricity:auth-changed", () => ((this.loadedFor = null), this.section && void this.render()));
  }

  /** Whether a section's front page is on show (the top bar's search then narrows it as you type). */
  get shown(): boolean {
    return !!this.section && !this.root.hidden;
  }

  /** Show a section with its view from the URL. */
  async show(section: Section, list = "") {
    const changed = section !== this.section;
    this.section = section;
    this.view = parseView(list);
    this.clipFilter = section === "clips" ? parseFilter(otherKeys(list)) : { ...DEFAULT_FILTER };
    if (changed || !this.bar) this.makeBar(section);
    this.bar!.set(this.view);
    await this.render();
  }

  /** The words in the top bar's box, as they're typed. */
  search(q: string) {
    if (!this.section) return;
    this.view = { ...this.view, q: q.trim() };
    this.bar?.set(this.view);
    this.report();
    void this.render();
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
        this.report();
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
      if (!rows.length) {
        this.body.replaceChildren(el("div", { className: "empty" }, v.q ? `No ${label.toLowerCase()} match “${v.q}”.` : mine ? `You haven't made any ${label.toLowerCase()} yet.` : `No ${label.toLowerCase()} here yet.`));
        return;
      }
      // Cards are made a page at a time as the grid asks for them (Clips has well over a thousand).
      let at = 0;
      const next = async () => {
        const page = rows.slice(at, (at += PAGE));
        return page.map(({ item, standing }) => new FeedCard(feedItemOf(rowOf(item, standing), deps), deps).root);
      };
      this.body.replaceChildren(count, feedGrid([], next));
    } catch (e) {
      if (seq !== this.seq) return;
      reportError(`load ${SECTION_LABEL[section]}`, e);
      this.body.replaceChildren(el("div", { className: "empty" }, `Couldn't load ${SECTION_LABEL[section].toLowerCase()}: ${(e as Error).message}`));
    }
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
