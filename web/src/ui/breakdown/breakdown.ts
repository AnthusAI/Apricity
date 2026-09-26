// A breakdown: the animated story of how a score was made (sources analyzed, clipped, sliced, placed
// into the composition, warped and tuned), with its sound, the score's code a tab away, where every
// sound comes from, and a way into the Score tab. Every breakdown is a bundle baked from a score by
// scripts/breakdown.py (web/src/breakdowns/<slug>.json); the landing hero is one of them.

import "./breakdown.css";
import { highlightApr } from "../apr-highlight";
import { el } from "../dom";
import { PlayButton } from "../play-button";
import { reasonOf } from "../../audio/pending";
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
  /** It starts the first time it's seen, and from then on keeps going (its sound too) when scrolled out of view. */
  private started = false;
  private raf = 0;
  private shown = { chapter: -1, caption: "" };
  private sound: StorySound | null;
  /** The same play button as the rest of the site: sound on (it plays along with the pictures) or off. */
  private play = new PlayButton("breakdown's sound", () => void this.toggleSound());
  private probe: Promise<void> = Promise.resolve();
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
    this.probe = this.probeSound();
    // Leaving the page stops its sound, like the rest of the app (the story itself carries on).
    document.addEventListener("apricity:page-changed", () => this.silence());
    new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible) this.start();
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
    this.metronomeBox.addEventListener("change", () => this.sound && (this.sound.clicks = this.metronomeBox.checked));
    const hasKit = d.sources.some((s) => s.kind === "kit");
    const metronome = el("label", { className: "metronome", title: hasKit ? "Click the beat until the drums come in" : "Click the beat" }, this.metronomeBox, "Metronome");

    // Tabs on the left: the story, or the code that made it. The play button on the right.
    const tabs = el("div", { className: "bd-tabs", role: "tablist" });
    const tabStory = el("button", { type: "button", role: "tab", className: "on" }, "Breakdown");
    const tabCode = el("button", { type: "button", role: "tab" }, "Code");
    tabStory.addEventListener("click", () => this.show("story"));
    tabCode.addEventListener("click", () => this.show("code"));
    tabs.append(tabStory, tabCode);
    const head = el("div", { className: "bd-head" }, tabs, el("span", { className: "bd-spacer" }), ...(this.sound ? [this.play.root] : []));
    if (variant === "card" && d.title) head.prepend(el("div", { className: "bd-title" }, el("b", {}, d.title)));
    const pre = el("pre", { className: "bd-source", innerHTML: highlightApr(d.code ?? "") });
    pre.setAttribute("aria-label", `The score: ${d.score}`);
    const code = el("div", { className: "bd-code", hidden: true });
    if (this.opts.open) {
      const open = el("button", { type: "button", className: "bd-open" }, `Open “${d.title ?? d.score}” in Score`);
      open.addEventListener("click", () => this.opts.open!(d.score));
      code.append(el("div", { className: "bd-code-bar" }, el("span", {}, d.score), open));
    }
    code.append(pre);

    const steps = el("ol", { className: "sr-only" }, ...this.story.chapters.map((c) => el("li", {}, c.label)));
    const fig = el(
      "figure",
      { className: `breakdown stage bd-${variant}` },
      head,
      this.stage,
      code,
      el("figcaption", {}, ...(this.sound ? [el("div", { className: "sound-controls" }, metronome)] : []), this.info, nav),
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
    const status = await soundStatus(this.data.audio!);
    const state = stateAfterProbe(status);
    this.soundButton(state);
    // Say why, so a missing sound can be told apart from a denied one (403) or no connection.
    if (state === "missing") this.play.set({ kind: "unavailable", why: `${soundView(state).hint} (${status ?? "no connection"})` });
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

  private soundButton(state: SoundState, progress?: { done: number; total: number }) {
    this.soundState = state;
    const v = soundView(state);
    this.play.set(
      state === "on"
        ? { kind: "playing" }
        : state === "loading"
          ? { kind: "loading", label: "Loading sounds", ...progress }
          : state === "missing"
            ? { kind: "unavailable", why: v.hint }
            : { kind: "idle" }, // checking, ready, armed: a click plays (once the check is done)
    );
    if (state === "armed") this.play.button.title = v.hint;
  }

  /** Turn this breakdown's sound off (another one is starting). */
  silence() {
    if (!this.sound?.on) return;
    this.storyT = this.sound.now();
    this.sound.disable();
    this.soundButton("ready");
  }

  private async toggleSound() {
    if (this.soundState === "checking") await this.probe;
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
      await this.sound.enable(this.storyT, (done, total) => this.soundButton("loading", { done, total }));
      this.paused = false;
      this.soundButton("on");
      if (this.opts.remember) rememberSound(true);
      this.start();
    } catch (e) {
      // The library answered the probe but the sound could not be played: say why; a click tries again.
      this.soundState = "ready";
      this.play.set({ kind: "error", message: reasonOf(e) });
    }
  }

  // ---- drawing

  private reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Hold still frames for reduced motion, unless the reader turned the sound on (then it plays). */
  private still = () => this.reduced() && !this.sound?.on;

  /** Begin (or carry on): the story runs from its start the first time it's seen. */
  private start() {
    if (!this.started) (this.started = true), (this.last = 0);
    if (!this.raf) this.loop();
  }

  private loop = () => {
    this.raf = 0;
    if (!this.started) return;
    this.frame();
    if (!this.still()) this.raf = requestAnimationFrame(this.loop);
  };

  private frame() {
    const now = performance.now() / 1000;
    const dt = this.last ? Math.min(0.1, now - this.last) : 0;
    this.last = now;
    if (this.sound?.on) this.storyT = this.sound.now();
    else if (!this.paused) this.storyT = (this.storyT + dt) % this.story.loop;
    // Out of view it keeps time (and plays), but there's nothing to draw.
    if (this.visible) this.draw(this.still() ? this.stillT : this.storyT, this.still());
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
