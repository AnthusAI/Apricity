// Samples and Clips: every analyzed sample (or every clip saved with one), ranked by stars, and a waveform editor for
// the clips saved with a sample. The two tabs are one view: opening a clip opens its sample with that clip selected.

import { notify, reportError } from "./notices";
import { api, audioUrl, manifest, me, ratings, type SampleSummary, type SavedClip } from "../apricity";
import { owns, SignedOut, type ClipItem, type Me } from "../data/catalog";
import { byline, handles, type Handles } from "../data/handles";
import { mode } from "../data/client";
import { player } from "../audio/player";
import { reasonOf } from "../audio/pending";
import { el } from "./dom";
import { RankedList } from "./ranked-list";
import { CommentThread } from "./comments";
import { commentsOn, countOf, threadOf } from "../data/comments";
import { opened, type Opened } from "./at";
import { sampleKey } from "../route";
import { applyClipFilter, CHOICES, CLIP_KINDS, DEFAULT_FILTER, filterQuery, kindOf, KIND_LABEL, parseFilter, type ClipFilter } from "../data/clip-filter";
import { totals, type Standing } from "../data/rank-window";
import { columnSplitter } from "./splitter";
import { licensePanel } from "./credits";
import { StarRating } from "./stars";
import type { PlayState } from "./play-button";
import { computePeaks, Waveform } from "./waveform";

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const keyLabel = (k: string) => k.replace(/b/g, "♭");
const GROUPS: Record<string, string> = { "marine-band": "U.S. Marine Band", "citizen-dj": "Library of Congress · Citizen DJ", uploads: "Your uploads" };
const signIn = () => document.dispatchEvent(new CustomEvent("apricity:sign-in"));

export type LibraryMode = "samples" | "clips";

/** A sample's year for its list row: when it was recorded, else when the piece was written ("1889"), when known. */
const yearOf = (c: Pick<SampleSummary, "recorded" | "composed">) => (c.recorded ? String(c.recorded).slice(0, 4) : c.composed ? `written ${c.composed}` : "");

