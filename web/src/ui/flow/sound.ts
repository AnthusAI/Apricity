// Sound for a Flow story: plays its cues (a stretch of a source recording, or of a track's render)
// in step with the pictures. While it's on, the audio clock is the story's clock, so the two can't
// drift: the page asks now() for the story time instead of counting frames.

import type { FlowAudio } from "./model";
import type { Cue } from "./story";

const LOOKAHEAD = 1.2; // seconds of cues scheduled ahead, so a late timer never drops one

export class StorySound {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private sources: AudioBuffer[] = [];
  private tracks: AudioBuffer[] = [];
  private gains: number[] = [];
  private nodes = new Set<AudioBufferSourceNode>();
  // Absolute story time `story` (it keeps counting past the loop) happens at audio time `audio`.
  private anchor = { story: 0, audio: 0 };
  private cursor = 0; // absolute story time scheduled up to
  private timer = 0;
  on = false;

  constructor(
    private audio: FlowAudio,
    private cues: Cue[],
    private loop: number, // story length, seconds
    private trackLoop: number, // length of one pass of a track render, seconds
    private base = import.meta.env.BASE_URL,
  ) {}

  /** Start (loading the sounds the first time), joining the story at `storyT`. Must follow a click. */
  async enable(storyT: number) {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      this.out = ctx.createGain();
      this.out.gain.value = 0.85;
      this.out.connect(ctx.destination);
      const load = async (url: string) => ctx.decodeAudioData(await (await fetch(this.base + url)).arrayBuffer());
      [this.sources, this.tracks] = await Promise.all([Promise.all(this.audio.sources.map(load)), Promise.all(this.audio.tracks.map((t) => load(t.url)))]);
      this.gains = this.audio.tracks.map((t) => 10 ** (t.gain_db / 20));
    }
    await this.ctx.resume();
    this.on = true;
    this.seek(storyT);
    // Its own timer, not the page's frames: frames stall (hidden or busy pages), sound mustn't.
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.pump(), 100);
  }

  disable() {
    this.on = false;
    clearInterval(this.timer);
    this.stopAll();
    void this.ctx?.suspend();
  }

  /** Off screen: hold everything, story time included (the audio clock stops while suspended). */
  hold(held: boolean) {
    if (!this.on || !this.ctx) return;
    void (held ? this.ctx.suspend() : this.ctx.resume());
  }

  /** The story time now, 0…loop. */
  now() {
    const a = this.abs();
    return ((a % this.loop) + this.loop) % this.loop;
  }

  /** Jump to `storyT`: silence what's playing, pick up any cue already under way. */
  seek(storyT: number) {
    if (!this.ctx) return;
    this.stopAll();
    this.anchor = { story: storyT, audio: this.ctx.currentTime + 0.03 };
    this.cursor = storyT;
    for (const c of this.cues) if (c.t < storyT && c.t + c.dur > storyT + 0.05) this.play(c, c.t, storyT);
    this.pump();
  }

  /** Schedule the cues coming up in the next moment (runs on a timer while the sound is on). */
  pump() {
    if (!this.on || !this.ctx) return;
    const horizon = this.abs() + LOOKAHEAD;
    const lap = Math.floor(this.cursor / this.loop) * this.loop;
    for (const base of [lap, lap + this.loop]) {
      for (const c of this.cues) {
        const T = base + c.t;
        if (T >= this.cursor && T < horizon) this.play(c, T);
      }
    }
    this.cursor = Math.max(this.cursor, horizon);
  }

  private abs() {
    return this.anchor.story + (this.ctx!.currentTime - this.anchor.audio);
  }

  /** Play cue `c`, due at absolute story time T, joining it at `from` (≥ T). */
  private play(c: Cue, T: number, from = T) {
    const ctx = this.ctx!;
    const buf = c.kind === "source" ? this.sources[c.index] : this.tracks[c.index];
    if (!buf) return;
    let when = this.anchor.audio + (from - this.anchor.story);
    let skip = from - T;
    const late = ctx.currentTime - when;
    if (late > 0) {
      when += late;
      skip += late;
    }
    const left = c.dur - skip;
    if (left <= 0.01) return;
    const end = when + left;
    const level = c.kind === "track" ? this.gains[c.index] : 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.006);
    const fade = Math.min(left / 2, c.fadeOut ?? 0.012);
    g.gain.setValueAtTime(level, end - fade);
    g.gain.linearRampToValueAtTime(0, end);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    if (c.loop) {
      node.loop = true;
      node.loopStart = 0;
      node.loopEnd = Math.min(buf.duration, this.trackLoop);
      node.start(when, (c.offset + skip) % node.loopEnd);
    } else {
      node.start(when, c.offset + skip, left);
    }
    node.stop(end + 0.02);
    node.connect(g).connect(this.out);
    this.nodes.add(node);
    node.onended = () => this.nodes.delete(node);
  }

  private stopAll() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {}
    }
    this.nodes.clear();
  }
}
