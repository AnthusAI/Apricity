// Render worker: owns the Rubber Band renderer (in wasm). Receives decoded sources and compiled
// timelines (its share of the events); renders what changed; sends its partial mix straight to the
// engine worklet over a dedicated MessagePort, transferring the buffer (no copy on the page thread).
// The worklet sends the summed mix back to one worker to measure the master's loudness make-up
// (too slow for the audio thread), then plays it through the master chain.

import { instantiate, type Apricitus } from "../wasm/shim.js";

let rw: Apricitus;
let engine: MessagePort;
let latest = 0; // newest arrange request id; older ones still queued are skipped
let sampleRate = 48000;

type Msg =
  | { type: "init"; module: WebAssembly.Module; sampleRate: number; engine: MessagePort }
  | { type: "source"; path: string; channels: Float32Array[]; sampleRate: number }
  | { type: "arrange"; id: number; part: number; parts: number; timeline: unknown; atNextBar: boolean };

self.onmessage = async ({ data }: MessageEvent<Msg>) => {
  if (data.type === "init") {
    rw = await instantiate(data.module);
    rw.exports.rw_renderer_new(data.sampleRate);
    sampleRate = data.sampleRate;
    engine = data.engine;
    engine.onmessage = ({ data: m }) => {
      if (m.type !== "master") return;
      const loop = m.loop as Float32Array;
      const gainDb = rw.withFloats(loop, (fp) => rw.withBytes(JSON.stringify(m.master), (p, n) => rw.exports.rw_master_gain(fp, m.frames, sampleRate, p, n)));
      engine.postMessage({ ...m, type: "mastered", gainDb }, [loop.buffer]);
    };
    postMessage({ type: "ready" });
  } else if (data.type === "source") {
    const frames = data.channels[0].length;
    const planar = new Float32Array(frames * data.channels.length);
    data.channels.forEach((c, i) => planar.set(c, i * frames));
    rw.withBytes(data.path, (p, n) =>
      rw.withFloats(planar, (fp) => rw.exports.rw_renderer_add_source(p, n, fp, frames, data.channels.length, data.sampleRate)),
    );
    postMessage({ type: "source-ready", path: data.path });
  } else if (data.type === "arrange") {
    latest = data.id;
    // Let any newer request that's already queued win (typing fast shouldn't queue renders).
    await new Promise((r) => setTimeout(r, 0));
    if (data.id !== latest) return void postMessage({ type: "skipped", id: data.id });
    const t0 = performance.now();
    // Raw (no master): the worklet sums every worker's part and masters the whole mix once.
    const ptr = rw.withBytes(JSON.stringify(data.timeline), (p, n) => rw.exports.rw_arrange(p, n, false));
    const info = rw.result();
    if (!ptr) {
      postMessage({ type: "error", id: data.id, error: info.error });
      return;
    }
    const loop = new Float32Array(rw.memory().buffer, ptr, 2 * info.frames).slice();
    rw.exports.rw_free(ptr, 2 * info.frames);
    engine.postMessage(
      { type: "part", id: data.id, part: data.part, parts: data.parts, loop, frames: info.frames, framesPerBeat: info.frames_per_beat, beatsPerBar: info.beats_per_bar, atNextBar: data.atNextBar,
        master: (data.timeline as any).master ?? {} },
      [loop.buffer],
    );
    postMessage({ type: "arranged", id: data.id, ms: performance.now() - t0, rendered: info.rendered, reused: info.reused, frames: info.frames });
  }
};
