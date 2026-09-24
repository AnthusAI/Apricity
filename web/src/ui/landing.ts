// The landing page: Apricity, the mashup machine — what it does, how, what's in the library, a piece to hear.

import "./landing.css";
import { api } from "../apricity";
import { el } from "./dom";
import heroData from "./flow/hero-data.json";
import type { FlowData } from "./flow/model";
import { readTheme } from "./flow/paint";
import { StorySound } from "./flow/sound";
import { CHAPTERS, LOOP, STILL, Story, chapterAt } from "./flow/story";

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
  library(): void;
  score(): void;
  docs(): void;
  hear(): Promise<void>;
}

export class Landing {
  root: HTMLElement;
  private canvas = el("canvas", { ariaHidden: "true" });
  private raf = 0;
  private visible = false;
  // The hero story: a mashup being made, on its own clock so it can pause and jump.
  private story = new Story(heroData as FlowData);
  private stage = el("canvas", { className: "stage-canvas" });
  private info = el("p", { className: "info" });
  private chapters: HTMLButtonElement[] = [];
  private storyT = 0;
  private stillT = STILL; // with reduced motion: the settled frame of the chosen chapter
  private last = 0;
  private paused = false;
  private shown = { chapter: -1, caption: "" };
  // Sound, off until asked for: then the audio clock drives the story.
  private sound = heroData.audio
    ? new StorySound((heroData as FlowData).audio!, this.story.cues(), LOOP, (heroData.beats * 60) / heroData.tempo)
    : null;
  private soundBtn = el("button", { type: "button", className: "sound" });

