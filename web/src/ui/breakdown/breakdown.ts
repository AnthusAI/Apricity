// A breakdown: the animated story of how a score was made (sources analyzed, clipped, sliced, placed
// into the composition, warped and tuned), with its sound, the score's code a tab away, where every
// sound comes from, and a way into the Score tab. Every breakdown is a bundle baked from a score by
// scripts/breakdown.py (web/src/breakdowns/<slug>.json); the landing hero is one of them.

import "./breakdown.css";
import { highlightApr } from "../apr-highlight";
import { el } from "../dom";
import type { FlowData, FlowRecording } from "../flow/model";
import { readTheme } from "../flow/paint";
import { rememberSound, soundRemembered, soundView, stateAfterProbe, type SoundState } from "../flow/hero-audio";
import { soundStatus, StorySound } from "../flow/sound";
import { Story, shortName } from "../flow/story";

export interface BreakdownOptions {
  /** "hero": the landing page's own; "card": one of many (a gallery, a docs page). */
  variant?: "hero" | "card";
  /** Open the score in the Score tab (and play it). */
  open?: (score: string) => void;
  /** Remember "sound on" across reloads (the hero does). */
  remember?: boolean;
}

/** Only one breakdown makes sound at a time. */
let playing: Breakdown | null = null;

export class Breakdown {
  root: HTMLElement;
  readonly story: Story;
  private stage = el("canvas", { className: "stage-canvas" });
  private info = el("p", { className: "info" });
  private chapterButtons: HTMLButtonElement[] = [];
  private storyT = 0;
  private stillT: number;
  private last = 0;
  private paused = false;
  private visible = false;
  private raf = 0;
  private shown = { chapter: -1, caption: "" };
  private sound: StorySound | null;
  private soundBtn = el("button", { type: "button", className: "sound" });
  private metronomeBox = el("input", { type: "checkbox", checked: true });
  private soundState: SoundState = "checking";
  private tab: "story" | "code" = "story";

