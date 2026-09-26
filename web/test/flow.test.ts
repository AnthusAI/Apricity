// Flow renderer: pure layout and timing, plus the promises every baked breakdown bundle keeps.
// Run: npx tsx --test web/test/flow.test.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { beatX, layout, secX } from "../src/ui/flow/layout.ts";
import { pulse, seg } from "../src/ui/flow/tween.ts";

const BUNDLES = new URL("../src/breakdowns/", import.meta.url);
const bundle = (slug: string) => JSON.parse(readFileSync(new URL(`${slug}.json`, BUNDLES), "utf8"));
const slugs = readdirSync(BUNDLES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

test("seg and pulse", () => {
  assert.equal(seg(0, 1, 3), 0);
  assert.equal(seg(2, 1, 3), 0.5);
  assert.equal(seg(9, 1, 3), 1);
  assert.equal(seg(5, 4, 4), 1, "an empty window is done once reached");
  assert.equal(pulse(2, 0, 1, 3, 4), 1);
  assert.equal(pulse(3.5, 0, 1, 3, 4), 0.5);
});

test("layout: sources stack from the top, lanes sit at the bottom", () => {
  const l = layout(1000, 380, [{ shown: 1, detail: 1 }, { shown: 1, detail: 0 }], [26, 34]);
  const [a, b] = l.sources;
  assert.ok(a.wave.h > 40 && b.wave.h === 0, "detail shows the waveform, summary hides it");
  assert.ok(b.title.y > a.chops.y + a.chops.h, "the second source is below the first");
  assert.equal(l.lanes[1].y + l.lanes[1].h, 380 - 8, "the last lane ends at the bottom");
  assert.equal(l.lanes[1].h, 34);
  assert.ok(l.ruler.y < l.chords.y && l.chords.y < l.lanes[0].y);
  assert.equal(beatX(l, 0, 32), l.left);
  assert.equal(beatX(l, 32, 32), l.right);
  assert.equal(secX(a.wave, [10, 20], 15), a.wave.x + a.wave.w / 2);
  const hidden = layout(1000, 380, [{ shown: 0, detail: 1 }], [26]);
  assert.equal(hidden.sources[0].chops.h, 0, "a source not shown yet takes no room");
});

test("hero bundle: the horns, then a drum kit", () => {
  const d = bundle("hero");
  assert.equal(d.sources.length, 2);
  assert.deepEqual(d.sources.map((s: { chops: unknown[] }) => s.chops.length), [4, 9]);
  assert.deepEqual(d.sources.map((s: { kind: string }) => s.kind), ["loop", "kit"]);
  assert.equal(d.sources[1].pads.length, d.sources[1].chops.length, "one named pad per kit chop");
  for (const s of d.sources) assert.equal(Buffer.from(s.peaks, "base64").length, 1200);
  for (const t of d.tiles) assert.ok(t.chop >= 0 && t.chop < d.sources[t.source].chops.length);
  const horns = d.tiles.filter((t: { source: number }) => t.source === 0);
  assert.ok(horns.some((t: { semitones: number }) => t.semitones !== 0), "the horns are transposed to the chords");
});

test("every breakdown bundle: well formed, library keys only, no machine paths", async () => {
  const { audioKeys, isLibraryKey } = await import("../src/ui/flow/hero-audio.ts");
  assert.ok(slugs.includes("hero") && slugs.length >= 3, `bundles: ${slugs}`);
  for (const slug of slugs) {
    const text = readFileSync(new URL(`${slug}.json`, BUNDLES), "utf8");
    assert.ok(!/\/Users\/|\/home\/|\/private\/|\/var\/|[A-Za-z]:\\/.test(text), `${slug}: no absolute path anywhere in the baked data`);
    const d = JSON.parse(text);
    assert.equal(d.slug, slug);
    assert.ok(d.title && d.code && d.score.startsWith("examples/"), `${slug}: title, code and score path`);
    for (const s of d.sources) {
      assert.ok(isLibraryKey(s.path), `${s.path} is a library key`);
      assert.ok(["loop", "kit", "clip"].includes(s.kind), s.kind);
      assert.equal(Buffer.from(s.peaks, "base64").length, 1200);
    }
    for (const t of d.tiles) assert.ok(t.chop >= 0 && t.chop < d.sources[t.source].chops.length, `${slug}: every note maps to a chop`);
    for (const k of audioKeys(d.audio)) assert.ok(isLibraryKey(k) && k.startsWith(`breakdowns/${slug}/`) && k.endsWith(".mp3"), k);
    assert.equal(d.audio.sources.length, d.sources.length, `${slug}: one source window per source`);
    assert.equal(d.audio.tracks.length, d.sources.length, `${slug}: one track render per source`);
    assert.equal(d.provenance.length, d.sources.length, `${slug}: provenance for every source`);
    for (const p of d.provenance) assert.ok(p.recordings.length && p.recordings.every((r: { title: string }) => r.title), `${slug}: every source names its recordings`);
  }
});

test("library keys: relative paths only", async () => {
  const { isLibraryKey } = await import("../src/ui/flow/hero-audio.ts");
  for (const ok of ["hero/b-track.mp3", "audio/smp_1/drums.wav", "a.mp3"]) assert.ok(isLibraryKey(ok), ok);
  for (const bad of ["", "/Users/x/a.mp3", "/hero/a.mp3", "../a.mp3", "hero/../a.mp3", "hero//a.mp3", "./a.mp3", "C:\\a.mp3", "https://x/a.mp3", "hero\\a.mp3", "hero/"]) assert.ok(!isLibraryKey(bad), bad);
});

test("silent fallback: what the sound button shows when the library has no sound", async () => {
  const { isAudioStatus, soundView, stateAfterProbe, MISSING_HINT } = await import("../src/ui/flow/hero-audio.ts");
  assert.ok(isAudioStatus(200) && isAudioStatus(206));
  for (const s of [404, 403, 500, 416, 0]) assert.ok(!isAudioStatus(s), String(s));
  assert.equal(stateAfterProbe(200), "ready");
  assert.equal(stateAfterProbe(206), "ready");
  assert.equal(stateAfterProbe(404), "missing", "no library file");
  assert.equal(stateAfterProbe(null), "missing", "no library or no network");
  const m = soundView("missing");
  assert.ok(m.disabled && !m.pressed, "cannot be clicked");
  assert.equal(m.hint, "Sound needs the audio library: run apricity migrate / fetch");
  assert.equal(m.hint, MISSING_HINT);
  assert.match(m.label, /audio library/);
  assert.ok(soundView("checking").disabled && soundView("loading").disabled);
  assert.ok(!soundView("ready").disabled && !soundView("on").disabled && soundView("on").pressed);
});

test("sound: an unreachable library is reported as a status, never thrown", async () => {
  const { soundStatus } = await import("../src/ui/flow/sound.ts");
  const d = bundle("hero");
  const seen: string[] = [];
  const at = async ({ path }: { path: string }) => ({ url: `http://localhost/files/${path}` });
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    assert.equal(await soundStatus(d.audio, at), 404);
    assert.equal(seen.length, 1, "stops at the first missing file: one failed request");
    assert.equal(seen[0], "http://localhost/files/breakdowns/hero/h-source.mp3");
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    assert.equal(await soundStatus(d.audio, at), null);
    const noUrl = async () => {
      throw new Error("not signed in");
    };
    assert.equal(await soundStatus(d.audio, noUrl), null, "no way to reach the library");
  } finally {
    globalThis.fetch = real;
  }
});

