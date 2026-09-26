// The landing page: Apricity, the mashup machine — what it does, how, what's in the library, a piece to hear.

import { reportError } from "./notices";
import "./landing.css";
import { api } from "../apricity";
import { el } from "./dom";
import { HERO, breakdown, breakdowns } from "../breakdowns";
import { Breakdown } from "./breakdown/breakdown";

const DEMO = `tempo 100
key F mixolydian

clip tuba  = marine-band/stems/WashingtonPost/bass.wav   pick 1bar
clip horns = marine-band/stems/WashingtonPost/other.wav  pick 1bar

chords I7 IV7 I7 . | IV7 . I7 . | V7 IV7 I7 V7

track tuba   follow
track horns  follow  bars 5-12`;

function highlight(code: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return code
    .split("\n")
    .map((line) => {
      const [head, ...rest] = line.split(" ");
      if (!head) return "";
      const body = esc(rest.join(" "));
      if (head === "chords") return `<span class="t-keyword">chords</span> ${body.replace(/([IV]+7?)/g, '<span class="t-chord">$1</span>')}`;
      return `<span class="t-keyword">${esc(head)}</span> ${body}`;
    })
    .join("\n");
}

export interface LandingActions {
  /** Open a score in the Score tab and play it (a breakdown's "Open in Score"). */
  open(score: string): void;
}

export class Landing {
  root: HTMLElement;
  private canvas = el("canvas", { ariaHidden: "true" });
  private raf = 0;
  private visible = false;

