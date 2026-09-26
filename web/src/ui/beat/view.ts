// The Beat editor: a drum machine under the score. A column of pads (click to hear one; M mutes it, S solos it), a
// grid of sixteenth steps (click or drag to paint, Shift-click for a ratchet, Alt-drag to hold a note), a playhead,
// and tempo, swing and pattern length. Every edit rewrites the score's text (model.ts), which recompiles and plays
// the change at the next bar. Mute and solo are for listening only and are never saved.

import { reportError } from "../notices";
import { el } from "../dom";
import { audioUrl, stepsView, type ClipItem, type Timeline } from "../../apricity";
import { pickClip } from "../clip-picker";
import { player } from "../../audio/player";
import { PALETTE } from "../flow/view";
import { lineage, padRecordings } from "../flow/lineage";
import { addPad, off, readBeat, setBars, setCell, setSwing, setTempo, writeBeat, type Beat, type Cell, type StepsView } from "./model";

export interface BeatDeps {
  /** The score's text now. */
  text(): string;
  /** Replace the score's text (the editor recompiles). */
  edit(text: string): void;
  /** Mute or solo changed: play the current timeline again (it is filtered by `filter`). */
  resend(): void;
}

type Gesture = { kind: "paint"; on: boolean } | { kind: "hold"; row: number; step: number } | null;

const LENGTHS = [1, 2, 4, 8];

export class BeatView {
  readonly root = el("section", { className: "beat", tabIndex: 0, ariaLabel: "Drum machine" });
  private bar = el("div", { className: "beat-bar" });
  private body = el("div", { className: "beat-body" });
  private gridEl = el("div", { className: "beat-grid", role: "grid" });
  private note = el("span", { className: "beat-note" });
  private pos = el("span", { className: "beat-pos mono" }, "1.1.1");
  private tempo = el("input", { type: "number", min: "40", max: "240", step: "1", className: "beat-tempo", ariaLabel: "Tempo" });
  private swing = el("input", { type: "range", min: "50", max: "75", step: "1", className: "beat-swing", ariaLabel: "Swing" });
  private swingOut = el("span", { className: "mono" });
  private lengths = el("div", { className: "seg beat-len", role: "group", ariaLabel: "Pattern length in bars" });
  private addBtn = el("button", { type: "button", className: "btn beat-add" }, "+ Add pad");
  private view: StepsView | null = null;
  private beat: Beat | null = null;
  private timeline: Timeline | null = null;
  private cells: HTMLElement[][] = [];
  private muted = new Set<string>();
  private soloed = new Set<string>();
  private gesture: Gesture = null;
  private playCol = -1;
  private cursor = { row: 0, step: 0 };
  private decoded = new Map<string, Promise<AudioBuffer>>();
  private seq = 0;

  constructor(private deps: BeatDeps) {
    for (const n of LENGTHS) {
      const b = el("button", { type: "button", textContent: `${n} bar${n > 1 ? "s" : ""}` });
      b.dataset.bars = String(n);
      b.addEventListener("click", () => this.setLength(n));
      this.lengths.append(b);
    }
    this.tempo.addEventListener("change", () => {
      const n = Number(this.tempo.value);
      if (this.view && n >= 20 && n <= 400) this.deps.edit(setTempo(this.deps.text(), this.view, n));
    });
    this.swing.addEventListener("input", () => (this.swingOut.textContent = `${this.swing.value}%`));
    this.swing.addEventListener("change", () => this.commit(setSwing(this.beat!, Number(this.swing.value))));
    this.addBtn.addEventListener("click", () => this.pickPad());
    const field = (label: string, ...kids: Node[]) => el("label", { className: "beat-field" }, el("span", {}, label), ...kids);
    this.bar.append(field("Tempo", this.tempo), field("Swing", this.swing, this.swingOut), field("Length", this.lengths), this.pos, this.note);
    this.body.append(this.gridEl, this.addBtn);
    this.root.append(this.bar, this.body);

    this.gridEl.addEventListener("pointerdown", (e) => this.down(e));
    this.gridEl.addEventListener("pointermove", (e) => this.move(e));
    window.addEventListener("pointerup", () => this.up());
    this.root.addEventListener("keydown", (e) => this.key(e));
    player.onTransport((t) => this.playhead(t.position / t.framesPerBeat, t.playing));
  }