test("hero story cues: each step is heard, in order", async () => {
  const { Story } = await import("../src/ui/flow/story.ts");
  const d = bundle("hero");
  const cues = new Story(d).cues();
  assert.deepEqual(cues.map((c) => c.t), [...cues.map((c) => c.t)].sort((a, b) => a - b), "sorted by time");
  d.sources.forEach((s: { window: number[] }, n: number) =>
    assert.ok(cues.some((c) => c.kind === "source" && c.index === n && c.offset === 0 && c.dur === s.window[1] - s.window[0]), `source ${n} is heard whole while it's analyzed`),
  );
  const chops = cues.filter((c) => c.kind === "source" && c.dur < 1);
  assert.equal(chops.length, 4 + 9, "every chop and pad is heard as it's cut");
  const loops = cues.filter((c) => c.loop);
  assert.equal(loops.length, 3, "the horns alone, then the whole groove");
  for (const c of cues.filter((c) => c.kind === "track" && !c.loop)) assert.ok(c.offset + c.dur <= (d.beats * 60) / d.tempo + 1e-6, "landings stay inside the render");
});

test("lineage: recordings, kit rows and lanes from a compiled timeline", async () => {
  const { lineage, islands } = await import("../src/ui/flow/lineage.ts");
  const piece = (source: number, a: number, b: number, name?: string) => ({ source, src_start: a, src_end: b, ...(name ? { name } : {}) });
  const tl = {
    tempo: 90, meter: 4, key: "C", length_beats: 4, warnings: [], harmony: [],
    sources: [
      { clip: "brk", path: "samples/x/stems/March/drums.wav", region: [10, 12] as [number, number] },
      { clip: "hit", path: "samples/x/stems/March/drums.wav", region: [0, 60] as [number, number] },
      { clip: "horn", path: "samples/x/March.mp3" },
    ],
    tracks: [
      { name: "b", clip: "b", region_key: "C", kit: "b", pieces: [piece(0, 10, 11), piece(0, 11, 12)] },
      { name: "d", clip: "d", region_key: "C", kit: "d", pieces: [piece(1, 40, 40.3, "kick"), piece(2, 5, 5.5, "stab")] },
      { name: "d.kick", clip: "d.kick", region_key: "C", pieces: [piece(1, 40, 40.3, "kick")] },
      { name: "horn", clip: "horn", region_key: "C", pieces: [piece(2, 20, 22)] },
    ],
    events: [
      { track: "b", source: 0, start_beat: 0, dur_beats: 0.5, src_start: 10, src_end: 11, semitones: 0, piece: 0 },
      { track: "b", source: 0, start_beat: 1, dur_beats: 0.5, src_start: 11, src_end: 12, semitones: 0, piece: 1 },
      { track: "d", source: 1, start_beat: 0, dur_beats: 0.25, src_start: 40, src_end: 40.3, semitones: 0, piece: 0 },
      { track: "d.kick", source: 1, start_beat: 2, dur_beats: 0.25, src_start: 40, src_end: 40.3, semitones: 0, piece: 0 },
      { track: "horn", source: 2, start_beat: 0, dur_beats: 4, src_start: 20, src_end: 22, semitones: 5, piece: 0 },
    ],
  };
  const l = lineage(tl);
  assert.deepEqual(l.recordings.map((r) => r.title), ["March/drums", "March"], "one row per recording; stems named with their piece");
  assert.deepEqual(l.recordings[0].clips, ["brk", "hit"]);
  assert.deepEqual(l.rows.map((r) => r.label), ["kit b", "kit d", "clip horn"], "a pad played on its own joins its kit's row");
  assert.equal(l.eventPiece[2], l.eventPiece[3], "the same pad, whichever track plays it");
  assert.equal(l.pieces[l.eventPiece[2]].events.length, 2);
  assert.equal(l.pieces[l.eventPiece[2]].label, "kick");
  assert.equal(l.lanes[2].detail, "pad of kit d");
  assert.equal(l.recordings[0].islands.length, 2, "10–12 s and 40 s are far apart: two islands");
  assert.deepEqual(islands([[1, 2], [2.5, 3]], 2, 0.5), [{ from: 0.5, to: 3.5 }], "near spans merge");
});

