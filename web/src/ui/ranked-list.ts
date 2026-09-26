// A ranked list for a tab's sidebar: top of the week / month / year / all time, a "Mine" toggle, a search box and a
// New button. Scores, Beats, Chords, Melodies, Clips and Samples all use it; each tab says how to load its items and
// how a row reads.

import { reportError } from "./notices";
import { el } from "./dom";
import { rank, WINDOWS, WINDOW_LABEL, widenedNote, type DayTally, type Rankable, type Ranked, type Standing, type Window } from "../data/rank-window";
import { starSummary } from "./stars";
import { owns, type Me } from "../data/catalog";

export interface RowText {
  title: string;
  sub?: string;
}

export interface RankedSource<T extends Rankable> {
  /** Names the list in messages and remembers its window, e.g. "scores". */
  name: string;
  load(): Promise<T[]>;
  /** Tally rows for these items (may be empty). */
  tallies(): Promise<DayTally[]>;
  row(item: T): RowText;
  /** Text the search box matches. */
  text(item: T): string;
  /** Who made an item. When given, the list offers a "Mine" toggle. */
  owner?(item: T): string | null | undefined;
  /** Who is signed in (null for a guest). */
  me(): Promise<Me | null>;
  open(item: T): void;
  /** More controls under the time range (Clips: its filters and sort). */
  tools?: HTMLElement;
  /** Narrow and reorder the ranked rows (Clips: its filters and sort). */
  refine?(rows: Array<{ item: T; standing: Standing }>): Array<{ item: T; standing: Standing }>;
  /** Controls on a row beside its link (Clips: play and rate it right there). */
  extra?(item: T, standing: Standing): HTMLElement;
  /** The New button; absent for lists people can't add to. */
  create?: { label: string; run(): void };
}

export interface ListFilter {
  query: string;
  mine: boolean;
  me: Me | null;
}

/** Search and "Mine", applied before ranking. Mine with nobody signed in shows nothing. */
export function filterItems<T extends Rankable>(items: T[], f: ListFilter, text: (i: T) => string, owner?: (i: T) => string | null | undefined): T[] {
  const q = f.query.trim().toLowerCase();
  return items.filter((i) => {
    if (f.mine && (!owner || !owns(f.me, owner(i)))) return false;
    return !q || text(i).toLowerCase().includes(q);
  });
}

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {} // storage can be blocked (private browsing): nothing to report
  },
};

export class RankedList<T extends Rankable> {
  readonly el: HTMLElement;
  private listEl = el("div", { className: "list" });
  private noteEl = el("div", { className: "rank-note", hidden: true });
  private windowEl = el("div", { className: "seg", role: "tablist", ariaLabel: "Time range" });
  private mineBtn = el("button", { type: "button", className: "btn mine", textContent: "Mine" });
  private items: T[] = [];
  private tallies: DayTally[] = [];
  private me: Me | null = null;
  private window: Window;
  private mine: boolean;
  private query = "";
  private addBtn: HTMLButtonElement | null = null;
  /** What the list calls its items in messages ("beats"); starts as the source's name. */
  private label: string;
  current: string | null = null;

  constructor(private src: RankedSource<T>) {
    this.label = src.name;
    this.window = (WINDOWS as string[]).includes(store.get(`apricity.${src.name}.window`) ?? "") ? (store.get(`apricity.${src.name}.window`) as Window) : "week";
    this.mine = store.get(`apricity.${src.name}.mine`) === "1";
    const search = el("input", { type: "search", placeholder: "Search…", ariaLabel: `Search ${src.name}` });
    search.addEventListener("input", () => ((this.query = search.value), this.render()));
    for (const w of WINDOWS) {
      const b = el("button", { type: "button", textContent: WINDOW_LABEL[w] });
      b.setAttribute("role", "tab");
      b.dataset.window = w;
      b.addEventListener("click", () => this.setWindow(w));
      this.windowEl.append(b);
    }
    this.mineBtn.hidden = !src.owner;
    this.mineBtn.addEventListener("click", () => {
      this.mine = !this.mine;
      store.set(`apricity.${src.name}.mine`, this.mine ? "1" : "0");
      this.render();
    });
    const tools = el("div", { className: "rank-tools" }, this.windowEl, this.mineBtn);
    const searchRow: HTMLElement[] = [search];
    if (src.create) {
      const add = (this.addBtn = el("button", { type: "button", className: "btn primary new", textContent: src.create.label }));
      add.addEventListener("click", () => src.create!.run());
      searchRow.push(add);
    }
    const kids: HTMLElement[] = [el("div", { className: "search" }, ...searchRow), tools, ...(src.tools ? [src.tools] : []), this.noteEl, this.listEl];
    this.el = el("aside", { className: "sidebar ranked" }, ...kids);
  }

