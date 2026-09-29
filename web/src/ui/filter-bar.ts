// The one filter bar every list uses (home, a section, a tag): Top or Recent, Top's time window, Mine, the words
// searched for (a chip that clears them; they're typed in the top bar's box), a section's own "More filters", and its
// "+ New" button. A page says which of these apply; the bar reports every change as a ListView (data/list-view.ts).

import { el } from "./dom";
import { WINDOWS, WINDOW_LABEL, type Window } from "../data/rank-window";
import type { ListView, Order } from "../data/list-view";

export interface FilterBarOptions {
  /** Offer the time window (sections and tags; home's Top has its own order). */
  window?: boolean;
  /** Offer Mine (lists of things people make). */
  mine?: boolean;
  /** A section's own filters, behind a "More filters" button; `active` says whether any is set. */
  more?: { panel: HTMLElement; active: () => boolean };
  /** "+ New beat". */
  create?: { label: string; run: () => void };
  /** At the right end (home's #tags). */
  tail?: HTMLElement[];
}

export class FilterBar {
  readonly el: HTMLElement;
  private orderEl = el("div", { className: "seg filter-order", role: "tablist", ariaLabel: "Order" });
  private windowEl = el("div", { className: "seg filter-window", role: "tablist", ariaLabel: "Time range" });
  private mineBtn = el("button", { type: "button", className: "btn filter-mine", title: "Only what you made" }, "Mine");
  private qChip = el("button", { type: "button", className: "filter-q", title: "Clear the search" });
  private moreBtn = el("button", { type: "button", className: "btn filter-more-btn", ariaExpanded: "false" }, "More filters");
  private noteEl = el("div", { className: "rank-note filter-note", hidden: true });
  private view: ListView;

  constructor(view: ListView, private opts: FilterBarOptions, private changed: (v: ListView) => void) {
    this.view = { ...view };
    for (const [o, label, title] of [["top", "Top", "Best rated first"], ["recent", "Recent", "Newest first"]] as const) {
      const b = el("button", { type: "button", textContent: label, title });
      b.setAttribute("role", "tab");
      b.dataset.value = o;
      b.addEventListener("click", () => this.update({ order: o as Order }));
      this.orderEl.append(b);
    }
    for (const w of WINDOWS) {
      const b = el("button", { type: "button", textContent: WINDOW_LABEL[w] });
      b.setAttribute("role", "tab");
      b.dataset.value = w;
      b.addEventListener("click", () => this.update({ window: w as Window }));
      this.windowEl.append(b);
    }
    this.mineBtn.addEventListener("click", () => this.update({ mine: !this.view.mine }));
    this.qChip.addEventListener("click", () => this.update({ q: "" }));
    const more = opts.more;
    if (more) {
      more.panel.classList.add("filter-more");
      more.panel.hidden = true;
      this.moreBtn.addEventListener("click", () => {
        more.panel.hidden = !more.panel.hidden;
        this.moreBtn.setAttribute("aria-expanded", String(!more.panel.hidden));
      });
    }
    const create = opts.create ? [el("button", { type: "button", className: "btn primary filter-new", onclick: opts.create.run }, `+ ${opts.create.label}`)] : [];
    this.el = el(
      "div",
      { className: "filter-bar" },
      el(
        "div",
        { className: "filter-row" },
        this.orderEl,
        ...(opts.window ? [this.windowEl] : []),
        ...(opts.mine ? [this.mineBtn] : []),
        ...(more ? [this.moreBtn] : []),
        this.qChip,
        ...create,
        el("span", { className: "filter-gap" }),
        ...(opts.tail ?? []),
      ),
      ...(more ? [more.panel] : []),
      this.noteEl,
    );
    this.paint();
  }

  get value(): ListView {
    return { ...this.view };
  }

  /** Show a view (from the URL) without reporting it. */
  set(view: ListView) {
    this.view = { ...view };
    this.paint();
  }

  /** A line under the bar ("Quiet week — showing the top of the month"), or none. */
  note(text: string | null) {
    this.noteEl.textContent = text ?? "";
    this.noteEl.hidden = !text;
  }

  /** Repaint "More filters" (a section changed its own filters). */
  refresh() {
    this.paint();
  }

  private update(change: Partial<ListView>) {
    this.view = { ...this.view, ...change };
    this.paint();
    this.changed(this.value);
  }

  private paint() {
    for (const b of this.orderEl.children) b.setAttribute("aria-selected", String((b as HTMLElement).dataset.value === this.view.order));
    for (const b of this.windowEl.children) b.setAttribute("aria-selected", String((b as HTMLElement).dataset.value === this.view.window));
    // The window ranks Top; Recent is simply newest first.
    this.windowEl.hidden = this.view.order !== "top";
    this.mineBtn.classList.toggle("on", this.view.mine);
    this.mineBtn.setAttribute("aria-pressed", String(this.view.mine));
    this.qChip.hidden = !this.view.q;
    this.qChip.textContent = `“${this.view.q}” ×`;
    this.moreBtn.classList.toggle("on", !!this.opts.more?.active());
  }
}
