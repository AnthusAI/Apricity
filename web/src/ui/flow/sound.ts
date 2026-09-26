// Sound for a Flow story: plays its cues (a stretch of a source recording, or of a track's render)
// in step with the pictures. While it's on, the audio clock is the story's clock, so the two can't
// drift: the page asks now() for the story time instead of counting frames.

import { getUrl } from "../../data/files";
import { audioKeys as audioKeysOf, isAudioStatus, isLibraryKey } from "./hero-audio";
import type { FlowAudio } from "./model";
import type { Cue, Metronome } from "./story";

const LOOKAHEAD = 1.2; // seconds of cues scheduled ahead, so a late timer never drops one

type UrlOf = (o: { path: string }) => Promise<{ url: string }>;

/** The bytes of a library key, from wherever the library is served (files.ts maps it to /files/<key> or the bucket). */
export async function fetchKey(key: string, range?: string, resolve: UrlOf = getUrl): Promise<ArrayBuffer> {
  if (!isLibraryKey(key)) throw new Error(`not a library key: ${key}`);
  const { url } = await resolve({ path: key });
  const res = await fetch(url, range ? { headers: { Range: range } } : undefined);
  if (!isAudioStatus(res.status)) throw new Error(`${key}: ${res.status}`);
  return res.arrayBuffer();
}

/** Is the sound in the library? Asks for one byte of every key; never throws. */
export async function soundStatus(audio: FlowAudio, resolve: UrlOf = getUrl): Promise<number | null> {
  try {
    for (const key of audioKeysOf(audio)) await fetchKey(key, "bytes=0-0", resolve);
    return 200;
  } catch (e) {
    const m = /: (\d{3})$/.exec(String((e as Error)?.message));
    return m ? Number(m[1]) : null;
  }
}

export class StorySound {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private sources: AudioBuffer[] = [];
  private tracks: AudioBuffer[] = [];
  private gains: number[] = [];
  private nodes = new Set<AudioScheduledSourceNode>();
  // Absolute story time `story` (it keeps counting past the loop) happens at audio time `audio`.
  private anchor = { story: 0, audio: 0 };
  private cursor = 0; // absolute story time scheduled up to
  private timer = 0;
  on = false;
  /** Click the beat until the drums come in (the page's Metronome checkbox). */
  clicks = true;

  constructor(
    private audio: FlowAudio,
    private cues: Cue[],
    private loop: number, // story length, seconds
    private trackLoop: number, // length of one pass of a track render, seconds
    private metronome?: Metronome,
  ) {}

  /** Start (loading the sounds the first time, saying how many are in), joining the story at `storyT`. Must follow a click. */
  async enable(storyT: number, onProgress?: (done: number, total: number) => void) {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      this.out = ctx.createGain();
      this.out.gain.value = 0.85;
      this.out.connect(ctx.destination);
      // iOS only lets a page start audio inside the tap itself, and loading the sounds takes longer
      // than that: unlock it now (resume, and play one silent sample), before anything is awaited.
      void ctx.resume();
      const unlock = ctx.createBufferSource();
      unlock.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      unlock.connect(ctx.destination);
      unlock.start(0);
      const total = this.audio.sources.length + this.audio.tracks.length;
      let done = 0;
      onProgress?.(done, total);
      const load = async (key: string) => {
        const buf = await ctx.decodeAudioData(await fetchKey(key));
        onProgress?.(++done, total);
        return buf;
      };
      try {
        [this.sources, this.tracks] = await Promise.all([Promise.all(this.audio.sources.map(load)), Promise.all(this.audio.tracks.map((t) => load(t.key)))]);
      } catch (e) {
        // Leave nothing half-built: the next try starts again.
        this.ctx = null;
        void ctx.close();
        throw e;
      }
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
      if (this.clicks) this.clickBetween(base, this.cursor, horizon);
    }
    this.cursor = Math.max(this.cursor, horizon);
  }

  /** Schedule the metronome's clicks due in [from, to) of the lap starting at absolute story time `base`. */
  private clickBetween(base: number, from: number, to: number) {
    const m = this.metronome;
    if (!m) return;
    const first = Math.ceil((Math.max(from, base) - base - m.anchor) / m.spb - 1e-9);
    for (let k = first; ; k++) {
      const t = m.anchor + k * m.spb; // story time of this click
      if (t >= m.until || base + t >= to) break;
      if (t >= 0) this.click(base + t, ((k % m.meter) + m.meter) % m.meter === 0);
    }
  }

  /** One short click, due at absolute story time T: higher on the downbeat. */
  private click(T: number, accent: boolean) {
    const ctx = this.ctx!;
    const when = this.anchor.audio + (T - this.anchor.story);
    if (when < ctx.currentTime) return;
    const osc = ctx.createOscillator();
    osc.frequency.value = accent ? 1760 : 1320;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(accent ? 0.35 : 0.22, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    osc.connect(g).connect(this.out);
    osc.start(when);
    osc.stop(when + 0.06);
    this.nodes.add(osc);
    osc.onended = () => this.nodes.delete(osc);
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
      } catch {} // already stopped
    }
    this.nodes.clear();
  }
}