  /** The score changed (or compiled): re-read the grid from the text. */
  async update(text: string, timeline: Timeline | null) {
    if (timeline) this.timeline = timeline;
    const seq = ++this.seq;
    let v: StepsView;
    try {
      v = await stepsView(text);
    } catch (e) {
      return this.message(`Couldn't read the beat: ${(e as Error).message}`);
    }
    if (seq !== this.seq || this.gesture) return; // a newer edit, or a drag in progress
    if (v.errors?.length) return this.message("Fix the score's problems to see the grid.");
    const slices = this.timeline?.tracks.find((t) => t.kit && v.kits.some((k) => k.name === t.kit && k.sliced))?.pieces?.length ?? 0;
    const b = readBeat(v, undefined, slices);
    if (!b) return this.message("This score has no kit. Add a kit (see Help → Kits) to use the drum machine.");
    this.view = v;
    this.beat = b;
    this.render();
  }

  private message(text: string) {
    this.view = null;
    this.beat = null;
    this.gridEl.replaceChildren(el("div", { className: "empty" }, text));
    this.note.textContent = "";
    this.addBtn.hidden = true;
  }

  /** Remove muted (or, with any solo, unsoloed) pads' notes. */
  filter(tl: Timeline): Timeline {
    if (!this.muted.size && !this.soloed.size) return tl;
    const silent = (pad: string | null) => !!pad && (this.muted.has(pad) || (this.soloed.size > 0 && !this.soloed.has(pad)));
    return { ...tl, events: tl.events.filter((e) => !silent(this.padOf(tl, e))) };
  }

  /** The pad an event plays: `drums.kick` tracks name it; a whole-kit track's piece does. */
  private padOf(tl: Timeline, e: Timeline["events"][number]): string | null {
    const kit = this.beat?.kit;
    if (!kit) return null;
    if (e.track.startsWith(kit + ".")) return e.track.slice(kit.length + 1);
    const t = tl.tracks.find((x) => x.name === e.track);
    if (t?.kit !== kit && t?.clip !== kit) return null;
    const piece = t?.pieces?.[e.piece ?? 0];
    return piece?.name ?? (e.piece !== undefined ? String(e.piece + 1) : null);
  }

  private render() {
    const b = this.beat!;
    const v = this.view!;
    this.tempo.value = String(v.tempo);
    const swing = b.rows.find((r) => r.cells.some((c) => c.on))?.swing ?? 50;
    this.swing.value = String(swing);
    this.swingOut.textContent = `${swing}%`;
    const bars = b.length / b.stepsPerBar;
    for (const btn of this.lengths.children) (btn as HTMLElement).setAttribute("aria-pressed", String(Number((btn as HTMLElement).dataset.bars) === bars));
    this.note.textContent = b.editable ? "" : `Read-only: ${b.why}. Edit it in the text.`;
    this.root.classList.toggle("readonly", !b.editable);
    for (const i of [this.tempo, this.swing]) i.disabled = !b.editable;
    for (const btn of this.lengths.children) (btn as HTMLButtonElement).disabled = !b.editable;
    this.addBtn.hidden = !b.editable || b.sliced;

    this.gridEl.style.setProperty("--steps", String(b.length));
    const head = [el("div", { className: "corner" }, b.kit)];
    for (let bar = 0; bar < bars; bar++) {
      const h = el("div", { className: "bar-no" }, String(bar + 1));
      h.style.gridColumn = `${2 + bar * b.stepsPerBar} / span ${b.stepsPerBar}`;
      head.push(h);
    }
    this.cells = [];
    // Colored by recording, as Flow colors its tiles; a pad the timeline doesn't know yet keeps a color by row.
    const recs = this.timeline ? padRecordings(this.timeline, lineage(this.timeline), b.kit) : new Map<string, number>();
    const rows = b.rows.map((r, ri) => {
      const color = PALETTE[(recs.get(r.pad) ?? ri) % PALETTE.length];
      const mute = el("button", { type: "button", className: "ms", title: "Mute (only while listening; not saved)" }, "M");
      const solo = el("button", { type: "button", className: "ms", title: "Solo (only while listening; not saved)" }, "S");
      mute.setAttribute("aria-pressed", String(this.muted.has(r.pad)));
      solo.setAttribute("aria-pressed", String(this.soloed.has(r.pad)));
      mute.addEventListener("click", () => this.toggle(this.muted, r.pad));
      solo.addEventListener("click", () => this.toggle(this.soloed, r.pad));
      const name = el("button", { type: "button", className: "pad-name", title: `Hear ${r.pad}` }, r.pad);
      name.addEventListener("click", () => this.audition(r.pad));
      const pad = el("div", { className: "pad", role: "rowheader" }, name, mute, solo);
      pad.style.setProperty("--pad", color);
      const quiet = this.muted.has(r.pad) || (this.soloed.size > 0 && !this.soloed.has(r.pad));
      pad.classList.toggle("quiet", quiet);
      const cells = r.cells.map((c, si) => {
        const d = el("div", { className: "step", role: "gridcell" });
        d.dataset.r = String(ri);
        d.dataset.s = String(si);
        d.style.setProperty("--pad", color);
        if (Math.floor(si / 4) % 2) d.classList.add("alt");
        if (si % b.stepsPerBar === 0) d.classList.add("bar-start");
        this.paintCell(d, c, r.cells, si);
        if (quiet) d.classList.add("quiet");
        return d;
      });
      this.cells.push(cells);
      return [pad, ...cells];
    });
    this.gridEl.replaceChildren(...head, ...rows.flat());
    this.playCol = -1;
    this.markCursor();
  }

