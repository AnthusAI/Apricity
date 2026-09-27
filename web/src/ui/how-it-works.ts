// The "How it works" page: every way Apricity uses machine learning and audio analysis, and where the line is —
// nothing here generates sound. Every claim links the file that backs it, so it stays honest as the code changes.

import "./how-it-works.css";
import { el } from "./dom";

interface Section {
  title: string;
  body: HTMLElement[]; // already-built block elements (paragraphs, lists) — see p()/list()/inProgress() below
  cites: string[];
}

const LOOP = ["Record", "Analyze", "Fit", "Check", "Propose", "People rate", "Calibrate"];

function code(text: string) {
  return el("code", {}, text);
}
function b(text: string) {
  return el("strong", {}, text);
}
/** A paragraph from a mix of plain text and inline elements. */
function p(...parts: (string | HTMLElement)[]) {
  return el("p", {}, ...parts);
}
function list(items: (string | HTMLElement)[][]) {
  return el("ul", {}, ...items.map((parts) => el("li", {}, ...parts)));
}
/** A callout paragraph for work that isn't built yet. */
function inProgress(...parts: (string | HTMLElement)[]) {
  return el("p", { className: "status-line" }, el("span", { className: "badge" }, "in progress"), " ", ...parts);
}

const SECTIONS: Section[] = [
  {
    title: "It listens to every recording",
    body: [
      p("Before a sample can be used, it is analyzed once and the result is saved next to the audio as a manifest (a ", code(".apricity.json"), " file). The analysis finds:"),
      list([
        [b("Beats and downbeats"), " — tracked with ", code("beat_this"), "."],
        [b("Tempo, key, tuning and chroma"), " — Essentia estimates the tempo and a chroma/HPCP profile; tuning is cross-checked against a second, independent estimator and only trusted when the two agree, otherwise the clip is left untuned rather than guessed at."],
        [b("Note transcription"), " — ", code("basic-pitch"), " finds the pitched notes in a clip, so a horn hit can be replayed at any pitch it's asked for."],
        [b("Loudness"), " — every clip is measured so tracks can be level-matched before their own volume."],
        [b("Stems"), " — some recordings are split into drums, bass, other and vocals with Demucs; a stem reuses its parent's beat grid rather than tracking beats on an isolated bass line, which is unreliable."],
        [b("Denoising"), " — an optional neural cleanup pass writes a sibling file and never touches the original recording; analysis then runs on the clean copy."],
      ]),
    ],
    cites: ["analysis/apricity_analyze/analyze.py", "analysis/apricity_analyze/loudness.py", "analysis/apricity_analyze/stems.py", "analysis/apricity_analyze/denoise.py", "samples/**/*.apricity.json"],
  },
  {
    title: "It marks up what it hears",
    body: [
      p("A second pass finds the structure inside a recording, beat-synchronously so everything lands on the grid:"),
      list([
        [b("Sections"), " — a self-similarity matrix over per-beat chroma and timbre, with boundaries at the peaks of a novelty curve; repeated strains are labelled with the same letter."],
        [b("Loops"), " — 4-, 8- and 16-beat windows scored for self-repetition, a steady beat, static harmony and level."],
        [b("Transients and one-shots"), " — onset peaks well above their surroundings, each saved as a playable hit."],
        [b("Holds"), " — sustained notes or chords, from attack to release, for pads, bass and melodies."],
        [b("Phrases"), " — the gaps between pauses, found without a beat grid, so speech and free-time material get them too."],
      ]),
      p("Machine-found markup is tagged as such and never overwrites anything a person named by hand."),
    ],
    cites: ["analysis/apricity_analyze/markup.py", "docs/concepts.md", "docs/language.md"],
  },
  {
    title: "It fits real clips to your score",
    body: [
      p("A score names clips, a tempo, a key and a chord progression; the compiler works out how to make the real recordings play it:"),
      list([
        [b("Time-stretch and warp"), " — each clip is warped onto the score's grid (or, in ", code("warp repitch"), " mode, played back at a changed speed like a record) using a vendored build of Rubber Band."],
        [b("The harmony solver"), " — chooses a transposition per chord for every harmonic track, so a track marked ", code("follow"), " moves its root onto each chord as it changes."],
        [b("Retuning"), " — every clip is detuned to A440 first, using its own measured tuning, before any of that, so recordings from different eras and pitch standards don't beat against each other."],
      ]),
    ],
    cites: ["crates/apricity-score/src/compile.rs", "crates/apricity-theory/src/harmony.rs", "crates/apricity-score/src/assist.rs", "crates/apricity-dsp", "docs/concepts.md"],
  },
  {
    title: "It checks the harmony",
    body: [
      p(
        "A render can be checked automatically: each stem's chroma is measured on the score's own beat grid, and an interval-clash measure scores how much concurrently-sounding stems clash, weighted by loudness and tonalness (so a hi-hat's noise doesn't count as much as a held pad); a bass stem's minor/major 2nds and major 7ths are counted doubly harsh, since those are the clashes a bass note makes worst. The result is a single 0–100 objective — with guards that penalize ways the objective could be gamed, such as muting a clashing stem, thinning the mix, or collapsing everything onto one part.",
      ),
    ],
    cites: ["analysis/apricity_analyze/check.py", "scripts/check-stems.py"],
  },
  {
    title: "It explores the library for you",
    body: [
      p(
        "An explorer auditions real clips from the library as hypotheses for a score, never generating one: it tries a person's own rated loops first, then loop and section clips cut from ccMixter recordings in a matching tempo range, filtered so only clips that can legally be sampled are offered. A two-level search — successive halving across candidate “casts”, refined by coordinate descent over the moves the checker's own findings suggest — narrows this down to a few finalists.",
      ),
      inProgress("a larger, stochastic mash-up optimizer is being built on top of this: it will search region, warp, transposition, role and processing together, score candidates without rendering every one, and hand a few diverse finalists to a listening cycle."),
    ],
    cites: ["analysis/apricity_analyze/explore/", "scripts/explore.py"],
  },
  {
    title: "People rate, blind — and the machine learns where it's wrong",
    body: [
      p(
        "The explorer's finalists, plus the current version as one more option, are published as a blind round: each is a forked candidate score, and the letters are shuffled so the person rating doesn't know which one is which. They rate the options in the web app (or locally); the verdict is read back, mapped through the round's own record to find out which candidate actually won, and logged next to what the checker predicted. That log is how the machine's scoring is checked against human ears: so far the checker is good at harmony faults and blind to style.",
      ),
      inProgress("using those verdicts to tune the optimizer's scoring automatically, once there are enough of them to trust."),
    ],
    cites: ["analysis/apricity_analyze/cycle.py", "web/amplify/data/resource.ts (ListeningCycle, CycleVerdict, Rating)"],
  },
  {
    title: "Timbre and genre fit",
    body: [
      inProgress(
        "today's checker measures pitch and rhythm, not timbre or genre — a distorted guitar and a flute playing the same notes can score alike. Work under way adds CLAP audio embeddings for every saved clip and region window, so a text prompt like “smooth deep-house pad” or “brass band” can rank how well a candidate actually fits the sound the score is going for, not just its notes.",
      ),
    ],
    cites: [],
  },
  {
    title: "The score is the shared language",
    body: [
      p(
        "None of this replaces the score. A score is a plain text file — a tempo, a key, a chord progression, which clips play when — the same format whether a person opens it in an editor or an agent writes it. Every step above reads or proposes changes to that one file, so any of it can be inspected, diffed, and handed back to a person to edit, same as the notes.",
      ),
    ],
    cites: ["docs/language.md", "docs/concepts.md"],
  },
];

