// How a list is looked at: its order (Top or Recent), Top's time window, only your own things (Mine), and the words
// searched for. The filter bar (ui/filter-bar.ts) shows it, and the page's URL query keeps it, so a view can be linked:
// /beats?window=month&mine=1&q=house. Other keys in the query (the Clips section's own filters) pass through untouched.
// Pure (test/list-view.test.ts).

import { WINDOWS, type Window } from "./rank-window";

export type Order = "top" | "recent";

export interface ListView {
  order: Order;
  window: Window;
  mine: boolean;
  q: string;
}

export const DEFAULT_VIEW: ListView = { order: "top", window: "all", mine: false, q: "" };

const KEYS = ["order", "window", "mine", "q"];

/** A view from a URL query; anything unknown or malformed is left at its default. */
export function parseView(query: string): ListView {
  const p = new URLSearchParams(query);
  const order = p.get("order");
  const window = p.get("window") as Window | null;
  return {
    order: order === "recent" ? "recent" : "top",
    window: window && WINDOWS.includes(window) ? window : DEFAULT_VIEW.window,
    mine: p.get("mine") === "1",
    q: (p.get("q") ?? "").trim(),
  };
}

/** The query's other keys (a section's own filters), without the view's. */
export function otherKeys(query: string): string {
  const p = new URLSearchParams(query);
  for (const k of KEYS) p.delete(k);
  return p.toString();
}

/** A URL query for a view (only what differs from the defaults), followed by `rest` (a section's own filters). */
export function viewQuery(v: ListView, rest = ""): string {
  const p = new URLSearchParams();
  if (v.q) p.set("q", v.q);
  if (v.order !== "top") p.set("order", v.order);
  if (v.order === "top" && v.window !== DEFAULT_VIEW.window) p.set("window", v.window);
  if (v.mine) p.set("mine", "1");
  for (const [k, val] of new URLSearchParams(rest)) if (!KEYS.includes(k)) p.set(k, val);
  return p.toString();
}
