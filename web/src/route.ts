// Every page and item has a URL, so anything can be linked, bookmarked, shared or gone Back to:
//
//   /                              the home page: what's happening, best-rated songs first (?order=recent, ?mine=1)
//   /about                         what Apricity is (the old landing page)
//   /scores  /beats  /chords  /melodies     the lists; a score is under the tab of its kind:
//   /beats/examples/salamander-beat         (its folder and name; ".apr" left off, ".yaml" kept) and ?play plays it
//   /clips  /clips/<sample>/<clip name>     a clip, by its sample (path without its extension) and its name;
//   ?q=house&window=month&mine…            a section's list, narrowed (and Clips: ?kind=loop&stars=4…)
//   /samples  /samples/<sample>             a sample, by its path without its extension
//   /help  /help/<page>#<section>           a Help page ("language" for language.md), and a heading on it
//   /tags  /tags/<tag>                      every tag, and one tag's leaderboard (?kind=beat&window=month)
//   /search?q=house                         what matches, every kind
//
// Pure: parse and href are inverses (tested in test/route.test.ts). main.ts follows them; the views report what
// they opened so the address bar keeps up.

import type { ScoreKind } from "./data/catalog";

export type Page = "home" | "about" | "how-it-works" | "listen" | "scores" | "beats" | "chords" | "melodies" | "clips" | "samples" | "help" | "tags" | "search";

export interface Route {
  page: Page;
  /** A listening cycle's id ("cyc_..."), on /listen/<id>; absent for the list of open cycles. */
  listenCycle?: string;
  /** A score's library path ("examples/salamander-beat.apr"). */
  score?: string;
  /** Play the score once it's open. */
  play?: boolean;
  /** A sample's path in the library, without its extension ("marine-band/Thunderer"). */
  sample?: string;
  /** A clip: its sample (as above) and its name. */
  clip?: { sample: string; name: string };
  /** A tag's leaderboard ("techno"). */
  tag?: string;
  /** A section or a tag: how its list is narrowed and sorted, as a query ("q=house&kind=loop&stars=4"; see ui/filter-bar.ts). */
  list?: string;
  /** What was searched for (/search?q=). */
  q?: string;
  /** A Help page (its file, "language.md") and a heading on it. */
  help?: { file: string; anchor?: string };
}

/** The pages whose list is narrowed by a query (a section, a tag). */
const LISTED: Page[] = ["scores", "beats", "chords", "melodies", "clips", "samples", "tags"];

export const PAGES: Page[] = ["home", "about", "how-it-works", "listen", "scores", "beats", "chords", "melodies", "clips", "samples", "help", "tags", "search"];
export const KIND_OF_PAGE: Partial<Record<Page, ScoreKind>> = { scores: "song", beats: "beat", chords: "chords", melodies: "melody" };
export const PAGE_OF_KIND: Record<ScoreKind, Page> = { song: "scores", beat: "beats", chords: "chords", melody: "melodies" };

const enc = (parts: string[]) => parts.map((p) => encodeURIComponent(p)).join("/");
const dec = (parts: string[]) => parts.map((p) => decodeURIComponent(p));
const safe = (parts: string[]) => parts.length > 0 && parts.every((p) => p && p !== "." && p !== "..");

/** A sample path as a URL names it: no "samples/" in front, no extension. */
export const sampleKey = (path: string) => path.replace(/^samples\//, "").replace(/\.[A-Za-z0-9]+$/, "");

/** Where a URL goes. Anything unknown is the home page. */
export function parse(pathname: string, search = "", hash = ""): Route {
  const parts = pathname.split("/").filter(Boolean);
  const page = (parts[0] ?? "home") as Page;
  if (!PAGES.includes(page)) return { page: "home" };
  if (page === "home") {
    const list = parts.length ? "" : search.replace(/^\?/, "");
    return list ? { page, list } : { page };
  }
  let rest: string[];
  try {
    rest = dec(parts.slice(1));
  } catch {
    return { page }; // a malformed escape: just the page
  }
  if (page === "search") {
    const q = new URLSearchParams(search).get("q")?.trim();
    return q ? { page, q } : { page };
  }
  const list = LISTED.includes(page) ? search.replace(/^\?/, "") : "";
  const listed = list ? { list } : {};
  if (!rest.length || !safe(rest)) return { page, ...listed };
  if (KIND_OF_PAGE[page]) {
    if (!rest.length) return { page, ...listed };
    const last = rest[rest.length - 1];
    const file = /\.(apr|yaml)$/.test(last) ? last : `${last}.apr`;
    const score = [...rest.slice(0, -1), file].join("/");
    return { page, score, ...(new URLSearchParams(search).has("play") ? { play: true } : {}) };
  }
  if (page === "listen") return rest.length === 1 ? { page, listenCycle: rest[0] } : { page };
  if (page === "samples") return { page, sample: rest.join("/") };
  if (page === "clips" && rest.length >= 2) return { page, clip: { sample: rest.slice(0, -1).join("/"), name: rest[rest.length - 1] }, ...listed };
  if (page === "tags" && rest.length === 1) return { page, tag: rest[0], ...listed };
  if (page === "help") {
    const anchor = decodeURIComponent(hash.replace(/^#/, ""));
    return { page, help: { file: `${rest.join("/")}.md`, ...(anchor ? { anchor } : {}) } };
  }
  return { page, ...listed };
}

/** The URL of a route (path, and ?play or #section when there is one). */
export function href(r: Route): string {
  if (r.page === "home") return r.list ? `/?${r.list}` : "/";
  if (r.score && KIND_OF_PAGE[r.page]) {
    const parts = r.score.replace(/\.apr$/, "").split("/");
    return `/${r.page}/${enc(parts)}${r.play ? "?play" : ""}`;
  }
  if (r.page === "search") return r.q ? `/search?${new URLSearchParams({ q: r.q })}` : "/search";
  if (r.page === "listen" && r.listenCycle) return `/listen/${enc([r.listenCycle])}`;
  if (r.page === "samples" && r.sample) return `/samples/${enc(r.sample.split("/"))}`;
  const list = LISTED.includes(r.page) && r.list && !r.score && !r.sample ? `?${r.list}` : "";
  if (r.page === "tags" && r.tag) return `/tags/${enc([r.tag])}${list}`;
  if (r.page === "clips" && r.clip) return `/clips/${enc([...r.clip.sample.split("/"), r.clip.name])}${list}`;
  if (r.page === "help" && r.help) return `/help/${enc(r.help.file.replace(/\.md$/, "").split("/"))}${r.help.anchor ? `#${encodeURIComponent(r.help.anchor)}` : ""}`;
  return `/${r.page}${list}`;
}

/** The tab a route shows (Help is the "docs" view). */
export const tabOf = (r: Route) => (r.page === "help" ? "docs" : r.page);

/** The page title for a route and the name of what's open ("Salamander Beat · Beats · Apricity"). */
export function titleOf(r: Route, name?: string): string {
  const label: Record<Page, string> = { home: "", about: "About", "how-it-works": "How it works", listen: "Listen", scores: "Scores", beats: "Beats", chords: "Chords", melodies: "Melodies", clips: "Clips", samples: "Samples", help: "Help", tags: "Tags", search: "Search" };
  return [name, label[r.page], "Apricity"].filter(Boolean).join(" · ");
}
