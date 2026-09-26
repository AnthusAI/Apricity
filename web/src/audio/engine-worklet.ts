// AudioWorklet: the Rust mixer (wasm) on the audio thread. Loops arrive from the render worker
// over a MessagePort and swap in at the next bar. The message handler (same thread, between
// render quanta) does the allocating; process() only mixes.

import { instantiate, type Apricity } from "../wasm/shim.js";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const QUANTUM = 128;

class ApricityEngine extends AudioWorkletProcessor {
  rw: Apricity | null = null;
  out = 0;
  blocks = 0;
  peak = 0;
  // Partial mixes from the render workers, summed per request; newest complete request wins.
  parts = new Map<number, { got: number; sum: Float32Array; meta: any }>();
  newestLoaded = 0;
  // Ports to the render workers (one measures the master loudness for each new mix).
  workers: MessagePort[] = [];

  constructor(options: { processorOptions: { module: WebAssembly.Module } }) {
    super();
    const handle = (msg: any) => this.onMessage(msg);
    this.port.onmessage = ({ data }) => handle(data);
    instantiate(options.processorOptions.module).then(
      (rw) => {
        rw.exports.rw_engine_new();
        this.out = rw.exports.rw_alloc(2 * QUANTUM);
        this.rw = rw;
        this.port.postMessage({ type: "ready" });
      },
      // Say why, so the page can report it instead of waiting forever.
      (e) => this.port.postMessage({ type: "failed", error: String((e as Error)?.message ?? e) }),
    );
  }

  onMessage(msg: any) {
    const rw = this.rw;
    if (!rw) return;
    if (msg.type === "connect") {
      (msg.port as MessagePort).onmessage = ({ data }) => this.onMessage(data);
      this.workers.push(msg.port);
    } else if (msg.type === "part") {
      if (msg.id <= this.newestLoaded) return; // a newer version already went in
      let entry = this.parts.get(msg.id);
      if (!entry) this.parts.set(msg.id, (entry = { got: 0, sum: new Float32Array(msg.loop.length), meta: msg }));
      const loop = msg.loop as Float32Array;
      const sum = entry.sum;
      for (let i = 0; i < loop.length; i++) sum[i] += loop[i];
      if (++entry.got < msg.parts) return;
      this.parts.delete(msg.id);
      for (const id of this.parts.keys()) if (id < msg.id) this.parts.delete(id);
      if (msg.master && this.workers.length > 0) {
        // Measuring loudness takes tens of ms: a worker does it, then "mastered" loads the mix.
        const { loop: _, ...meta } = msg;
        this.workers[msg.id % this.workers.length].postMessage({ ...meta, type: "master", loop: sum }, [sum.buffer]);
        return;
      }
      this.newestLoaded = msg.id;
      let peak = 0;
      for (let i = 0; i < sum.length; i++) peak = Math.max(peak, Math.abs(sum[i]));
      const gain = peak > 0 ? 0.89 / peak : 1; // loudest sample at -1 dBFS
      const ptr = rw.exports.rw_alloc(sum.length);
      const dst = new Float32Array(rw.memory().buffer, ptr, sum.length);
      for (let i = 0; i < sum.length; i++) dst[i] = sum[i] * gain;
      rw.exports.rw_engine_load(ptr, msg.frames, msg.framesPerBeat, msg.beatsPerBar, sampleRate, msg.atNextBar);
      rw.exports.rw_engine_gc();
      this.port.postMessage({ type: "loaded", id: msg.id, frames: msg.frames, framesPerBeat: msg.framesPerBeat, beatsPerBar: msg.beatsPerBar });
    } else if (msg.type === "mastered") {
      if (msg.id <= this.newestLoaded) return;
      this.newestLoaded = msg.id;
      const sum = msg.loop as Float32Array;
      const ptr = rw.exports.rw_alloc(sum.length);
      new Float32Array(rw.memory().buffer, ptr, sum.length).set(sum);
      rw.withBytes(JSON.stringify(msg.master), (p, n) =>
        rw.exports.rw_engine_load_mastered(ptr, msg.frames, msg.framesPerBeat, msg.beatsPerBar, sampleRate, msg.atNextBar, p, n, msg.gainDb),
      );
      rw.exports.rw_engine_gc();
      this.port.postMessage({ type: "loaded", id: msg.id, frames: msg.frames, framesPerBeat: msg.framesPerBeat, beatsPerBar: msg.beatsPerBar, gainDb: msg.gainDb });
    } else if (msg.type === "play") {
      rw.exports.rw_engine_play(true);
    } else if (msg.type === "pause") {
      rw.exports.rw_engine_play(false);
    } else if (msg.type === "seek") {
      rw.exports.rw_engine_seek(msg.frame);
    } else if (msg.type === "gc") {
      rw.exports.rw_engine_gc();
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const rw = this.rw;
    const out = outputs[0];
    if (!rw || !out || out.length === 0) return true;
    rw.exports.rw_engine_process(this.out, QUANTUM);
    const mixed = new Float32Array(rw.memory().buffer, this.out, 2 * QUANTUM);
    out[0].set(mixed.subarray(0, QUANTUM));
    if (out[1]) out[1].set(mixed.subarray(QUANTUM));
    for (let i = 0; i < QUANTUM; i++) {
      const a = Math.abs(mixed[i]);
      if (a > this.peak) this.peak = a;
    }
    if (++this.blocks % 16 === 0) {
      this.port.postMessage({
        type: "status",
        position: rw.exports.rw_engine_position(),
        pending: rw.exports.rw_engine_pending(),
        swaps: rw.exports.rw_engine_swaps(),
        peak: this.peak,
      });
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor("apricity-engine", ApricityEngine);