  constructor(root: HTMLElement, go: LandingActions) {
    this.root = root;
    const cta = (label: string, cls: string, f: () => void, icon = "") => {
      const b = el("button", { className: `cta ${cls}`, type: "button" }, ...(icon ? [el("span", { className: "icon", ariaHidden: "true" }, icon)] : []), label);
      b.addEventListener("click", f);
      return b;
    };
    const hear = cta("Hear “Chop Shop”", "primary", async () => {
      hear.disabled = true;
      hear.lastChild!.textContent = "Warming up…";
      try {
        await go.hear();
      } finally {
        hear.disabled = false;
        hear.lastChild!.textContent = "Hear “Chop Shop”";
      }
    }, "▶");
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
            el("div", { className: "eyebrow" }, "The mashup machine"),
            el("h1", { className: "wordmark" }, "Apricity"),
            el("p", { className: "tagline", innerHTML: "Intelligent sampling. It <em>hears the beat, key and tuning</em> of every sample, then <em>warps them to one groove</em> and <em>tunes them to your chords</em>, so they play as one." }),
            el("div", { className: "actions" }, hear, cta("Open the library", "ghost", go.library), cta("Write a score", "ghost", go.score), cta("Read the docs", "ghost", go.docs)),
          ),
          this.stageFigure(),
        ),
        el(
          "section",
          { className: "band" },
          el("h2", {}, "How it works"),
          el("p", { className: "lede" }, "Apricity listens to every recording once, then does the fiddly part of a mashup for you: finding the beat, the key and the tuning, and bending each sample to fit the music you describe."),
          el(
            "div",
            { className: "steps" },
            this.step("1", "Listen", "Each sample is analyzed for its beats, key, tuning and notes. Split a recording into drums, bass and horns, and save the passages you like as clips."),
            this.step("2", "Describe", "Write a score: a tempo, a key, a chord progression, and which clips play when. Say “follow” and a riff moves with every chord, like a blues."),
            this.step("3", "Play", "Every clip is warped onto one grid and transposed to fit each chord. Edit while it loops; your change comes in at the next bar."),
          ),
          el("div", { className: "score" }, el("div", { className: "head" }, el("span", {}, "a 12-bar blues, from an 1889 march"), el("span", {}, ".apr")), el("pre", { innerHTML: highlight(DEMO) })),
        ),
        el("section", { className: "band" }, el("h2", {}, "In the library"), el("p", { className: "lede" }, "Every sample analyzed and ready to use: the public-domain collection Apricity ships with, plus anything you drop in."), stats),
        el(
          "section",
          { className: "band credits" },
          el("p", {
            innerHTML:
              'Recordings from the <a href="https://citizen-dj.labs.loc.gov/" target="_blank" rel="noopener">Library of Congress Citizen DJ</a> project and “The President’s Own” <a href="https://www.marineband.marines.mil/Audio-Resources/The-Complete-Marches-of-John-Philip-Sousa/" target="_blank" rel="noopener">United States Marine Band</a>, all in the public domain. Time-stretching by Rubber Band; analysis by Essentia, Beat This! and Basic Pitch; stems by Demucs. Apricity is free software under the GPL.',
          }),
        ),
      ),
    );
    this.loadStats(stats);
    new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      this.sound?.hold(!this.visible);
      if (this.visible && !this.raf) this.loop();
    }).observe(this.canvas);
  }

  private stageFigure() {
    this.stage.setAttribute("role", "img");
    this.stage.setAttribute(
      "aria-label",
      "Animation: two stems of Sousa's The Thunderer are analyzed, cut into clips, sliced onto pads, and placed into a new composition, warped to one tempo and transposed to follow its chords.",
    );
    const nav = el("nav", { className: "chapters", ariaLabel: "Story chapters" });
    this.chapters = CHAPTERS.map((c, i) => {
      const b = el("button", { type: "button" }, c.label);
      b.addEventListener("click", () => {
        this.storyT = c.t;
        this.sound?.on && this.sound.seek(c.t);
        this.stillT = i + 1 < CHAPTERS.length ? CHAPTERS[i + 1].t - 0.5 : STILL;
        this.paused = false;
        this.frame();
      });
      return b;
    });
    nav.append(...this.chapters);
    const steps = el(
      "ol",
      { className: "sr-only" },
      ...[
        "Listen: a recording is analyzed for its beats, tempo, key and tuning.",
        "Clip: you mark the part you want as a clip; the selection snaps to the beat.",
        "Slice: the clip is sliced into equal pieces, one on each pad of a kit.",
        "Warp: a step pattern plays the pads in the composition, stretched to its tempo.",
        "Again: a second recording goes through the same steps.",
        "Tune: its slices are transposed to follow the chords.",
        "Play: the finished piece plays, each sound lit back to where it came from.",
      ].map((t) => el("li", {}, t)),
    );
    this.soundButton(false);
    this.soundBtn.addEventListener("click", () => this.toggleSound());
    const fig = el("figure", { className: "stage" }, this.stage, el("figcaption", {}, ...(this.sound ? [this.soundBtn] : []), this.info, nav), steps);
    // Hovering the picture holds it still, to look closer (not while listening: the music goes on).
    this.stage.addEventListener("pointerenter", (e) => (e.pointerType === "mouse" ? (this.paused = true) : null));
    this.stage.addEventListener("pointerleave", () => (this.paused = false));
    new ResizeObserver(() => this.still() && this.frame()).observe(this.stage);
    return fig;
  }

  private soundButton(on: boolean, loading = false) {
    const icon = on
      ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor"/><path d="M13 7.2a4 4 0 0 1 0 5.6M15.2 5a7 7 0 0 1 0 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor"/><path d="M13.5 8l4 4m0-4l-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    this.soundBtn.innerHTML = `${icon}<span>${loading ? "Loading…" : on ? "Sound on" : "Turn on sound"}</span>`;
    this.soundBtn.setAttribute("aria-pressed", String(on));
    this.soundBtn.classList.toggle("on", on);
    this.soundBtn.disabled = loading;
  }

  private async toggleSound() {
    if (!this.sound) return;
    if (this.sound.on) {
      this.storyT = this.sound.now();
      this.sound.disable();
      this.soundButton(false);
      return;
    }
    this.soundButton(false, true);
    try {
      await this.sound.enable(this.storyT);
      this.paused = false;
      this.soundButton(true);
      if (!this.raf && this.visible) this.loop();
    } catch {
      this.soundButton(false);
    }
  }

  private reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Hold still frames for reduced motion, unless the reader turned the sound on (then it plays). */
  private still = () => this.reduced() && !this.sound?.on;

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
    } catch {
      box.replaceChildren(el("p", { className: "lede" }, "Start the server to see your library."));
    }
  }

  // ---- hero light: warm rings rising from below; in front of it, the story.
  private loop = () => {
    this.raf = 0;
    if (!this.visible) return;
    this.frame();
    if (!this.still()) this.raf = requestAnimationFrame(this.loop);
  };

  private frame() {
    const now = performance.now() / 1000;
    const dt = this.last ? Math.min(0.1, now - this.last) : 0;
    this.last = now;
    if (this.sound?.on) {
      this.storyT = this.sound.now();
    } else if (!this.paused) this.storyT = (this.storyT + dt) % LOOP;
    this.draw(now);
    this.drawStage(this.still() ? this.stillT : this.storyT, this.still());
  }

  private drawStage(t: number, still: boolean) {
    const c = this.stage, dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) (c.width = Math.round(w * dpr)), (c.height = Math.round(h * dpr));
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    this.story.draw(g, w, h, t, readTheme(this.root.querySelector(".landing")!), still);
    const k = chapterAt(t);
    if (k !== this.shown.chapter) {
      this.chapters.forEach((b, i) => b.classList.toggle("on", i === k));
      this.shown.chapter = k;
    }
    const cap = this.story.caption(t);
    const key = cap.title + cap.text;
    if (key !== this.shown.caption) {
      this.info.replaceChildren(el("b", {}, cap.title), " ", cap.text);
      this.shown.caption = key;
    }
  }

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
