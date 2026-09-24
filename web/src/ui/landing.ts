// The landing page: Apricity, the mashup machine — what it does, how, what's in the library, a piece to hear.

import "./landing.css";
import { api } from "../apricity";
import { el } from "./dom";

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

  constructor(root: HTMLElement, go: LandingActions) {
    this.root = root;
    const cta = (label: string, cls: string, f: () => void, icon = "") => {
      const b = el("button", { className: `cta ${cls}`, type: "button" }, ...(icon ? [el("span", { className: "icon", ariaHidden: "true" }, icon)] : []), label);
      b.addEventListener("click", f);
      return b;
    };
    const hear = cta("Hear “March Blues”", "primary", async () => {
      hear.disabled = true;
      hear.lastChild!.textContent = "Warming up…";
      try {
        await go.hear();
      } finally {
        hear.disabled = false;
        hear.lastChild!.textContent = "Hear “March Blues”";
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
            el("p", { className: "tagline", innerHTML: "Intelligent sampling. It <em>hears the beat, key and tuning</em> of every clip, then <em>warps them to one groove</em> and <em>tunes them to your chords</em>, so they play as one." }),
            el("div", { className: "actions" }, hear, cta("Open the library", "ghost", go.library), cta("Write a score", "ghost", go.score), cta("Read the docs", "ghost", go.docs)),
          ),
        ),
        el(
          "section",
          { className: "band" },
          el("h2", {}, "How it works"),
          el("p", { className: "lede" }, "Apricity listens to every recording once, then does the fiddly part of a mashup for you: finding the beat, the key and the tuning, and bending each clip to fit the music you describe."),
          el(
            "div",
            { className: "steps" },
            this.step("1", "Listen", "Each clip is analyzed for its beats, key, tuning and notes. Split a recording into drums, bass and horns, and mark the passages you like."),
            this.step("2", "Describe", "Write a score: a tempo, a key, a chord progression, and which clips play when. Say “follow” and a riff moves with every chord, like a blues."),
            this.step("3", "Play", "Every clip is warped onto one grid and transposed to fit each chord. Edit while it loops; your change comes in at the next bar."),
          ),
          el("div", { className: "score" }, el("div", { className: "head" }, el("span", {}, "a 12-bar blues, from an 1889 march"), el("span", {}, ".apr")), el("pre", { innerHTML: highlight(DEMO) })),
        ),
        el("section", { className: "band" }, el("h2", {}, "In the library"), el("p", { className: "lede" }, "Every clip analyzed and ready to sample: the public-domain collection Apricity ships with, plus anything you drop in."), stats),
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
      if (this.visible && !this.raf) this.loop();
    }).observe(this.canvas);
  }

  private step(n: string, title: string, text: string) {
    return el("div", { className: "step" }, el("div", { className: "n" }, n), el("h3", {}, title), el("p", {}, text));
  }

  private async loadStats(box: HTMLElement) {
    try {
      const { clips } = await api.clips();
      const stems = clips.filter((c: any) => c.stem).length;
      const minutes = clips.reduce((a, c) => a + c.duration, 0) / 60;
      const big = (value: string, label: string) => el("div", { className: "stat-big" }, el("b", {}, value), el("span", {}, label));
      box.replaceChildren(
        big(String(clips.length - stems), "recordings and excerpts"),
        big(String(stems), "stems separated"),
        big(`${Math.round(minutes)}`, "minutes of music"),
        big(String(new Set(clips.map((c) => c.key)).size), "different keys detected"),
      );
    } catch {
      box.replaceChildren(el("p", { className: "lede" }, "Start the server to see your library."));
    }
  }

  // ---- hero light: warm rings rising from below, and a slow waveform drifting through.
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

    // A waveform drifting across: a march, heard from far away.
    const y0 = h * 0.8;
    g.globalAlpha = dark ? 0.55 : 0.45;
    g.strokeStyle = sun;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const u = x / w;
      const env = Math.sin(Math.PI * u) ** 1.5;
      const beat = 0.55 + 0.45 * Math.abs(Math.sin((u * 16 + t * 0.9) * Math.PI));
      const y = y0 + env * beat * 26 * Math.sin(u * 90 + t * 2.1) * Math.sin(u * 7 - t * 0.6);
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
    g.globalAlpha = 1;
  }
}
