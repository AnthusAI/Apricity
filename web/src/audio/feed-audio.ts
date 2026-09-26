// Playing from a page of cards (Activity, a tag's leaderboard): one thing at a time. A score plays through the shared
// player (the engine holds one loop); a sample or a clip plays its stretch of the decoded recording. Starting one
// stops whatever else a card was playing.

import { player, progressLabel } from "./player";
import { once, reasonOf } from "./pending";
import { audioUrl, compile, type Timeline } from "../apricity";
import type { PlayState } from "../ui/play-button";

type Report = (s: PlayState) => void;

let current: { key: string; stop: () => void } | null = null;

/** Stop what a card is playing (the page was left, or another card started). */
export function stopFeed() {
  const c = current;
  current = null;
  c?.stop();
}

function claim(key: string, stop: () => void) {
  if (current?.key !== key) stopFeed();
  current = { key, stop };
}

/** What a card is playing now ("score:<id>", "clip:<id>"), if anything. */
export const playingKey = () => current?.key ?? null;

const compiled = new Map<string, Promise<Timeline>>();

/** A score compiled once per page (the strip draws it; Play plays it). Rejects with the compiler's words. */
export function compiledScore(path: string, text: () => Promise<string>): Promise<Timeline> {
  return once(compiled, path, async () => {
    const r = await compile(await text(), path);
    if (r.errors) throw new Error(r.errors[0] ?? "it doesn't compile");
    return r.timeline;
  });
}

/** Play a compiled score from its start, saying how it goes on `report`. */
export async function playScore(key: string, tl: Timeline, report: Report): Promise<void> {
  claim(key, () => (player.pause(), report({ kind: "idle" })));
  try {
    if (!player.started) report({ kind: "loading", label: "Starting the audio engine" });
    await player.init();
    if (player.transport.playing) player.pause(); // a new loop replaces the old at once, not at its next bar
    await player.arrange(tl, (p) => current?.key === key && report({ kind: "loading", label: progressLabel(p), ...(p.step === "sounds" ? { done: p.done, total: p.total } : {}) }));
    if (current?.key !== key) return; // another card started meanwhile
    player.seekBeat(0);
    await player.play();
    report({ kind: "playing" });
  } catch (e) {
    if (current?.key === key) current = null;
    report({ kind: "error", message: reasonOf(e) });
  }
}

const decoded = new Map<string, Promise<AudioBuffer>>();

/** A sample's audio, decoded once per page (a failed load is tried again next time). */
export function decodeSample(path: string): Promise<AudioBuffer> {
  return once(decoded, path, () =>
    audioUrl(path)
      .then((url) => fetch(url))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${path}: ${r.status}`))))
      .then((b) => new OfflineAudioContext(2, 1, 48000).decodeAudioData(b)),
  );
}

/**
 * Play a stretch of a sample (all of it without `range`). `at(seconds)` follows the playhead while it plays, and
 * null when it stops.
 */
export async function playSample(key: string, path: string, range: [number, number] | null, report: Report, at?: (t: number | null) => void): Promise<void> {
  let src: AudioBufferSourceNode | null = null;
  let stopped = false;
  claim(key, () => {
    stopped = true;
    src?.stop();
    at?.(null);
    report({ kind: "idle" });
  });
  try {
    report({ kind: "loading", label: "Loading the recording" });
    const buf = await decodeSample(path);
    await player.init();
    if (stopped) return;
    const ctx = player.ctx!;
    await ctx.resume();
    const [from, to] = range ?? [0, buf.duration];
    src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const t0 = ctx.currentTime;
    src.start(t0, from, to - from);
    report({ kind: "playing" });
    const tick = () => {
      if (stopped) return;
      at?.(from + (ctx.currentTime - t0));
      requestAnimationFrame(tick);
    };
    tick();
    src.onended = () => {
      if (stopped) return;
      stopped = true;
      if (current?.key === key) current = null;
      at?.(null);
      report({ kind: "idle" });
    };
  } catch (e) {
    if (current?.key === key) current = null;
    report({ kind: "error", message: reasonOf(e) });
  }
}
