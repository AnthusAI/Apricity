// The chord harp: play chords, not notes. Under the score for the Chords kind:
//   - chord bars: the chords of the key as big buttons (numeral and name), lit by how well your strings fit each
//     one, with the likeliest next chords marked;
//   - the progression: one slot per bar; select a slot and press a chord bar, or turn on Record and tap chord bars
//     in time while it loops; Suggest fills the selected bar, Fill writes a whole progression that suits your sounds;
//   - strings: the clips that play the chords, each with a job (follow the root, or take a chord tone), and the
//     shift the solver chose for it in every bar.
// Every edit rewrites the score's text (model.ts); stopped, with nothing selected, a chord bar lets you hear it.

import { el } from "../dom";
import { chordFits, chordsView, compile, type ClipItem, type Timeline } from "../../apricity";
import { player } from "../../audio/player";
import { pickClip } from "../clip-picker";
import {
  addString,
  degreeOf,
  fill,
  freshName,
  qualities,
  jobOf,
  readHarp,
  removeString,
  setJob,
  setKey,
  suggest,
  writeProgression,
  type ChordsView,
  type Harp,
  type Job,
  type PaletteChord,
  type Role,
  type Slot,
  type StringView,
} from "./model";

export interface HarpDeps {
  text(): string;
  edit(text: string): void;
  /** Where the score lives (a preview compiles against the same samples). */
  path(): string | null;
  /** Mute or solo changed: play the current timeline again (it is filtered by `filter`). */
  resend(): void;
}

const TONICS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const MODES: [string, string][] = [
  ["major", "Major"],
  ["minor", "Minor"],
  ["dorian", "Dorian"],
  ["phrygian", "Phrygian"],
  ["lydian", "Lydian"],
  ["mixolydian", "Mixolydian"],
  ["locrian", "Locrian"],
  ["harmonic_minor", "Harmonic minor"],
  ["melodic_minor", "Melodic minor"],
];
const JOBS: [string, string][] = [
  ["follow", "Follow the root"],
  ["role:root", "Root"],
  ["role:third", "Third"],
  ["role:fifth", "Fifth"],
  ["role:seventh", "Seventh"],
  ["role:chord", "Any chord tone"],
  ["role:any", "Free (fit anywhere)"],
  ["fixed", "Stay put"],
];

