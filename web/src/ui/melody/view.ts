// The piano roll: a `notes` melody as notes on rows of the key's pitches. Under the score for the Melodies kind:
// rows are the key's degrees over two octaves (All notes adds the ones between), columns are steps; click to place
// a note, drag it to move, drag its right edge to lengthen it, Delete removes it; the chords run underneath. Every
// edit rewrites the melody in the text (model.ts), which recompiles and plays at the next bar. A row's key plays
// the clip at that pitch.

import { reportError } from "../notices";
import { el } from "../dom";
import { audioUrl, melodyView, type ClipItem, type Timeline } from "../../apricity";
import { player } from "../../audio/player";
import { pickClip } from "../clip-picker";
import { midiOf, noteName } from "../chords/view";
import { move, pitchAt, pitchText, place, readRoll, remove, resize, rows, semitones, setGrid, setLength, stepDegree, writeRoll, type MelodyView, type Pitch, type Roll } from "./model";

export interface RollDeps {
  text(): string;
  edit(text: string): void;
}

type Gesture = { kind: "move"; i: number; dx: number; moved: boolean } | { kind: "resize"; i: number } | { kind: "draw"; i: number } | null;

const PC: Record<string, number> = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };

export class RollView {
  readonly root = el("section", { className: "roll", tabIndex: 0, ariaLabel: "Piano roll" });
  private bar = el("div", { className: "roll-bar" });
  private body = el("div", { className: "roll-body" });
  private gridEl = el("div", { className: "roll-grid", role: "grid" });
  private trackSel = el("select", { ariaLabel: "Melody track" });
  private pitchEl = el("span", { className: "roll-pitch" });
  private grids = el("div", { className: "seg", role: "group", ariaLabel: "Step size" });
  private lengths = el("div", { className: "seg", role: "group", ariaLabel: "Length in bars" });
  private all = el("button", { type: "button", className: "btn tog", title: "Show the notes between the key's notes too (b3, #4…)" }, "All notes");
  private pos = el("span", { className: "roll-pos mono" }, "1.1");
  private note = el("span", { className: "roll-note" });
  private view: MelodyView | null = null;
  private roll: Roll | null = null;
  private timeline: Timeline | null = null;
  private trackIndex = 0;
  private rowList: number[] = [];
  private selected: number | null = null;
  private gesture: Gesture = null;
  private ph = el("div", { className: "ph", hidden: true });
  private seq = 0;
  private decoded = new Map<string, Promise<AudioBuffer>>();

  constructor(private deps: RollDeps) {
    this.trackSel.addEventListener("change", () => ((this.trackIndex = Number(this.trackSel.value)), (this.selected = null), this.reread()));
    for (const g of [8, 16]) {
      const b = el("button", { type: "button", textContent: `1/${g}` });
      b.dataset.grid = String(g);
      b.addEventListener("click", () => this.setGrid(g));
      this.grids.append(b);
    }
    for (const n of [1, 2, 4, 8]) {
      const b = el("button", { type: "button", textContent: `${n} bar${n > 1 ? "s" : ""}` });
      b.dataset.bars = String(n);
      b.addEventListener("click", () => this.setBars(n));
      this.lengths.append(b);
    }
    this.all.addEventListener("click", () => (this.all.setAttribute("aria-pressed", String(!this.allNotes())), this.render()));
    const field = (label: string, ...kids: Node[]) => el("label", { className: "beat-field" }, el("span", {}, label), ...kids);
    this.lengths.title = "The melody's own length; it repeats over the piece";
    this.bar.append(field("Track", this.trackSel), this.pitchEl, field("Steps", this.grids), field("Melody", this.lengths), this.all, this.pos, this.note);
    this.body.append(this.gridEl);
    this.root.append(this.bar, this.body);
    this.gridEl.addEventListener("pointerdown", (e) => this.down(e));
    window.addEventListener("pointermove", (e) => this.drag(e));
    window.addEventListener("pointerup", () => this.up());
    this.root.addEventListener("keydown", (e) => this.key(e));
    player.onTransport((t) => this.playhead(t.position / t.framesPerBeat, t.playing));
  }

  private allNotes() {
    return this.all.getAttribute("aria-pressed") === "true";
  }

  /** The score changed (or compiled): re-read the melody from the text. */
  async update(text: string, timeline: Timeline | null) {
    if (timeline) this.timeline = timeline;
    const seq = ++this.seq;
    let v: MelodyView;
    try {
      v = await melodyView(text);
    } catch (e) {
      return this.message(`Couldn't read the melody: ${(e as Error).message}`);
    }
    if (seq !== this.seq || this.gesture) return;
    if (v.errors?.length) return this.message("Fix the score's problems to see the roll.");
    this.view = v;
    if (!v.tracks.length) return this.empty();
    if (this.trackIndex >= v.tracks.length) this.trackIndex = 0;
    this.reread();
  }

