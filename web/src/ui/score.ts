// Score editor: YAML in, live compile (wasm) on every edit, live playback that swaps changes in
// at the next bar. Problems with a line number are marked in the editor; all are listed beside it.

import { EditorView, basicSetup } from "codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment } from "@codemirror/state";
import { aprLanguage } from "./apr-lang";
import { tags as t } from "@lezer/highlight";
import { api, compile, me, ratings, type Timeline } from "../apricity";
import { byline, handles, type Handles } from "../data/handles";
import { owns, SignedOut, SCORE_KINDS, type Me, type ScoreItem, type ScoreKind } from "../data/catalog";
import { RankedList } from "./ranked-list";
import { StarRating } from "./stars";
import { KIND_LABEL, rebaseSamples, TEMPLATES, TEMPLATE_FOLDER } from "./templates";
import { player, Superseded, type LoadProgress } from "../audio/player";
import { el } from "./dom";
import { currentAccount } from "../data/auth";
import { FlowView } from "./flow/view";
import { BeatView } from "./beat/view";
import { HarpView } from "./chords/view";
import { RollView } from "./melody/view";


// Colors from the page's CSS variables, so the editor follows light/dark mode.
const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--accent)" },
  { tag: [t.string, t.special(t.string)], color: "var(--fg)" },
  { tag: [t.number, t.bool, t.null], color: "var(--slice)" },
  { tag: [t.comment, t.lineComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.punctuation, t.separator, t.brace, t.squareBracket], color: "var(--muted)" },
  { tag: [t.keyword, t.meta], color: "var(--warn)", fontWeight: "600" },
  { tag: t.typeName, color: "var(--ok)", fontWeight: "550" },
  { tag: t.variableName, color: "var(--fg)" },
  { tag: t.invalid, color: "var(--bad)", textDecoration: "underline wavy" },
]);


const signIn = () => document.dispatchEvent(new CustomEvent("apricity:sign-in"));