  /** A cell's look: on, its ratchet, and whether an earlier note's hold covers it. */
  private paintCell(d: HTMLElement, c: Cell, row: Cell[], i: number) {
    d.classList.toggle("on", c.on);
    d.dataset.ratchet = c.on && c.ratchet > 1 ? String(c.ratchet) : "";
    d.setAttribute("aria-label", c.on ? `on${c.ratchet > 1 ? `, ${c.ratchet} hits` : ""}${c.hold > 1 ? `, held ${c.hold} steps` : ""}` : "off");
    let held = false;
    for (let j = i - 1; j >= 0 && !held; j--) {
      if (row[j].on) {
        held = j + row[j].hold > i;
        break;
      }
    }
    d.classList.toggle("held", !c.on && held);
  }

  private repaintRow(ri: number) {
    const row = this.beat!.rows[ri].cells;
    this.cells[ri].forEach((d, si) => this.paintCell(d, row[si], row, si));
  }

  private cellAt(e: PointerEvent): { r: number; s: number } | null {
    const t = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(".step");
    if (!t || !this.gridEl.contains(t)) return null;
    return { r: Number(t.dataset.r), s: Number(t.dataset.s) };
  }

  private set(r: number, s: number, cell: Cell) {
    this.beat = setCell(this.beat!, r, s, cell);
    this.repaintRow(r);
  }

  private down(e: PointerEvent) {
    if (!this.beat?.editable) return;
    const at = this.cellAt(e);
    if (!at) return;
    e.preventDefault();
    this.cursor = { row: at.r, step: at.s };
    this.markCursor();
    const c = this.beat.rows[at.r].cells[at.s];
    if (e.shiftKey) {
      // Ratchet: 1 → 2 → 3 → 4 → 1 hit(s) in the step.
      this.set(at.r, at.s, { on: true, ratchet: c.on ? (c.ratchet % 4) + 1 : 2, hold: 1 });
      return this.commit(this.beat);
    }
    if (e.altKey && c.on) {
      this.gesture = { kind: "hold", row: at.r, step: at.s };
      return;
    }
    this.gesture = { kind: "paint", on: !c.on };
    this.set(at.r, at.s, c.on ? off() : { on: true, ratchet: 1, hold: 1 });
    if (!c.on) this.audition(this.beat.rows[at.r].pad);
  }

  private move(e: PointerEvent) {
    const g = this.gesture;
    if (!g || !this.beat) return;
    const at = this.cellAt(e);
    if (!at) return;
    if (g.kind === "hold") {
      if (at.s < g.step) return;
      const c = this.beat.rows[g.row].cells[g.step];
      this.set(g.row, g.step, { ...c, hold: at.s - g.step + 1 });
      return;
    }
    const c = this.beat.rows[at.r].cells[at.s];
    if (c.on !== g.on) this.set(at.r, at.s, g.on ? { on: true, ratchet: 1, hold: 1 } : off());
  }

  private up() {
    if (!this.gesture) return;
    this.gesture = null;
    this.commit(this.beat!);
  }