test("hero metronome: on the horns' grid, from the start until the drums are heard", async () => {
  const { Story } = await import("../src/ui/flow/story.ts");
  const d = bundle("hero");
  const story = new Story(d);
  const m = story.metronome();
  const cues = story.cues();
  const hornsAlone = cues.find((c) => c.loop && c.index === 0)!;
  const drumsHeard = Math.min(...cues.filter((c) => c.kind === "source" && c.index === 1).map((c) => c.t));
  assert.equal(m.anchor, hornsAlone.t, "a click falls exactly where the horns' first playback starts");
  assert.equal(m.until, drumsHeard, "the clicks stop when the drums are first heard");
  assert.ok(Math.abs(m.spb - 60 / d.tempo) < 1e-9, "one click per beat of the score");
  assert.ok(m.anchor % m.spb < m.spb && m.until > m.anchor, "clicks run from the start through the horns' playback");
});

test("hero sound is remembered across a reload, and storage failures are harmless", async () => {
  const { soundRemembered, rememberSound, soundView } = await import("../src/ui/flow/hero-audio.ts");
  const store = new Map<string, string>();
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  assert.equal(soundRemembered(fake), false, "off until turned on");
  rememberSound(true, fake);
  assert.equal(soundRemembered(fake), true, "on survives");
  rememberSound(false, fake);
  assert.equal(soundRemembered(fake), false, "turning it off forgets it");
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(soundRemembered(blocked), false);
  assert.doesNotThrow(() => rememberSound(true, blocked));
  const armed = soundView("armed");
  assert.ok(armed.pressed && !armed.disabled && /click/.test(armed.label), "after a reload: on, waiting for a click");
});