export class ScoreView {
  root: HTMLElement;
  path: string | null = null;
  timeline: Timeline | null = null;
  /** Which kind of score the tab shows: Scores (songs), Beats, Chords or Melodies. */
  kind: ScoreKind = "song";
  private view: EditorView;
  private language = new Compartment();
  private items: ScoreItem[] = [];
  private who: Me | null = null;
  private names: Handles | null = null;
  private list: RankedList<ScoreItem>;
  private stars = new StarRating((n) => this.rate(n), signIn);
  private kindSel = el("select", { className: "kind", ariaLabel: "What this score is" });
  private nameEl = el("span", { className: "name" }, "—");
  private saveBtn = el("button", { className: "btn", type: "button", disabled: true }, "Save");
  private statusEl = el("span", { className: "status" });
  private sideEl = el("div", { className: "side" });
  private chordsEl = el("div", { className: "chords", title: "Click to jump" });
  private head = el("i", { className: "head" });
  private flow = new FlowView();
  private flowBtn = el("button", { className: "btn", type: "button", title: "Show where every sound comes from" }, "Flow");
  private beat = new BeatView({
    text: () => this.view.state.doc.toString(),
    edit: (text) => this.replaceText(text),
    resend: () => player.transport.playing && this.send(),
  });
  private stepsBtn = el("button", { className: "btn", type: "button", title: "The drum machine: pads and steps" }, "Steps");
  private harp = new HarpView({
    text: () => this.view.state.doc.toString(),
    edit: (text) => this.replaceText(text),
    path: () => this.path,
    resend: () => player.transport.playing && this.send(),
  });
  private roll = new RollView({
    text: () => this.view.state.doc.toString(),
    edit: (text) => this.replaceText(text),
  });
  private rollBtn = el("button", { className: "btn", type: "button", title: "The piano roll: the melody's notes on the key's pitches" }, "Roll");
  private harpBtn = el("button", { className: "btn", type: "button", title: "The chord harp: chords of the key, the progression, and the clips that play it" }, "Harp");
  private applyDock = () => {};
  private saved = "";
  private compileTimer = 0;
  /** Opening, listing and compiling under way; `ready()` waits for them. */
  private busy = new Set<Promise<unknown>>();
  private generation = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.view = new EditorView({
      extensions: [
        basicSetup,
        this.language.of(aprLanguage),
        syntaxHighlighting(highlight),
        lintGutter(),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (this.save(), true) }]),
        EditorView.updateListener.of((u) => u.docChanged && this.changed()),
        EditorView.theme({ "&": { backgroundColor: "var(--panel)", color: "var(--fg)" }, ".cm-gutters": { backgroundColor: "var(--panel)", borderRight: "1px solid var(--line)", color: "var(--muted)" }, ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)" }, ".cm-cursor": { borderLeftColor: "var(--fg)" }, "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)" } }),
      ],
    });
    this.saveBtn.addEventListener("click", () => this.save());
    for (const k of SCORE_KINDS) this.kindSel.append(el("option", { value: k, textContent: k === "song" ? "Song" : k[0].toUpperCase() + k.slice(1) }));
    this.kindSel.addEventListener("change", () => this.changeKind(this.kindSel.value as ScoreKind));
    this.list = new RankedList<ScoreItem>({
      name: "scores",
      load: async () => {
        const [{ scores }, who, names] = await Promise.all([api.scores(), me().catch(() => null), handles()]);
        this.items = scores;
        this.who = who;
        this.names = names;
        return scores.filter((x) => x.kind === this.kind);
      },
      tallies: async () => (await ratings()).tallies("score"),
      row: (x) => ({ title: x.title, sub: byline(this.names, x.owner, owns(this.who, x.owner)) }),
      text: (x) => `${x.title} ${byline(this.names, x.owner, false)}`,
      owner: (x) => x.owner,
      me: async () => this.who,
      open: (x) => this.open(x.path),
      create: { label: "New score", run: () => this.create() },
    });
    document.addEventListener("apricity:handles-changed", () => void this.list.refresh());
    this.chordsEl.addEventListener("click", (e) => {
      if (!this.timeline) return;
      const r = this.chordsEl.getBoundingClientRect();
      const beat = ((e.clientX - r.left) / r.width) * this.timeline.length_beats;
      player.seekBeat(Math.floor(beat / this.timeline.meter) * this.timeline.meter);
    });
    root.append(
      this.list.el,
      el("div", { className: "editor" }, el("div", { className: "bar" }, this.nameEl, this.kindSel, this.stars.el, el("span", { style: "flex:1" }), this.statusEl, this.stepsBtn, this.harpBtn, this.rollBtn, this.flowBtn, this.refBtn(), this.saveBtn), el("div", { className: "cm-host" }, this.view.dom)),
      this.sideEl,
      ...this.dockPanels(),
    );
    player.onTransport((t) => this.drawHead(t.position / t.framesPerBeat));
    document.addEventListener("apricity:auth-changed", () => this.loadList());
    this.list.rename(KIND_LABEL[this.kind].many, `New ${KIND_LABEL[this.kind].one}`);
  }

  /**
   * The panel under the editor: Steps (the drum machine, for beats) or Flow (where every sound comes from), or
   * neither. Which one is open is remembered per kind of score; the height is shared.
   */
  private dockPanels() {
    type Dock = "steps" | "harp" | "roll" | "flow" | null;
    // Each kind of score has its own editor panel; every kind has Flow.
    const own: Partial<Record<ScoreKind, "steps" | "harp" | "roll">> = { beat: "steps", chords: "harp", melody: "roll" };
    let saved: { height: number } & Partial<Record<ScoreKind, Dock>> = { height: 440 };
    try {
      const old = JSON.parse(localStorage.getItem("apricity.flow") ?? "{}"); // the Flow panel's old setting
      saved = { ...saved, ...(typeof old.height === "number" ? { height: old.height } : {}), ...(old.open === false ? { song: null } : {}) };
      saved = { ...saved, ...JSON.parse(localStorage.getItem("apricity.dock") ?? "{}") };
    } catch {}
    const panels = { flow: this.flow.root, steps: this.beat.root, harp: this.harp.root, roll: this.roll.root };
    const current = (): Dock => {
      const d = this.kind in saved ? saved[this.kind]! : (own[this.kind] ?? "flow");
      return d === "flow" || d === null || d === own[this.kind] ? d : "flow";
    };
    const apply = (this.applyDock = () => {
      const d = current();
      for (const [name, panel] of Object.entries(panels)) {
        panel.hidden = d !== name;
        panel.style.height = `${saved.height}px`;
      }
      this.stepsBtn.hidden = own[this.kind] !== "steps";
      this.harpBtn.hidden = own[this.kind] !== "harp";
      this.rollBtn.hidden = own[this.kind] !== "roll";
      for (const [btn, name] of [[this.flowBtn, "flow"], [this.stepsBtn, "steps"], [this.harpBtn, "harp"], [this.rollBtn, "roll"]] as const) {
        btn.setAttribute("aria-pressed", String(d === name));
        btn.classList.toggle("on", d === name);
      }
      try {
        localStorage.setItem("apricity.dock", JSON.stringify(saved));
      } catch {}
      if (d === "flow") this.flow.redraw();
      if (d === "steps") this.beat.update(this.view.state.doc.toString(), this.timeline);
      if (d === "harp") this.harp.update(this.view.state.doc.toString(), this.timeline);
      if (d === "roll") this.roll.update(this.view.state.doc.toString(), this.timeline);
    });
    const toggle = (name: "steps" | "harp" | "roll" | "flow") => {
      saved[this.kind] = current() === name ? null : name;
      apply();
    };
    this.flowBtn.addEventListener("click", () => toggle("flow"));
    this.stepsBtn.addEventListener("click", () => toggle("steps"));
    this.harpBtn.addEventListener("click", () => toggle("harp"));
    this.rollBtn.addEventListener("click", () => toggle("roll"));
    for (const panel of Object.values(panels)) {
      const grip = el("div", { className: "flow-grip", title: "Drag to resize", role: "separator", ariaOrientation: "horizontal" });
      panel.prepend(grip);
      grip.addEventListener("pointerdown", (e) => {
        const y0 = e.clientY,
          h0 = saved.height;
        grip.setPointerCapture(e.pointerId);
        const move = (m: PointerEvent) => ((saved.height = Math.max(140, Math.min(innerHeight * 0.8, h0 - (m.clientY - y0)))), (panel.style.height = `${saved.height}px`));
        const up = () => (grip.removeEventListener("pointermove", move), apply());
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up, { once: true });
      });
    }
    apply();
    return Object.values(panels);
  }

  /** Replace the whole text (the drum machine's edits); the editor recompiles as for any edit. */
  private replaceText(text: string) {
    const doc = this.view.state.doc.toString();
    if (text === doc) return;
    // Change only the lines that differ, so the cursor and undo history stay sensible.
    let a = 0;
    while (a < doc.length && a < text.length && doc[a] === text[a]) a++;
    let b = 0;
    while (b < doc.length - a && b < text.length - a && doc[doc.length - 1 - b] === text[text.length - 1 - b]) b++;
    this.view.dispatch({ changes: { from: a, to: doc.length - b, insert: text.slice(a, text.length - b) } });
  }

  /** Opens the reference for whichever format is being edited. */
  private refBtn() {
    const b = el("button", { className: "btn", type: "button", title: "Open the language reference in Help" }, "Reference");
    b.addEventListener("click", () => {
      const file = this.path?.endsWith(".yaml") ? "yaml.md" : "language.md";
      document.dispatchEvent(new CustomEvent("apricity:docs", { detail: { file } }));
    });
    return b;
  }

  /** The list's top of the week (where signing in lands). */
  topOfWeek() {
    this.list.setWindow("week");
  }

  /** Show another kind of score (the Scores, Beats, Chords and Melodies tabs share this view). */
  setKind(kind: ScoreKind) {
    if (kind === this.kind && this.items.length) return;
    this.kind = kind;
    const label = KIND_LABEL[kind];
    this.list.rename(label.many, `New ${label.one}`);
    this.applyDock();
    this.loadList();
  }

  loadList(select?: string) {
    return this.track(this.listNow(select));
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.busy.add(p);
    const done = () => this.busy.delete(p);
    p.then(done, done);
    return p;
  }

  /**
   * The open score's timeline, once whatever is under way has finished: the list loading, the score opening, and
   * the compile of its latest text (started now if it was waiting for the typing to pause). Null: nothing playable.
   */
  async ready(): Promise<Timeline | null> {
    for (let i = 0; i < 20; i++) {
      if (this.compileTimer) {
        clearTimeout(this.compileTimer);
        this.compileTimer = 0;
        void this.recompile();
      }
      if (!this.busy.size) break;
      await Promise.allSettled([...this.busy]);
    }
    return this.timeline;
  }

  private async listNow(select?: string) {
    const shown = await this.list.refresh();
    const current = this.items.find((x) => x.path === (select ?? this.path));
    if (current && current.kind === this.kind) {
      this.list.current = current.id;
      this.list.render();
      if (current.path !== this.path) this.open(current.path);
      return;
    }
    // Another kind's score is open (or none): open this list's top item.
    const top = this.list.top();
    if (top && top.path !== this.path) this.open(top.path);
    else if (!shown.length && !this.dirty()) this.clear();
  }

  /** Nothing open (an empty list). */
  private clear() {
    this.path = null;
    this.saved = "";
    this.timeline = null;
    this.nameEl.textContent = "—";
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: "" } });
    this.renderSide(null, [], "");
    this.header();
  }

  /** The open score's record, if it is in the list. */
  private item(path = this.path): ScoreItem | undefined {
    return this.items.find((x) => x.path === path);
  }

  /** Title, kind, stars and the Save button for the open score and whoever is looking. */
  private async header() {
    const it = this.item();
    const mine = !!it && (owns(this.who, it.owner) || !!this.who?.curator);
    this.nameEl.textContent = it ? it.title : this.path ?? "—";
    this.nameEl.title = this.path ?? "";
    this.kindSel.hidden = !it;
    this.kindSel.value = it?.kind ?? this.kind;
    this.kindSel.disabled = !mine;
    this.kindSel.title = mine ? "What this score is: it decides the tab it is listed under" : "Only its author can change what it is";
    this.stars.el.hidden = !it;
    this.changedDirty();
    if (!it) return;
    const standing = this.list.standingOf(it.id);
    let mineStars: number | null = null;
    try {
      mineStars = await (await ratings()).mineFor("score", it.id);
    } catch {}
    if (this.item()?.id !== it.id) return;
    this.stars.set({ mine: mineStars, average: standing?.average ?? null, count: standing?.count ?? 0, signedIn: !!this.who });
  }

  private async rate(stars: number | null) {
    const it = this.item();
    if (!it) return;
    await (await ratings()).rate("score", it.id, stars);
  }

  private async changeKind(kind: ScoreKind) {
    if (!this.path) return;
    try {
      await api.setScoreKind(this.path, kind);
      this.statusEl.textContent = `now listed under ${KIND_LABEL[kind].many[0].toUpperCase() + KIND_LABEL[kind].many.slice(1)}`;
    } catch (e) {
      this.statusEl.textContent = `couldn't change it: ${(e as Error).message}`;
    }
    await this.list.refresh();
    this.header();
  }

  /** The kind of a score (after the list has loaded); a song when unknown. */
  async kindOf(path: string): Promise<ScoreKind> {
    if (!this.items.length) await this.list.refresh();
    return this.item(path)?.kind ?? "song";
  }

  open(path: string) {
    return this.track(this.openNow(path));
  }

  private async openNow(path: string) {
    if (this.dirty() && !confirm(`Discard unsaved changes to ${this.item()?.title ?? this.path}?`)) return;
    if (!this.items.length) await this.list.refresh();
    let text: string;
    try {
      text = await api.score(path);
    } catch (e) {
      this.statusEl.textContent = e instanceof SignedOut ? "sign in to open scores" : `couldn't open ${path}: ${(e as Error).message}`;
      return;
    }
    this.path = path;
    this.saved = text;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      effects: this.language.reconfigure(path.endsWith(".apr") ? aprLanguage : yaml()),
    });
    const it = this.item(path);
    if (it) {
      this.list.current = it.id;
      this.list.render();
    }
    this.header();
  }

  /** Where a new score of yours goes: your own folder, so two people's "my-beat" never collide. */
  private async folder(): Promise<string | null> {
    const a = await currentAccount().catch(() => null);
    if (a) return `scores/${a.username}`;
    return this.who ? "scores" : null; // locally there is one person; a guest has no folder
  }

  /** A new score of this tab's kind: the kind's template, or (`from`) a copy of another score's text. */
  private async create(text?: string, suggested?: string, from?: string) {
    const folder = await this.folder();
    if (!folder) return signIn();
    const one = KIND_LABEL[this.kind].one;
    const name = prompt(`Name for the new ${one} (letters, digits, - and _):`, suggested ?? `my-${one}`)?.trim();
    if (!name) return;
    const safe = name.replace(/[^A-Za-z0-9_-]+/g, "-");
    const format = from?.endsWith(".yaml") ? "yaml" : "apr";
    const path = `${folder}/${safe}.${format}`;
    // The samples folder is relative to the score: keep it pointing at the same place from the new folder.
    const source = from ? from.split("/").slice(0, -1).join("/") : TEMPLATE_FOLDER;
    text = rebaseSamples(text ?? TEMPLATES[this.kind], source, folder);
    if (this.items.some((x) => x.path === path)) {
      this.statusEl.textContent = `you already have ${safe}; pick another name`;
      return;
    }
    try {
      await api.saveScore(path, text, this.kind);
    } catch (e) {
      this.statusEl.textContent = `couldn't create ${path}: ${(e as Error).message}`;
      return;
    }
    this.statusEl.textContent = "";
    this.saved = "";
    this.path = null; // nothing unsaved to warn about: open the new one
    await this.loadList(path);
    await this.open(path);
  }

  private dirty() {
    return this.path !== null && this.view.state.doc.toString() !== this.saved;
  }

  private async save() {
    if (!this.path) return;
    if (!this.who) return signIn();
    const it = this.item();
    const text = this.view.state.doc.toString();
    if (it && !owns(this.who, it.owner) && !this.who.curator) {
      // Someone else's score: yours is a copy, under your name.
      this.saved = text; // the edits move to the copy
      return this.create(text, it.title, it.path);
    }
    try {
      await api.saveScore(this.path, text);
    } catch (e) {
      this.statusEl.textContent = `couldn't save: ${(e as Error).message}`;
      return;
    }
    this.saved = text;
    this.changedDirty();
  }

  private changedDirty() {
    const d = this.dirty();
    const it = this.item();
    const theirs = !!it && !!this.who && !owns(this.who, it.owner) && !this.who.curator;
    this.saveBtn.disabled = !d;
    this.saveBtn.textContent = !d ? "Saved" : !this.who ? "Sign in to save" : theirs ? "Save a copy •" : "Save •";
  }

  private changed() {
    this.changedDirty();
    clearTimeout(this.compileTimer);
    this.compileTimer = window.setTimeout(() => ((this.compileTimer = 0), this.recompile()), 300);
  }

  private recompile() {
    return this.track(this.compileNow());
  }

  private async compileNow() {
    if (!this.path) return;
    const gen = ++this.generation;
    const text = this.view.state.doc.toString();
    const r = await compile(text, this.path);
    if (gen !== this.generation) return; // a newer edit is already compiling
    const doc = this.view.state.doc;
    const diagnostics: Diagnostic[] = (r.errors ?? []).flatMap((msg) => {
      const m = /line (\d+) column (\d+)/.exec(msg);
      if (!m) return [];
      const line = doc.line(Math.min(doc.lines, +m[1]));
      const from = Math.min(line.to, line.from + Math.max(0, +m[2] - 1));
      // Underline the word at the error, not the rest of the line.
      const word = /^\S+/.exec(doc.sliceString(from, line.to));
      const to = Math.max(from + 1, from + (word ? word[0].length : 1));
      return [{ from, to: Math.min(to, line.to), severity: "error" as const, message: msg.replace(/^.*?: (line \d+ column \d+: )?/, "") }];
    });
    this.view.dispatch(setDiagnostics(this.view.state, diagnostics));
    if (!this.beat.root.hidden) this.beat.update(text, r.timeline ?? null);
    if (!this.harp.root.hidden) this.harp.update(text, r.timeline ?? null);
    if (!this.roll.root.hidden) this.roll.update(text, r.timeline ?? null);
    if (r.errors) {
      this.renderSide(null, r.errors, "");
      this.statusEl.textContent = player.transport.playing ? "still playing the last good version" : "";
      return;
    }
    this.timeline = r.timeline;
    this.renderSide(r.timeline, [], r.explain);
    this.flow.update(r.timeline);
    if (player.transport.playing) this.send(r.timeline);
  }

  /** Render and queue the current timeline (at the next bar if already playing). */
  async send(tl = this.timeline, onProgress?: (p: LoadProgress) => void) {
    if (!tl) return;
    try {
      // Progress shows on the play button (onProgress); the status line reports the result.
      const res = await player.arrange(this.harp.filter(this.beat.filter(tl)), onProgress);
      this.statusEl.textContent = `${res.rendered} rendered, ${res.reused} reused in ${(res.ms / 1000).toFixed(1)} s` + (player.transport.playing ? " · lands at the next bar" : "");
    } catch (e) {
      if (e instanceof Superseded) return; // a newer edit's render will report
      this.statusEl.textContent = `couldn't render: ${(e as Error).message}`;
    }
  }

  private renderSide(tl: Timeline | null, errors: string[], explain: string) {
    const kids: Node[] = [];
    if (tl) {
      const bars = tl.length_beats / tl.meter;
      kids.push(el("h2", {}, `${bars} bars · ${tl.tempo} BPM · ${tl.key.replace("b", "♭")}`));
      this.chordsEl.replaceChildren(
        ...tl.harmony.map((h) => {
          const [numeral, name] = /^(.*?)(?: \((.*)\))?$/.exec(h.label)!.slice(1);
          const d = el("div", {}, numeral || "—", el("small", {}, name ? `${name} · ${Math.round((h.fit?.coverage ?? 0) * 100)}%` : "no chord"));
          d.style.flex = String(h.end_beat - h.start_beat);
          return d;
        }),
        this.head,
      );
      kids.push(this.chordsEl);
    }
    if (errors.length) kids.push(el("h2", {}, `Problems (${errors.length})`), el("ul", { className: "problems" }, ...errors.map((e) => el("li", {}, e.replace(/^[^:]*\.(yaml|apricity): /, "")))));
    if (tl?.warnings.length) kids.push(el("h2", {}, "Warnings"), el("ul", { className: "warnings" }, ...tl.warnings.map((w) => el("li", {}, w))));
    // Warnings are listed above; don't repeat them at the end of the explanation.
    if (explain) kids.push(el("h2", {}, "How it was solved"), el("pre", { className: "explain" }, explain.split("\nWarnings:")[0].trimEnd()));
    if (!tl && !errors.length) kids.push(el("div", { className: "empty" }, "Open or create a score."));
    this.sideEl.replaceChildren(...kids);
  }

  private drawHead(beat: number) {
    if (!this.timeline) return;
    this.head.style.left = `${(beat / this.timeline.length_beats) * 100}%`;
  }
}