  constructor(
    readonly data: FlowData,
    private opts: BreakdownOptions = {},
  ) {
    this.story = new Story(data);
    this.stillT = this.story.still;
    this.sound = data.audio ? new StorySound(data.audio, this.story.cues(), this.story.loop, (data.beats * 60) / data.tempo, this.story.metronome()) : null;
    this.root = this.build();
    void this.probeSound();
    new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      this.sound?.hold(!this.visible);
      if (this.visible && !this.raf) this.loop();
    }).observe(this.stage);
  }

  // ---- building

  private build() {
    const d = this.data;
    const variant = this.opts.variant ?? "card";
    this.stage.setAttribute("role", "img");
    this.stage.setAttribute("aria-label", `Animation: how ${d.title ?? "the piece"} was made. ${this.story.chapters.map((c) => c.label).join(", ")}.`);

    const nav = el("nav", { className: "chapters", ariaLabel: "Story chapters" });
    this.chapterButtons = this.story.chapters.map((c, i) => {
      const b = el("button", { type: "button" }, c.label);
      b.addEventListener("click", () => {
        this.show("story");
        this.storyT = c.t;
        this.sound?.on && this.sound.seek(c.t);
        this.stillT = i + 1 < this.story.chapters.length ? this.story.chapters[i + 1].t - 0.5 : this.story.still;
        this.paused = false;
        this.frame();
      });
      return b;
    });
    nav.append(...this.chapterButtons);

    this.soundButton("checking");
    this.soundBtn.addEventListener("click", () => this.toggleSound());
    this.metronomeBox.addEventListener("change", () => this.sound && (this.sound.clicks = this.metronomeBox.checked));
    const hasKit = d.sources.some((s) => s.kind === "kit");
    const metronome = el("label", { className: "metronome", title: hasKit ? "Click the beat until the drums come in" : "Click the beat" }, this.metronomeBox, "Metronome");

    // Tabs: the story, or the score that made it.
    const tabs = el("div", { className: "bd-tabs", role: "tablist" });
    const tabStory = el("button", { type: "button", role: "tab", className: "on" }, "Breakdown");
    const tabCode = el("button", { type: "button", role: "tab" }, "Score");
    tabStory.addEventListener("click", () => this.show("story"));
    tabCode.addEventListener("click", () => this.show("code"));
    tabs.append(tabStory, tabCode);
    const head = el("div", { className: "bd-head" }, tabs);
    if (variant === "card" && d.title) head.prepend(el("div", { className: "bd-title" }, el("b", {}, d.title)));
    if (this.opts.open) {
      const open = el("button", { type: "button", className: "bd-open" }, `Open “${d.title ?? d.score}” in Score`);
      open.addEventListener("click", () => this.opts.open!(d.score));
      head.append(open);
    }
    const code = el("pre", { className: "bd-code", hidden: true, innerHTML: highlightApr(d.code ?? "") });
    code.setAttribute("aria-label", `The score: ${d.score}`);

    const steps = el("ol", { className: "sr-only" }, ...this.story.chapters.map((c) => el("li", {}, c.label)));
    const fig = el(
      "figure",
      { className: `breakdown stage bd-${variant}` },
      head,
      this.stage,
      code,
      el("figcaption", {}, ...(this.sound ? [el("div", { className: "sound-controls" }, this.soundBtn, metronome)] : []), this.info, nav),
      ...(variant === "card" && d.blurb ? [el("p", { className: "bd-blurb" }, d.blurb)] : []),
      this.provenance(),
      steps,
    );
    // More sources need more room (the stage and the code pane alike).
    fig.style.setProperty("--stage-h", `${380 + Math.max(0, d.sources.length - 2) * 44}px`);
    // Hovering the picture holds it still, to look closer (not while listening: the music goes on).
    this.stage.addEventListener("pointerenter", (e) => (e.pointerType === "mouse" ? (this.paused = true) : null));
    this.stage.addEventListener("pointerleave", () => (this.paused = false));
    new ResizeObserver(() => this.still() && this.frame()).observe(this.stage);
    (fig as HTMLElement & { tabs: HTMLButtonElement[] }).tabs = [tabStory, tabCode];
    return fig;
  }

  private show(tab: "story" | "code") {
    this.tab = tab;
    const [s, c] = (this.root as HTMLElement & { tabs: HTMLButtonElement[] }).tabs;
    s.classList.toggle("on", tab === "story");
    c.classList.toggle("on", tab === "code");
    s.setAttribute("aria-selected", String(tab === "story"));
    c.setAttribute("aria-selected", String(tab === "code"));
    this.stage.hidden = tab !== "story";
    (this.root.querySelector(".bd-code") as HTMLElement).hidden = tab !== "code";
  }

  /** Where the sounds come from, from the library's records: every sample carries its provenance. */
  private provenance() {
    const box = el("div", { className: "provenance" }, el("h3", {}, "Where these sounds come from"));
    for (const p of this.data.provenance ?? []) {
      const line = el("p", {}, el("b", {}, `${shortName(p.title)}:`), " ");
      const what = p.kind === "kit" ? "Single hits, one per pad, from " : p.kind === "loop" ? "Sliced from " : "A clip of ";
      line.append(what);
      p.recordings.forEach((r, i) => {
        if (i) line.append(i === p.recordings.length - 1 ? " and " : ", ");
        line.append(...recordingText(r));
      });
      line.append(".");
      const rights = [...new Set(p.recordings.map((r) => r.rights).filter(Boolean))];
      if (rights.length) line.append(" ", rights.join(" "));
      box.append(line);
    }
    return box;
  }

  // ---- sound

  private async probeSound() {
    if (!this.sound) return;
    const state = stateAfterProbe(await soundStatus(this.data.audio!));
    this.soundButton(state);
    if (state === "ready" && this.opts.remember && soundRemembered()) this.resumeRemembered();
  }

  /** Sound was on before a reload: start it now if the browser allows sound without a click, else on
   *  the first click or key press anywhere on the page. */
  private resumeRemembered() {
    const policy = (navigator as Navigator & { getAutoplayPolicy?: (type: string) => string }).getAutoplayPolicy?.("audiocontext");
    if (policy === "allowed") {
      void this.toggleSound();
      return;
    }
    this.soundButton("armed");
    const start = () => {
      document.removeEventListener("click", start, true);
      document.removeEventListener("keydown", start, true);
      if (this.soundState === "armed") void this.toggleSound();
    };
    document.addEventListener("click", start, true);
    document.addEventListener("keydown", start, true);
  }

  private soundButton(state: SoundState) {
    this.soundState = state;
    const on = state === "on";
    const v = soundView(state);
    const icon = on
      ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor"/><path d="M13 7.2a4 4 0 0 1 0 5.6M15.2 5a7 7 0 0 1 0 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor"/><path d="M13.5 8l4 4m0-4l-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    this.soundBtn.innerHTML = `${icon}<span>${v.label}</span>`;
    this.soundBtn.setAttribute("aria-pressed", String(v.pressed));
    this.soundBtn.title = v.hint;
    this.soundBtn.setAttribute("aria-label", v.hint);
    this.soundBtn.classList.toggle("on", on);
    this.soundBtn.disabled = v.disabled;
  }

  /** Turn this breakdown's sound off (another one is starting). */
  silence() {
    if (!this.sound?.on) return;
    this.storyT = this.sound.now();
    this.sound.disable();
    this.soundButton("ready");
  }

  private async toggleSound() {
    if (!this.sound || this.soundState === "missing" || this.soundState === "checking" || this.soundState === "loading") return;
    if (this.sound.on) {
      this.silence();
      if (this.opts.remember) rememberSound(false);
      return;
    }
    if (playing && playing !== this) playing.silence();
    playing = this;
    this.soundButton("loading");
    try {
      await this.sound.enable(this.storyT);
      this.paused = false;
      this.soundButton("on");
      if (this.opts.remember) rememberSound(true);
      if (!this.raf && this.visible) this.loop();
    } catch {
      // The library answered the probe but the sound could not be played: silent, and says so.
      this.soundButton("missing");
    }
  }

  // ---- drawing

  private reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Hold still frames for reduced motion, unless the reader turned the sound on (then it plays). */
  private still = () => this.reduced() && !this.sound?.on;

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
    if (this.sound?.on) this.storyT = this.sound.now();
    else if (!this.paused) this.storyT = (this.storyT + dt) % this.story.loop;
    this.draw(this.still() ? this.stillT : this.storyT, this.still());
  }

  private draw(t: number, still: boolean) {
    if (this.tab !== "story") return;
    const c = this.stage, dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) (c.width = Math.round(w * dpr)), (c.height = Math.round(h * dpr));
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    this.story.draw(g, w, h, t, readTheme(this.root), still);
    const k = this.story.chapterAt(t);
    if (k !== this.shown.chapter) {
      this.chapterButtons.forEach((b, i) => b.classList.toggle("on", i === k));
      this.shown.chapter = k;
    }
    const cap = this.story.caption(t);
    const key = cap.title + cap.text;
    if (key !== this.shown.caption) {
      this.info.replaceChildren(el("b", {}, cap.title), " ", cap.text);
      this.shown.caption = key;
    }
  }
}

/** “The Thunderer” (composed 1889), recorded in 2017 by …, as text and a link. */
function recordingText(r: FlowRecording): (Node | string)[] {
  const name = `“${r.title}”`;
  const title = r.source_page ? el("a", { href: r.source_page, target: "_blank", rel: "noopener" }, name) : name;
  const bits: string[] = [];
  const parts = r.parts?.length ? r.parts : r.part ? [r.part] : [];
  if (parts.length) bits.push(`the ${parts.join(" and ")} split out of the full recording`);
  if (r.composed) bits.push(`composed in ${r.composed}`);
  if (r.recorded) bits.push(`recorded in ${r.recorded}${r.performer ? ` by ${r.performer}` : ""}`);
  else if (r.performer) bits.push(`by ${r.performer}`);
  else if (r.credit) bits.push(r.credit.replace(/\.$/, ""));
  return [title, bits.length ? ` (${bits.join("; ")})` : ""];
}