  constructor(root: HTMLElement, go: LandingActions) {
    this.root = root;
    const stats = el("div", { className: "stats" });

    root.append(
      el(
        "div",
        { className: "landing" },
        el(
          "header",
          { className: "hero" },
          this.canvas,
          el(
            "div",
            { className: "hero-inner" },
            el("div", { className: "eyebrow" }, "The social mashup machine"),
            el("h1", { className: "wordmark" }, "Apricity"),
            el("p", {
              className: "tagline",
              innerHTML:
                "A <em>collaborative, social</em> instrument. Make beats, chords and melodies from real recordings, <em>share them</em>, and <em>build on each other’s</em>. Every sound in it is <em>cleared</em>.",
            }),
          ),
          new Breakdown(breakdown(HERO)!, { variant: "hero", open: go.open, remember: true }).root,
        ),
        el(
          "section",
          { className: "band" },
          el("h2", {}, "How it works"),
          el("p", { className: "lede" }, "Apricity hears the beat, key and tuning of every sample, then warps them to one groove and tunes them to your chords, so they play as one. It does the fiddly part of sampling for you."),
          el(
            "div",
            { className: "steps" },
            this.step("1", "Listen", "Each sample is analyzed for its beats, key, tuning and notes. Split a recording into drums, bass and horns, and save the passages you like as clips."),
            this.step("2", "Describe", "Write a score: a tempo, a key, a chord progression, and which clips play when. Say “follow” and a riff moves with every chord, like a blues."),
            this.step("3", "Play", "Every clip is warped onto one grid and transposed to fit each chord. Edit while it loops; your change comes in at the next bar."),
          ),
          el("div", { className: "score" }, el("div", { className: "head" }, el("span", {}, "a 12-bar blues, from an 1889 march"), el("span", {}, ".apr")), el("pre", { innerHTML: highlight(DEMO) })),
        ),
        el(
          "section",
          { className: "band" },
          el("h2", {}, "Made together"),
          el("p", { className: "lede" }, "Everything anyone makes here is public: take it apart, rate it, talk about it, and make it yours."),
          el(
            "div",
            { className: "steps" },
            this.step("♪", "Share", "Your beats, chord progressions, melodies and clips are listed for everyone, ranked by the people who hear them."),
            this.step("★", "Rate and talk", "Rate anything from zero to five stars, and comment on it in threads. The Activity page shows what's happening now."),
            this.step("↻", "Build on it", "Open anyone's score and save your own copy; take someone's clip and make it yours. Every copy says where it came from."),
          ),
        ),
        el(
          "section",
          { className: "band" },
          el("h2", {}, "Every sound is cleared"),
          el("p", { className: "lede" }, "You can use anything you make here, because every sound in Apricity is chosen for it in advance and its paperwork travels with it."),
          el(
            "div",
            { className: "steps" },
            this.step("1", "Curated in advance", "Only public-domain and openly licensed recordings: the Library of Congress’s Citizen DJ collections, the U.S. Marine Band, and openly licensed drum kits. Nothing goes in without its rights known."),
            this.step("2", "Provenance documented", "Every sample says where it came from: the recording, its performer and date, its source, and the license it’s under."),
            this.step("3", "Credits written for you", "Where a license asks for credit, Apricity writes the citation, and every score lists its credits ready to copy, including when a share-alike license applies."),
          ),
        ),
        this.gallery(go),
        el("section", { className: "band" }, el("h2", {}, "In the library"), el("p", { className: "lede" }, "Every sample analyzed, cleared and ready to use."), stats),
        el(
          "section",
          { className: "band credits" },
          el("p", {
            innerHTML:
              'Each sample’s page shows its license and the credit to give. Time-stretching by Rubber Band; analysis by Essentia, Beat This! and Basic Pitch; stems by Demucs. Apricity is free software under the GPL.',
          }),
        ),
      ),
    );
    this.loadStats(stats);
    new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible && !this.raf) this.loop();
    }).observe(this.canvas);
  }

  /** "See how it's made": every other breakdown, one at a time. */
  private gallery(go: LandingActions) {
    const others = breakdowns.filter((b) => b.slug !== HERO);
    if (!others.length) return el("div");
    const picker = el("div", { className: "gallery-picker", role: "tablist" });
    const slot = el("div", { className: "gallery-slot" });
    const shown = new Map<string, HTMLElement>();
    const pick = (slug: string) => {
      for (const b of picker.children) b.classList.toggle("on", (b as HTMLElement).dataset.slug === slug);
      if (!shown.has(slug)) shown.set(slug, new Breakdown(breakdown(slug)!, { variant: "card", open: go.open }).root);
      slot.replaceChildren(shown.get(slug)!);
    };
    for (const b of others) {
      const btn = el("button", { type: "button", role: "tab" }, b.title ?? b.slug!);
      btn.dataset.slug = b.slug!;
      btn.addEventListener("click", () => pick(b.slug!));
      picker.append(btn);
    }
    pick(others[0].slug!);
    return el("section", { className: "band gallery" }, el("h2", {}, "See how it's made"), el("p", { className: "lede" }, "Each piece below is a score, taken apart: its samples, how they were cut, and where they landed. Open the Score tab to read it, or open it in the editor to play with it."), picker, slot);
  }

  private step(n: string, title: string, text: string) {
    return el("div", { className: "step" }, el("div", { className: "n" }, n), el("h3", {}, title), el("p", {}, text));
  }

  private async loadStats(box: HTMLElement) {
    try {
      const { samples } = await api.samples();
      const stems = samples.filter((c) => c.stem).length;
      const minutes = samples.reduce((a, c) => a + c.duration, 0) / 60;
      const big = (value: string, label: string) => el("div", { className: "stat-big" }, el("b", {}, value), el("span", {}, label));
      box.replaceChildren(
        big(String(samples.length - stems), "recordings and excerpts"),
        big(String(stems), "stems separated"),
        big(`${Math.round(minutes)}`, "minutes of music"),
        big(String(new Set(samples.map((c) => c.key)).size), "different keys detected"),
      );
    } catch (e) {
      reportError("load the library's numbers", e);
      box.replaceChildren(el("p", { className: "lede" }, "The library's numbers couldn't be loaded."));
    }
  }

  // ---- hero light: warm rings rising from below; in front of it, the story.
  private loop = () => {
    this.raf = 0;
    if (!this.visible) return;
    this.draw(performance.now() / 1000);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) this.raf = requestAnimationFrame(this.loop);
  };

  private draw(t: number) {
    const c = this.canvas, dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr)) (c.width = Math.round(w * dpr)), (c.height = Math.round(h * dpr));
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.root.querySelector(".landing")!);
    const sun = css.getPropertyValue("--sun").trim(), sun2 = css.getPropertyValue("--sun-2").trim(), ember = css.getPropertyValue("--ember").trim();
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    g.clearRect(0, 0, w, h);

    // The low sun: a warm glow just below the fold.
    const cx = w / 2, cy = h * 1.02;
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
    glow.addColorStop(0, sun2);
    glow.addColorStop(0.18, sun);
    glow.addColorStop(0.45, ember);
    glow.addColorStop(1, "transparent");
    g.globalAlpha = dark ? 0.32 : 0.22;
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);

    // Ripples: rings expanding outward from the sun, fading as they go.
    g.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) {
      const p = (t * 0.035 + i / 9) % 1;
      const r = 60 + p * Math.max(w, h) * 0.95;
      g.globalAlpha = (1 - p) * (dark ? 0.35 : 0.28);
      g.strokeStyle = i % 2 ? sun : sun2;
      g.beginPath();
      g.arc(cx, cy, r, Math.PI, 2 * Math.PI);
      g.stroke();
    }

    g.globalAlpha = 1;
  }
}