  /** Read the chosen track's melody from the view (the text), then draw it. Edits in progress draw with render(). */
  private reread() {
    const v = this.view!;
    this.roll = readRoll(v, v.tracks[this.trackIndex]);
    if (this.selected !== null && this.selected >= this.roll.notes.length) this.selected = null;
    this.render();
  }

  private message(text: string) {
    this.view = null;
    this.roll = null;
    this.gridEl.replaceChildren(el("div", { className: "empty" }, text));
  }

  /** No melody yet: offer to add one. */
  private empty() {
    this.roll = null;
    const add = el("button", { type: "button", className: "btn primary" }, "Add a melody track");
    add.addEventListener("click", () => this.addTrack());
    this.gridEl.replaceChildren(el("div", { className: "empty" }, el("p", {}, "This score has no melody yet: a track that plays one sound at the notes of a tune."), add));
  }

  // ---------------------------------------------------------------- pitch helpers

  /** The MIDI note of the key's degree 1 for this track: in its `octave`, else nearest the clip's own pitch. */
  private tonicMidi(): number {
    const v = this.view!;
    const t = v.tracks[this.trackIndex];
    const pc = PC[v.scale[0]?.name ?? "C"] ?? 0;
    if (t.octave !== null && t.octave !== undefined) return 12 * (t.octave + 1) + pc;
    const near = this.clipMidi() ?? 60;
    let d = (((pc - near) % 12) + 12) % 12;
    if (d > 6) d -= 12;
    return near + d;
  }

  /** The track's clip pitch (heard, pinned or guessed), from the compiled timeline. */
  private clipMidi(): number | null {
    const name = this.view?.tracks[this.trackIndex]?.name;
    const p = this.timeline?.tracks.find((t) => t.name === name)?.pitch;
    return p ? midiOf(p) : null;
  }

  // ---------------------------------------------------------------- render

  private render() {
    const v = this.view!;
    const t = v.tracks[this.trackIndex];
    this.trackSel.replaceChildren(...v.tracks.map((x, i) => el("option", { value: String(i), textContent: x.name })));
    this.trackSel.value = String(this.trackIndex);
    this.trackSel.parentElement!.hidden = v.tracks.length < 2;
    const r = this.roll!;
    const heard = this.timeline?.tracks.find((x) => x.name === t.name)?.pitch;
    this.pitchEl.textContent = heard ? `${t.name}: ${heard.replace(/\s*\((\w+)\)$/, " · $1")}` : t.name;
    for (const b of this.grids.children) (b as HTMLElement).setAttribute("aria-pressed", String(Number((b as HTMLElement).dataset.grid) === r.grid));
    const bars = r.length / r.stepsPerBar;
    for (const b of this.lengths.children) (b as HTMLElement).setAttribute("aria-pressed", String(Number((b as HTMLElement).dataset.bars) === bars));
    for (const b of [...this.grids.children, ...this.lengths.children, this.all]) (b as HTMLButtonElement).disabled = !r.editable;
    this.note.textContent = r.editable ? "" : `Read-only: ${r.why}. Edit it in the text.`;
    this.root.classList.toggle("readonly", !r.editable);

    // Rows: the key's pitches (or all twelve), plus any note that isn't on one.
    const extra = r.notes.map((x) => semitones(v, x.pitch));
    this.rowList = rows(v, this.allNotes(), extra);
    const tonic = this.tonicMidi();
    const L = r.length;
    const spb = r.stepsPerBar;
    const perBeat = r.grid / 4;
    this.gridEl.style.setProperty("--steps", String(L));
    this.gridEl.style.setProperty("--rows", String(this.rowList.length));
    this.gridEl.style.setProperty("--step-pct", `${100 / L}%`);
    this.gridEl.style.setProperty("--beat-pct", `${(100 * perBeat) / L}%`);
    this.gridEl.style.setProperty("--bar-pct", `${(100 * spb) / L}%`);

    const kids: HTMLElement[] = [el("div", { className: "corner" }, "")];
    for (let b = 0; b < bars; b++) {
      const h = el("div", { className: "bar-no" }, String(b + 1));
      h.style.gridColumn = `${2 + b * spb} / span ${spb}`;
      kids.push(h);
    }
    this.rowList.forEach((s, ri) => {
      const p = pitchAt(v, s);
      const inKey = p.accidental === 0;
      const key = el("button", { type: "button", className: `key${inKey ? "" : " out"}${p.degree === 1 && inKey ? " root" : ""}` }, el("b", {}, pitchText(p)), el("span", {}, noteName(tonic + s)));
      key.style.gridRow = String(ri + 2);
      key.title = `Hear ${noteName(tonic + s)}`;
      key.addEventListener("click", () => this.hear(s));
      const lane = el("div", { className: `lane${inKey ? "" : " out"}` });
      lane.style.gridRow = String(ri + 2);
      lane.dataset.row = String(ri);
      kids.push(key, lane);
    });
    r.notes.forEach((x, i) => {
      const ri = this.rowList.indexOf(semitones(v, x.pitch));
      const n = el("div", { className: `nt${i === this.selected ? " sel" : ""}` }, el("span", {}, pitchText(x.pitch)), el("i", { className: "edge" }));
      n.dataset.i = String(i);
      n.style.gridRow = String(ri + 2);
      n.style.gridColumn = `${2 + x.step} / span ${x.len}`;
      n.title = `${noteName(tonic + semitones(v, x.pitch))}, ${x.len} step${x.len > 1 ? "s" : ""}${x.vel ? `, velocity ${x.vel}` : ""}`;
      kids.push(n);
    });
    // The chords underneath, from the compiled harmony.
    const chordRow = String(this.rowList.length + 2);
    const corner = el("div", { className: "corner chords-h" }, "chords");
    corner.style.gridRow = chordRow;
    kids.push(corner);
    for (const h of this.timeline?.harmony ?? []) {
      const a = Math.round(h.start_beat * perBeat);
      const b = Math.min(L, Math.round(h.end_beat * perBeat));
      if (a >= L || b <= a) continue;
      const [num, name] = /^(.*?)(?: \((.*)\))?$/.exec(h.label)!.slice(1);
      const c = el("div", { className: "ch" }, el("b", {}, num || "—"), el("span", {}, name ?? ""));
      c.style.gridRow = chordRow;
      c.style.gridColumn = `${2 + a} / span ${b - a}`;
      kids.push(c);
    }
    this.ph.style.gridRow = `1 / span ${this.rowList.length + 2}`;
    this.gridEl.replaceChildren(...kids, this.ph);
  }

