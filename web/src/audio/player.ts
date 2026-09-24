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
import { encodePath, apricityModule, type Timeline } from "../apricity";

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
  init(): Promise<void> {
    this.ready ??= (async () => {
      const module = await apricityModule();
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(workletUrl);
      this.node = new AudioWorkletNode(ctx, "apricity-engine", { outputChannelCount: [2], processorOptions: { module } });
      const engineReady = new Promise<void>((resolve) => {
        this.node.port.onmessage = ({ data }) => {
          if (data.type === "ready") resolve();
          else if (data.type === "status") this.emit({ position: data.position, pending: data.pending, swaps: data.swaps, peak: data.peak });
          else if (data.type === "loaded") this.emit({ frames: data.frames, framesPerBeat: data.framesPerBeat, beatsPerBar: data.beatsPerBar });
        };
      });
      this.node.connect(ctx.destination);
      await engineReady;

      const count = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
      await Promise.all(
        Array.from({ length: count }, () => {
          const worker = new RenderWorker();
          const channel = new MessageChannel();
          this.node.port.postMessage({ type: "connect", port: channel.port2 }, [channel.port2]);
          const ready = new Promise<void>((resolve) => {
            worker.onmessage = ({ data }) => {
              if (data.type === "ready") resolve();
              else if (data.type === "arranged") this.partDone(data.id, data);
              else if (data.type === "error") this.waiting.get(data.id)?.reject(new Error(data.error)), this.waiting.delete(data.id);
              else if (data.type === "skipped") this.waiting.get(data.id)?.reject(new Superseded()), this.waiting.delete(data.id);
            };
          });
          worker.postMessage({ type: "init", module, sampleRate: ctx.sampleRate, engine: channel.port1 }, [channel.port1]);
          this.workers.push(worker);
          return ready;
        }),
      );
      setInterval(() => this.node.port.postMessage({ type: "gc" }), 1000);
      this.emit({ sampleRate: ctx.sampleRate });
    })();
    return this.ready;
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

  /** Decode (Web Audio) and hand to every renderer each source the timeline needs. */
  private async loadSources(tl: Timeline, onProgress?: (msg: string) => void) {
    const ctx = this.ctx!;
    const paths = [...new Set(tl.sources.map((s) => s.path))].filter((p) => !this.loaded.has(p));
    await Promise.all(
      paths.map((p) => {
        if (!this.decoding.has(p)) {
          this.decoding.set(
            p,
            (async () => {
              onProgress?.(`decoding ${p.split("/").pop()}`);
              const bytes = await fetch(`/files/${encodePath(p)}`).then((r) => {
                if (!r.ok) throw new Error(`${p}: ${r.status}`);
                return r.arrayBuffer();
              });
              const buf = await ctx.decodeAudioData(bytes);
              const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i).slice());
              await Promise.all(
                this.workers.map((w) => {
                  const done = new Promise<void>((resolve) => {
                    const f = ({ data }: MessageEvent) => data.type === "source-ready" && data.path === p && (w.removeEventListener("message", f), resolve());
                    w.addEventListener("message", f);
                  });
                  const copy = channels.map((c) => c.slice());
                  w.postMessage({ type: "source", path: p, channels: copy, sampleRate: buf.sampleRate }, copy.map((c) => c.buffer));
                  return done;
                }),
              );
              this.loaded.add(p);
            })(),
          );
        }
        return this.decoding.get(p)!;
      }),
    );
  }

  /** Render a timeline and queue it: immediately if nothing is playing yet, else at the next bar. */
  async arrange(tl: Timeline, onProgress?: (msg: string) => void): Promise<ArrangeResult> {
    await this.init();
    await this.loadSources(tl, onProgress);
    onProgress?.("rendering");
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