  /** Write the grid into the score. */
  private commit(b: Beat) {
    if (!this.view) return;
    this.beat = b;
    this.deps.edit(writeBeat(this.deps.text(), this.view, b));
  }

  private setLength(bars: number) {
    if (!this.view || !this.beat?.editable) return;
    this.deps.edit(setBars(this.deps.text(), this.view, this.beat, bars));
  }

  private toggle(set: Set<string>, pad: string) {
    if (set.has(pad)) set.delete(pad);
    else set.add(pad);
    this.render();
    this.deps.resend();
  }

  private key(e: KeyboardEvent) {
    if (!this.beat || (e.target as HTMLElement).closest("input, button")) return;
    const { rows, length } = this.beat;
    const c = this.cursor;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      c.row = Math.max(0, Math.min(rows.length - 1, c.row + moves[e.key][0]));
      c.step = Math.max(0, Math.min(length - 1, c.step + moves[e.key][1]));
      this.markCursor();
    } else if (e.key === "Enter" && this.beat.editable) {
      e.preventDefault();
      const cell = rows[c.row].cells[c.step];
      this.set(c.row, c.step, cell.on ? off() : { on: true, ratchet: 1, hold: 1 });
      this.commit(this.beat);
    }
  }

  private markCursor() {
    this.gridEl.querySelector(".cursor")?.classList.remove("cursor");
    this.cells[this.cursor.row]?.[this.cursor.step]?.classList.add("cursor");
  }

  private playhead(beat: number, playing: boolean) {
    const b = this.beat;
    if (!b) return;
    const step = playing ? Math.floor(beat * 4) % b.length : -1;
    const bar = Math.floor(beat / (b.stepsPerBar / 4));
    this.pos.textContent = `${bar % (b.length / b.stepsPerBar) + 1}.${Math.floor(beat % (b.stepsPerBar / 4)) + 1}.${Math.floor((beat * 4) % 4) + 1}`;
    if (step === this.playCol) return;
    for (const row of this.cells) {
      row[this.playCol]?.classList.remove("now");
      row[step]?.classList.add("now");
    }
    this.playCol = step;
  }

  /** Hear one pad: the sound it plays in the compiled score. */
  private async audition(pad: string) {
    const tl = this.timeline;
    const kit = this.beat?.kit;
    if (!tl || !kit) return;
    const t = tl.tracks.find((x) => x.name === `${kit}.${pad}`) ?? tl.tracks.find((x) => x.kit === kit || x.clip === kit);
    const piece = t?.pieces?.find((p) => p.name === pad) ?? (t?.name === `${kit}.${pad}` ? t.pieces?.[0] : undefined) ?? (this.beat!.sliced ? t?.pieces?.[Number(pad) - 1] : undefined);
    if (!piece) return; // not playing yet: nothing compiled to hear
    const path = tl.sources[piece.source]?.path;
    if (!path) return;
    try {
      await player.init();
      const ctx = player.ctx!;
      await ctx.resume();
      if (!this.decoded.has(path)) {
        const p = audioUrl(path)
          .then((u) => fetch(u))
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${path}: ${r.status}`))))
          .then((bytes) => ctx.decodeAudioData(bytes));
        p.catch(() => this.decoded.delete(path));
        this.decoded.set(path, p);
      }
      const buf = await this.decoded.get(path)!;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0, piece.src_start, Math.max(0.01, piece.src_end - piece.src_start));
    } catch (e) {
      reportError("play that pad", e);
    }
  }

  /** Pick a clip for a new pad: short hits first. */
  private async pickPad() {
    if (!this.view || !this.beat) return;
    const c = await pickClip("Add a pad", "Find a clip (kick, snare, hat…)", (c) => (/^(shot|hit)/.test(c.name) ? 2 : 0) - Math.min(1, c.end - c.start));
    if (c) this.add(c);
  }

  private add(c: ClipItem) {
    const v = this.view!;
    const kit = v.kits.find((k) => k.name === this.beat!.kit)!;
    const taken = new Set(kit.pads.map((p) => p.name));
    const base = c.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[^A-Za-z]+/, "") || "pad";
    let name = base;
    for (let n = 2; taken.has(name) || name === "x"; n++) name = `${base}${n}`;
    try {
      this.deps.edit(addPad(this.deps.text(), v, kit.name, name, c.samplePath.replace(/^samples\//, ""), c.name));
    } catch (e) {
      this.note.textContent = (e as Error).message;
    }
  }
}