/** "Abm", "F mixolydian", "Bb" → [tonic, mode] for the pickers. */
export function splitKey(key: string): [string, string] {
  const m = /^([A-G])([b#♭♯]?)\s*(.*)$/.exec(key.trim());
  if (!m) return ["C", "major"];
  const sharp: Record<string, string> = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };
  let tonic = m[1] + m[2].replace("♭", "b").replace("♯", "#");
  tonic = sharp[tonic] ?? tonic;
  const rest = m[3].trim().toLowerCase().replace(/\s+/g, "_");
  const mode = ["", "maj", "major", "ionian"].includes(rest) ? "major" : ["m", "min", "minor", "aeolian"].includes(rest) ? "minor" : rest === "mixo" ? "mixolydian" : rest;
  return [tonic, mode];
}

const pretty = (numeral: string) => numeral.replace(/o7$/, "°7").replace(/o$/, "°");
const flat = (name: string) => name.replace(/b(?=\d|m|$|aug|dim|sus)/, "♭").replace(/^([A-G])b/, "$1♭");

export class HarpView {
  readonly root = el("section", { className: "harp", tabIndex: 0, ariaLabel: "Chord harp" });
  private top = el("div", { className: "harp-bar" });
  private body = el("div", { className: "harp-body" });
  private barsEl = el("div", { className: "chord-bars", role: "group", ariaLabel: "Chords of the key" });
  private stripEl = el("div", { className: "prog", role: "list", ariaLabel: "Progression, one slot per bar" });
  private stringsEl = el("div", { className: "strings" });
  private note = el("span", { className: "harp-note" });
  private pos = el("span", { className: "harp-pos mono" }, "1.1");
  private tonic = el("select", { ariaLabel: "Key" });
  private mode = el("select", { ariaLabel: "Mode" });
  private sevenths = el("button", { type: "button", className: "btn tog", title: "Seventh chords (Alt-press a chord bar for the other kind)" }, "7ths");
  private record = el("button", { type: "button", className: "btn tog rec", title: "While it plays, tap chord bars in time: each lands on the bar it's played in" }, "● Record");
  private suggestBtn = el("button", { type: "button", className: "btn", title: "Put the best next chord in the selected bar" }, "Suggest");
  private fillBtn = el("button", { type: "button", className: "btn", title: "Write a whole progression that suits your strings (press again for another)" }, "Fill");
  private addBtn = el("button", { type: "button", className: "btn" }, "+ Add string");
  private view: ChordsView | null = null;
  private harp: Harp | null = null;
  private timeline: Timeline | null = null;
  private fits = new Map<string, { score: number; coverage: number }>();
  private selected: number | null = null;
  private variation = 0;
  private playing = false;
  private beat = 0;
  private playBar = -1;
  private slotEls: HTMLElement[] = [];
  private muted = new Set<string>();
  private soloed = new Set<string>();
  private seq = 0;
  private previewTimer = 0;
  private hint = "";
  private path: string | null = null;

  constructor(private deps: HarpDeps) {
    for (const t of TONICS) this.tonic.append(el("option", { value: t, textContent: flat(t) }));
    for (const [v, label] of MODES) this.mode.append(el("option", { value: v, textContent: label }));
    const changeKey = () => this.view && this.deps.edit(setKey(this.deps.text(), this.view, `${this.tonic.value} ${this.mode.value}`));
    this.tonic.addEventListener("change", changeKey);
    this.mode.addEventListener("change", changeKey);
    this.sevenths.addEventListener("click", () => (this.toggle(this.sevenths), this.renderBars()));
    this.record.addEventListener("click", () => this.toggle(this.record));
    this.suggestBtn.addEventListener("click", () => this.suggestHere());
    this.fillBtn.addEventListener("click", () => this.fillAll());
    this.addBtn.addEventListener("click", () => this.pickString());
    const field = (label: string, ...kids: Node[]) => el("label", { className: "beat-field" }, el("span", {}, label), ...kids);
    this.top.append(field("Key", this.tonic, this.mode), this.sevenths, this.record, this.suggestBtn, this.fillBtn, this.pos, this.note);
    this.body.append(
      this.barsEl,
      el("div", { className: "harp-h" }, "Progression", el("span", { className: "hint" }, " · click a bar, then a chord (Shift: its second half) · Delete holds the chord before")),
      this.stripEl,
      el("div", { className: "harp-h" }, "Strings", el("span", { className: "hint" }, " · the clips that play the chords, and the shift each takes per bar")),
      this.stringsEl,
      this.addBtn,
    );
    this.root.append(this.top, this.body);
    this.root.addEventListener("keydown", (e) => this.key(e));
    player.onTransport((t) => this.playhead(t.position / t.framesPerBeat, t.playing));
  }

  private toggle(b: HTMLButtonElement) {
    b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
  }
  private on(b: HTMLButtonElement) {
    return b.getAttribute("aria-pressed") === "true";
  }

  /** The score changed (or compiled): re-read it, and score the palette against the strings. */
  async update(text: string, timeline: Timeline | null) {
    if (timeline) this.timeline = timeline;
    const seq = ++this.seq;
    let v: ChordsView;
    try {
      v = await chordsView(text);
    } catch (e) {
      return this.message(`Couldn't read the chords: ${(e as Error).message}`);
    }
    if (seq !== this.seq) return;
    if (v.errors?.length) return this.message("Fix the score's problems to see the harp.");
    this.view = v;
    this.harp = readHarp(v);
    // A newly opened score: the 7ths toggle follows what its progression mostly uses.
    if (this.deps.path() !== this.path) {
      this.path = this.deps.path();
      this.hint = "";
      this.selected = null;
      this.variation = 0;
      this.fillBtn.textContent = "Fill";
      const labels = v.progression.map((c) => c.label);
      const sevenths = labels.filter((l) => /(7|ø)$/.test(l)).length;
      this.sevenths.setAttribute("aria-pressed", String(labels.length > 0 && sevenths * 2 >= labels.length));
    }
    if (this.selected !== null && this.selected >= this.harp.slots.length) this.selected = null;
    const [tonic, mode] = splitKey(v.key);
    this.tonic.value = tonic;
    this.mode.value = mode;
    await this.score(v);
    if (seq !== this.seq) return;
    this.render();
  }

  /** How well the strings fit every chord of the palette (the harmony solver, per chord). */
  private async score(v: ChordsView) {
    this.fits.clear();
    const voices = (this.timeline?.tracks ?? []).map((t) => t.voice).filter((x): x is NonNullable<typeof x> => !!x);
    if (!voices.length || !v.palette.length) return;
    try {
      for (const f of await chordFits(v.key, voices, v.palette.map((p) => p.numeral))) this.fits.set(f.label, { score: f.score, coverage: f.coverage });
    } catch {
      /* no fits: the bars just aren't lit */
    }
  }

  private message(text: string) {
    this.view = null;
    this.harp = null;
    this.barsEl.replaceChildren();
    this.stripEl.replaceChildren(el("div", { className: "empty" }, text));
    this.stringsEl.replaceChildren();
  }

  /** Remove muted (or, with any solo, unsoloed) strings' notes. */
  filter(tl: Timeline): Timeline {
    if (!this.muted.size && !this.soloed.size) return tl;
    const silent = (name: string) => this.muted.has(name) || (this.soloed.size > 0 && !this.soloed.has(name));
    const strings = new Set(this.view?.strings.map((s) => s.name) ?? []);
    return { ...tl, events: tl.events.filter((e) => !(strings.has(e.track) && silent(e.track))) };
  }

  private render() {
    this.renderBars();
    this.renderStrip();
    this.renderStrings();
    const h = this.harp!;
    this.note.textContent = h.editable ? this.hint : `Read-only: ${h.why}. Edit it in the text.`;
    this.root.classList.toggle("readonly", !h.editable);
    for (const b of [this.suggestBtn, this.fillBtn, this.record]) b.disabled = !h.editable;
  }

  /** What was playing before the selected bar (for suggestions). */
  private previous(at: number | null): string | null {
    const slots = this.harp?.slots ?? [];
    for (let i = (at ?? slots.length) - 1; i >= 0; i--) {
      const s = slots[i];
      if (s) return s[s.length - 1];
    }
    return null;
  }

  private scores(): Map<string, number> {
    return new Map([...this.fits].map(([k, v]) => [k, v.score]));
  }

  private renderBars() {
    const v = this.view;
    if (!v) return;
    const sevenths = this.on(this.sevenths);
    const pool = v.palette.filter((p) => p.seventh === sevenths);
    const ranked = suggest(v.palette, this.scores(), this.previous(this.selected), { sevenths });
    const top = new Map(ranked.slice(0, 3).map((s, i) => [s.chord.numeral, { rank: i + 1, why: s.why }]));
    const vals = pool.map((p) => this.fits.get(p.numeral)?.score).filter((x): x is number => x !== undefined);
    const [lo, hi] = [Math.min(...vals), Math.max(...vals)];
    this.barsEl.replaceChildren(
      ...pool.map((p, i) => {
        const f = this.fits.get(p.numeral);
        const fit = f && hi > lo ? (f.score - lo) / (hi - lo) : null;
        const t = top.get(p.numeral);
        const b = el(
          "button",
          { type: "button", className: `cb ${p.function}` },
          el("span", { className: "num" }, pretty(p.numeral)),
          el("span", { className: "name" }, flat(p.name)),
          el("span", { className: "fit" }, el("i", { style: `width:${fit === null ? 0 : Math.round(20 + 80 * fit)}%` })),
          ...(t ? [el("span", { className: "rank" }, String(t.rank))] : []),
        );
        b.title = `${p.numeral} = ${p.name} (${p.function}, key ${i + 1})${f ? ` · your strings fit it ${Math.round((fit ?? 0) * 100)}%, cover ${Math.round(f.coverage * 100)}% of its notes` : ""}${t ? ` · suggestion ${t.rank}: ${t.why}` : ""}`;
        b.addEventListener("click", (e) => this.press(p, e.altKey, e.shiftKey));
        // Right-click (or a long press): the same degree as another kind of chord (a blues IV7, a sus4…).
        b.addEventListener("contextmenu", (e) => (e.preventDefault(), this.menu(b, p)));
        let long = 0;
        b.addEventListener("pointerdown", () => (long = window.setTimeout(() => this.menu(b, p), 550)));
        for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, () => clearTimeout(long));
        return b;
      }),
    );
  }

  /** A written chord's name: from the palette, or from the compiled harmony (`V7 (C7)`) for chords outside the key. */
  private nameOf(label: string): string {
    const p = this.view!.palette.find((x) => x.numeral === label);
    if (p) return p.name;
    for (const s of this.timeline?.harmony ?? []) {
      const m = /^(.*) \((.*)\)$/.exec(s.label);
      if (m && m[1] === label) return m[2];
    }
    return "";
  }

  private renderStrip() {
    const h = this.harp!;
    const meter = this.view!.meter;
    const cover = (bar: number) => this.timeline?.harmony.find((s) => s.start_beat <= bar * meter + 1e-6 && s.end_beat > bar * meter + 1e-6)?.fit?.coverage;
    this.slotEls = h.slots.map((s, i) => {
      const label = s === null ? "·" : s.map(pretty).join(" ");
      const names = s?.map((l) => this.nameOf(l)).filter(Boolean).map(flat).join(" ");
      const c = cover(i);
      const d = el(
        "button",
        { type: "button", className: `slot${s === null ? " hold" : ""}`, role: "listitem" },
        el("span", { className: "bar-no" }, String(i + 1)),
        el("span", { className: "num" }, label),
        el("span", { className: "name" }, names ?? ""),
        el("span", { className: "fit" }, el("i", { style: `width:${c === undefined ? 0 : Math.round(c * 100)}%` })),
      );
      d.title = s === null ? `bar ${i + 1}: the chord before goes on` : `bar ${i + 1}: ${label}${names ? ` (${names})` : ""}${c !== undefined ? ` · your strings cover ${Math.round(c * 100)}% of its notes` : ""}`;
      d.setAttribute("aria-current", String(i === this.selected));
      d.classList.toggle("now", i === this.playBar);
      d.addEventListener("click", () => this.select(i === this.selected ? null : i));
      return d;
    });
    const more = el("button", { type: "button", className: "slot add", title: "Add a bar" }, "+");
    const less = el("button", { type: "button", className: "slot add", title: "Remove the last bar" }, "−");
    more.addEventListener("click", () => this.write([...h.slots, null]));
    less.addEventListener("click", () => h.slots.length > 1 && this.write(h.slots.slice(0, -1)));
    this.stripEl.replaceChildren(...this.slotEls, ...(h.editable ? [more, less] : []));
  }

  private renderStrings() {
    const v = this.view!;
    const bars = this.harp!.slots.length;
    const meter = v.meter;
    const shiftAt = (name: string, bar: number) =>
      (this.timeline?.harmony.find((s) => s.start_beat <= bar * meter + 1e-6 && s.end_beat > bar * meter + 1e-6)?.fit as { voices?: { name: string; semitones: number; on_chord: number }[] } | null | undefined)?.voices?.find((x) => x.name === name);
    this.stringsEl.replaceChildren(
      ...(v.strings.length ? [] : [el("div", { className: "hint" }, "No strings yet: add a clip to play the chords.")]),
      ...v.strings.map((s) => {
        const job = el("select", { ariaLabel: `${s.name}'s job` });
        for (const [val, label] of JOBS) job.append(el("option", { value: val, textContent: label }));
        const j = jobOf(s);
        job.value = j.kind === "follow" ? "follow" : j.kind === "fixed" ? "fixed" : `role:${j.role}`;
        job.addEventListener("change", () => this.setJob(s, job.value));
        const mute = el("button", { type: "button", className: "ms", title: "Mute (only while listening; not saved)" }, "M");
        const solo = el("button", { type: "button", className: "ms", title: "Solo (only while listening; not saved)" }, "S");
        mute.setAttribute("aria-pressed", String(this.muted.has(s.name)));
        solo.setAttribute("aria-pressed", String(this.soloed.has(s.name)));
        mute.addEventListener("click", () => this.flip(this.muted, s.name));
        solo.addEventListener("click", () => this.flip(this.soloed, s.name));
        const del = el("button", { type: "button", className: "ms", title: `Remove ${s.name}` }, "×");
        del.addEventListener("click", () => this.deps.edit(removeString(this.deps.text(), s)));
        const shifts = el(
          "div",
          { className: "shifts" },
          ...Array.from({ length: bars }, (_, b) => {
            const x = shiftAt(s.name, b);
            const cell = el("span", { className: "sh" }, x ? (x.semitones > 0 ? `+${x.semitones}` : String(x.semitones)) : "");
            if (x) cell.style.setProperty("--on", String(x.on_chord));
            cell.title = x ? `bar ${b + 1}: moved ${x.semitones} semitones; ${Math.round(x.on_chord * 100)}% of it on the chord` : `bar ${b + 1}: not playing`;
            return cell;
          }),
        );
        const quiet = this.muted.has(s.name) || (this.soloed.size > 0 && !this.soloed.has(s.name));
        const row = el("div", { className: `string${quiet ? " quiet" : ""}` }, el("span", { className: "s-name", title: s.clip }, s.name), job, mute, solo, del, shifts);
        return row;
      }),
    );
    this.addBtn.hidden = !this.harp!.editable;
  }

  private flip(set: Set<string>, name: string) {
    if (set.has(name)) set.delete(name);
    else set.add(name);
    this.renderStrings();
    this.deps.resend();
  }

  private setJob(s: StringView, value: string) {
    let job: Job;
    if (value === "follow") job = { kind: "follow" };
    else if (value === "fixed") job = { kind: "fixed", semitones: 0 };
    else job = { kind: "role", role: value.slice(5) as Role };
    this.deps.edit(setJob(this.deps.text(), s, job));
  }

  private select(i: number | null) {
    this.selected = i;
    this.slotEls.forEach((d, k) => d.setAttribute("aria-current", String(k === i)));
    this.renderBars(); // suggestions depend on the bar before
  }

  private write(slots: Slot[]) {
    if (!this.view) return;
    try {
      this.deps.edit(writeProgression(this.deps.text(), this.view, slots));
    } catch (e) {
      this.note.textContent = (e as Error).message;
    }
  }

  /** The quality menu of a chord bar: every way to write its degree. */
  private menu(anchor: HTMLElement, p: PaletteChord) {
    document.querySelector(".cb-menu")?.remove();
    const m = el("div", { className: "cb-menu", role: "menu" });
    for (const q of qualities(p.degree)) {
      const item = el("button", { type: "button", role: "menuitem" }, el("b", {}, pretty(q.label)), el("span", {}, q.what));
      item.addEventListener("click", () => (m.remove(), this.put_or_hear(q.label)));
      m.append(item);
    }
    const r = anchor.getBoundingClientRect();
    const host = this.root.getBoundingClientRect();
    m.style.left = `${r.left - host.left}px`;
    m.style.top = `${r.bottom - host.top + 4}px`;
    this.root.append(m);
    const away = (e: Event) => !m.contains(e.target as Node) && (m.remove(), document.removeEventListener("pointerdown", away, true));
    setTimeout(() => document.addEventListener("pointerdown", away, true));
  }

  /** A chord label from the menu: like pressing a chord bar with that chord. */
  private put_or_hear(label: string) {
    const p = this.view?.palette.find((x) => x.numeral === label);
    const degree = degreeOf(this.view?.palette ?? [], label) ?? 1;
    this.press(p ?? { numeral: label, name: "", degree, function: "tonic", seventh: /7|ø/.test(label) }, false);
  }

  /**
   * A chord bar: into the selected bar (Shift: into its second half, splitting the bar); in time while recording;
   * otherwise, hear it. Alt plays the other kind on the same degree (a seventh for a triad, and back).
   */
  private press(p: PaletteChord, other: boolean, split = false) {
    const h = this.harp;
    if (!h || !this.view) return;
    let label = p.numeral;
    if (other) {
      const alt = this.view.palette.find((x) => x.degree === p.degree && x.seventh !== p.seventh);
      if (alt) label = alt.numeral;
    }
    if (this.playing && this.on(this.record) && h.editable) {
      // Lands on the bar being played; a tap just before a bar line counts for the next bar.
      const meter = this.view.meter;
      const within = (this.beat % meter) / meter;
      const bar = (Math.floor(this.beat / meter) + (within > 7 / 8 ? 1 : 0)) % h.slots.length;
      return this.put(bar, label, false);
    }
    if (this.selected !== null && h.editable) {
      const at = this.selected;
      this.put(at, label, split);
      if (at + 1 < h.slots.length) this.selected = at + 1;
      return;
    }
    if (!this.playing) this.preview(label);
    else this.note.textContent = "Select a bar, or turn on Record, to put a chord in.";
  }

  private put(bar: number, label: string, secondHalf: boolean) {
    const slots = [...this.harp!.slots];
    const cur = slots[bar];
    if (secondHalf && cur && cur.length) slots[bar] = [cur[0], label];
    else slots[bar] = [label];
    // Clearing a hold's chord would leave a hold in bar 1: never.
    if (slots[0] === null) slots[0] = [label];
    this.write(slots);
  }

  private suggestHere() {
    const h = this.harp;
    if (!h || !this.view) return;
    const at = this.selected ?? Math.max(0, h.slots.findIndex((s, i) => i > 0 && s === null));
    const best = suggest(this.view.palette, this.scores(), this.previous(at), { sevenths: this.on(this.sevenths) })[0];
    if (!best) return;
    this.hint = `Suggested ${pretty(best.chord.numeral)} (${flat(best.chord.name)}) for bar ${at + 1}: ${best.why}.`;
    this.put(at, best.chord.numeral, false);
  }

  private fillAll() {
    const h = this.harp;
    if (!h || !this.view) return;
    const p = fill(this.view.palette, this.scores(), h.slots.length, { sevenths: this.on(this.sevenths), variation: this.variation++ });
    if (p.length) this.write(p);
    this.hint = "A progression that suits your strings: it starts at home and ends with a cadence. Press Try another for a different one.";
    this.fillBtn.textContent = "Try another";
  }

  /** Hear one chord: the score with only that chord, one bar, once. The header's Play plays the real score again. */
  private async preview(label: string) {
    const path = this.deps.path();
    if (!path || !this.view) return;
    const lines = this.deps.text().split("\n");
    const drop = new Set<number>();
    for (const [a, b] of this.view.chordLines) for (let i = a; i <= b; i++) drop.add(i - 1);
    if (this.view.barsLine) drop.add(this.view.barsLine - 1);
    const first = this.view.chordLines[0]?.[0] ?? 0;
    const text = lines
      .flatMap((l, i) => (i === first - 1 ? [`chords ${label}`] : drop.has(i) ? [] : [/^track\s/.test(l) ? l.replace(/\s+bars\s+\S+/, "") : l]))
      .join("\n");
    this.note.textContent = `hearing ${pretty(label)}…`;
    const r = await compile(text, path);
    if (!r.timeline) {
      this.note.textContent = `can't play ${label}: ${r.errors?.[0] ?? "it didn't compile"}`;
      return;
    }
    try {
      await player.init();
      await player.arrange(this.filter(r.timeline));
      await player.play();
      clearTimeout(this.previewTimer);
      const ms = (60 / r.timeline.tempo) * r.timeline.meter * 1000;
      this.previewTimer = window.setTimeout(() => player.pause(), ms + 150);
      this.note.textContent = "";
    } catch (e) {
      this.note.textContent = `couldn't play it: ${(e as Error).message}`;
    }
  }

  private key(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest("input, select")) return;
    const h = this.harp;
    if (!h || !this.view) return;
    if (/^[1-7]$/.test(e.key)) {
      const pool = this.view.palette.filter((p) => p.seventh === this.on(this.sevenths));
      const p = pool.find((x) => x.degree === Number(e.key));
      if (p) (e.preventDefault(), this.press(p, e.altKey, e.shiftKey));
    } else if ((e.key === "Delete" || e.key === "Backspace") && this.selected !== null && this.selected > 0 && h.editable) {
      e.preventDefault();
      const slots = [...h.slots];
      slots[this.selected] = null;
      this.write(slots);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const n = h.slots.length;
      this.select(this.selected === null ? 0 : (this.selected + (e.key === "ArrowRight" ? 1 : n - 1)) % n);
    } else if (e.key === "Escape") this.select(null);
  }

  private playhead(beat: number, playing: boolean) {
    this.playing = playing;
    this.beat = beat;
    const v = this.view;
    const h = this.harp;
    if (!v || !h || !h.slots.length) return;
    const bar = playing ? Math.floor(beat / v.meter) % h.slots.length : -1;
    this.pos.textContent = playing ? `${bar + 1}.${Math.floor(beat % v.meter) + 1}` : "1.1";
    if (bar === this.playBar) return;
    this.slotEls[this.playBar]?.classList.remove("now");
    this.slotEls[bar]?.classList.add("now");
    this.playBar = bar;
  }

  /** Pick a clip for a new string: phrases and loops first. */
  private async pickString() {
    if (!this.view) return;
    const c: ClipItem | null = await pickClip("Add a string", "Find a clip (horns, bass, loop…)", (c) => (/^(loop|phrase|section)/.test(c.name) ? 2 : /^shot/.test(c.name) ? -2 : 0) + Math.min(1, (c.end - c.start) / 4));
    if (!c) return;
    const text = this.deps.text();
    const name = freshName(text, c.name);
    const job: Job = this.view.strings.some((s) => s.transpose === "follow") ? { kind: "role", role: "third" } : { kind: "follow" };
    this.deps.edit(addString(text, this.view, name, c.samplePath.replace(/^samples\//, ""), c.name, job));
  }
}
