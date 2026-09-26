// Page-side audio orchestration: AudioContext + engine worklet + render worker.
//
//   page ──share of events──▶ render workers (pool) ──partial mixes──▶ engine worklet ──▶ speakers
//     ▲                                                                   │
//     └────────────────── status (position, pending swap) ────────────────┘
//
// Each event always goes to the same worker (by a hash of what it sounds like), so every
// worker's render cache stays warm across edits.

import workletUrl from "./engine-worklet.ts?worker&url";
import RenderWorker from "./render-worker.ts?worker";
import { audioUrl, apricityModule, type Timeline } from "../apricity";
import { AudioFailure, once, Pending, reasonOf, withTimeout } from "./pending";
import { notify } from "../ui/notices";

export { AudioFailure } from "./pending";

/** How long the engine, and then its renderers, may take to start. */
const START_MS = 15_000;
const fileName = (path: string) => path.split("/").pop() ?? path;

export interface Transport {
  playing: boolean;
  position: number; // frames
  frames: number; // loop length
  framesPerBeat: number;
  beatsPerBar: number;
  pending: boolean;
  swaps: number;
  peak: number;
  sampleRate: number;
}

type Listener = (t: Transport) => void;

/** A newer edit replaced this render before it finished. */
export class Superseded extends Error {
  constructor() {
    super("superseded by a newer edit");
  }
}
type ArrangeResult = { ms: number; rendered: number; reused: number; frames: number };

export class Player {
  ctx: AudioContext | null = null;
  private node!: AudioWorkletNode;
  private workers: Worker[] = [];
  private ready: Promise<void> | null = null;
  private loaded = new Set<string>();
  private decoding = new Map<string, Promise<void>>();
  /** Each renderer's "I have this source" (key: `<worker>|<path>`). */
  private sources = new Pending<string, void>();
  private gcTimer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<Listener>();
  private nextId = 1;
  private waiting = new Map<number, { parts: ArrangeResult[]; of: number; resolve: (r: ArrangeResult) => void; reject: (e: Error) => void }>();
  private hasLoop = false;
  transport: Transport = { playing: false, position: 0, frames: 0, framesPerBeat: 1, beatsPerBar: 4, pending: false, swaps: 0, peak: 0, sampleRate: 48000 };

  onTransport(f: Listener) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit(patch: Partial<Transport>) {
    this.transport = { ...this.transport, ...patch };
    for (const f of this.listeners) f(this.transport);
  }

  /** Start audio (must follow a user gesture the first time). */
  /** Whether the audio engine is up (the first start takes a moment: the engine, then its renderers). */
  get started() {
    return this.isStarted;
  }
  private isStarted = false;

  /**
   * Start the engine and its renderers. A failure (or one that takes too long) rejects with the reason and leaves
   * nothing half-built behind, so the next Play starts fresh instead of waiting forever.
   */
  init(): Promise<void> {
    this.ready ??= (async () => {
      try {
        const module = await apricityModule();
        const ctx = new AudioContext({ latencyHint: "interactive" });
        this.ctx = ctx;
        await ctx.audioWorklet.addModule(workletUrl);
        this.node = new AudioWorkletNode(ctx, "apricity-engine", { outputChannelCount: [2], processorOptions: { module } });
        const engineReady = new Promise<void>((resolve, reject) => {
          this.node.port.onmessage = ({ data }) => {
            if (data.type === "ready") resolve();
            else if (data.type === "failed") reject(new AudioFailure(`the audio engine didn't start: ${data.error}`));
            else if (data.type === "status") this.emit({ position: data.position, pending: data.pending, swaps: data.swaps, peak: data.peak });
            else if (data.type === "loaded") this.emit({ frames: data.frames, framesPerBeat: data.framesPerBeat, beatsPerBar: data.beatsPerBar });
          };
        });
        this.node.connect(ctx.destination);
        await withTimeout(engineReady, START_MS, "starting the audio engine");

        const count = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
        await withTimeout(
          Promise.all(Array.from({ length: count }, (_, k) => this.startWorker(k, module, ctx.sampleRate))),
          START_MS,
          "starting the audio renderers",
        );
        this.gcTimer = setInterval(() => this.node.port.postMessage({ type: "gc" }), 1000);
        this.emit({ sampleRate: ctx.sampleRate });
        this.isStarted = true;
      } catch (e) {
        this.reset();
        throw e instanceof AudioFailure ? e : new AudioFailure(`the audio engine didn't start: ${reasonOf(e)}`);
      }
    })();
    return this.ready;
  }

