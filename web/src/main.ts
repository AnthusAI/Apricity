import "./style.css";
import { player, progressLabel, type Transport } from "./audio/player";
import { PlayButton, type PlayState } from "./ui/play-button";
import { reasonOf } from "./audio/pending";
import { Library } from "./ui/library";
import { ScoreView } from "./ui/score";
import { DocsView } from "./ui/docs";
import { Landing } from "./ui/landing";
import { HowItWorks } from "./ui/how-it-works";
import { ListenView } from "./ui/listen";
import { LabsView } from "./ui/labs";
import { ActivityView } from "./ui/activity";
import { TagsView } from "./ui/tags";
import { mountSearch, SearchView } from "./ui/search";
import { SectionView } from "./ui/section";
import { SoundClustersView } from "./ui/sound-clusters";
import { SECTIONS, type Section } from "./data/sections";
import { parseView } from "./data/list-view";
import { mountNav } from "./ui/nav";
import { stopFeed } from "./audio/feed-audio";
import { bootstrap, bootstrapError, mode } from "./data/client";
import { mountNotices, notify } from "./ui/notices";
import { watchAuth } from "./data/auth";
import { AccountControl, realDeps } from "./ui/account";
import type { ScoreKind } from "./data/catalog";
import { href, KIND_OF_PAGE, PAGE_OF_KIND, parse, tabOf, titleOf, type Page, type Route } from "./route";
import type { At } from "./ui/at";

// Configure the data layer first: /amplify_outputs.json says whether files come from `apricity serve` or the bucket.
// A deploy renames every built file. A tab opened before the deploy then fails to load its lazy chunks (sign-out, storage)
// with a 404: reload once to pick up the new build instead of leaving a dead page.
window.addEventListener("vite:preloadError", (e) => {
  e.preventDefault();
  try {
    const last = Number(sessionStorage.getItem("apricity.reloadedAt") ?? "0");
    if (Date.now() - last < 30_000) return; // already tried a moment ago: do not loop
    sessionStorage.setItem("apricity.reloadedAt", String(Date.now()));
  } catch {} // storage can be blocked (private browsing): nothing to report
  location.reload();
});

// Listen before configure: Amplify exchanges a Google redirect code asynchronously. Nothing waits for it: the views render
// at once and reload when watchAuth announces the session (apricity:auth-changed), so the page is never blank.
void watchAuth();
await bootstrap();

// Failures outside the play button show here (a list that wouldn't load, a waveform, a rating).
mountNotices(document.body.appendChild(document.createElement("div")));
if (bootstrapError())
  notify(`Couldn't reach Apricity's servers (${bootstrapError()}). Lists will be empty until it can.`, { action: { label: "Retry", run: () => location.reload() } });

// Sign in / out lives in the bottom-left pill; it only appears against the cloud backend.
new AccountControl(document.querySelector<HTMLElement>("#account")!, realDeps(() => mode() === "cloud"));

const score = new ScoreView(document.querySelector("#score")!);
const clips = new Library(document.querySelector("#clips")!, "clips");
const samples = new Library(document.querySelector("#samples")!, "samples");
const docs = new DocsView(document.querySelector("#docs")!);
// Home is the feed (ui/activity.ts): the best-rated first, or the newest.
const activity = new ActivityView(document.querySelector("#home")!);
const tagsView = new TagsView(document.querySelector("#tags")!);
// A section's front page: its items as cards (ui/section.ts). "+ New beat" opens the score view on a new one.
const section = new SectionView(document.querySelector("#section")!, {
  create: (s) => {
    front = null;
    showTab(s);
    void score.createNew();
  },
});
// The top bar's search box narrows a section's front page as you type; anywhere else, Enter searches everything.
let searchView!: SearchView;
const searchBox = mountSearch(document.querySelector("#top-search")!, () => (section.shown ? (q, immediate) => section.search(q, immediate) : document.body.dataset.tab === "search" ? (q, immediate) => searchView.search(q, immediate) : null));
searchView = new SearchView(document.querySelector("#search")!, searchBox);
document.addEventListener("apricity:global-search-submit", (event) => searchView.submitNext((event as CustomEvent<string>).detail));
(window as any).apricity = { player, score, clips, samples, docs }; // handy from the console

