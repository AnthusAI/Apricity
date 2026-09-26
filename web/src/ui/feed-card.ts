// A card on a page of things to hear (Activity, a tag's leaderboard): what it sounds like first, then who made it,
// its tags and stars, then what people say about it. The stage draws a score's strip (its tracks' events and chords)
// or a sample's envelope (loudness per beat, keys), and plays it from the big button; one card plays at a time
// (audio/feed-audio.ts). Nothing is fetched until the card scrolls into view.

import { el } from "./dom";
import { api, manifest } from "../apricity";
import { owns, SignedOut, type Me, type ScoreItem, type ScoreKind } from "../data/catalog";
import type { Handles } from "../data/handles";
import { href, PAGE_OF_KIND, type Route } from "../route";
import { go } from "./at";
import { PlayButton, type PlayState } from "./play-button";
import { StarRating } from "./stars";
import { tagRow } from "./tag-chips";
import { CommentThread } from "./comments";
import { commentsOn } from "../data/comments";
import { timeAgo } from "./time";
import { ratings } from "../apricity";
import { player } from "../audio/player";
import { mode } from "../data/client";
import { compiledScore, playingKey, playSample, playScore, stopFeed } from "../audio/feed-audio";
import { envelopeModel, stripModel, type EnvelopeModel, type StripModel } from "../data/feed-visual";

export interface FeedItem {
  type: "score" | "sample" | "clip";
  id: string;
  title: string;
  /** "Beat", "Sample", "Clip"… and the kind's key for its color ("beat", "clip"). */
  kindLabel: string;
  kindKey: string;
  owner: string | null;
  /** Where the title goes (its deep link). */
  route: Route;
  score?: { path: string };
  /** A sample (its audio path, "samples/…"), or a clip of it: its range, or its id to look the range up. */
  sample?: { path: string; clip?: [number, number]; clipId?: string };
  tags: string[];
  stars: { average: number | null; count: number };
  /** One quiet line of news ("@ann rated it ★★★★ · 5m"). */
  note?: string;
  /** Its place on a leaderboard. */
  rank?: number;
  /** Stars and news fetched once the card is in view (Activity's cards). */
  later?: () => Promise<{ stars?: FeedItem["stars"]; note?: string }>;
}

const SCORE_KIND_LABEL: Record<ScoreKind, string> = { song: "Score", beat: "Beat", chords: "Chords", melody: "Melody" };

/** A score as a card (`rank`: its place on a leaderboard). */
export function scoreFeedItem(s: ScoreItem, stars: FeedItem["stars"], rank?: number, note?: string): FeedItem {
  return {
    type: "score",
    id: s.id,
    title: s.title,
    kindLabel: SCORE_KIND_LABEL[s.kind],
    kindKey: s.kind,
    owner: s.owner,
    route: { page: PAGE_OF_KIND[s.kind], score: s.path },
    score: { path: s.path },
    tags: s.tags,
    stars,
    ...(rank ? { rank } : {}),
    ...(note ? { note } : {}),
  };
}

export interface FeedDeps {
  who: Me | null;
  names: Handles | null;
}

const signIn = () => document.dispatchEvent(new CustomEvent("apricity:sign-in"));
const STAGE_H = 132;

/** Compiles (and manifests) one card at a time, so a page of cards doesn't compile everything at once. */
let queue: Promise<unknown> = Promise.resolve();
const inTurn = <T>(f: () => Promise<T>): Promise<T> => {
  const p = queue.then(f, f);
  queue = p.catch(() => undefined);
  return p;
};

/** "you", "@ann" or "someone". */
export function whoLabel(deps: FeedDeps, owner: string | null | undefined): string {
  if (mode() === "local" || (owner && owns(deps.who, owner))) return "you"; // a local library is all yours
  const h = deps.names?.of(owner);
  return h ? `@${h}` : "someone";
}

export class FeedCard {
  readonly root: HTMLElement;
  private canvas = el("canvas", { className: "feed-canvas" });
  private play: PlayButton;
  private strip: StripModel | null = null;
  private envelope: EnvelopeModel | null = null;
  private placeholder = "";
  private blocked: "sign-in" | null = null;
  private playhead: number | null = null; // beats (a score) or seconds (a sample)
  private key: string;
  private talk = el("div", { className: "feed-talk" });
  private note = el("div", { className: "feed-note" });
  private paintStars = () => {};
  /** It has been on the page (so leaving it means it was dropped). */
  private shown = false;

