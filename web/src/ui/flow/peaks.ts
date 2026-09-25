// Waveform peaks for whole recordings, decoded once per path and kept small: min/max pairs (int8)
// every 128 samples at 22.05 kHz, about 6 ms per column. That is fine enough for a 0.1 s chop.

import { audioUrl } from "../../apricity";

export interface Peaks {
  peaks: Int8Array; // min/max pairs, −127…127
  win: [number, number]; // seconds the columns cover
}

const RATE = 22050;
const HOP = 128;
const cache = new Map<string, Promise<Peaks>>();

export function peaksOf(path: string): Promise<Peaks> {
  let p = cache.get(path);
  if (!p) {
    p = (async () => {
      const bytes = await fetch(await audioUrl(path)).then((r) => {
        if (!r.ok) throw new Error(`${path}: ${r.status}`);
        return r.arrayBuffer();
      });
      const buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes);
      const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
      const cols = Math.ceil(buf.length / HOP);
      const lo = new Float32Array(cols);
      const hi = new Float32Array(cols);
      let top = 1e-9;
      for (let c = 0; c < cols; c++) {
        let a = Infinity, b = -Infinity;
        for (let i = c * HOP, end = Math.min(buf.length, i + HOP); i < end; i++) {
          let v = 0;
          for (const ch of chans) v += ch[i];
          v /= chans.length;
          if (v < a) a = v;
          if (v > b) b = v;
        }
        lo[c] = a;
        hi[c] = b;
        top = Math.max(top, -a, b);
      }
      const peaks = new Int8Array(cols * 2);
      for (let c = 0; c < cols; c++) {
        peaks[2 * c] = Math.round((lo[c] / top) * 127);
        peaks[2 * c + 1] = Math.round((hi[c] / top) * 127);
      }
      return { peaks, win: [0, (cols * HOP) / RATE] as [number, number] };
    })();
    cache.set(path, p);
    p.catch(() => cache.delete(path));
  }
  return p;
}