// ---- tabs
// Scores, Beats, Chords and Melodies all show the score view, listing that kind of score.
const KIND_OF_TAB = KIND_OF_PAGE as Record<string, ScoreKind>;
const TAB_OF_KIND = PAGE_OF_KIND as Record<ScoreKind, string>;
const TABS = ["home", "about", "how-it-works", "listen", "labs", "sounds", "tags", "search", ...Object.keys(KIND_OF_TAB), "clips", "samples", "docs"];
const tabs = [...document.querySelectorAll<HTMLAnchorElement>(".tabs a")];
const brand = document.querySelector<HTMLAnchorElement>(".brand.link")!;
// Lists load the first time their tab is shown (Clips lists every clip in the library).
const loaded = new Set<string>();
let landing: Landing | null = null;
let howItWorks: HowItWorks | null = null;
let listen: ListenView | null = null;
let labs: LabsView | null = null;
let sounds: SoundClustersView | null = null;
/** The transport's play button follows the page shown (set up below). */
let syncTransport = () => {};
/** Home's view from its URL (?order=recent&mine=1), for the next showTab. */
let homeList = "";
/** The section whose front page (its cards, not an item) the next showTab shows, with its view; null: an item's page. */
let front: { section: Section; list: string } | null = null;
function showTab(name: string) {
  if (!TABS.includes(name)) name = "scores";
  // Leaving a page stops what it was playing: the score, or an audition in Clips or Samples.
  if (document.body.dataset.tab && document.body.dataset.tab !== name) {
    if (player.transport.playing) player.pause();
    clips.silence();
    samples.silence();
    stopFeed(); // a card on Activity or a tag's page
    document.dispatchEvent(new CustomEvent("apricity:page-changed")); // breakdowns fall silent
  }
  document.body.dataset.tab = name;
  // The About page (the landing page: its player, its sounds) is made the first time it's shown, not on every start.
  if (name === "about") landing ??= new Landing(document.querySelector("#about")!, { open: (path) => navigate({ page: "scores", score: path, play: true }) });
  if (name === "how-it-works") howItWorks ??= new HowItWorks(document.querySelector("#how-it-works")!);
  if (name === "listen") listen ??= new ListenView(document.querySelector("#listen")!);
  if (name === "labs") labs ??= new LabsView(document.querySelector("#labs")!);
  const kind = KIND_OF_TAB[name];
  const atFront = !!front && front.section === name;
  const view = atFront ? "section" : kind ? "score" : name;
  for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.tab === name));
  for (const v of document.querySelectorAll<HTMLElement>(".view")) v.hidden = v.dataset.view !== view;
  // The transport plays the score; it has no business on the landing or Docs pages.
  // (Cards on Activity and the tag pages have their own play buttons.)
  document.querySelector<HTMLElement>("#transport")!.hidden = ["docs", "home", "about", "how-it-works", "listen", "labs", "sounds", "tags", "search"].includes(name) || atFront;
  activity.show(name === "home", homeList);
  syncTransport();
  if (atFront) {
    const f = front!;
    void section.show(f.section, f.list);
    return;
  }
  if (kind) score.setKind(kind);
  else if ((name === "clips" || name === "samples") && !loaded.has(name)) {
    loaded.add(name);
    void (name === "clips" ? clips : samples).refresh();
  } else if (name === "clips" || name === "samples") (name === "clips" ? clips : samples).relist(); // stars rated since show
}
// ---- the address bar: every page and item has a URL (route.ts). A click on a tab or the brand goes there; the views
// report what they open (ui/at.ts), and Back and Forward follow the URL.
const pageOfTab = (tab: string): Page => (tab === "docs" ? "help" : (tab as Page));
/** Show what a route names: its tab, and the item on it. The URL is already there. */
async function follow(r: Route) {
  // `showTab` only announces tab changes. Routes can open a detail on the same tab, so semantic
  // work must be invalidated explicitly before any transition as well.
  searchView.cancelSemantic();
  section.cancelSemantic();
  if (r.page !== "sounds") sounds?.dispose();
  // An item named in the URL is opened below; the tab needn't open the top of its list first.
  if (r.sample) loaded.add("samples");
  if (r.clip) loaded.add("clips");
  if (r.page === "clips") clips.setFilterQuery(r.list);
  homeList = r.page === "home" ? (r.list ?? "") : "";
  // A section with no item named: its front page.
  front = SECTIONS.includes(r.page as Section) && !r.score && !r.sample && !r.clip ? { section: r.page as Section, list: r.list ?? "" } : null;
  // The box shows what's searched for here (a section's words, the search page's), and nothing elsewhere.
  searchBox.value = r.page === "search" ? (r.q ?? "") : front ? parseView(front.list).q : "";
  showTab(tabOf(r));
  if (r.score) await openScore(r.score, !!r.play, "route");
  else if (r.sample) await samples.openKey(r.sample, undefined, "route");
  else if (r.clip) await clips.openKey(r.clip.sample, r.clip.name, "route");
  else if (r.help) docs.open(r.help.file, r.help.anchor, "route");
  else if (r.page === "help") docs.report();
  else if (front) document.title = titleOf(r, parseView(front.list).q ? `“${parseView(front.list).q}”` : undefined);
  else if (r.page === "tags") {
    document.title = titleOf(r, r.tag ? `#${r.tag}` : undefined);
    await tagsView.show(r.tag ?? null, r.list);
  }
  else if (r.page === "search") await searchView.show(r.q);
  else if (r.page === "listen") await (listen ??= new ListenView(document.querySelector("#listen")!)).show(r.listenCycle ?? null, !!r.waiting);
  else if (r.page === "labs") await (labs ??= new LabsView(document.querySelector("#labs")!)).show(r.lab ?? null);
  else if (r.page === "sounds") await (sounds ??= new SoundClustersView(document.querySelector("#sounds")!)).show(r);
  else document.title = titleOf(r); // an item's view titles the page with its name
}
/** Go somewhere: a new history entry (or, `replace`, this one), then show it. */
function navigate(r: Route, replace = false) {
  const url = href(r);
  if (url !== location.pathname + location.search + location.hash) history[replace ? "replaceState" : "pushState"](null, "", url);
  void follow(r);
}
window.addEventListener("popstate", () => void follow(parse(location.pathname, location.search, location.hash)));
document.addEventListener("apricity:go", (e) => navigate((e as CustomEvent<Route>).detail));
// A view opened something: the URL and title follow (only for the page on show; a view loading in the background
// doesn't take the address bar).
document.addEventListener("apricity:at", (e) => {
  const { route, how, title } = (e as CustomEvent<At>).detail;
  const shown = document.body.dataset.tab ?? "";
  const same = tabOf(route) === shown || (!!KIND_OF_PAGE[route.page] && !!KIND_OF_TAB[shown]);
  if (!same) return;
  // A section's cards are on show: an item view working behind them (the score view reloading its list after sign-in
  // and opening the first score) doesn't take the address bar, or the page.
  if (front && (route.score || route.sample || route.clip)) return;
  document.title = titleOf(route, title);
  const url = href(route);
  const now = location.pathname + location.search + location.hash;
  if (url === now) return;
  // From the address bar: only correct it (a beat asked for under /scores moves to /beats), keeping ?play off.
  history[how === "user" ? "pushState" : "replaceState"](null, "", url);
});
// Tabs that don't fit fold into a menu that fills the screen.
mountNav(document.querySelector<HTMLElement>(".topbar")!, document.querySelector<HTMLElement>(".tabs")!, (page) => navigate({ page }));
for (const t of tabs)
  t.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // a new tab or window: the link does it
    e.preventDefault();
    navigate({ page: pageOfTab(t.dataset.tab!) });
  });
