// Library: every analyzed clip, its analysis, and a waveform editor for slices.

import { api, encodePath, manifest, type ClipSummary, type Slice } from "../apricity";
import { player } from "../audio/player";
import { el } from "./dom";
import { computePeaks, Waveform } from "./waveform";

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const keyLabel = (k: string) => k.replace(/b/g, "♭");
const GROUPS: Record<string, string> = { "marine-band": "U.S. Marine Band", "citizen-dj": "Library of Congress · Citizen DJ", uploads: "Your uploads" };

export class Library {
  root: HTMLElement;
  clips: ClipSummary[] = [];
  current: string | null = null;
  private listEl = el("div", { className: "list" });
  private detailEl = el("div", { className: "detail" });
  private filter = "";
  private decoded = new Map<string, Promise<AudioBuffer>>();
  private audition: AudioBufferSourceNode | null = null;
  private jobsTimer = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    const search = el("input", { type: "search", placeholder: "Filter by title, key, BPM…", ariaLabel: "Filter clips" });
    search.addEventListener("input", () => ((this.filter = search.value.toLowerCase()), this.renderList()));
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
    root.append(el("aside", { className: "sidebar" }, el("div", { className: "search" }, search), this.listEl, drop, pick), this.detailEl);
    this.refresh();
  }

  async refresh(select?: string) {
    const r = await api.clips();
    this.clips = r.clips;
    const running = r.jobs.filter((j) => j.state === "analyzing" || j.state === "queued");
    clearTimeout(this.jobsTimer);
    if (running.length) this.jobsTimer = window.setTimeout(() => this.refresh(), 3000);
    this.jobs = r.jobs;
    this.renderList();
    const target = select ?? this.current ?? this.clips[0]?.path;
    if (target && target !== this.current) this.show(target);
  }
  private jobs: { path: string; state: string; error?: string }[] = [];

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

  private renderList() {
    const q = this.filter;
    const match = (c: ClipSummary) => !q || [c.title, c.key, c.camelot, String(Math.round(c.bpm ?? 0)), c.group].join(" ").toLowerCase().includes(q);
    const groups = new Map<string, ClipSummary[]>();
    for (const c of this.clips.filter(match)) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    const kids: Node[] = [];
    for (const job of this.jobs.filter((j) => j.state !== "done")) {
      kids.push(el("div", { className: "row" }, el("span", { className: "t" }, job.path.split("/").pop()!), el("span", { className: `pill ${job.state === "failed" ? "bad" : ""}` }, job.state === "failed" ? "failed" : "analyzing…"), el("span", { className: "sub" }, job.error ?? "beats, key, notes — about a minute")));
    }
    for (const [g, clips] of groups) {
      kids.push(el("div", { className: "group" }, GROUPS[g] ?? g));
      for (const c of clips) {
        const row = el(
          "button",
          { className: "row", type: "button" },
          el("span", { className: "t", title: c.title }, c.title + (c.excerpt_start ? ` @${c.excerpt_start.replace(/^00:/, "")}` : "")),
          el("span", { className: "k" }, `${keyLabel(c.key)} · ${c.camelot ?? ""}`),
          el("span", { className: "sub" }, `${c.bpm ? Math.round(c.bpm) + " BPM" : "no beat"} · ${fmt(c.duration)}${c.slices ? ` · ${c.slices} slice${c.slices > 1 ? "s" : ""}` : ""}`),
        );
        row.setAttribute("aria-current", String(c.path === this.current));
        row.addEventListener("click", () => this.show(c.path));
        kids.push(row);
      }
    }
    if (!kids.length) kids.push(el("div", { className: "empty" }, "No clips match."));
    this.listEl.replaceChildren(...kids);
  }

  private decode(path: string) {
    if (!this.decoded.has(path)) {
      this.decoded.set(
        path,
        fetch(`/files/${encodePath(path)}`)
          .then((r) => r.arrayBuffer())
          .then((b) => new OfflineAudioContext(2, 1, 48000).decodeAudioData(b)),
      );
    }
    return this.decoded.get(path)!;
  }

  async show(path: string) {
    this.current = path;
    this.renderList();
    this.stopAudition();
    const c = this.clips.find((x) => x.path === path);
    const m = await manifest(path, true);
    if (!c || !m || this.current !== path) return;
    this.detailEl.replaceChildren(el("div", { className: "empty" }, "Loading audio…"));
    const buf = await this.decode(path);
    if (this.current !== path) return;

    const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    const wave = new Waveform({
      duration: buf.duration,
      peaks: computePeaks(channels),
      manifest: m,
      slices: structuredClone(m.annotations?.slices ?? []),
      selected: null,
      selection: null,
      playhead: null,
    });
    let dirty = false;
    let showAuto = false;
    const errors = el("div", { className: "errors" });
    const save = el("button", { className: "btn primary", type: "button", disabled: true }, "Save slices");
    const makeSlice = el("button", { className: "btn", type: "button", disabled: true }, "Make slice from selection");
    const play = el("button", { className: "btn", type: "button" }, "▶ Audition");
    const snippet = el("button", { className: "btn", type: "button", disabled: true, title: "Copy a clips: entry for the score editor" }, "Copy for score");
    const table = el("table", { className: "slices" });

    const selectionOrSlice = (): [number, number] | null => {
      const s = wave.state;
      if (s.selection && s.selection[1] - s.selection[0] >= 0.05) return s.selection;
      if (s.selected !== null) return [s.slices[s.selected].start, s.slices[s.selected].end];
      return null;
    };
    const markDirty = () => {
      dirty = true;
      save.disabled = false;
      save.textContent = "Save slices •";
    };
    const renderTable = () => {
      const s = wave.state;
      makeSlice.disabled = !(s.selection && s.selection[1] - s.selection[0] >= 0.05);
      snippet.disabled = s.selected === null;
      const row = (sl: Slice, i: number) => {
        const auto = sl.source === "ml";
        const name = el("input", { value: sl.name, ariaLabel: "Slice name", spellcheck: false });
        // Only characters the manifest accepts can be typed (letters, digits, - and _).
        name.addEventListener("input", () => {
          const clean = name.value.replace(/[^A-Za-z0-9_-]+/g, "-");
          if (clean !== name.value) name.value = clean;
          sl.name = clean || `slice-${i + 1}`;
          if (sl.source === "ml") sl.source = "user"; // renamed, so it's yours now
          markDirty();
          wave.draw();
        });
        const del = el("button", { className: "btn", type: "button", ariaLabel: `Delete slice ${sl.name}` }, "Delete");
        del.addEventListener("click", () => (s.slices.splice(i, 1), (s.selected = null), markDirty(), renderTable(), wave.draw()));
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
      const mine = s.slices.map((sl, i) => [sl, i] as const).filter(([sl]) => sl.source !== "ml");
      const auto = s.slices.map((sl, i) => [sl, i] as const).filter(([sl]) => sl.source === "ml");
      const head = el("thead", {}, el("tr", {}, ...["Name", "", "Start", "End", "Length", ""].map((h) => el("th", {}, h))));
      const body = el("tbody", {}, ...(mine.length ? mine.map(([sl, i]) => row(sl, i)) : [el("tr", {}, el("td", { colSpan: 6, className: "hint" }, "No slices of your own yet. Drag across the waveform to select a region, then make it a slice."))]));
      const autoBody = el("tbody", {});
      if (auto.length) {
        const toggle = el("button", { className: "btn", type: "button" }, `${showAuto ? "Hide" : "Show"} auto markup (${auto.length})`);
        toggle.addEventListener("click", () => ((showAuto = !showAuto), renderTable()));
        autoBody.append(el("tr", {}, el("td", { colSpan: 6 }, toggle, el("span", { className: "hint" }, "  sections, loops and hits found automatically; use them in a score with slice <name>"))));
        if (showAuto) autoBody.append(...auto.map(([sl, i]) => row(sl, i)));
      }
      table.replaceChildren(head, body, autoBody);
    };

    wave.onChange = (_s, why) => {
      if (why === "slices") markDirty();
      renderTable();
    };
    wave.onSeek = (t) => this.startAudition(buf, t, null, wave);
    makeSlice.addEventListener("click", () => {
      const s = wave.state;
      if (!s.selection) return;
      const taken = new Set(s.slices.map((x) => x.name));
      let n = s.slices.length + 1;
      while (taken.has(`slice-${n}`)) n++;
      s.slices.push({ name: `slice-${n}`, start: +s.selection[0].toFixed(3), end: +s.selection[1].toFixed(3), source: "user" });
      s.slices.sort((a, b) => a.start - b.start);
      s.selected = s.slices.findIndex((x) => x.name === `slice-${n}`);
      s.selection = null;
      markDirty();
      renderTable();
      wave.draw();
    });
    play.addEventListener("click", () => {
      if (this.audition) return this.stopAudition(play);
      const r = selectionOrSlice();
      this.startAudition(buf, r ? r[0] : 0, r ? r[1] : null, wave, play);
    });
    save.addEventListener("click", async () => {
      errors.textContent = "";
      const slices = wave.state.slices.map((s) => ({ ...s, start: +s.start.toFixed(3), end: +s.end.toFixed(3) }));
      try {
        await api.saveAnnotations(path, { ...(m.annotations ?? {}), slices });
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
      const s = wave.state.slices[wave.state.selected!];
      const src = path.replace(/^samples\//, "");
      const id = s.name.replace(/-/g, "_");
      await navigator.clipboard.writeText(`  ${id}: { source: ${src}, slice: ${s.name} }`);
      snippet.textContent = "Copied ✓";
      setTimeout(() => (snippet.textContent = "Copy for score"), 1500);
    });

    const k = m.tonal.key;
    const stat = (label: string, value: string) => el("div", { className: "stat" }, el("b", {}, label), el("span", {}, value));
    const keysOverTime = c.keys_over_time.map(keyLabel).join(" → ");
    this.detailEl.replaceChildren(
      el("h1", {}, c.title),
      el("div", { className: "credit" }, [c.credit, c.rights].filter(Boolean).join(" ") || path),
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
      el("div", { className: "card" }, wave.canvas),
      el("p", { className: "hint" }, "Drag to select (snaps to beats; hold ⌥ for free), double-click to play from a point. Drag slice edges or bodies in the lower lane; Delete removes the selected slice."),
      el("div", { className: "toolbar" }, play, makeSlice, save, snippet),
      errors,
      table,
    );
    renderTable();
    requestAnimationFrame(() => wave.draw());
    window.onbeforeunload = () => (dirty ? true : null);
  }

  private async startAudition(buf: AudioBuffer, from: number, to: number | null, wave: Waveform, button?: HTMLButtonElement) {
    this.stopAudition();
    await player.init();
    const ctx = player.ctx!;
    await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const t0 = ctx.currentTime;
    src.start(t0, from, to !== null ? to - from : undefined);
    this.audition = src;
    if (button) button.textContent = "■ Stop";
    const tick = () => {
      if (this.audition !== src) return;
      wave.state.playhead = from + (ctx.currentTime - t0);
      wave.draw();
      requestAnimationFrame(tick);
    };
    tick();
    src.onended = () => {
      if (this.audition === src) this.stopAudition(button);
      wave.state.playhead = null;
      wave.draw();
    };
  }

  private stopAudition(button?: HTMLButtonElement) {
    const a = this.audition;
    this.audition = null;
    a?.stop();
    if (button) button.textContent = "▶ Audition";
  }
}
