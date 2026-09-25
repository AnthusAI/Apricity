// Deep links into the app: `#score=examples/chop-shop.apr` opens a score in the Score tab, and
// `&play` also plays it. Breakdowns' "Open in Score" buttons use them, and they can be shared.

export interface Route {
  score?: string;
  play: boolean;
}

/** Read a location hash ("#score=examples/chop-shop.apr&play"). Anything else is no route. */
export function parseRoute(hash: string): Route {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const score = params.get("score")?.trim();
  return { score: score && !score.startsWith("/") && !score.split("/").includes("..") ? score : undefined, play: params.has("play") };
}

/** The hash that opens `score` (and plays it). */
export function routeFor(score: string, play = false) {
  return `#score=${encodeURIComponent(score).replace(/%2F/g, "/")}${play ? "&play" : ""}`;
}