brand.addEventListener("click", (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate({ page: "home" });
});
/** Open a score in the tab for its kind, and play it once it has compiled; nothing waits forever. */
async function openScore(path: string, play: boolean, how: "user" | "route") {
  await score.open(path, how);
  if (score.path !== path) return; // not found: the status line says why
  const tab = TAB_OF_KIND[await score.kindOf(path)];
  if (document.body.dataset.tab !== tab) {
    showTab(tab);
    history.replaceState(null, "", href({ page: tab as Page, score: path, ...(play ? { play } : {}) }));
  }
  if (!play) return;
  for (let i = 0; i < 100 && !(score.timeline && score.path === path); i++) await new Promise((r) => setTimeout(r, 100));
  if (score.timeline && score.path === path && !player.transport.playing) void togglePlay();
  // Played: drop ?play, so a reload doesn't start it again.
  history.replaceState(null, "", href({ page: tab as Page, score: path }));
}

// An item opened from elsewhere (an Activity card): a score in its tab, a sample in Samples, a clip in Clips.
document.addEventListener("apricity:open-item", async (e) => {
  const { type, id } = (e as CustomEvent<{ type: "score" | "sample" | "clip"; id: string }>).detail;
  if (type === "score") {
    const path = await score.pathOf(id);
    if (path) navigate({ page: "scores", score: path });
    return;
  }
  const tab = type === "clip" ? "clips" : "samples";
  searchView.cancelSemantic();
  section.cancelSemantic();
  loaded.add(tab); // openId loads the list itself
  history.pushState(null, "", `/${tab}`);
  showTab(tab);
  await (type === "clip" ? clips : samples).openId(id, "auto");
});