  /** Call the items something else in messages and on the New button (one view, several tabs). */
  rename(label: string, createLabel?: string) {
    this.label = label;
    if (this.addBtn && createLabel) this.addBtn.textContent = createLabel;
    (this.el.querySelector("input[type=search]") as HTMLInputElement).ariaLabel = `Search ${label}`;
  }

  /** The first item as ranked now (what a tab opens by default). */
  top(): T | undefined {
    return this.ranked?.rows[0]?.item;
  }

  setWindow(w: Window) {
    this.window = w;
    store.set(`apricity.${this.src.name}.window`, w);
    this.render();
  }

  /** Reload items, tallies and who is signed in. */
  async refresh(): Promise<T[]> {
    try {
      [this.items, this.tallies, this.me] = await Promise.all([this.src.load(), this.src.tallies().catch((e) => (reportError("load the ratings that rank this list", e), [])), this.src.me().catch(() => null)]);
    } catch (e) {
      this.items = [];
      this.listEl.replaceChildren(el("div", { className: "empty" }, `Couldn't load the ${this.label}: ${(e as Error).message}`));
      return [];
    }
    this.render();
    return this.items;
  }

  /** The item's standing in the window shown, for an open item's header. */
  standingOf(id: string): Standing | undefined {
    return this.ranked?.rows.find((r) => r.item.id === id)?.standing;
  }

  private ranked: Ranked<T> | null = null;

  render() {
    for (const b of this.windowEl.children) (b as HTMLElement).setAttribute("aria-selected", String((b as HTMLElement).dataset.window === this.window));
    this.mineBtn.classList.toggle("on", this.mine);
    this.mineBtn.setAttribute("aria-pressed", String(this.mine));
    const shown = filterItems(this.items, { query: this.query, mine: this.mine, me: this.me }, (i) => this.src.text(i), this.src.owner);
    const ranked = rank(shown, this.tallies, this.window, new Date());
    const r = (this.ranked = this.src.refine ? { ...ranked, rows: this.src.refine(ranked.rows) } : ranked);
    const note = widenedNote(r);
    this.noteEl.hidden = !note;
    this.noteEl.textContent = note ?? "";
    if (!r.rows.length) {
      const msg = this.mine && !this.me ? `Sign in to see your ${this.label}.` : this.mine ? `You haven't made any ${this.label} yet.` : this.query || shown.length ? "Nothing matches." : `No ${this.label} yet.`;
      this.listEl.replaceChildren(el("div", { className: "empty" }, msg));
      return;
    }
    this.listEl.replaceChildren(
      ...r.rows.map(({ item, standing }, n) => {
        const t = this.src.row(item);
        const row = el(
          "button",
          { className: "row ranked", type: "button" },
          el("span", { className: "n" }, standing.count ? String(n + 1) : ""),
          el("span", { className: "t" }, t.title),
          starSummary(standing.average, standing.count),
          ...(t.sub ? [el("span", { className: "sub" }, t.sub)] : []),
        );
        row.setAttribute("aria-current", String(item.id === this.current));
        row.addEventListener("click", () => this.open(item));
        if (!this.src.extra) return row;
        const wrap = el("div", { className: "row-wrap" }, row, this.src.extra(item, standing));
        wrap.setAttribute("aria-current", String(item.id === this.current));
        return wrap;
      }),
    );
  }

  open(item: T) {
    this.current = item.id;
    this.render();
    this.src.open(item);
  }
}
