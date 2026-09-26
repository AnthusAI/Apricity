// Samples and Clips: every analyzed sample (or every clip saved with one), ranked by stars, and a waveform editor for
// the clips saved with a sample. The two tabs are one view: opening a clip opens its sample with that clip selected.

import { api, audioUrl, manifest, me, ratings, type SampleSummary, type SavedClip } from "../apricity";
import { owns, SignedOut, type ClipItem, type Me } from "../data/catalog";
import { byline, handles, type Handles } from "../data/handles";
import { mode } from "../data/client";
import { player } from "../audio/player";
import { el } from "./dom";
import { RankedList } from "./ranked-list";
import { CommentThread } from "./comments";
import { licensePanel } from "./credits";
import { StarRating } from "./stars";
import type { PlayState } from "./play-button";
import { computePeaks, Waveform } from "./waveform";

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const keyLabel = (k: string) => k.replace(/b/g, "♭");
const GROUPS: Record<string, string> = { "marine-band": "U.S. Marine Band", "citizen-dj": "Library of Congress · Citizen DJ", uploads: "Your uploads" };
const signIn = () => document.dispatchEvent(new CustomEvent("apricity:sign-in"));

export type LibraryMode = "samples" | "clips";

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
          sub: `${c.undocumented ? "⚠ no license documented · " : ""}${GROUPS[c.group] ?? c.group} · ${keyLabel(c.key)} · ${c.bpm ? Math.round(c.bpm) + " BPM" : "no beat"} · ${fmt(c.duration)}${c.clips ? ` · ${c.clips} clip${c.clips > 1 ? "s" : ""}` : ""}`,
        }),
        text: (c) => [c.title, c.key, c.camelot, String(Math.round(c.bpm ?? 0)), c.group, GROUPS[c.group] ?? ""].join(" "),
        me: async () => this.who,
        open: (c) => this.show(c.path),
      });
    } else {
      this.list = new RankedList<ClipItem>({
        name: "clips",
        load: async () => {
          await loadSamples();
          this.clips = await api.clips();
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
        open: (c) => ((this.currentClip = c), this.show(c.samplePath)),
      });
    }
    const drop = el("div", { className: "drop" }, "Drop audio here to add and analyze it");
    const pick = el("input", { type: "file", accept: "audio/*", multiple: true, hidden: true });
    drop.addEventListener("click", () => pick.click());
    pick.addEventListener("change", () => this.upload([...(pick.files ?? [])]));
    drop.addEventListener("dragover", (e) => (e.preventDefault(), drop.classList.add("over")));
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      this.upload([...(e.dataTransfer?.files ?? [])]);
    });
    // Uploads need the local analysis server; in the cloud there's nothing to drop onto. Clips are made on a sample.
    drop.hidden = mode === "clips" || this.cloud();
    this.list.el.append(this.jobsEl, drop, pick);
    root.append(this.list.el, this.detailEl);
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

  /** Open a sample (Samples) or a clip (Clips) by its record id, e.g. from an Activity card. */
  async openId(id: string) {
    await this.list.refresh();
    if (this.mode === "clips") {
      const clip = this.clips.find((c) => c.id === id);
      if (!clip) return;
      this.currentClip = clip;
      this.list.current = clip.id;
      this.list.render();
      return this.show(clip.samplePath);
    }
    const s = this.samples.find((x) => x.id === id);
    if (s) return this.show(s.path);
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
        this.show(clip.samplePath);
      }
      return;
    }
    const target = select ?? this.current ?? (this.list as RankedList<SampleSummary>).top()?.path;
    if (target && target !== this.current) this.show(target);
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
    } catch {}
    const now = this.target();
    if (now?.id !== t.id) return;
    this.stars.set({ mine, average: standing?.average ?? null, count: standing?.count ?? 0, signedIn: !!this.who });
  }

  private async upload(files: File[]) {
    for (const f of files) {
      try {
        await api.upload(f);
      } catch (e) {
        alert(`${f.name}: ${(e as Error).message}`);
      }
    }
    this.refresh();
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

  async show(path: string) {
    this.current = path;
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
    let showAuto = false;
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
    const renderTable = () => {
      const s = wave.state;
      makeClip.disabled = !(s.selection && s.selection[1] - s.selection[0] >= 0.05);
      snippet.disabled = s.selected === null;
      const row = (sl: SavedClip, i: number) => {
        const auto = sl.source === "ml";
        const name = el("input", { value: sl.name, ariaLabel: "Clip name", spellcheck: false });
        // Only characters the manifest accepts can be typed (letters, digits, - and _).
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
        const tr = el("tr", {}, el("td", {}, name), el("td", {}, kind), el("td", { className: "mono" }, fmt(sl.start)), el("td", { className: "mono" }, fmt(sl.end)), el("td", { className: "mono" }, `${(sl.end - sl.start).toFixed(2)} s`), el("td", {}, del));
        tr.setAttribute("aria-selected", String(i === s.selected));
        tr.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          s.selected = i;
          s.selection = null;
          renderTable();
          wave.draw();
        });
        return tr;
      };
      // Yours (and new ones), then other people's, then the automatic ones (collapsed).
      const isMine = (sl: SavedClip) => !this.cloud() || !sl.owner || !sl.id || owns(this.who, sl.owner) || !!this.who?.curator;
      const mine = s.clips.map((sl, i) => [sl, i] as const).filter(([sl]) => sl.source !== "ml" && isMine(sl));
      const others = s.clips.map((sl, i) => [sl, i] as const).filter(([sl]) => sl.source !== "ml" && !isMine(sl));
      const auto = s.clips.map((sl, i) => [sl, i] as const).filter(([sl]) => sl.source === "ml");
      const head = el("thead", {}, el("tr", {}, ...["Name", "", "Start", "End", "Length", ""].map((h) => el("th", {}, h))));
      const body = el(
        "tbody",
        {},
        ...(mine.length ? mine.map(([sl, i]) => row(sl, i)) : [el("tr", {}, el("td", { colSpan: 6, className: "hint" }, "No clips of your own yet. Drag across the waveform to select a region, then make it a clip."))]),
        ...(others.length ? [el("tr", {}, el("td", { colSpan: 6, className: "hint" }, "Other people's clips (editing one saves your own copy):")), ...others.map(([sl, i]) => row(sl, i))] : []),
      );
      const autoBody = el("tbody", {});
      if (auto.length) {
        const toggle = el("button", { className: "btn", type: "button" }, `${showAuto ? "Hide" : "Show"} auto markup (${auto.length})`);
        toggle.addEventListener("click", () => ((showAuto = !showAuto), renderTable()));
        autoBody.append(el("tr", {}, el("td", { colSpan: 6 }, toggle, el("span", { className: "hint" }, "  sections, loops and one-shots found automatically; use one in a score by name, right after the path: clip brk = <sample> loop-1"))));
        if (showAuto) autoBody.append(...auto.map(([sl, i]) => row(sl, i)));
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
      const p = await api.provenance(path).catch(() => null);
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

  private async startAudition(buf: AudioBuffer, from: number, to: number | null, wave: Waveform) {
    this.stopAudition();
    if (!player.started) this.setPlay({ kind: "loading", label: "Starting the audio engine" });
    await player.init();
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
      if (this.audition !== src) return;
      wave.state.playhead = from + (ctx.currentTime - t0);
      wave.draw();
      requestAnimationFrame(tick);
    };
    tick();
    src.onended = () => {
      if (this.audition === src) this.stopAudition();
      wave.state.playhead = null;
      wave.draw();
    };
  }

  private stopAudition() {
    const a = this.audition;
    this.audition = null;
    a?.stop();
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