  /** One render worker: its messages, and what happens if it dies (every wait fails with why; the next Play rebuilds). */
  private startWorker(k: number, module: WebAssembly.Module, sampleRate: number): Promise<void> {
    const worker = new RenderWorker();
    const channel = new MessageChannel();
    this.node.port.postMessage({ type: "connect", port: channel.port2 }, [channel.port2]);
    const ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") resolve();
        else if (data.type === "arranged") this.partDone(data.id, data);
        else if (data.type === "error") this.waiting.get(data.id)?.reject(new AudioFailure(data.error)), this.waiting.delete(data.id);
        else if (data.type === "skipped") this.waiting.get(data.id)?.reject(new Superseded()), this.waiting.delete(data.id);
        else if (data.type === "source-ready") this.sources.resolve(`${k}|${data.path}`, undefined);
        else if (data.type === "source-error") this.sources.reject(`${k}|${data.path}`, new AudioFailure(`couldn't prepare ${fileName(data.path)}: ${data.error}`));
        else if (data.type === "init-error") reject(new AudioFailure(`an audio renderer didn't start: ${data.error}`));
      };
      const died = (why: string) => {
        const err = new AudioFailure(`an audio renderer stopped: ${why}`);
        reject(err);
        this.fail(err);
      };
      worker.onerror = (e) => (e.preventDefault(), died(e.message || "it crashed"));
      worker.onmessageerror = () => died("a message couldn't be read");
    });
    worker.postMessage({ type: "init", module, sampleRate, engine: channel.port1 }, [channel.port1]);
    this.workers.push(worker);
    return ready;
  }

  /** Something broke: every waiting render and source load fails with the reason, and the engine is taken down so
   *  the next Play starts it again. */
  private fail(err: Error) {
    // If it was playing, it has just stopped: say why (a waiting Play reports on its own button).
    if (this.transport.playing) notify(`Playback stopped: ${err.message}. Press Play to start again.`);
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
    this.sources.failAll(err);
    this.reset();
  }

  /** Take everything down (nothing is left waiting); the next `init()` builds it again. */
  private reset() {
    clearInterval(this.gcTimer);
    for (const w of this.workers) w.terminate();
    this.workers = [];
    try {
      this.node?.disconnect();
    } catch {
      /* already disconnected */
    }
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.ready = null;
    this.isStarted = false;
    this.loaded.clear();
    this.decoding.clear();
    this.hasLoop = false;
    if (this.transport.playing) this.emit({ playing: false });
  }

  private partDone(id: number, r: ArrangeResult) {
    const w = this.waiting.get(id);
    if (!w) return;
    w.parts.push(r);
    if (w.parts.length < w.of) return;
    this.waiting.delete(id);
    w.resolve({
      ms: Math.max(...w.parts.map((p) => p.ms)),
      rendered: w.parts.reduce((a, p) => a + p.rendered, 0),
      reused: w.parts.reduce((a, p) => a + p.reused, 0),
      frames: w.parts[0].frames,
    });
  }

  /**
   * Decode (Web Audio) and hand to every renderer each source the timeline needs. A sound that can't be fetched or
   * decoded fails with its name and the reason, and is forgotten, so the next try fetches it again.
   */
  private async loadSources(tl: Timeline, onProgress?: (p: LoadProgress) => void) {
    const ctx = this.ctx!;
    const paths = [...new Set(tl.sources.map((s) => s.path))].filter((p) => !this.loaded.has(p));
    let done = 0;
    if (paths.length) onProgress?.({ step: "sounds", done, total: paths.length });
    const counted = (p: Promise<void>) => p.then(() => onProgress?.({ step: "sounds", done: ++done, total: paths.length }));
    await Promise.all(
      paths.map((p) =>
        counted(
          once(this.decoding, p, async () => {
            const name = fileName(p);
            const res = await fetch(await audioUrl(p)).catch((e) => {
              throw new AudioFailure(`couldn't load ${name}: ${reasonOf(e)}`);
            });
            if (!res.ok) throw new AudioFailure(`couldn't load ${name} (${res.status})`);
            const bytes = await res.arrayBuffer();
            const buf = await ctx.decodeAudioData(bytes).catch(() => {
              throw new AudioFailure(`couldn't decode ${name}: it isn't audio this browser can read`);
            });
            const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i).slice());
            await Promise.all(
              this.workers.map((w, k) => {
                const ready = this.sources.wait(`${k}|${p}`);
                const copy = channels.map((c) => c.slice());
                w.postMessage({ type: "source", path: p, channels: copy, sampleRate: buf.sampleRate }, copy.map((c) => c.buffer));
                return ready;
              }),
            );
            this.loaded.add(p);
          }),
        ),
      ),
    );
  }

  /** Render a timeline and queue it: immediately if nothing is playing yet, else at the next bar. */
  async arrange(tl: Timeline, onProgress?: (p: LoadProgress) => void): Promise<ArrangeResult> {
    await this.init();
    await this.loadSources(tl, onProgress);
    onProgress?.({ step: "mix" });
    const id = this.nextId++;
    // Deal events to workers by a stable hash of what they sound like. A track with effects goes
    // whole to one worker (a compressor needs the whole track), by a hash of its name; every track
    // that feeds a bus, ducks, or keys a duck goes to the same worker, which renders the buses.
    const n = this.workers.length;
    const shares: unknown[][] = Array.from({ length: n }, () => []);
    const tracks: any[] = (tl as any).tracks ?? [];
    // Sidechains: a ducked track (or bus) and the track it listens to must share a worker.
    const keyOf = (fx: any[] = []) => fx.map((e) => e.comp?.sidechain).filter(Boolean) as string[];
    const keys = new Set([...tracks.flatMap((t) => keyOf(t.effects)), ...((tl as any).buses ?? []).flatMap((b: any) => keyOf(b.effects))]);
    const bused = new Set(
      tracks.filter((t) => (t.out && t.out !== "master") || Object.keys(t.sends ?? {}).length || keys.has(t.name) || keyOf(t.effects).length).map((t) => t.name),
    );
    const whole = new Set(tracks.filter((t) => t.effects?.length).map((t) => t.name));
    for (const e of tl.events as any[]) {
      const key = bused.has(e.track)
        ? "buses"
        : whole.has(e.track)
          ? `track|${e.track}`
          : `${tl.sources[e.source].path}|${e.src_start.toFixed(4)}|${e.src_end.toFixed(4)}|${e.dur_beats}|${e.semitones}|${e.tuning_cents}|${e.mode}`;
      let h = 2166136261;
      for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
      shares[(h >>> 0) % n].push(e);
    }
    const result = new Promise<ArrangeResult>((resolve, reject) => this.waiting.set(id, { parts: [], of: n, resolve, reject }));
    const atNextBar = this.hasLoop && this.transport.playing;
    this.workers.forEach((w, k) => w.postMessage({ type: "arrange", id, part: k, parts: n, timeline: { ...tl, events: shares[k] }, atNextBar }));
    const r = await result;
    this.hasLoop = true;
    return r;
  }

  async play() {
    await this.init();
    await this.ctx!.resume();
    this.node.port.postMessage({ type: "play" });
    this.emit({ playing: true });
  }

  pause() {
    this.node?.port.postMessage({ type: "pause" });
    this.emit({ playing: false });
  }

  seekBeat(beat: number) {
    this.node?.port.postMessage({ type: "seek", frame: Math.max(0, Math.round(beat * this.transport.framesPerBeat)) });
  }
}

export const player = new Player();

/** How far along getting a timeline ready to play is: its sounds (fetched and decoded), then the mix. */
export type LoadProgress = { step: "sounds"; done: number; total: number } | { step: "mix" };

/** The play button's words for a step. */
export const progressLabel = (p: LoadProgress) => (p.step === "sounds" ? "Loading sounds" : "Mixing");
