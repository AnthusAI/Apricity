// Star ratings: 0–5 stars, one rating per person per item.
//
// Lists show a quiet summary ("★ 4.2 · 12"). An open item shows the widget: five stars plus a zero, your own rating
// highlighted, the average behind it. Clicking your current rating again takes it back. Guests see the average and are
// asked to sign in when they click.

import { el } from "./dom";

/** "★ 4.2 · 12", "★ 5 · 1", or "" when nobody rated it. */
export function summaryText(average: number | null, count: number): string {
  if (average === null || count <= 0) return "";
  const avg = Number.isInteger(Math.round(average * 10) / 10) ? String(Math.round(average)) : average.toFixed(1);
  return `★ ${avg} · ${count}`;
}

/** The list-row summary. */
export function starSummary(average: number | null, count: number): HTMLElement {
  const text = summaryText(average, count);
  return el("span", { className: "stars-sum", title: text ? `${count} rating${count === 1 ? "" : "s"}` : "Not rated yet" }, text || "☆");
}

/** What a click on `value` does given your current rating: set it, or take it back when it is the same. */
export function nextRating(mine: number | null, value: number): number | null {
  return mine === value ? null : value;
}

export interface StarState {
  mine: number | null;
  average: number | null;
  count: number;
  signedIn: boolean;
}

export class StarRating {
  readonly el = el("div", { className: "stars", role: "radiogroup", ariaLabel: "Your rating" });
  private buttons: HTMLButtonElement[] = [];
  private note = el("span", { className: "stars-note" });
  private state: StarState = { mine: null, average: null, count: 0, signedIn: false };

  constructor(
    private rate: (stars: number | null) => Promise<void>,
    private signIn: () => void,
    /** Small, for a list row: no note beside the stars unless a save fails. */
    private compact = false,
  ) {
    this.el.classList.toggle("compact", compact);
    for (let v = 0; v <= 5; v++) {
      const b = el("button", { type: "button", className: v === 0 ? "star zero" : "star", textContent: v === 0 ? "0" : "★" });
      b.setAttribute("role", "radio");
      b.ariaLabel = v === 0 ? "Zero stars" : `${v} star${v === 1 ? "" : "s"}`;
      b.addEventListener("click", () => this.click(v));
      b.addEventListener("mouseenter", () => this.paint(v));
      b.addEventListener("focus", () => this.paint(v));
      this.buttons.push(b);
    }
    this.el.addEventListener("mouseleave", () => this.paint());
    this.el.append(...this.buttons, this.note);
  }

  set(state: StarState) {
    this.state = state;
    this.paint();
  }

  private async click(v: number) {
    if (!this.state.signedIn) return this.signIn();
    const before = this.state;
    const mine = nextRating(before.mine, v);
    this.set({ ...before, mine }); // show it at once; roll back if the save fails
    try {
      await this.rate(mine);
    } catch (e) {
      this.set(before);
      this.note.textContent = `Couldn't save: ${(e as Error).message}`;
      this.note.classList.add("failed");
    }
  }

  private paint(hover?: number) {
    const { mine, average, count, signedIn } = this.state;
    const shown = hover ?? mine ?? (average === null ? 0 : Math.round(average));
    const yours = hover !== undefined || mine !== null;
    this.buttons.forEach((b, v) => {
      b.classList.toggle("on", v > 0 && v <= shown);
      b.classList.toggle("yours", yours);
      b.setAttribute("aria-checked", String(mine === v));
    });
    this.buttons[0].classList.toggle("on", yours && shown === 0);
    this.note.classList.remove("failed");
    const sum = summaryText(average, count);
    this.note.textContent =
      hover !== undefined && !signedIn ? "Sign in to rate" : mine !== null ? `You: ${mine}${sum ? ` · ${sum}` : ""}` : sum || "Not rated yet";
  }
}