  constructor(
    private item: FeedItem,
    private deps: FeedDeps,
  ) {
    this.key = `${item.type}:${item.id}`;
    this.note.textContent = item.note ?? "";
    this.note.hidden = !item.note;
    this.play = new PlayButton(item.type === "score" ? "score" : "sample", () => void this.toggle());
    const title = el("a", { className: "feed-title", href: href(item.route), textContent: item.title || "(untitled)" });
    title.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      go(item.route);
    });
    const stars = new StarRating(
      async (n) => void (await (await ratings()).rate(item.type, item.id, n)),
      signIn,
      true,
    );
    let mine: number | null = null;
    const paintStars = () => stars.set({ mine, average: this.item.stars.average, count: this.item.stars.count, signedIn: !!deps.who });
    paintStars();
    void ratings()
      .then((r) => r.mineFor(item.type, item.id))
      .then((m) => ((mine = m), paintStars()), () => undefined);
    this.paintStars = paintStars;
    const stage = el("div", { className: "feed-stage" }, this.canvas, this.play.root);
    this.root = el(
      "article",
      { className: `feed-card k-${item.kindKey}` },
      stage,
      el(
        "div",
        { className: "feed-body" },
        el(
          "div",
          { className: "feed-head" },
          ...(item.rank ? [el("span", { className: "feed-rank" }, String(item.rank))] : []),
          el("div", { className: "feed-titles" }, title, el("div", { className: "feed-by" }, el("span", { className: "feed-kind" }, item.kindLabel), item.owner ? ` by ${whoLabel(deps, item.owner)}` : "")),
          stars.el,
        ),
        ...(item.tags.length ? [tagRow(item.tags)] : []),
        this.note,
        this.talk,
      ),
    );
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    // Load what it needs the first time it's (nearly) on screen.
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        seen.disconnect();
        this.shown = true;
        void this.loadVisual();
        void this.loadTalk();
        void this.loadLater();
      },
      { rootMargin: "300px" },
    );
    seen.observe(this.root);
    // A score's playhead follows the engine while this card is the one playing.
    if (item.type === "score") {
      const off = player.onTransport((t) => {
        if (!this.root.isConnected) return void (this.shown && off()); // the page dropped this card
        if (playingKey() !== this.key || !this.strip) return;
        const beat = t.position / t.framesPerBeat;
        this.playhead = t.playing ? beat % this.strip.beats : null;
        this.draw();
      });
    }
  }

  private async loadLater() {
    const got = await this.item.later?.().catch(() => null);
    if (!got) return;
    if (got.stars) (this.item.stars = got.stars), this.paintStars();
    if (got.note) (this.note.textContent = got.note), (this.note.hidden = false);
  }

  /** A clip known by its id: its range, from its sample's clips. */
  private async clipRange(): Promise<[number, number] | undefined> {
    const s = this.item.sample;
    if (!s || s.clip || !s.clipId) return s?.clip;
    const m = await manifest(s.path);
    const c = m?.annotations?.clips?.find((x) => x.id === s.clipId);
    if (c) s.clip = [c.start, c.end];
    return s.clip;
  }

  private async loadVisual() {
    const it = this.item;
    try {
      if (it.score) {
        const path = it.score.path;
        const tl = await inTurn(() => compiledScore(path, () => api.score(path)));
        this.strip = stripModel(tl);
      } else if (it.sample) {
        const m = await inTurn(() => manifest(it.sample!.path));
        if (m) this.envelope = envelopeModel(m as never, await this.clipRange());
      }
    } catch (e) {
      const signedOut = e instanceof SignedOut || /sign in/i.test((e as Error).message);
      this.blocked = signedOut ? "sign-in" : null;
      this.placeholder = signedOut ? "Sign in to hear it" : `Can't draw it: ${(e as Error).message}`;
    }
    this.draw();
  }

  private async toggle() {
    if (this.blocked === "sign-in") return signIn();
    if (playingKey() === this.key) return stopFeed();
    const report = (s: PlayState) => {
      this.play.set(s);
      if (s.kind !== "playing") (this.playhead = null), this.draw();
    };
    const it = this.item;
    if (it.score) {
      try {
        const path = it.score.path;
        report({ kind: "loading", label: "Getting the score ready" });
        const tl = await compiledScore(path, () => api.score(path));
        this.strip ??= stripModel(tl);
        await playScore(this.key, tl, report);
      } catch (e) {
        report({ kind: "error", message: (e as Error).message });
      }
    } else if (it.sample) {
      await this.clipRange().catch(() => undefined);
      await playSample(this.key, it.sample.path, it.sample.clip ?? null, report, (t) => ((this.playhead = t), this.draw()));
    }
  }

  /** The newest two comments, and a way into the whole thread. */
  private async loadTalk() {
    const it = this.item;
    let rows: Awaited<ReturnType<typeof commentsOn>> = [];
    try {
      rows = (await commentsOn(it.id)).filter((c) => !c.deleted);
    } catch {
      /* no comments shown; the button still opens the thread */
    }
    rows.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    const latest = rows.slice(-2);
    const open = el("button", { type: "button", className: "feed-talk-open" }, rows.length > 2 ? `All ${rows.length} comments` : rows.length ? "Reply…" : "Add a comment…");
    open.addEventListener("click", () => {
      const thread = new CommentThread({ type: it.type, id: it.id }, { title: false });
      this.talk.replaceChildren(thread.root);
      void thread.load();
    });
    this.talk.replaceChildren(
      ...latest.map((c) => el("div", { className: "feed-comment" }, el("b", {}, whoLabel(this.deps, c.owner)), el("span", { className: "feed-ago" }, ` · ${timeAgo(c.createdAt)}`), el("p", {}, c.body))),
      open,
    );
  }

  private draw() {
    const c = this.canvas;
    const w = c.clientWidth;
    if (!w) return;
    const dpr = devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(STAGE_H * dpr);
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(this.root);
    const col = (v: string, d: string) => css.getPropertyValue(v).trim() || d;
    const fg = col("--fg", "#222");
    const muted = col("--muted", "#888");
    const line = col("--line", "#ddd");
    const accent = col("--accent", "#36f");
    g.clearRect(0, 0, w, STAGE_H);
    if (this.strip) drawStrip(g, this.strip, w, STAGE_H, { fg, muted, line, accent }, this.playhead);
    else if (this.envelope) drawEnvelope(g, this.envelope, w, STAGE_H, { fg, muted, line, accent }, this.playhead);
    else {
      g.fillStyle = muted;
      g.font = "12px system-ui, sans-serif";
      g.fillText(this.placeholder || "…", 14, STAGE_H - 14);
    }
  }
}

