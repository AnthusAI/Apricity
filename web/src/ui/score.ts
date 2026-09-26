// Score editor: YAML in, live compile (wasm) on every edit, live playback that swaps changes in
// at the next bar. Problems with a line number are marked in the editor; all are listed beside it.

import { reportError } from "./notices";
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
import { forkFrom, freeTitle, owns, SignedOut, SCORE_KINDS, type Me, type ScoreItem, type ScoreKind } from "../data/catalog";
import { RankedList } from "./ranked-list";
import { TagEditor } from "./tag-chips";
import { tagCounts } from "../data/tags";
import { CommentThread } from "./comments";
import { columnSplitter } from "./splitter";
import { scoreCredits } from "./credits";
import { opened, type Opened } from "./at";
import { PAGE_OF_KIND } from "../route";
import { basedOn } from "../data/licenses";
import { timeAgo } from "./time";
import { mode } from "../data/client";
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
  /** Its tags, under the bar: chips linking to each tag's leaderboard; its author adds and removes them. */
  private tagEditor = new TagEditor(async (tags) => {
    if (!this.path) return;
    await api.setScoreTags(this.path, tags);
    await this.list.refresh();
  });
  private nameEl = el("span", { className: "name" }, "—");
  private saveBtn = el("button", { className: "btn", type: "button", disabled: true }, "Save");
  private forkBtn = el("button", { className: "btn", type: "button", title: "Make your own copy of this score, linked back to it" }, "Fork");
  /** "forked from beat-1 by @ann", under the title bar. */
  private lineageEl = el("div", { className: "lineage", hidden: true });
  /** The editor's two views: the code, and how the compiler solved it (tempo, key, and each clip's warp and
   *  transposition per chord, with why). The second is there when you want it, not all the time. */
  private codeTab = el("button", { type: "button", role: "tab", className: "on", ariaSelected: "true" }, "Code");
  private solvedTab = el("button", { type: "button", role: "tab", ariaSelected: "false", title: "What the compiler did to make it play: each clip's tempo, key, stretch and transposition per chord, and why" }, "How it was solved");
  private solvedEl = el("pre", { className: "explain solved", hidden: true }, "Nothing compiled yet.");
  /** Its forks, in the side panel. */
  private forksHost = el("div", { className: "side-forks" });
  private statusEl = el("span", { className: "status" });
  private sideEl = el("div", { className: "side" });
  /** The open score's comments, at the bottom of the side panel (kept across recompiles). */
  private commentsHost = el("div", { className: "side-comments" });
  /** The open score's credits: a citation for every recording it plays (redrawn when its sources change). */
  private creditsHost = el("div", { className: "side-credits" });
  private creditsKey = "";
  private thread: { id: string; view: CommentThread } | null = null;
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
    this.forkBtn.addEventListener("click", () => void this.fork());
    this.codeTab.addEventListener("click", () => this.showCode(true));
    this.solvedTab.addEventListener("click", () => this.showCode(false));
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
      row: (x) => ({
        title: x.title,
        sub: [x.undocumented ? "⚠ plays a sample with no license documented" : "", byline(this.names, x.owner, owns(this.who, x.owner)), x.forks ? `${x.forks} fork${x.forks > 1 ? "s" : ""}` : "", x.tags.map((t) => `#${t}`).join(" ")].filter(Boolean).join(" · "),
      }),
      // "#techno" finds its tag; so does "techno".
      text: (x) => `${x.title} ${byline(this.names, x.owner, false)} ${x.tags.map((t) => `#${t}`).join(" ")}`,
      owner: (x) => x.owner,
      me: async () => this.who,
      open: (x) => this.open(x.path, "user"),
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
      el("div", { className: "editor" }, el("div", { className: "bar" }, this.nameEl, this.kindSel, this.stars.el, el("span", { style: "flex:1" }), this.statusEl, this.stepsBtn, this.harpBtn, this.rollBtn, this.flowBtn, this.forkBtn, this.saveBtn), this.tagEditor.root, this.lineageEl, el("div", { className: "code-tabs", role: "tablist" }, this.codeTab, this.solvedTab), el("div", { className: "cm-host" }, this.view.dom), this.solvedEl),
      this.sideEl,
      ...this.dockPanels(),
    );
    // The list and the side panel are as wide as you drag them.
    // Neither may squeeze the editor below its minimum (--editor-min in style.css), so its buttons always fit.
    const editorMin = () => parseFloat(getComputedStyle(root).getPropertyValue("--editor-min")) || 440;
    const widthOf = (e: HTMLElement) => e.getBoundingClientRect().width;
    columnSplitter({ view: root, panel: this.list.el, edge: "right", prop: "--list-w", key: "score-list", min: 180, max: (w) => Math.min(480, w - widthOf(this.sideEl) - editorMin()) });
    columnSplitter({ view: root, panel: this.sideEl, edge: "left", prop: "--side-w", key: "score-side", min: 280, max: (w) => w - widthOf(this.list.el) - editorMin() });
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
    } catch {} // storage can be blocked (private browsing): nothing to report
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
      } catch {} // storage can be blocked (private browsing): nothing to report
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
    // What to show: the one asked for, or one being opened now (a link), or what was open.
    const current = this.items.find((x) => x.path === (select ?? this.opening ?? this.path));
    if (current && current.kind === this.kind) {
      this.list.current = current.id;
      this.list.render();
      if (current.path !== this.path) this.open(current.path, "auto");
      return;
    }
    // Another kind's score is open (or none): open this list's top item.
    const top = this.list.top();
    if (top && top.path !== this.path && !this.opening) this.open(top.path, "auto");
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

  /** A score's path by its record id (e.g. from an Activity card), or null. */
  async pathOf(id: string): Promise<string | null> {
    const { scores } = await api.scores();
    return scores.find((x) => x.id === id)?.path ?? null;
  }

  /** The open score's record, if it is in the list. */
  private item(path = this.path): ScoreItem | undefined {
    return this.items.find((x) => x.path === path);
  }

  /** Title, kind, stars and the Save button for the open score and whoever is looking. */
  private async header() {
    const it = this.item();
    // Its comments: a new thread when another score opens.
    if (!it) (this.thread = null), this.commentsHost.replaceChildren();
    else if (this.thread?.id !== it.id) {
      this.thread = { id: it.id, view: new CommentThread({ type: "score", id: it.id }) };
      this.commentsHost.replaceChildren(this.thread.view.root);
      void this.thread.view.load();
    }
    const mine = !!it && (owns(this.who, it.owner) || !!this.who?.curator);
    this.forkBtn.hidden = !it;
    this.renderLineage(it);
    this.nameEl.textContent = it ? it.title : this.path ?? "—";
    this.nameEl.title = this.path ?? "";
    this.kindSel.hidden = !it;
    this.kindSel.value = it?.kind ?? this.kind;
    this.kindSel.disabled = !mine;
    this.kindSel.title = mine ? "What this score is: it decides the tab it is listed under" : "Only its author can change what it is";
    this.stars.el.hidden = !it;
    this.tagEditor.show(it?.tags ?? [], mine, tagCounts(this.items).map((t) => t.tag));
    this.tagEditor.root.hidden ||= !it;
    this.changedDirty();
    if (!it) return;
    const standing = this.list.standingOf(it.id);
    let mineStars: number | null = null;
    try {
      mineStars = await (await ratings()).mineFor("score", it.id);
    } catch (e) {
      reportError("load your rating", e);
    }
    if (this.item()?.id !== it.id) return;
    this.stars.set({ mine: mineStars, average: standing?.average ?? null, count: standing?.count ?? 0, signedIn: !!this.who });
  }

  /** Show the code, or how it was solved. */
  private showCode(code: boolean) {
    this.codeTab.classList.toggle("on", code);
    this.solvedTab.classList.toggle("on", !code);
    this.codeTab.setAttribute("aria-selected", String(code));
    this.solvedTab.setAttribute("aria-selected", String(!code));
    (this.view.dom.parentElement as HTMLElement).hidden = !code;
    this.solvedEl.hidden = code;
  }

  /** "forked from beat-1 by @ann" under the bar, and the score's own forks in the side panel. */
  private renderLineage(it: ScoreItem | undefined) {
    const who = (owner: string | null | undefined) => byline(this.names, owner, owns(this.who, owner)).replace(/^by /, "") || "someone";
    const openLink = (x: ScoreItem) => {
      const a = el("button", { type: "button", className: "link" }, x.title);
      a.addEventListener("click", () => void this.openAny(x));
      return a;
    };
    const parent = it?.forkOf ? this.items.find((x) => x.id === it.forkOf) : undefined;
    this.lineageEl.hidden = !it?.forkOf;
    if (it?.forkOf) this.lineageEl.replaceChildren("forked from ", ...(parent ? [openLink(parent), ` by ${who(parent.owner)}`] : ["a score that's gone"]));
    const forks = it ? this.items.filter((x) => x.forkOf === it.id).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")) : [];
    this.forksHost.replaceChildren(
      ...(forks.length
        ? [el("section", { className: "forks" }, el("h3", {}, `Forks · ${forks.length}`), el("ul", {}, ...forks.map((f) => el("li", {}, openLink(f), ` · ${who(f.owner)} · ${timeAgo(f.createdAt)}`))))]
        : []),
    );
  }

  /** Open a score in the tab of its kind (a fork's parent may be another kind). */
  private async openAny(x: ScoreItem) {
    if (x.kind !== this.kind) document.dispatchEvent(new CustomEvent("apricity:open-item", { detail: { type: "score", id: x.id } }));
    else await this.open(x.path, "user");
  }

  /** Make your own copy of the open score (its current text), linked back to it. */
  private async fork() {
    const it = this.item();
    if (!it) return;
    if (!this.who) return signIn();
    const text = this.view.state.doc.toString();
    this.saved = text; // any edits go with the fork
    await this.create(text, it.title, it.path);
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

  /**
   * Open a score. `how` says who asked, for the address bar: a person ("user": a new history entry), the app
   * itself ("auto": the top of a list; the entry is replaced), or the address bar ("route": it's already there).
   */
  open(path: string, how: Opened = "user") {
    this.opening = path;
    const seq = ++this.openSeq;
    return this.track(this.openNow(path, how, seq).finally(() => seq === this.openSeq && (this.opening = null)));
  }
  /** The newest open asked for (older ones still loading give way to it), and the path it opens. */
  private openSeq = 0;
  private opening: string | null = null;

  private async openNow(path: string, how: Opened, seq: number) {
    if (this.dirty() && !confirm(`Discard unsaved changes to ${this.item()?.title ?? this.path}?`)) return;
    if (!this.items.length) await this.list.refresh();
    let text: string;
    try {
      text = await api.score(path);
      if (seq !== this.openSeq) return; // a newer open (a click, a link) took over
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
    opened({ page: PAGE_OF_KIND[it?.kind ?? this.kind], score: path }, how, it?.title);
  }

  /** Where a new score of yours goes: your own folder, so two people's "my-beat" never collide. */
  private async folder(): Promise<string | null> {
    const a = await currentAccount().catch(() => null);
    if (a) return `scores/${a.username}`;
    return this.who ? "scores" : null; // locally there is one person; a guest has no folder
  }

  /**
   * A new score of this tab's kind: the kind's template, or (`from`) a fork of another score, which remembers where
   * it came from (and the original at the start of the chain).
   */
  private async create(text?: string, suggested?: string, from?: string) {
    const folder = await this.folder();
    if (!folder) return signIn();
    const one = KIND_LABEL[this.kind].one;
    const parent = from ? this.item(from) : undefined;
    const taken = this.items.filter((x) => x.path.startsWith(`${folder}/`)).map((x) => x.title);
    const name = prompt(`Name for the new ${one} (letters, digits, - and _):`, freeTitle(suggested ?? `my-${one}`, taken))?.trim();
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
      await api.saveScore(path, text, this.kind, parent ? forkFrom(parent) : undefined);
    } catch (e) {
      this.statusEl.textContent = `couldn't create ${path}: ${(e as Error).message}`;
      return;
    }
    this.statusEl.textContent = "";
    this.saved = "";
    this.path = null; // nothing unsaved to warn about: open the new one
    await this.loadList(path);
    await this.open(path, "user");
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
    void this.renderCredits(r.timeline);
    this.flow.update(r.timeline);
    if (player.transport.playing) this.send(r.timeline);
  }

  /** Render and queue the current timeline (at the next bar if already playing). */
  /** Render and queue it; the reason it couldn't, or null when it could (or a newer edit took over). */
  async send(tl = this.timeline, onProgress?: (p: LoadProgress) => void): Promise<string | null> {
    if (!tl) return null;
    try {
      // Progress shows on the play button (onProgress); the status line reports the result.
      const res = await player.arrange(this.harp.filter(this.beat.filter(tl)), onProgress);
      this.statusEl.textContent = `${res.rendered} rendered, ${res.reused} reused in ${(res.ms / 1000).toFixed(1)} s` + (player.transport.playing ? " · lands at the next bar" : "");
      return null;
    } catch (e) {
      if (e instanceof Superseded) return null; // a newer edit's render will report
      this.statusEl.textContent = `couldn't render: ${(e as Error).message}`;
      return (e as Error).message;
    }
  }

  private async renderCredits(tl: Timeline) {
    const paths = [...new Set(tl.sources.map((s) => s.path))];
    const key = `${this.path}|${paths.join("|")}`;
    if (key === this.creditsKey) return;
    this.creditsKey = key;
    const [recs, who] = await Promise.all([api.creditsFor(paths).catch((e) => (reportError("work out this score's credits", e), [])), me().catch(() => null)]);
    if (key !== this.creditsKey) return;
    // A fork credits the score it came from first (and the original, further back).
    const it = this.item();
    const named = (id?: string) => {
      const x = id ? this.items.find((s) => s.id === id) : undefined;
      return x ? { id: x.id, title: x.title, by: byline(this.names, x.owner, false).replace(/^by /, "") || "someone" } : null;
    };
    const based = it?.forkOf ? basedOn(named(it.forkOf), named(it.forkRoot)) : null;
    this.creditsHost.replaceChildren(recs.length || based ? scoreCredits(recs, mode() === "local" || !!who?.curator, based) : "");
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
    // Warnings are listed above; the explanation lives in the editor's second tab.
    if (explain) this.solvedEl.textContent = explain.split("\nWarnings:")[0].trimEnd();
    else if (!tl) this.solvedEl.textContent = errors.length ? "It doesn't compile yet: see Problems." : "Nothing compiled yet.";
    if (!tl && !errors.length) kids.push(el("div", { className: "empty" }, "Open or create a score."));
    this.sideEl.replaceChildren(...kids, this.forksHost, this.creditsHost, this.commentsHost);
  }

  private drawHead(beat: number) {
    if (!this.timeline) return;
    this.head.style.left = `${(beat / this.timeline.length_beats) * 100}%`;
  }
}
