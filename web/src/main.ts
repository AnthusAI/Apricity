import "./style.css";
import { player, type Transport } from "./audio/player";
import { Library } from "./ui/library";
import { ScoreView } from "./ui/score";
import { DocsView } from "./ui/docs";
import { Landing } from "./ui/landing";
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
(window as any).apricity = { player, score, clips, samples, docs }; // handy from the console

// ---- tabs (remembered per browser)
// Scores, Beats, Chords and Melodies all show the score view, listing that kind of score.
const KIND_OF_TAB: Record<string, ScoreKind> = { scores: "song", beats: "beat", chords: "chords", melodies: "melody" };
const TAB_OF_KIND: Record<ScoreKind, string> = { song: "scores", beat: "beats", chords: "chords", melody: "melodies" };
const TABS = ["home", ...Object.keys(KIND_OF_TAB), "clips", "samples", "docs"];
const tabs = [...document.querySelectorAll<HTMLButtonElement>(".tabs button")];
const brand = document.querySelector<HTMLButtonElement>(".brand.link")!;
// Lists load the first time their tab is shown (Clips lists every clip in the library).
const loaded = new Set<string>();
function showTab(name: string) {
  if (!TABS.includes(name)) name = "scores";
  const kind = KIND_OF_TAB[name];
  const view = kind ? "score" : name;
  for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.tab === name));
  for (const v of document.querySelectorAll<HTMLElement>(".view")) v.hidden = v.dataset.view !== view;
  // The transport plays the score; it has no business on the landing or Docs pages.
  document.querySelector<HTMLElement>("#transport")!.hidden = name === "docs" || name === "home";
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
let initial: string | null = null;
try {
  initial = localStorage.getItem("apricity.tab");
} catch {}
if (!initial) initial = (await currentAccount().catch(() => null)) ? "scores" : "home";

// Signing in takes you to the top scores of the week.
let wasSignedIn = !!(await currentAccount().catch(() => null));
document.addEventListener("apricity:auth-changed", async () => {
  const now = !!(await currentAccount().catch(() => null));
  if (now && !wasSignedIn) (score.topOfWeek(), showTab("scores"));
  wasSignedIn = now;
});

/** Open a score in the tab for its kind, and play it once it has compiled; nothing waits forever. */
async function openScore(path: string, play: boolean) {
  await score.open(path);
  if (score.path !== path) return; // not found: the status line says why
  showTab(TAB_OF_KIND[await score.kindOf(path)]);
  if (!play) return;
  for (let i = 0; i < 100 && !(score.timeline && score.path === path); i++) await new Promise((r) => setTimeout(r, 100));
  if (score.timeline && score.path === path && !player.transport.playing) playBtn.click();
}

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
  library: () => showTab("samples"),
  score: () => showTab("scores"),
  docs: () => showTab("docs"),
  hear: () => openScore("examples/chop-shop.apr", true),
  open: (path) => (location.hash = routeFor(path, true)),
});
showTab(initial);
void followRoute();

// The score editor's "Reference" button opens the language docs.
document.addEventListener("apricity:docs", (e) => {
  const { file, anchor } = (e as CustomEvent<{ file: string; anchor?: string }>).detail;
  showTab("docs");
  docs.open(file, anchor);
});

// ---- transport: plays the score open in the Score tab
const bar = document.querySelector("#transport")!;
const playBtn = Object.assign(document.createElement("button"), { className: "play", type: "button", ariaLabel: "Play score", innerHTML: "▶" });
const pos = Object.assign(document.createElement("span"), { className: "pos", textContent: "1.1" });
const meta = Object.assign(document.createElement("span"), { className: "meta" });
const pill = Object.assign(document.createElement("span"), { className: "pill", hidden: true, textContent: "change queued" });
const meter = document.createElement("span");
meter.className = "meter";
meter.innerHTML = '<i style="width:0"></i>';
bar.append(pill, meta, pos, meter, playBtn);

playBtn.addEventListener("click", async () => {
  if (player.transport.playing) return player.pause();
  if (!score.timeline) {
    showTab(TAB_OF_KIND[score.kind]);
    return;
  }
  playBtn.disabled = true;
  try {
    await player.init();
    await score.send(); // renders the current score; starts immediately (nothing is playing yet)
    await player.play();
  } finally {
    playBtn.disabled = false;
  }
});

player.onTransport((t: Transport) => {
  playBtn.innerHTML = t.playing ? "■" : "▶";
  playBtn.ariaLabel = t.playing ? "Stop" : "Play score";
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
    playBtn.click();
  }
});
