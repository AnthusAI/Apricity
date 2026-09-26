// A grid of feed cards that fills the width, a screenful at a time: more are added as the end comes into view.

import { el } from "./dom";

const PAGE = 24;

/** Lay out `cards`, `PAGE` at a time; `more` (optional) fetches further cards when these run out. */
export function feedGrid(cards: HTMLElement[], more?: () => Promise<HTMLElement[]>): HTMLElement {
  const grid = el("div", { className: "feed-grid" });
  const end = el("div", { className: "feed-end" });
  let next = 0;
  let busy = false;
  const fill = async () => {
    if (busy) return;
    busy = true;
    try {
      if (next < cards.length) grid.append(...cards.slice(next, (next += PAGE)));
      else if (more) {
        const got = await more();
        if (!got.length) return watch.disconnect();
        cards.push(...got);
        grid.append(...cards.slice(next, (next += PAGE)));
      } else watch.disconnect();
    } finally {
      busy = false;
    }
    // Still in view (a tall screen, or few cards per page): keep going.
    requestAnimationFrame(() => end.isConnected && end.getBoundingClientRect().top < innerHeight + 600 && (next < cards.length || more) && void fill());
  };
  const watch = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && void fill(), { rootMargin: "600px" });
  void fill();
  watch.observe(end);
  return el("div", { className: "feed-grid-wrap" }, grid, end);
}