  // ---------------------------------------------------------------- editing

  /** The step and row under the pointer. */
  private at(e: PointerEvent): { step: number; row: number } | null {
    const lane = (document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[]).find((x) => x.classList?.contains("lane") && this.gridEl.contains(x));
    if (!lane || !this.roll) return null;
    const box = lane.getBoundingClientRect();
    const step = Math.max(0, Math.min(this.roll.length - 1, Math.floor(((e.clientX - box.left) / box.width) * this.roll.length)));
    return { step, row: Number(lane.dataset.row) };
  }

  private pitchOfRow(row: number): Pitch {
    return pitchAt(this.view!, this.rowList[row]);
  }

  private down(e: PointerEvent) {
    const r = this.roll;
    if (!r || !r.editable) return;
    const target = e.target as HTMLElement;
    const nt = target.closest<HTMLElement>(".nt");
    if (nt) {
      e.preventDefault();
      const i = Number(nt.dataset.i);
      this.selected = i;
      if (target.classList.contains("edge")) this.gesture = { kind: "resize", i };
      else {
        const at = this.at(e);
        this.gesture = { kind: "move", i, dx: at ? at.step - r.notes[i].step : 0, moved: false };
      }
      this.renderNotes();
      return;
    }
    const at = this.at(e);
    if (!at) return;
    e.preventDefault();
    const pitch = this.pitchOfRow(at.row);
    this.roll = place(r, at.step, pitch);
    this.selected = this.roll.notes.findIndex((x) => x.step === at.step);
    this.gesture = { kind: "draw", i: this.selected };
    this.hear(this.rowList[at.row]);
    this.render();
  }

  private drag(e: PointerEvent) {
    const g = this.gesture;
    const r = this.roll;
    if (!g || !r) return;
    const at = this.at(e);
    if (!at) return;
    const x = r.notes[g.i];
    if (!x) return;
    if (g.kind === "resize" || g.kind === "draw") {
      const len = at.step - x.step + 1;
      if (len !== x.len) (this.roll = resize(r, g.i, len)), this.render();
      return;
    }
    const step = Math.max(0, at.step - g.dx);
    const pitch = this.pitchOfRow(at.row);
    const same = step === x.step && semitones(this.view!, pitch) === semitones(this.view!, x.pitch);
    if (same) return;
    g.moved = true;
    this.roll = move(r, g.i, step, pitch);
    this.selected = this.roll.notes.findIndex((y) => y.step === step);
    g.i = this.selected;
    if (semitones(this.view!, pitch) !== semitones(this.view!, x.pitch)) this.hear(semitones(this.view!, pitch));
    this.render();
  }

  private up() {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (g.kind === "move" && !g.moved) return; // a click: just selected
    this.commit();
  }

  private commit() {
    if (!this.roll) return;
    try {
      this.deps.edit(writeRoll(this.deps.text(), this.roll));
    } catch (e) {
      this.note.textContent = (e as Error).message;
    }
  }

