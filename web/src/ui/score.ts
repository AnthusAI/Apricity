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
import { api, compile, type Timeline } from "../apricitus";
import { player, Superseded } from "../audio/player";
import { el } from "./dom";


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

const NEW_SCORE = `# A new Apricitus score. Every edit recompiles; press play (or Space) to hear it.
tempo 100
key F mixolydian
samples ../samples

clip groove = marine-band/stems/Thunderer/drums.wav  pick 2bars  warp beats
clip horns  = marine-band/stems/Thunderer/other.wav  pick 1bar

chords I7 IV7 I7 . | IV7 . I7 . | V7 IV7 I7 V7

track groove  transpose 0
track horns   follow
`;

export class ScoreView {
  root: HTMLElement;
  path: string | null = null;
  timeline: Timeline | null = null;
  private view: EditorView;
  private language = new Compartment();
  private listEl = el("div", { className: "list" });
  private nameEl = el("span", { className: "name" }, "—");
  private saveBtn = el("button", { className: "btn", type: "button", disabled: true }, "Save");
  private statusEl = el("span", { className: "status" });
  private sideEl = el("div", { className: "side" });
  private chordsEl = el("div", { className: "chords", title: "Click to jump" });
  private head = el("i", { className: "head" });
  private saved = "";
  private compileTimer = 0;
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
    const newBtn = el("button", { className: "btn", type: "button" }, "New score");
    newBtn.addEventListener("click", () => this.create());
    this.chordsEl.addEventListener("click", (e) => {
      if (!this.timeline) return;
      const r = this.chordsEl.getBoundingClientRect();
      const beat = ((e.clientX - r.left) / r.width) * this.timeline.length_beats;
      player.seekBeat(Math.floor(beat / this.timeline.meter) * this.timeline.meter);
    });
    root.append(
      el("aside", { className: "sidebar" }, this.listEl, el("div", { className: "search" }, newBtn)),
      el("div", { className: "editor" }, el("div", { className: "bar" }, this.nameEl, el("span", { style: "flex:1" }), this.statusEl, this.refBtn(), this.saveBtn), el("div", { className: "cm-host" }, this.view.dom)),
      this.sideEl,
    );
    player.onTransport((t) => this.drawHead(t.position / t.framesPerBeat));
    this.loadList();
  }

  /** Opens the reference for whichever format is being edited. */
  private refBtn() {
    const b = el("button", { className: "btn", type: "button", title: "Open the language reference in the Docs tab" }, "Reference");
    b.addEventListener("click", () => {
      const file = this.path?.endsWith(".yaml") ? "yaml.md" : "language.md";
      document.dispatchEvent(new CustomEvent("apricitus:docs", { detail: { file } }));
    });
    return b;
  }

  async loadList(select?: string) {
    const { scores } = await api.scores();
    this.listEl.replaceChildren(
      el("div", { className: "group" }, "Scores"),
      ...scores.map((s) => {
        const row = el("button", { className: "row", type: "button" }, el("span", { className: "t" }, s.path.split("/").pop()!), el("span", { className: "sub" }, s.path));
        row.setAttribute("aria-current", String(s.path === this.path));
        row.addEventListener("click", () => this.open(s.path));
        return row;
      }),
    );
    const target = select ?? this.path ?? scores[0]?.path;
    if (target && target !== this.path) this.open(target);
  }

  async open(path: string) {
    if (this.dirty() && !confirm(`Discard unsaved changes to ${this.path}?`)) return;
    const text = await api.score(path);
    this.path = path;
    this.saved = text;
    this.nameEl.textContent = path;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      effects: this.language.reconfigure(path.endsWith(".apr") ? aprLanguage : yaml()),
    });
    this.loadList(path);
  }

  private async create() {
    const name = prompt("Name for the new score (letters, digits, - and _):", "my-piece")?.trim();
    if (!name) return;
    const safe = name.replace(/[^A-Za-z0-9_-]+/g, "-");
    const path = `scores/${safe}.apr`;
    await api.saveScore(path, NEW_SCORE);
    this.saved = "";
    await this.loadList(path);
    this.open(path);
  }

  private dirty() {
    return this.path !== null && this.view.state.doc.toString() !== this.saved;
  }

  private async save() {
    if (!this.path) return;
    const text = this.view.state.doc.toString();
    await api.saveScore(this.path, text);
    this.saved = text;
    this.changedDirty();
  }

  private changedDirty() {
    const d = this.dirty();
    this.saveBtn.disabled = !d;
    this.saveBtn.textContent = d ? "Save •" : "Saved";
  }

  private changed() {
    this.changedDirty();
    clearTimeout(this.compileTimer);
    this.compileTimer = window.setTimeout(() => this.recompile(), 300);
  }

  private async recompile() {
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
    if (r.errors) {
      this.renderSide(null, r.errors, "");
      this.statusEl.textContent = player.transport.playing ? "still playing the last good version" : "";
      return;
    }
    this.timeline = r.timeline;
    this.renderSide(r.timeline, [], r.explain);
    if (player.transport.playing) this.send(r.timeline);
  }

  /** Render and queue the current timeline (at the next bar if already playing). */
  async send(tl = this.timeline) {
    if (!tl) return;
    try {
      const res = await player.arrange(tl, (m) => (this.statusEl.textContent = m + "…"));
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
    if (errors.length) kids.push(el("h2", {}, `Problems (${errors.length})`), el("ul", { className: "problems" }, ...errors.map((e) => el("li", {}, e.replace(/^[^:]*\.(yaml|apricitus): /, "")))));
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
