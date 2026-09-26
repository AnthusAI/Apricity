// A view says what it has open, so the address bar (and the page title) keep up: main.ts turns it into a URL.
// `how`: a person opened it (a new history entry), the app chose it (the entry is replaced), or it came from the
// address bar itself (nothing to push; the title still follows).

import type { Route } from "../route";

export type Opened = "user" | "auto" | "route";

export interface At {
  route: Route;
  how: Opened;
  title?: string;
}

export function opened(route: Route, how: Opened, title?: string) {
  document.dispatchEvent(new CustomEvent<At>("apricity:at", { detail: { route, how, ...(title ? { title } : {}) } }));
}

/** Go somewhere, as a click on a link would (main.ts pushes the URL and follows it). */
export function go(route: Route) {
  document.dispatchEvent(new CustomEvent<Route>("apricity:go", { detail: route }));
}