  private renderNotes() {
    for (const n of this.gridEl.querySelectorAll<HTMLElement>(".nt")) n.classList.toggle("sel", Number(n.dataset.i) === this.selected);
  }

  private key(e: KeyboardEvent) {
    const r = this.roll;
    if (!r || !r.editable || this.selected === null || (e.target as HTMLElement).closest("input, select")) return;
    const x = r.notes[this.selected];
    if (!x) return;
    const v = this.view!;
    let next: Roll;
    let select: number | null = null;
    if (e.key === "Delete" || e.key === "Backspace") {
      next = remove(r, this.selected);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      // A scale step (a semitone with All notes on); Shift: an octave.
      const dir = e.key === "ArrowUp" ? 1 : -1;
      const pitch = e.shiftKey ? { ...x.pitch, octave: x.pitch.octave + dir } : this.allNotes() ? pitchAt(v, semitones(v, x.pitch) + dir) : stepDegree(x.pitch, dir);
      next = move(r, this.selected, x.step, pitch);
      select = x.step;
      this.hear(semitones(v, pitch));
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const step = x.step + (e.key === "ArrowRight" ? 1 : -1);
      if (step < 0 || step >= r.length) return;
      next = move(r, this.selected, step, x.pitch);
      select = step;
    } else if (e.key === "Escape") {
      this.selected = null;
      return this.renderNotes();
    } else return;
    e.preventDefault();
    this.roll = next;
    this.selected = select === null ? null : next.notes.findIndex((y) => y.step === select);
    this.render();
    this.commit();
  }

  private setGrid(g: number) {
    if (!this.roll || !this.roll.editable || g === this.roll.grid) return;
    try {
      this.deps.edit(setGrid(this.deps.text(), this.roll, g));
    } catch (e) {
      this.note.textContent = (e as Error).message;
    }
  }

  private setBars(n: number) {
    if (!this.roll || !this.roll.editable) return;
    this.deps.edit(setLength(this.deps.text(), this.roll, n));
  }

  private playhead(beat: number, playing: boolean) {
    const r = this.roll;
    if (!r) return;
    const step = Math.floor(beat * (r.grid / 4)) % r.length;
    this.ph.hidden = !playing;
    if (playing) this.ph.style.gridColumn = `${2 + step} / span 1`;
    this.pos.textContent = playing ? `${Math.floor(step / r.stepsPerBar) + 1}.${Math.floor((step % r.stepsPerBar) / (r.grid / 4)) + 1}` : "1.1";
  }

  // ---------------------------------------------------------------- sound

  /** Hear the track's clip at a pitch (semitones above the key's degree 1): a quick sampler-style preview. */
  private async hear(semis: number) {
    const tl = this.timeline;
    const name = this.view?.tracks[this.trackIndex]?.name;
    const info = tl?.tracks.find((t) => t.name === name);
    const piece = info?.pieces?.[0];
    const path = piece ? tl!.sources[piece.source]?.path : undefined;
    const clip = this.clipMidi();
    if (!piece || !path || clip === null) return;
    try {
      await player.init();
      const ctx = player.ctx!;
      await ctx.resume();
      if (!this.decoded.has(path)) {
        const p = audioUrl(path)
          .then((u) => fetch(u))
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${path}: ${r.status}`))))
          .then((b) => ctx.decodeAudioData(b));
        p.catch(() => this.decoded.delete(path));
        this.decoded.set(path, p);
      }
      const buf = await this.decoded.get(path)!;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 2 ** ((this.tonicMidi() + semis - clip) / 12);
      src.connect(ctx.destination);
      src.start(0, piece.src_start, Math.max(0.05, piece.src_end - piece.src_start));
    } catch (e) {
      reportError("play that note", e);
    }
  }

  // ---------------------------------------------------------------- a new melody track

  private async addTrack() {
    const c: ClipItem | null = await pickClip("A sound for the melody", "Find a clip (a single note works best: shot…)", (c) => (/^(shot|hit)/.test(c.name) ? 2 : 0) - Math.min(1, (c.end - c.start) / 4));
    if (!c) return;
    const text = this.deps.text();
    const taken = new Set([...text.matchAll(/^clip\s+([A-Za-z][A-Za-z0-9_-]*)/gm)].map((m) => m[1]));
    let name = "lead";
    for (let n = 2; taken.has(name); n++) name = `lead${n}`;
    const lines = text.replace(/\s+$/, "").split("\n");
    let lastClip = -1;
    lines.forEach((l, i) => /^clip\s/.test(l) && (lastClip = i));
    lines.splice(lastClip + 1, 0, `clip ${name} = ${c.samplePath.replace(/^samples\//, "")}  ${c.name}`);
    lines.push(`track ${name}  notes "1 . . . 3 . . . | 5 . . . 3 . . ."  grid 8`);
    this.deps.edit(lines.join("\n") + "\n");
  }
}