type Colors = { fg: string; muted: string; line: string; accent: string };

/** A lane's color: evenly around the wheel, warm first. */
const laneColor = (i: number, n: number, a = 1) => `hsla(${(18 + (i * 360) / Math.max(n, 1)) % 360}, 70%, 58%, ${a})`;
const keyColor = (label: string) => {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsla(${h}, 55%, 60%, 0.8)`;
};

function drawStrip(g: CanvasRenderingContext2D, m: StripModel, w: number, h: number, c: Colors, playhead: number | null) {
  const top = 18; // the chord row
  const x = (b: number) => (b / m.beats) * w;
  // Bars.
  g.strokeStyle = c.line;
  g.lineWidth = 1;
  for (let b = 0; b <= m.beats; b += m.meter) {
    g.beginPath();
    g.moveTo(Math.round(x(b)) + 0.5, top);
    g.lineTo(Math.round(x(b)) + 0.5, h);
    g.stroke();
  }
  // Chords along the top.
  g.font = "600 11px system-ui, sans-serif";
  g.textBaseline = "middle";
  for (const ch of m.chords) {
    const x0 = x(ch.start);
    const cw = x(ch.end) - x0;
    if (cw < 14) continue;
    g.fillStyle = c.muted;
    g.save();
    g.beginPath();
    g.rect(x0, 0, cw - 2, top);
    g.clip();
    g.fillText(ch.label.replace(/b/g, "♭"), x0 + 3, top / 2);
    g.restore();
  }
  // Lanes and their events.
  const n = m.lanes.length || 1;
  const laneH = (h - top - 4) / n;
  m.lanes.forEach((lane, i) => {
    const y = top + 2 + i * laneH;
    g.fillStyle = laneColor(i, n);
    for (const [s, d] of lane.blocks) {
      const x0 = x(s);
      const bw = Math.max(2, x(s + d) - x0 - 1);
      const bh = Math.max(2, laneH - 3);
      g.beginPath();
      g.roundRect(x0, y + 1, bw, bh, Math.min(3, bh / 2, bw / 2));
      g.fill();
    }
  });
  if (playhead !== null) {
    g.fillStyle = c.fg;
    g.fillRect(x(playhead), top, 2, h - top);
  }
}

function drawEnvelope(g: CanvasRenderingContext2D, m: EnvelopeModel, w: number, h: number, c: Colors, playhead: number | null) {
  const span = m.to - m.from || 1;
  const x = (t: number) => ((t - m.from) / span) * w;
  const base = h - 10; // the key band below
  if (m.highlight) {
    g.fillStyle = c.accent;
    g.globalAlpha = 0.12;
    g.fillRect(x(m.highlight[0]), 0, x(m.highlight[1]) - x(m.highlight[0]), base);
    g.globalAlpha = 1;
  }
  for (const b of m.bars) {
    const inClip = !m.highlight || (b.t1 > m.highlight[0] && b.t0 < m.highlight[1]);
    const bh = Math.max(2, b.v * (base - 8));
    const x0 = x(b.t0);
    const bw = Math.max(1, x(b.t1) - x0 - 1);
    g.fillStyle = inClip ? c.accent : c.muted;
    g.globalAlpha = inClip ? 0.85 : 0.35;
    g.beginPath();
    g.roundRect(x0, (base - bh) / 2 + 4, bw, bh, Math.min(2, bw / 2));
    g.fill();
  }
  g.globalAlpha = 1;
  g.fillStyle = c.muted;
  for (const t of m.downbeats) g.fillRect(Math.round(x(t)), base - 3, 1, 3);
  for (const k of m.keys) {
    g.fillStyle = keyColor(k.label);
    g.fillRect(x(k.t0), base + 3, Math.max(1, x(k.t1) - x(k.t0) - 1), 5);
  }
  if (playhead !== null) {
    g.fillStyle = c.fg;
    g.fillRect(x(playhead), 0, 2, base);
  }
}