test("story clock: the hero keeps its timing; any number of sources get their turn", async () => {
  const { plan } = await import("../src/ui/flow/story.ts");
  const hero = plan(bundle("hero"));
  assert.deepEqual(hero.chapters.map((c) => c.label), ["Listen", "Clip", "Slice", "Warp", "Kit", "Play"]);
  assert.equal(hero.sessions.at(-1)!.from, hero.chapters.at(-1)!.t);
  for (const slug of slugs) {
    const d = bundle(slug);
    const p = plan(d);
    assert.equal(p.ph.length, d.sources.length, `${slug}: a turn for every source`);
    for (let n = 1; n < p.ph.length; n++) assert.ok(p.ph[n].appear[0] >= p.ph[n - 1].fill[1], `${slug}: source ${n} comes after the one before`);
    assert.deepEqual(p.chapters.map((c) => c.t), [...p.chapters.map((c) => c.t)].sort((a, b) => a - b), `${slug}: chapters in order`);
    assert.equal(new Set(p.chapters.map((c) => c.label)).size, p.chapters.length, `${slug}: no two chapters share a name`);
    assert.ok(p.loop > p.sessions.at(-1)!.from && p.still < p.loop, `${slug}: the finale plays inside the loop`);
    assert.deepEqual(p.sessions.at(-1)!.sources, d.sources.map((_: unknown, n: number) => n), `${slug}: the finale plays every source`);
  }
  const blues = plan(bundle("march-blues"));
  assert.deepEqual(blues.chapters.slice(0, 3).map((c) => c.label), ["Listen", "Clip", "Warp"], "a clip is not sliced");
});

test("story metronome: off when a kit comes first, to the finale when there is none", async () => {
  const { Story } = await import("../src/ui/flow/story.ts");
  const hero = bundle("hero");
  const swapped = { ...hero, sources: [hero.sources[1], hero.sources[0]], tiles: hero.tiles.map((t: { source: number }) => ({ ...t, source: 1 - t.source })) };
  const m = new Story(swapped).metronome();
  assert.ok(m.until <= 2.5 + 1e-9, "the kit is heard at once: no clicks before it");
  const blues = new Story(bundle("march-blues"));
  assert.equal(blues.metronome().until, blues.plan.sessions.at(-1)!.from, "no kit: clicks until the finale");
});

test("every breakdown draws and captions its whole story without throwing", async () => {
  const { Story } = await import("../src/ui/flow/story.ts");
  const noop = () => {};
  const g = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 10 }) : k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop: noop }) : noop),
    set: (t, k, v) => ((t[k] = v), true),
  }) as unknown as CanvasRenderingContext2D;
  const th = { ink: "#000", inkSoft: "#777", card: "#fff", line: "#ddd", night: "#fff", sun: "#f90", sun2: "#fc9", clips: ["#a0a", "#fa0", "#0aa", "#aa0"], clipInk: "#000", mono: "monospace", sans: "sans" };
  for (const slug of slugs) {
    const s = new Story(bundle(slug));
    for (let t = 0; t < s.loop; t += 0.37) {
      s.draw(g, 800, 380, t, th, false);
      const c = s.caption(t);
      assert.ok(c.title && c.text, `${slug} at ${t.toFixed(2)}s has a caption`);
    }
    s.draw(g, 400, 340, s.still, th, true);
  }
});