// Where to start: the URL (at "/", the home page). An address that names no page (an old /activity link) shows the home
// page, and the address bar says so.
const start = parse(location.pathname, location.search, location.hash);
if (start.page === "home" && location.pathname !== "/") history.replaceState(null, "", "/");
void follow(start);

// ---- transport: one play button for every page. On a score's tab it plays the score (waiting for the score to open and
// compile, then the engine, the sounds and the mix, and saying so on the button); on Clips and Samples it plays the
// sample shown (its selection or clip, else all of it).
const bar = document.querySelector<HTMLElement>("#transport")!;
const play = new PlayButton("score", () => void togglePlay(), "space");
const pos = Object.assign(document.createElement("span"), { className: "pos", textContent: "1.1" });
const meta = Object.assign(document.createElement("span"), { className: "meta" });
const pill = Object.assign(document.createElement("span"), { className: "pill", hidden: true, textContent: "change queued" });
const meter = document.createElement("span");
meter.className = "meter";
meter.innerHTML = '<i style="width:0"></i>';
bar.append(pill, meta, pos, meter, play.root);

const libraryOf = (tab = document.body.dataset.tab) => (tab === "clips" ? clips : tab === "samples" ? samples : null);
const libraryState: Record<string, PlayState> = {};
let scoreState: PlayState = { kind: "idle" };
syncTransport = () => {
  const tab = document.body.dataset.tab ?? "";
  const lib = libraryOf(tab);
  bar.dataset.plays = lib ? "sample" : "score";
  play.set(lib ? (libraryState[tab] ?? { kind: "idle" }) : scoreState);
};
const setScore = (s: PlayState) => ((scoreState = s), syncTransport());
clips.onPlay((s) => ((libraryState.clips = s), syncTransport()));
samples.onPlay((s) => ((libraryState.samples = s), syncTransport()));
syncTransport();

async function togglePlay() {
  const lib = libraryOf();
  if (lib) return lib.togglePlay();
  if (player.transport.playing) return player.pause();
  if (scoreState.kind === "loading") return;
  try {
    setScore({ kind: "loading", label: "Getting the score ready" });
    const tl = await score.ready();
    if (!tl) return setScore({ kind: "idle" }); // nothing open, or it doesn't compile: the score's own panel says why
    if (!player.started) setScore({ kind: "loading", label: "Starting the audio engine" });
    await player.init();
    const failed = await score.send(tl, (p) => setScore({ kind: "loading", label: progressLabel(p), ...(p.step === "sounds" ? { done: p.done, total: p.total } : {}) }));
    if (failed) return setScore({ kind: "error", message: failed });
    await player.play();
    setScore({ kind: player.transport.playing ? "playing" : "idle" });
  } catch (e) {
    // Say why on the button; a click tries again (a failed engine or sound is started or fetched afresh).
    setScore({ kind: "error", message: reasonOf(e) });
  }
}

player.onTransport((t: Transport) => {
  if (scoreState.kind !== "loading" && (scoreState.kind === "playing") !== t.playing) setScore({ kind: t.playing ? "playing" : "idle" });
  const beat = t.position / t.framesPerBeat;
  pos.textContent = `${Math.floor(beat / t.beatsPerBar) + 1}.${Math.floor(beat % t.beatsPerBar) + 1}`;
  const tl = score.timeline;
  meta.textContent = tl ? `${tl.tempo} BPM · ${tl.key.replace("b", "♭")}` : "";
  pill.hidden = !t.pending;
  (meter.firstChild as HTMLElement).style.width = `${Math.min(100, t.peak * 100)}%`;
});
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !(e.target as HTMLElement).closest(".cm-editor, input, textarea")) {
    e.preventDefault();
    play.button.click();
  }
});
