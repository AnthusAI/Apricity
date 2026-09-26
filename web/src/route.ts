// Every page and item has a URL, so anything can be linked, bookmarked, shared or gone Back to:
//
//   /                              the home page
//   /activity                      Activity
//   /scores  /beats  /chords  /melodies     the lists; a score is under the tab of its kind:
//   /beats/examples/salamander-beat         (its folder and name; ".apr" left off, ".yaml" kept) and ?play plays it
//   /clips  /clips/<sample>/<clip name>     a clip, by its sample (path without its extension) and its name
//   /samples  /samples/<sample>             a sample, by its path without its extension
//   /help  /help/<page>#<section>           a Help page ("language" for language.md), and a heading on it
//
// Pure: parse and href are inverses (tested in test/route.test.ts). main.ts follows them; the views report what
// they opened so the address bar keeps up.

import type { ScoreKind } from "./data/catalog";

export type Page = "home" | "activity" | "scores" | "beats" | "chords" | "melodies" | "clips" | "samples" | "help";

export interface Route {
  page: Page;
  /** A score's library path ("examples/salamander-beat.apr"). */
  score?: string;
  /** Play the score once it's open. */
  play?: boolean;
  /** A sample's path in the library, without its extension ("marine-band/Thunderer"). */
  sample?: string;
  /** A clip: its sample (as above) and its name. */
  clip?: { sample: string; name: string };
  /** A Help page (its file, "language.md") and a heading on it. */
  help?: { file: string; anchor?: string };
}

export const PAGES: Page[] = ["home", "activity", "scores", "beats", "chords", "melodies", "clips", "samples", "help"];
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
  if (!PAGES.includes(page) || page === "home") return { page: "home" };
  let rest: string[];
  try {
    rest = dec(parts.slice(1));
  } catch {
    return { page }; // a malformed escape: just the page
  }
  if (!rest.length || !safe(rest)) return { page };
  if (KIND_OF_PAGE[page]) {
    const last = rest[rest.length - 1];
    const file = /\.(apr|yaml)$/.test(last) ? last : `${last}.apr`;
    const score = [...rest.slice(0, -1), file].join("/");
    return { page, score, ...(new URLSearchParams(search).has("play") ? { play: true } : {}) };
  }
  if (page === "samples") return { page, sample: rest.join("/") };
  if (page === "clips" && rest.length >= 2) return { page, clip: { sample: rest.slice(0, -1).join("/"), name: rest[rest.length - 1] } };
  if (page === "help") {
    const anchor = decodeURIComponent(hash.replace(/^#/, ""));
    return { page, help: { file: `${rest.join("/")}.md`, ...(anchor ? { anchor } : {}) } };
  }
  return { page };
}

/** The URL of a route (path, and ?play or #section when there is one). */
export function href(r: Route): string {
  if (r.page === "home") return "/";
  if (r.score && KIND_OF_PAGE[r.page]) {
    const parts = r.score.replace(/\.apr$/, "").split("/");
    return `/${r.page}/${enc(parts)}${r.play ? "?play" : ""}`;
  }
  if (r.page === "samples" && r.sample) return `/samples/${enc(r.sample.split("/"))}`;
  if (r.page === "clips" && r.clip) return `/clips/${enc([...r.clip.sample.split("/"), r.clip.name])}`;
  if (r.page === "help" && r.help) return `/help/${enc(r.help.file.replace(/\.md$/, "").split("/"))}${r.help.anchor ? `#${encodeURIComponent(r.help.anchor)}` : ""}`;
  return `/${r.page}`;
}

/** The tab a route shows (Help is the "docs" view). */
export const tabOf = (r: Route) => (r.page === "help" ? "docs" : r.page);

/** The page title for a route and the name of what's open ("Salamander Beat · Beats · Apricity"). */
export function titleOf(r: Route, name?: string): string {
  const label: Record<Page, string> = { home: "", activity: "Activity", scores: "Scores", beats: "Beats", chords: "Chords", melodies: "Melodies", clips: "Clips", samples: "Samples", help: "Help" };
  return [name, label[r.page], "Apricity"].filter(Boolean).join(" · ");
}
