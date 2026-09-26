// Drag a panel's edge to resize it: the list beside a score, the score's side panel, the Library's list, Help's
// contents. The width goes into a CSS custom property the view's grid uses (e.g. --list-w), is remembered per browser,
// and goes back to the default on a double-click. Arrow keys move a focused grip too. On a phone the views are one
// column, so the grips hide.
//
// The grip lives on the view, not in the panel (panels scroll, and a grip inside would scroll away), and is placed over
// the panel's edge whenever either changes size.

import { el } from "./dom";

export interface SplitterOptions {
  /** The grid container whose CSS property sets the width. */
  view: HTMLElement;
  /** The panel being resized. */
  panel: HTMLElement;
  /** Which of the panel's edges moves. */
  edge: "left" | "right";
  /** The CSS custom property (e.g. "--list-w"). */
  prop: string;
  /** Where the width is remembered ("apricity.width.<key>"). */
  key: string;
  min: number;
  /** The widest it may be, given the view's width. */
  max: (viewWidth: number) => number;
}

const STEP = 16;

/** Clamp a width between a panel's limits. */
export const clampWidth = (w: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, w)));

export function columnSplitter(o: SplitterOptions): HTMLElement {
  const storage = `apricity.width.${o.key}`;
  const grip = el("div", { className: "col-grip", role: "separator", tabIndex: 0, title: "Drag to resize · double-click to reset" });
  grip.setAttribute("aria-orientation", "vertical");
  o.view.append(grip);

  const set = (w: number | null) => {
    if (w === null) o.view.style.removeProperty(o.prop);
    else o.view.style.setProperty(o.prop, `${w}px`);
    grip.setAttribute("aria-valuenow", String(Math.round(o.panel.getBoundingClientRect().width)));
    place();
  };
  const save = (w: number | null) => {
    try {
      if (w === null) localStorage.removeItem(storage);
      else localStorage.setItem(storage, String(w));
    } catch {}
  };

  /** Put the grip over the panel's moving edge (hidden when the panel is). */
  const place = () => {
    const r = o.panel.getBoundingClientRect();
    const v = o.view.getBoundingClientRect();
    const shown = r.width > 0 && r.height > 0 && !o.panel.hidden;
    grip.hidden = !shown;
    if (!shown) return;
    grip.style.left = `${(o.edge === "right" ? r.right : r.left) - v.left - 4}px`;
    grip.style.top = `${r.top - v.top + o.view.scrollTop}px`;
    grip.style.height = `${r.height}px`;
  };
  new ResizeObserver(place).observe(o.panel);
  new ResizeObserver(place).observe(o.view);

  try {
    const w = Number(localStorage.getItem(storage));
    if (w > 0) set(clampWidth(w, o.min, o.max(o.view.clientWidth || innerWidth)));
  } catch {}

  const widthFor = (w0: number, dx: number) => clampWidth(o.edge === "right" ? w0 + dx : w0 - dx, o.min, o.max(o.view.clientWidth));
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = o.panel.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("dragging");
    document.body.classList.add("col-resizing");
    let w = w0;
    const move = (m: PointerEvent) => set((w = widthFor(w0, m.clientX - x0)));
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
      save(w);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  });
  grip.addEventListener("dblclick", () => (save(null), set(null)));
  grip.addEventListener("keydown", (e) => {
    const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const w = widthFor(o.panel.getBoundingClientRect().width, dir * STEP);
    set(w);
    save(w);
  });
  return grip;
}