export class Library {
  root: HTMLElement;
  samples: SampleSummary[] = [];
  clips: ClipItem[] = [];
  current: string | null = null;
  /** In the Clips tab: the clip that is open (selected on its sample's waveform). */
  private currentClip: ClipItem | null = null;
  private detailEl = el("div", { className: "detail" });
  private jobsEl = el("div", { className: "jobs" });
  private decoded = new Map<string, Promise<AudioBuffer>>();
  private audition: AudioBufferSourceNode | null = null;
  /** What the top bar's play button plays here: the shown sample (a selection or a clip of it, else all of it). */
  private playable: { buf: AudioBuffer; wave: Waveform; range: () => [number, number] | null } | null = null;
  private playState: PlayState = { kind: "unavailable", why: "Pick a sample to hear it" };
  private playListeners: ((s: PlayState) => void)[] = [];
  private jobsTimer = 0;
  private who: Me | null = null;
  private names: Handles | null = null;
  private list: RankedList<SampleSummary> | RankedList<ClipItem>;
  private stars = new StarRating((n) => this.rate(n), signIn);
  /** Clips: how the list is narrowed and sorted (kept in the URL, and remembered). */
  private filter: ClipFilter = DEFAULT_FILTER;
  private filterEl = el("div", { className: "clip-filters" });
  /** Your stars on clips, by id (for the rows' stars and the "Not rated by me" filter). */
  private myStars = new Map<string, number>();
  /** What the audition playing now is (a clip's id, or a row on the sample page), and how its button resets. */
  private auditionKey: string | null = null;
  private auditionEnded: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    readonly mode: LibraryMode = "samples",
  ) {
    this.root = root;
    const loadSamples = async () => {
      const [r, who, names] = await Promise.all([api.samples(), me().catch(() => null), handles()]);
      this.who = who;
      this.names = names;
      this.samples = r.samples;
      this.jobs = r.jobs;
      this.renderJobs();
      return r.samples;
    };
    if (mode === "samples") {
      this.list = new RankedList<SampleSummary>({
        name: "samples",
        load: loadSamples,
        tallies: async () => (await ratings()).tallies("sample"),
        row: (c) => ({
          title: c.title + (c.excerpt_start ? ` @${c.excerpt_start.replace(/^00:/, "")}` : ""),
          sub: `${c.undocumented ? "⚠ no license documented · " : ""}${GROUPS[c.group] ?? c.group}${yearOf(c) ? ` · ${yearOf(c)}` : ""} · ${keyLabel(c.key)} · ${c.bpm ? Math.round(c.bpm) + " BPM" : "no beat"} · ${fmt(c.duration)}${c.clips ? ` · ${c.clips} clip${c.clips > 1 ? "s" : ""}` : ""}`,
        }),
        text: (c) => [c.title, c.key, c.camelot, String(Math.round(c.bpm ?? 0)), c.group, GROUPS[c.group] ?? ""].join(" "),
        me: async () => this.who,
        open: (c) => this.show(c.path, "user"),
      });
    } else {
      this.list = new RankedList<ClipItem>({
        name: "clips",
        load: async () => {
          await loadSamples();
          [this.clips, this.myStars] = await Promise.all([api.clips(), this.loadMyStars()]);
          this.renderFilters();
          return this.clips;
        },
        tallies: async () => (await ratings()).tallies("clip"),
        row: (c) => ({
          title: c.name,
          sub: `${c.undocumented ? "⚠ no license documented · " : ""}${c.sampleTitle} · ${(c.end - c.start).toFixed(2)} s · ${c.source === "ml" && !owns(this.who, c.owner) ? "found by analysis" : byline(this.names, c.owner, owns(this.who, c.owner)) || "made by someone"}${this.copiedFrom(c)}`,
        }),
        text: (c) => `${c.name} ${c.sampleTitle} ${c.samplePath} ${byline(this.names, c.owner, false)}`,
        owner: (c) => c.owner,
        me: async () => this.who,
        open: (c) => ((this.currentClip = c), this.show(c.samplePath, "user")),
        tools: this.filterEl,
        refine: (rows) => applyClipFilter(rows, this.filter, { me: this.who, mine: this.myStars, now: new Date() }),
        extra: (c, standing) => el("div", { className: "row-extra" }, this.playButton(c.id, `Play ${c.name}`, () => this.playClip(c)), this.rowStars(c.id, standing), this.talkButton(c)),
      });
      try {
        this.filter = parseFilter(localStorage.getItem("apricity.clips.filter") ?? "");
      } catch {} // storage can be blocked (private browsing): nothing to report
      this.renderFilters();
    }
    this.list.el.append(this.jobsEl);
    root.append(this.list.el, this.detailEl);
    columnSplitter({ view: root, panel: this.list.el, edge: "right", prop: "--list-w", key: `${mode}-list`, min: 200, max: (w) => Math.min(560, w - 420) });
    document.addEventListener("apricity:auth-changed", () => ((this.current = null), this.decoded.clear(), this.refresh()));
  }

  private cloud() {
    return mode() === "cloud";
  }

  /** " · copied from loop-1 by @ann" for someone's copy of another person's clip (else ""). */
  private copiedFrom(c: ClipItem): string {
    if (!c.copyOf) return "";
    const p = this.clips.find((x) => x.id === c.copyOf);
    if (!p) return " · copied from a clip that's gone";
    const by = byline(this.names, p.owner, owns(this.who, p.owner)).replace(/^by /, "") || (p.source === "ml" ? "analysis" : "someone");
    return ` · copied from ${p.name} by ${by}`;
  }

  private async loadMyStars(): Promise<Map<string, number>> {
    return (await ratings()).mineOf("clip").catch((e) => (reportError("load your ratings", e), new Map<string, number>()));
  }

  /** The list's filter as the URL carries it ({} when it's the default). */
  private listQuery(): { list?: string } {
    const q = filterQuery(this.filter);
    return q ? { list: q } : {};
  }

  /** Take the filter from a URL (Clips); undefined keeps the one in use. */
  setFilterQuery(query: string | undefined) {
    if (query === undefined || this.mode !== "clips") return;
    this.filter = parseFilter(query);
    this.renderFilters();
    this.list.render();
  }

  /** Say what's open and how the list is filtered (Clips' tab was chosen: the address bar names them). */
  report() {
    const c = this.currentClip;
    opened(c ? { page: "clips", clip: { sample: sampleKey(c.samplePath), name: c.name }, ...this.listQuery() } : { page: "clips", ...this.listQuery() }, "auto", c?.name);
  }

  private setFilter(f: ClipFilter) {
    this.filter = f;
    try {
      localStorage.setItem("apricity.clips.filter", filterQuery(f));
    } catch {} // storage can be blocked (private browsing): nothing to report
    this.renderFilters();
    this.list.render();
    this.report();
  }

  /** The Clips list's filters and sort: one menu each, and Reset when any is set. */
  private renderFilters() {
    const f = this.filter;
    const menu = <K extends keyof ClipFilter>(key: K, label: string, options: readonly (readonly [string, string])[]) => {
      const s = el("select", { ariaLabel: label, title: label }, ...options.map(([v, text]) => el("option", { value: v, textContent: text })));
      s.value = f[key];
      s.classList.toggle("set", f[key] !== DEFAULT_FILTER[key]);
      s.addEventListener("change", () => this.setFilter({ ...this.filter, [key]: s.value }));
      return s;
    };
    const samples = [...new Map(this.clips.map((c) => [c.samplePath, c.sampleTitle])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (f.sample && !samples.some(([p]) => p === f.sample)) samples.unshift([f.sample, f.sample]);
    const reset = el("button", { type: "button", className: "btn link", hidden: !filterQuery(f) }, "Reset");
    reset.addEventListener("click", () => this.setFilter(DEFAULT_FILTER));
    this.filterEl.replaceChildren(
      menu("sort", "Sort by", CHOICES.sort),
      menu("stars", "Stars", CHOICES.stars),
      menu("kind", "Kind", CHOICES.kind),
      menu("origin", "Made by", CHOICES.origin),
      menu("length", "Length", CHOICES.length),
      menu("added", "Added", CHOICES.added),
      menu("sample", "Sample", [["", "Every sample"], ...samples]),
      reset,
    );
  }

  /** A small ▶ that plays something and turns into ■ while it does. */
  private playButton(key: string, label: string, play: () => Promise<boolean>): HTMLButtonElement {
    const b = el("button", { type: "button", className: "row-play", ariaLabel: label, title: label }, this.auditionKey === key ? "■" : "▶");
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (this.auditionKey === key) return this.stopAudition();
      if (!(await play())) return;
      this.auditionKey = key;
      b.textContent = "■";
      this.auditionEnded = () => (b.textContent = "▶");
    });
    return b;
  }

  /** Play one clip from the list (without opening it). */
  private async playClip(c: ClipItem): Promise<boolean> {
    let buf: AudioBuffer;
    try {
      buf = await this.decode(c.samplePath);
    } catch (e) {
      this.decoded.delete(c.samplePath);
      reportError(`play ${c.name}`, e);
      return false;
    }
    const wave = this.current === c.samplePath ? (this.playable?.wave ?? null) : null;
    return this.startAudition(buf, c.start, c.end, wave);
  }

  /** 💬 on a list row: open the clip at its comments. */
  private talkButton(c: ClipItem): HTMLButtonElement {
    const b = el("button", { type: "button", className: "row-talk", title: "Comments on this clip" }, "💬");
    b.addEventListener("click", async () => {
      this.list.current = c.id;
      this.list.render();
      this.currentClip = c;
      await this.show(c.samplePath, "user");
      this.detailEl.querySelector(".comments")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return b;
  }

  /** Small stars for a clip in a row: yours, over everyone's average. */
  private rowStars(id: string, standing: Pick<Standing, "average" | "count">, rated?: () => void): HTMLElement {
    const w = new StarRating(
      async (n) => {
        rated?.(); // e.g. open its comments, to say why
        await (await ratings()).rate("clip", id, n);
        if (n === null) this.myStars.delete(id);
        else this.myStars.set(id, n);
        if (this.currentClip?.id === id) void this.paintStars();
      },
      signIn,
      true,
    );
    w.set({ mine: this.myStars.get(id) ?? null, average: standing.average, count: standing.count, signedIn: !!this.who });
    return w.el;
  }

  /** Open a sample (Samples) or a clip (Clips) by its record id, e.g. from an Activity card. */
  async openId(id: string, how: Opened = "user") {
    await this.list.refresh();
    if (this.mode === "clips") {
      const clip = this.clips.find((c) => c.id === id);
      return clip ? this.openClipItem(clip, how) : undefined;
    }
    const s = this.samples.find((x) => x.id === id);
    if (s) return this.show(s.path, how);
  }

  /** Open what a URL names: a sample by its path without extension, or (Clips) one of its clips by name. */
  async openKey(sample: string, clipName: string | undefined, how: Opened) {
    await this.list.refresh();
    if (this.mode === "clips") {
      const clip = this.clips.find((c) => sampleKey(c.samplePath) === sample && c.name === clipName);
      if (clip) return this.openClipItem(clip, how);
      return notify(`There's no clip ${clipName} on ${sample}.`, { kind: "info" });
    }
    const s = this.samples.find((x) => sampleKey(x.path) === sample);
    if (s) return this.show(s.path, how);
    notify(`There's no sample ${sample} here${this.cloud() ? " (or it isn't public yet)" : ""}.`, { kind: "info" });
  }

  private openClipItem(clip: ClipItem, how: Opened) {
    this.currentClip = clip;
    this.list.current = clip.id;
    this.list.render();
    return this.show(clip.samplePath, how);
  }

  /** Load (or reload) the list; opens `select`, or what was open, or the top of the list. */
  async refresh(select?: string) {
    const items = await this.list.refresh();
    const running = this.jobs.filter((j) => j.state === "analyzing" || j.state === "queued");
    clearTimeout(this.jobsTimer);
    if (running.length) this.jobsTimer = window.setTimeout(() => this.refresh(), 3000);
    if (!items.length) {
      this.detailEl.replaceChildren(el("div", { className: "empty" }, this.mode === "clips" ? "No clips yet. Open a sample and drag across its waveform to make one." : "The library is empty."));
      return;
    }
    if (this.mode === "clips") {
      const clip = (this.currentClip && this.clips.find((c) => c.id === this.currentClip!.id)) ?? (this.list as RankedList<ClipItem>).top();
      if (clip && (clip.id !== this.currentClip?.id || !this.current)) {
        this.list.current = clip.id;
        this.list.render();
        this.currentClip = clip;
        this.show(clip.samplePath, "auto");
      }
      return;
    }
    const target = select ?? this.current ?? (this.list as RankedList<SampleSummary>).top()?.path;
    if (target && target !== this.current) this.show(target, "auto");
  }
  private jobs: { path: string; state: string; error?: string }[] = [];

  /** Samples being analyzed (local uploads). */
  private renderJobs() {
    this.jobsEl.replaceChildren(
      ...this.jobs
        .filter((j) => j.state !== "done")
        .map((job) => el("div", { className: "row" }, el("span", { className: "t" }, job.path.split("/").pop()!), el("span", { className: `pill ${job.state === "failed" ? "bad" : ""}` }, job.state === "failed" ? "failed" : "analyzing…"), el("span", { className: "sub" }, job.error ?? "beats, key, notes — about a minute"))),
    );
  }

  /** What the stars in the detail header rate: the open clip in the Clips tab, the sample otherwise. */
  private target(): { type: "sample" | "clip"; id: string } | null {
    if (this.mode === "clips") return this.currentClip ? { type: "clip", id: this.currentClip.id } : null;
    const c = this.samples.find((x) => x.path === this.current);
    return c ? { type: "sample", id: c.id } : null;
  }

  private async rate(stars: number | null) {
    const t = this.target();
    if (t) await (await ratings()).rate(t.type, t.id, stars);
  }

  private async paintStars() {
    const t = this.target();
    if (!t) return;
    const standing = this.list.standingOf(t.id);
    let mine: number | null = null;
    try {
      mine = await (await ratings()).mineFor(t.type, t.id);
    } catch (e) {
      reportError("load your rating", e);
    }
    const now = this.target();
    if (now?.id !== t.id) return;
    this.stars.set({ mine, average: standing?.average ?? null, count: standing?.count ?? 0, signedIn: !!this.who });
  }

  private decode(path: string) {
    if (!this.decoded.has(path)) {
      this.decoded.set(
        path,
        audioUrl(path)
          .then((url) => fetch(url))
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${path}: ${r.status}`))))
          .then((b) => new OfflineAudioContext(2, 1, 48000).decodeAudioData(b)),
      );
    }
    return this.decoded.get(path)!;
  }

  async show(path: string, how: Opened = "user") {
    this.current = path;
    // The address bar follows: the sample, or (in Clips) the clip open on it.
    const clipOpen = this.mode === "clips" ? this.currentClip : null;
    const summary = this.samples.find((x) => x.path === path);
    if (clipOpen) opened({ page: "clips", clip: { sample: sampleKey(clipOpen.samplePath), name: clipOpen.name }, ...this.listQuery() }, how, clipOpen.name);
    else if (this.mode === "samples") opened({ page: "samples", sample: sampleKey(path) }, how, summary?.title);
    if (this.mode === "samples") {
      const c = this.samples.find((x) => x.path === path);
      if (c) this.list.current = c.id;
    } else if (this.currentClip) this.list.current = this.currentClip.id;
    this.list.render();
    this.stopAudition();
    this.playable = null;
    this.setPlay({ kind: "loading", label: "Loading the sample" });
    const c = this.samples.find((x) => x.path === path);
    let m: Awaited<ReturnType<typeof manifest>>, buf: AudioBuffer;
    // Everyone's stars and yours on this sample's clips, for their rows (a failure leaves them unrated).
    const clipStars = Promise.all([
      ratings()
        .then((r) => r.tallies("clip"))
        .then((t) => totals(t, "all", new Date()))
        .catch(() => new Map<string, { count: number; sum: number }>()),
      this.loadMyStars(),
    ]);
    try {
      m = await manifest(path, true);
      if (!c || !m || this.current !== path) return;
      this.detailEl.replaceChildren(el("div", { className: "empty" }, "Loading audio…"));
      buf = await this.decode(path);
    } catch (e) {
      this.decoded.delete(path);
      if (this.current !== path) return;
      const msg = e instanceof SignedOut ? "Sign in to see this sample." : `Couldn't load ${path}: ${(e as Error).message}`;
      this.detailEl.replaceChildren(el("div", { className: "empty" }, msg));
      this.setPlay({ kind: "unavailable", why: msg });
      return;
    }
    if (this.current !== path) return;
    const [clipTotals, mine] = await clipStars;
    this.myStars = mine;
    if (this.current !== path) return;
    const standingOf = (id: string) => {
      const t = clipTotals.get(id);
      return { average: t && t.count ? t.sum / t.count : null, count: t?.count ?? 0 };
    };

    const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    const clips = structuredClone((m.annotations?.clips ?? []).filter((x) => !x.retired));
    // In the Clips tab, the open clip is selected.
    const picked = this.mode === "clips" && this.currentClip ? clips.findIndex((x) => x.id === this.currentClip!.id) : -1;
    const wave = new Waveform({
      duration: buf.duration,
      peaks: computePeaks(channels),
      manifest: m,
      clips,
      selected: picked >= 0 ? picked : null,
      selection: null,
      playhead: null,
    });
    let dirty = false;
    let showAuto = true;
    const errors = el("div", { className: "errors" });
    const save = el("button", { className: "btn primary", type: "button", disabled: true }, "Save clips");
    const makeClip = el("button", { className: "btn", type: "button", disabled: true }, "Make clip from selection");
    const snippet = el("button", { className: "btn", type: "button", disabled: true, title: "Copy a clip line for the score editor" }, "Copy for score");
    const table = el("table", { className: "slices" });

    const selectionOrClip = (): [number, number] | null => {
      const s = wave.state;
      if (s.selection && s.selection[1] - s.selection[0] >= 0.05) return s.selection;
      if (s.selected !== null) return [s.clips[s.selected].start, s.clips[s.selected].end];
      return null;
    };
    this.playable = { buf, wave, range: selectionOrClip };
    this.setPlay({ kind: "idle" });
    const markDirty = () => {
      dirty = true;
      save.disabled = false;
      save.textContent = this.cloud() && !this.who ? "Sign in to save clips" : "Save clips •";
    };
    // One clip's comments are open at a time, under its row: the clip you're working on. Playing it, rating it, clicking
    // its row or its name opens them; 💬 opens or closes them by hand. They open in place (no redraw), so typing in a
    // name or a comment keeps its focus. The threads and their counts outlive a redraw of the table.
    const threads = new Map<string, CommentThread>();
    const talkCounts = new Map<string, number>();
    const talkButtons = new Map<string, HTMLButtonElement>();
    let talkOn: string | null = null;
    const talkLabel = (id: string) => (talkCounts.get(id) ? `💬 ${talkCounts.get(id)}` : "💬 Comment");
    const threadFor = (id: string) => {
      let t = threads.get(id);
      if (!t) {
        t = new CommentThread({ type: "clip", id }, { onCount: (n) => (talkCounts.set(id, n), talkButtons.get(id) && (talkButtons.get(id)!.textContent = talkLabel(id))) });
        threads.set(id, t);
        void t.load();
      }
      return t;
    };
    const talkRow = (id: string) => el("tr", { className: "talk" }, el("td", { colSpan: COLS }, threadFor(id).root));
    const closeTalk = () => {
      for (const r of table.querySelectorAll("tr.talk")) r.remove();
      if (talkOn) talkButtons.get(talkOn)?.setAttribute("aria-expanded", "false");
      talkOn = null;
    };
    const openTalk = (id: string, tr: HTMLElement) => {
      if (talkOn === id) return;
      closeTalk();
      talkOn = id;
      tr.after(talkRow(id));
      talkButtons.get(id)?.setAttribute("aria-expanded", "true");
    };
    void Promise.all(
      clips.filter((x) => x.id).map(async (x) => talkCounts.set(x.id!, countOf(threadOf(await commentsOn(x.id!))))),
    ).then(
      () => {
        for (const [id, b] of talkButtons) b.textContent = talkLabel(id);
      },
      () => {}, // no counts: the buttons still open the threads
    );
    const COLS = 9;
    const renderTable = () => {
      const s = wave.state;
      talkButtons.clear();
      makeClip.disabled = !(s.selection && s.selection[1] - s.selection[0] >= 0.05);
      snippet.disabled = s.selected === null;
      const row = (sl: SavedClip, i: number) => {
        const auto = sl.source === "ml";
        const name = el("input", { value: sl.name, ariaLabel: "Clip name", spellcheck: false });
        // Only characters the manifest accepts can be typed (letters, digits, - and _).
        name.addEventListener("focus", () => engage());
        name.addEventListener("input", () => {
          const clean = name.value.replace(/[^A-Za-z0-9_-]+/g, "-");
          if (clean !== name.value) name.value = clean;
          sl.name = clean || `clip-${i + 1}`;
          if (sl.source === "ml") sl.source = "user"; // renamed, so it's yours now
          markDirty();
          wave.draw();
        });
        const del = el("button", { className: "btn", type: "button", ariaLabel: `Delete clip ${sl.name}` }, "Delete");
        del.addEventListener("click", () => (s.clips.splice(i, 1), (s.selected = null), markDirty(), renderTable(), wave.draw()));
        const kind = auto ? el("span", { className: "pill", title: "Found automatically; edit it to make it yours" }, (sl.tags ?? []).filter((t) => !/beats$/.test(t)).join(" · ") || "auto") : el("span", {});
        // Hear it (and select it on the waveform) without leaving the row; rate it once it's saved.
        const play = this.playButton(`${path}#${sl.id ?? `${sl.name}@${sl.start}`}`, `Play ${sl.name}`, () => {
          s.selected = i;
          s.selection = null;
          wave.draw();
          for (const r of table.querySelectorAll("tbody tr")) r.setAttribute("aria-selected", String(r === tr));
          engage();
          return this.startAudition(buf, sl.start, sl.end, wave);
        });
        const id = sl.id;
        /** Working on this clip: its comments open under it. */
        const engage = () => id && openTalk(id, tr);
        const stars = id ? this.rowStars(id, standingOf(id), engage) : el("span", { className: "hint", title: "Save the clip to rate it" }, "—");
        const talk = el("button", { type: "button", className: "row-talk", disabled: !id, title: id ? "Comments on this clip" : "Save the clip to comment on it" }, id ? talkLabel(id) : "💬");
        talk.setAttribute("aria-expanded", String(!!id && talkOn === id));
        if (id) {
          talkButtons.set(id, talk);
          talk.addEventListener("click", () => (talkOn === id ? closeTalk() : openTalk(id, tr)));
        }
        const tr = el("tr", {}, el("td", { className: "play-cell" }, play), el("td", {}, name), el("td", {}, kind), el("td", { className: "mono" }, fmt(sl.start)), el("td", { className: "mono" }, fmt(sl.end)), el("td", { className: "mono" }, `${(sl.end - sl.start).toFixed(2)} s`), el("td", {}, stars), el("td", {}, talk), el("td", {}, del));
        tr.setAttribute("aria-selected", String(i === s.selected));
        tr.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          s.selected = i;
          s.selection = null;
          if (id) talkOn = id;
          renderTable();
          wave.draw();
        });
        if (!id || talkOn !== id) return [tr];
        return [tr, el("tr", { className: "talk" }, el("td", { colSpan: COLS }, threadFor(id).root))];
      };
      // Yours (and new ones), then other people's, then the automatic ones (collapsed).
      const isMine = (sl: SavedClip) => !this.cloud() || !sl.owner || !sl.id || owns(this.who, sl.owner) || !!this.who?.curator;
      const mine = s.clips.map((sl, i) => [sl, i] as const).filter(([sl]) => sl.source !== "ml" && isMine(sl));
      const others = s.clips.map((sl, i) => [sl, i] as const).filter(([sl]) => sl.source !== "ml" && !isMine(sl));
      // The automatic ones by kind (loops first, one-shots last), in the order they come in the sample.
      const kindRank = (sl: SavedClip) => {
        const k = kindOf({ kind: sl.tags?.find((t) => (CLIP_KINDS as readonly string[]).includes(t)), name: sl.name });
        return k ? CLIP_KINDS.indexOf(k) : CLIP_KINDS.length;
      };
      const auto = s.clips
        .map((sl, i) => [sl, i] as const)
        .filter(([sl]) => sl.source === "ml")
        .sort(([a], [b]) => kindRank(a) - kindRank(b) || a.start - b.start);
      const head = el("thead", {}, el("tr", {}, ...["", "Name", "", "Start", "End", "Length", "Stars", "", ""].map((h) => el("th", {}, h))));
      const body = el(
        "tbody",
        {},
        ...(mine.length ? mine.flatMap(([sl, i]) => row(sl, i)) : [el("tr", {}, el("td", { colSpan: COLS, className: "hint" }, "No clips of your own yet. Drag across the waveform to select a region, then make it a clip."))]),
        ...(others.length ? [el("tr", {}, el("td", { colSpan: COLS, className: "hint" }, "Other people's clips (editing one saves your own copy):")), ...others.flatMap(([sl, i]) => row(sl, i))] : []),
      );
      const autoBody = el("tbody", {});
      if (auto.length) {
        const toggle = el("button", { className: "btn", type: "button" }, `${showAuto ? "Hide" : "Show"} auto markup (${auto.length})`);
        toggle.addEventListener("click", () => ((showAuto = !showAuto), renderTable()));
        autoBody.append(el("tr", {}, el("td", { colSpan: COLS }, toggle, el("span", { className: "hint" }, "  sections, loops and one-shots found automatically; use one in a score by name, right after the path: clip brk = <sample> loop-1"))));
        if (showAuto)
          for (const [n, [sl, i]] of auto.entries()) {
            const k = kindRank(sl);
            if (n === 0 || kindRank(auto[n - 1][0]) !== k) {
              const count = auto.filter(([x]) => kindRank(x) === k).length;
              autoBody.append(el("tr", { className: "group" }, el("td", { colSpan: COLS }, `${k < CLIP_KINDS.length ? KIND_LABEL[CLIP_KINDS[k]] : "Other"} (${count})`)));
            }
            autoBody.append(...row(sl, i));
          }
      }
      table.replaceChildren(head, body, autoBody);
    };

    wave.onChange = (_s, why) => {
      if (why === "clips") markDirty();
      renderTable();
    };
    wave.onSeek = (t) => this.startAudition(buf, t, null, wave);
    makeClip.addEventListener("click", () => {
      const s = wave.state;
      if (!s.selection) return;
      const taken = new Set(s.clips.map((x) => x.name));
      let n = s.clips.length + 1;
      while (taken.has(`clip-${n}`)) n++;
      s.clips.push({ name: `clip-${n}`, start: +s.selection[0].toFixed(3), end: +s.selection[1].toFixed(3), source: "user" });
      s.clips.sort((a, b) => a.start - b.start);
      s.selected = s.clips.findIndex((x) => x.name === `clip-${n}`);
      s.selection = null;
      markDirty();
      renderTable();
      wave.draw();
    });
    save.addEventListener("click", async () => {
      if (this.cloud() && !this.who) return signIn();
      errors.textContent = "";
      const clips = wave.state.clips.map((s) => ({ ...s, start: +s.start.toFixed(3), end: +s.end.toFixed(3) }));
      try {
        await api.saveAnnotations(path, { ...(m.annotations ?? {}), clips });
        dirty = false;
        save.disabled = true;
        save.textContent = "Saved";
        await manifest(path, true);
        this.refresh();
      } catch (e) {
        errors.textContent = ((e as { errors?: string[] }).errors ?? [(e as Error).message]).join("\n");
      }
    });
    snippet.addEventListener("click", async () => {
      const s = wave.state.clips[wave.state.selected!];
      const src = path.replace(/^samples\//, "");
      const id = s.name.replace(/-/g, "_");
      await navigator.clipboard.writeText(`clip ${id} = ${src}  ${s.name}`);
      snippet.textContent = "Copied ✓";
      setTimeout(() => (snippet.textContent = "Copy for score"), 1500);
    });

    const k = m.tonal.key;
    const stat = (label: string, value: string) => el("div", { className: "stat" }, el("b", {}, label), el("span", {}, value));
    const keysOverTime = c.keys_over_time.map(keyLabel).join(" → ");
    const clip = this.mode === "clips" ? this.currentClip : null;
    // Comments on the clip open in Clips, else on the sample.
    const thread = new CommentThread(clip ? { type: "clip", id: clip.id } : { type: "sample", id: c.id });
    // Where it came from and what its license asks (a clip shows its sample's); curators can write it down.
    const license = el("div", { className: "license-host" });
    const curator = !this.cloud() || !!this.who?.curator;
    const fillLicense = async () => {
      const p = await api.provenance(path).catch((e) => (reportError("load where this sample comes from", e), null));
      if (this.current !== path || !p) return;
      license.replaceChildren(
        licensePanel(
          p.recording,
          curator
            ? {
                recordings: () => api.recordings(),
                update: (id, fields) => api.updateRecording(id, fields),
                relink: (recordingId) => api.relinkSample(p.sample.id, recordingId),
                changed: () => void this.list.refresh().then(fillLicense),
              }
            : undefined,
        ),
      );
    };
    void fillLicense();
    this.detailEl.replaceChildren(
      el("div", { className: "title-row" }, el("h1", {}, clip ? clip.name : c.title), this.stars.el),
      el("div", { className: "credit" }, clip ? `A clip of ${c.title} · ${fmt(clip.start)}–${fmt(clip.end)}${this.copiedFrom(clip)}` : [c.credit, c.rights].filter(Boolean).join(" ") || path),
      el(
        "div",
        { className: "stats" },
        ...(c.recorded ? [stat("Recorded", c.recorded)] : []),
        ...(c.composed ? [stat("Composed", String(c.composed))] : []),
        stat("Tempo", m.rhythm.bpm ? `${m.rhythm.bpm} BPM` : "—"),
        stat("Steadiness", m.rhythm.bpm_stability !== undefined ? `${Math.round(m.rhythm.bpm_stability * 100)}%` : "—"),
        stat("Key", `${keyLabel(k.tonic)} ${k.mode} · ${k.camelot ?? ""}`),
        stat("Over time", keysOverTime || "—"),
        stat("Tuning", `A = ${m.tonal.tuning_hz} Hz (${(m.tonal.tuning_cents ?? 0) > 0 ? "+" : ""}${m.tonal.tuning_cents ?? 0}¢)`),
        stat("Length", fmt(buf.duration)),
        stat("Notes found", String(c.notes)),
      ),
      license,
      el("div", { className: "card" }, wave.canvas),
      el("p", { className: "hint" }, "Play (top right, or space) plays the selection or the selected clip, else the whole sample. Drag to select (snaps to beats; hold ⌥ for free), double-click to play from a point. Drag a clip's edges or body in the lower lane; Delete removes the selected clip."),
      el("div", { className: "toolbar" }, makeClip, save, snippet),
      errors,
      table,
      thread.root,
    );
    void thread.load();
    renderTable();
    this.paintStars();
    requestAnimationFrame(() => wave.draw());
    window.onbeforeunload = () => (dirty ? true : null);
  }

  /** Play `buf` from `from` (to `to`), drawing the playhead on `wave` when there is one; false if it couldn't. */
  private async startAudition(buf: AudioBuffer, from: number, to: number | null, wave: Waveform | null): Promise<boolean> {
    this.stopAudition();
    if (!player.started) this.setPlay({ kind: "loading", label: "Starting the audio engine" });
    try {
      await player.init();
    } catch (e) {
      this.setPlay({ kind: "error", message: reasonOf(e) }); // a click tries again
      return false;
    }
    const ctx = player.ctx!;
    await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const t0 = ctx.currentTime;
    src.start(t0, from, to !== null ? to - from : undefined);
    this.audition = src;
    this.setPlay({ kind: "playing" });
    const tick = () => {
      if (this.audition !== src || !wave) return;
      wave.state.playhead = from + (ctx.currentTime - t0);
      wave.draw();
      requestAnimationFrame(tick);
    };
    tick();
    src.onended = () => {
      if (this.audition === src) this.stopAudition();
      if (!wave) return;
      wave.state.playhead = null;
      wave.draw();
    };
    return true;
  }

  private stopAudition() {
    const a = this.audition;
    this.audition = null;
    a?.stop();
    const ended = this.auditionEnded;
    this.auditionKey = this.auditionEnded = null;
    ended?.();
    if (a && this.playState.kind === "playing") this.setPlay({ kind: "idle" });
  }

  /** Stop any audition (the reader left this page). */
  silence() {
    this.stopAudition();
  }

  /** The top bar's play button: play what is shown (the selection, else the selected clip, else it all), or stop. */
  togglePlay() {
    if (this.audition) return this.stopAudition();
    const p = this.playable;
    if (!p) return;
    const r = p.range();
    void this.startAudition(p.buf, r ? r[0] : 0, r ? r[1] : null, p.wave);
  }

  /** Follow the play button's state here (called at once with the current one). */
  onPlay(fn: (s: PlayState) => void) {
    this.playListeners.push(fn);
    fn(this.playState);
  }

  private setPlay(s: PlayState) {
    this.playState = s;
    for (const f of this.playListeners) f(s);
  }
}