export class HowItWorks {
  root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    root.append(
      el(
        "div",
        { className: "how-it-works docs-page" },
        el(
          "header",
          { className: "intro" },
          el("div", { className: "eyebrow" }, "How it works"),
          el("h1", {}, "Every sound here is a real recording"),
          p(
            "Apricity uses machine learning and audio analysis at almost every step — but never to generate sound. Nothing here is a music-generation model. The machines listen, measure, fit and propose; people curate, rate and decide. What follows is how, with the code that does it.",
          ),
        ),
        this.loop(),
        ...SECTIONS.map((s) => this.section(s)),
      ),
    );
  }

  private loop() {
    const nodes = LOOP.flatMap((step, i) => (i === 0 ? [el("span", { className: "node" }, step)] : [el("span", { className: "arrow", ariaHidden: "true" }, "→"), el("span", { className: "node" }, step)]));
    return el("div", { className: "loop", role: "img", ariaLabel: `The loop: ${LOOP.join(" then ")}, and back around.` }, ...nodes);
  }

  private section(s: Section) {
    return el("section", { className: "section" }, el("h2", {}, s.title), ...s.body, ...(s.cites.length ? [el("p", { className: "cite" }, "In the code: ", ...s.cites.flatMap((c, i) => (i === 0 ? [code(c)] : [", ", code(c)])))] : []));
  }
}
