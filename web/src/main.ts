import "./style.css";
import { player, progressLabel, type Transport } from "./audio/player";
import { PlayButton, type PlayState } from "./ui/play-button";
import { Library } from "./ui/library";
import { ScoreView } from "./ui/score";
import { DocsView } from "./ui/docs";
import { Landing } from "./ui/landing";
import { ActivityView } from "./ui/activity";
import { bootstrap, mode } from "./data/client";
import { watchAuth } from "./data/auth";
import { AccountControl, realDeps } from "./ui/account";
import { currentAccount } from "./data/auth";
import type { ScoreKind } from "./data/catalog";
import { parseRoute, routeFor } from "./route";

// Configure the data layer first: /amplify_outputs.json says whether files come from `apricity serve` or the bucket.
// A deploy renames every built file. A tab opened before the deploy then fails to load its lazy chunks (sign-out, storage)
// with a 404: reload once to pick up the new build instead of leaving a dead page.
window.addEventListener("vite:preloadError", (e) => {
  e.preventDefault();
  try {
    const last = Number(sessionStorage.getItem("apricity.reloadedAt") ?? "0");
    if (Date.now() - last < 30_000) return; // already tried a moment ago: do not loop
    sessionStorage.setItem("apricity.reloadedAt", String(Date.now()));
  } catch {}
  location.reload();
});

// Listen before configure: Amplify exchanges a Google redirect code asynchronously. Nothing waits for it: the views render
// at once and reload when watchAuth announces the session (apricity:auth-changed), so the page is never blank.
void watchAuth();
await bootstrap();

// Sign in / out lives in the bottom-left pill; it only appears against the cloud backend.
new AccountControl(document.querySelector<HTMLElement>("#account")!, realDeps(() => mode() === "cloud"));

const score = new ScoreView(document.querySelector("#score")!);
const clips = new Library(document.querySelector("#clips")!, "clips");
const samples = new Library(document.querySelector("#samples")!, "samples");
const docs = new DocsView(document.querySelector("#docs")!);
const activity = new ActivityView(document.querySelector("#activity")!);
(window as any).apricity = { player, score, clips, samples, docs }; // handy from the console

// ---- tabs (remembered per browser)
// Scores, Beats, Chords and Melodies all show the score view, listing that kind of score.
const KIND_OF_TAB: Record<string, ScoreKind> = { scores: "song", beats: "beat", chords: "chords", melodies: "melody" };
const TAB_OF_KIND: Record<ScoreKind, string> = { song: "scores", beat: "beats", chords: "chords", melody: "melodies" };
const TABS = ["home", "activity", ...Object.keys(KIND_OF_TAB), "clips", "samples", "docs"];
const tabs = [...document.querySelectorAll<HTMLButtonElement>(".tabs button")];
const brand = document.querySelector<HTMLButtonElement>(".brand.link")!;
// Lists load the first time their tab is shown (Clips lists every clip in the library).
const loaded = new Set<string>();
/** The transport's play button follows the page shown (set up below). */
let syncTransport = () => {};
function showTab(name: string) {
  if (!TABS.includes(name)) name = "scores";
  // Leaving a page stops what it was playing: the score, or an audition in Clips or Samples.
  if (document.body.dataset.tab && document.body.dataset.tab !== name) {
    if (player.transport.playing) player.pause();
    clips.silence();
    samples.silence();
    document.dispatchEvent(new CustomEvent("apricity:page-changed")); // breakdowns fall silent
  }
  document.body.dataset.tab = name;
  const kind = KIND_OF_TAB[name];
  const view = kind ? "score" : name;
  for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.tab === name));
  for (const v of document.querySelectorAll<HTMLElement>(".view")) v.hidden = v.dataset.view !== view;
  // The transport plays the score; it has no business on the landing or Docs pages.
  document.querySelector<HTMLElement>("#transport")!.hidden = name === "docs" || name === "home" || name === "activity";
  activity.show(name === "activity");
  syncTransport();
  if (kind) score.setKind(kind);
  else if ((name === "clips" || name === "samples") && !loaded.has(name)) {
    loaded.add(name);
    void (name === "clips" ? clips : samples).refresh();
  }
  try {
    localStorage.setItem("apricity.tab", name);
  } catch {}
}
tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab!)));
brand.addEventListener("click", () => showTab("home"));
// First visit: the landing page (signed in: the top scores of the week). After that, wherever you were.
let saved: string | null = null;
try {
  saved = localStorage.getItem("apricity.tab");
} catch {}
const initial = saved ?? "home";

// Signing in takes you to Activity. Nothing here is awaited at the top level: the auth code is a
// lazily loaded chunk that imports from this one, so awaiting it while this module is still evaluating deadlocks.
let wasSignedIn = false;
void currentAccount()
  .catch(() => null)
  .then((a) => {
    wasSignedIn = !!a;
    if (a && !saved) showTab("activity");
  });
document.addEventListener("apricity:auth-changed", async () => {
  const now = !!(await currentAccount().catch(() => null));
  if (now && !wasSignedIn) showTab("activity");
  wasSignedIn = now;
});

/** Open a score in the tab for its kind, and play it once it has compiled; nothing waits forever. */
async function openScore(path: string, play: boolean) {
  await score.open(path);
  if (score.path !== path) return; // not found: the status line says why
  showTab(TAB_OF_KIND[await score.kindOf(path)]);
  if (!play) return;
  for (let i = 0; i < 100 && !(score.timeline && score.path === path); i++) await new Promise((r) => setTimeout(r, 100));
  if (score.timeline && score.path === path && !player.transport.playing) void togglePlay();
}

// An item opened from elsewhere (an Activity card): a score in its tab, a sample in Samples, a clip in Clips.
document.addEventListener("apricity:open-item", async (e) => {
  const { type, id } = (e as CustomEvent<{ type: "score" | "sample" | "clip"; id: string }>).detail;
  if (type === "score") {
    const path = await score.pathOf(id);
    if (path) await openScore(path, false);
    return;
  }
  const tab = type === "clip" ? "clips" : "samples";
  loaded.add(tab); // openId loads the list itself
  showTab(tab);
  await (type === "clip" ? clips : samples).openId(id);
});

// Deep links: #score=<path>[&play] (a breakdown's "Open in Score", or a shared link).
async function followRoute() {
  const r = parseRoute(location.hash);
  if (!r.score) return;
  await openScore(r.score, r.play);
  // The link has done its job: drop it, so a reload doesn't reopen (and replay) the score.
  history.replaceState(null, "", location.pathname + location.search);
}
window.addEventListener("hashchange", () => void followRoute());

new Landing(document.querySelector("#home")!, {
  open: (path) => (location.hash = routeFor(path, true)),
});
showTab(initial);
void followRoute();


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
    await score.send(tl, (p) => setScore({ kind: "loading", label: progressLabel(p), ...(p.step === "sounds" ? { done: p.done, total: p.total } : {}) }));
    await player.play();
  } finally {
    setScore({ kind: player.transport.playing ? "playing" : "idle" });
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
