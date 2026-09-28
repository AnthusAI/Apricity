// The Listen page (Kanbus apricitus-8c706d): rate a blind listening cycle's candidates — a player, stars and a note
// per option, one explicit best-pick control, an overall note, Save. Blind: only letters show until you've saved a
// verdict (or the cycle has closed), then the real scores are revealed with links to them. Signed-in only.

import "./listen.css";
import { el } from "./dom";
import { api, cycles, labs, me, ratings } from "../apricity";
import { getUrl } from "../data/files";
import { StarRating, type StarState } from "./stars";
import { href, PAGE_OF_KIND, type Route } from "../route";
import { go, opened } from "./at";
import { timeAgo } from "./time";
import { incumbentLetter, lettersOf, noteFor, revealed, validBest, type CycleRecord, type VerdictRecord } from "../data/cycles";
import type { ScoreItem } from "../data/catalog";

const signIn = () => document.dispatchEvent(new CustomEvent("apricity:sign-in"));

/** An in-app link (a plain click stays in the app; a middle click opens a new tab). */
function link(route: Route, text: string | HTMLElement, className = ""): HTMLAnchorElement {
  const a = el("a", { href: href(route), className }, text);
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(route);
  });
  return a;
}

/** One option's editable state while a verdict is unsaved (or being changed, up until the cycle closes). */
interface OptionDraft {
  stars: number | null;
  note: string;
}

export class ListenView {
  root: HTMLElement;
  private listHost = el("div", { className: "listen-list" });
  private detailHost = el("div", { className: "listen-detail", hidden: true });
  /** The cycle id currently shown in detail, or null when the list is shown. */
  private shown: string | null = null;
  private seq = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    root.append(el("div", { className: "listen-page" }, this.listHost, this.detailHost));
  }

  /** Show the list of open cycles (optionally filtered to "waiting for you"), or one cycle by id. Called from
   * main.ts's routing. */
  async show(cycleId: string | null, waiting = false) {
    const seq = ++this.seq;
    this.shown = cycleId;
    this.detailHost.hidden = !cycleId;
    this.listHost.hidden = !!cycleId;
    if (!cycleId) return this.showList(seq, waiting);
    return this.showDetail(cycleId, seq);
  }

  // ---------------------------------------------------------------- the list: every open cycle, newest first

  private async showList(seq: number, waitingOnly: boolean) {
    this.listHost.replaceChildren(el("div", { className: "listen-loading" }, "Loading…"));
    const who = await me().catch(() => null);
    if (seq !== this.seq) return;
    if (!who) return this.showSignInPrompt(this.listHost, "Sign in to rate listening cycles.");
    try {
      const store = await cycles();
      const open = await store.openCycles();
      if (seq !== this.seq) return;
      const verdicts = await Promise.all(open.map((c) => store.verdict(c.id).catch(() => null)));
      if (seq !== this.seq) return;
      const labIds = [...new Set(open.map((c) => c.labId).filter((id): id is string => !!id))];
      const labStore = await labs();
      const labRecords = await Promise.all(labIds.map((id) => labStore.lab(id).catch(() => null)));
      if (seq !== this.seq) return;
      const labTitleById = new Map(labIds.map((id, i) => [id, labRecords[i]?.title ?? null]));
      opened({ page: "listen" }, "auto");
      const shown = waitingOnly ? open.filter((_, i) => !verdicts[i]) : open;
      const toggle = el(
        "a",
        { className: "listen-waiting-toggle" + (waitingOnly ? " on" : ""), href: href({ page: "listen", waiting: !waitingOnly }) },
        waitingOnly ? "Showing: waiting for you" : "Show only: waiting for you",
      );
      toggle.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go({ page: "listen", waiting: !waitingOnly });
      });
      if (!open.length) {
        this.listHost.replaceChildren(el("h1", {}, "Listen"), el("p", { className: "listen-intro" }, "Rate a blind round of candidates: a player, stars and a note per option, then say which you'd keep."), el("div", { className: "empty" }, "No open listening cycles right now."));
        return;
      }
      this.listHost.replaceChildren(
        el("h1", {}, "Listen"),
        el("p", { className: "listen-intro" }, "Rate a blind round of candidates: a player, stars and a note per option, then say which you'd keep."),
        el("div", { className: "listen-filter-row" }, toggle),
        shown.length
          ? el(
              "ul",
              { className: "listen-cycles" },
              ...shown.map((c) => {
                const i = open.indexOf(c);
                const saved = !!verdicts[i];
                const labTitle = c.labId ? labTitleById.get(c.labId) : null;
                const row = el(
                  "a",
                  { className: "listen-cycle-row", href: href({ page: "listen", listenCycle: c.id }) },
                  el(
                    "div",
                    { className: "listen-cycle-main" },
                    el("span", { className: "listen-cycle-title" }, c.title),
                    el("span", { className: "listen-cycle-question" }, c.question || ""),
                    labTitle ? el("span", { className: "listen-cycle-lab" }, `Lab: ${labTitle}`) : "",
                  ),
                  el(
                    "div",
                    { className: "listen-cycle-meta" },
                    el("span", {}, `${c.options.length} option${c.options.length === 1 ? "" : "s"}`),
                    el("span", {}, timeAgo(c.createdAt)),
                    saved ? el("span", { className: "badge saved" }, "saved") : el("span", { className: "badge waiting" }, "waiting for you"),
                  ),
                );
                row.addEventListener("click", (e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  go({ page: "listen", listenCycle: c.id });
                });
                return el("li", {}, row);
              }),
            )
          : el("div", { className: "empty" }, "Nothing is waiting for your verdict right now."),
      );
    } catch (e) {
      if (seq === this.seq) this.listHost.replaceChildren(el("h1", {}, "Listen"), el("div", { className: "empty" }, `Couldn't load listening cycles: ${(e as Error).message}`));
    }
  }

  private showSignInPrompt(host: HTMLElement, text: string) {
    const btn = el("button", { type: "button", className: "btn primary" }, "Sign in");
    btn.addEventListener("click", signIn);
    host.replaceChildren(el("h1", {}, "Listen"), el("div", { className: "listen-signin" }, el("p", {}, text), btn));
  }

  // ---------------------------------------------------------------- one cycle: options, best pick, notes, save

  private async showDetail(cycleId: string, seq: number) {
    this.detailHost.replaceChildren(el("div", { className: "listen-loading" }, "Loading…"));
    const who = await me().catch(() => null);
    if (seq !== this.seq) return;
    if (!who) return this.showSignInPrompt(this.detailHost, "Sign in to rate this listening cycle.");
    try {
      const store = await cycles();
      const [cycle, mine] = await Promise.all([store.cycle(cycleId), store.verdict(cycleId)]);
      if (seq !== this.seq) return;
      if (!cycle) {
        this.detailHost.replaceChildren(el("div", { className: "listen-back" }, link({ page: "listen" }, "← All cycles")), el("div", { className: "empty" }, "That listening cycle doesn't exist, or you can't see it."));
        return;
      }
      opened({ page: "listen", listenCycle: cycleId }, "auto", cycle.title);
      await this.renderCycle(cycle, mine, seq);
    } catch (e) {
      if (seq === this.seq)
        this.detailHost.replaceChildren(el("div", { className: "listen-back" }, link({ page: "listen" }, "← All cycles")), el("div", { className: "empty" }, `Couldn't load this cycle: ${(e as Error).message}`));
    }
  }

  private async renderCycle(cycle: CycleRecord, mine: VerdictRecord | null, seq: number) {
    const letters = lettersOf(cycle);
    const isRevealed = revealed(cycle, mine);
    const closed = cycle.status === "closed";
    const incLetter = incumbentLetter(cycle);
    const lab = cycle.labId ? await (await labs()).lab(cycle.labId).catch(() => null) : null;
    if (seq !== this.seq) return;

    // Blind: audio always plays (the letter is the only label); reveal is titles/links, gated separately.
    const [urls, myStars, scoreItems] = await Promise.all([
      Promise.all(cycle.options.map((o) => getUrl({ path: o.audio.key }).then((r) => r.url).catch(() => null))),
      Promise.all(cycle.options.map((o) => ratings().then((r) => r.mineFor("score", o.scoreId)).catch(() => null))),
      isRevealed ? Promise.all(cycle.options.map((o) => api.scoreById(o.scoreId).catch(() => null))) : Promise.resolve<(ScoreItem | null)[]>([]),
    ]);
    if (seq !== this.seq) return;

    const draft: Record<string, OptionDraft> = {};
    letters.forEach((letter, i) => (draft[letter] = { stars: myStars[i], note: noteFor(mine, letter) }));
    let best = mine?.best ?? "";
    let overallNote = mine?.note ?? "";
    let saving = false;
    let statusText = mine ? `Saved ${timeAgo(mine.savedAt)}` : "";

    const statusEl = el("span", { className: "listen-status" }, statusText);
    const saveBtn = el("button", { type: "button", className: "btn primary", disabled: closed }, closed ? "Cycle closed" : mine ? "Save changes" : "Save");
    const bestGroup = el("div", { className: "listen-best", role: "radiogroup", ariaLabel: "Which would you keep?" });

    const paintBest = () => {
      for (const b of [...bestGroup.children] as HTMLButtonElement[]) {
        const on = b.dataset.value === best;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
      }
    };
    const bestChoice = (value: string, label: string) => {
      const b = el("button", { type: "button", className: "listen-best-btn", disabled: closed, textContent: label });
      b.dataset.value = value;
      b.setAttribute("role", "radio");
      if (!closed) b.addEventListener("click", () => ((best = value), paintBest()));
      return b;
    };
    bestGroup.append(...letters.map((l) => bestChoice(l, l)), bestChoice("same", "Can't tell them apart"));
    paintBest();

    const noteArea = (letter: string) => {
      const ta = el("textarea", { className: "listen-note", placeholder: "A note on this option (optional)", rows: 2, value: draft[letter].note, disabled: closed });
      ta.addEventListener("input", () => (draft[letter].note = ta.value));
      return ta;
    };

    const optionCard = (o: CycleRecord["options"][number], i: number) => {
      const item = scoreItems[i];
      const isIncumbent = o.letter === incLetter;
      const stars = new StarRating(
        async (n) => {
          draft[o.letter].stars = n;
        },
        signIn,
        true,
      );
      stars.set({ mine: draft[o.letter].stars, average: null, count: 0, signedIn: true } as StarState);
      const heading = isRevealed
        ? el(
            "span",
            { className: "listen-option-title" },
            item ? link({ page: PAGE_OF_KIND[item.kind], score: item.path }, item.title) : el("span", {}, "(score no longer available)"),
            isIncumbent ? el("span", { className: "badge" }, "the current version") : "",
          )
        : el("span", { className: "listen-option-title" }, `Option ${o.letter}`);
      return el(
        "li",
        { className: "listen-option" },
        el("div", { className: "listen-option-head" }, el("span", { className: "listen-letter" }, o.letter), heading),
        // crossOrigin before src: the site sends Cross-Origin-Embedder-Policy: require-corp, so cross-origin media
        // (the bucket's signed URLs) only loads as a CORS request; a plain <audio src> is blocked and shows "Error".
        urls[i] ? el("audio", { className: "listen-player", controls: true, preload: "none", crossOrigin: "anonymous", src: urls[i]! }) : el("p", { className: "listen-note-missing" }, "Audio unavailable."),
        stars.el,
        noteArea(o.letter),
      );
    };

    const overallArea = el("textarea", { className: "listen-note listen-overall", placeholder: "An overall note (optional)", rows: 3, value: overallNote, disabled: closed });
    overallArea.addEventListener("input", () => (overallNote = overallArea.value));

    saveBtn.addEventListener("click", async () => {
      if (saving || closed) return;
      if (!validBest(cycle, best)) {
        statusEl.textContent = "Pick the one you'd keep (or “can't tell them apart”) before saving.";
        statusEl.classList.add("failed");
        return;
      }
      saving = true;
      saveBtn.disabled = true;
      statusEl.classList.remove("failed");
      statusEl.textContent = "Saving…";
      try {
        const notesByLetter: Record<string, string> = {};
        for (const l of letters) notesByLetter[l] = draft[l].note;
        const r = await ratings();
        await Promise.all(cycle.options.map((o) => (draft[o.letter].stars !== null ? r.rate("score", o.scoreId, draft[o.letter].stars) : Promise.resolve())));
        const saved = await (await cycles()).saveVerdict(cycle.id, best, notesByLetter, overallNote);
        if (seq !== this.seq) return;
        statusEl.textContent = `Saved ${timeAgo(saved.savedAt)}`;
        await this.renderCycle(cycle, saved, seq); // reveal now shows, and the form reflects what was saved
      } catch (e) {
        statusEl.textContent = `Couldn't save: ${(e as Error).message}`;
        statusEl.classList.add("failed");
        saving = false;
        saveBtn.disabled = false;
      }
    });

    this.detailHost.replaceChildren(
      el("div", { className: "listen-back" }, link({ page: "listen" }, "← All cycles")),
      el("h1", {}, cycle.title),
      ...(cycle.question ? [el("p", { className: "listen-question" }, cycle.question)] : []),
      ...(lab ? [el("p", { className: "listen-question" }, "Lab: ", link({ page: "labs", lab: lab.id }, lab.title))] : []),
      ...(closed ? [el("p", { className: "badge" }, "This cycle is closed: read-only.")] : []),
      el("ul", { className: "listen-options" }, ...cycle.options.map((o, i) => optionCard(o, i))),
      el("div", { className: "listen-verdict" }, el("div", { className: "listen-best-label" }, "Which would you keep?"), bestGroup, el("label", { className: "listen-overall-label" }, "Overall note", overallArea), el("div", { className: "listen-save-row" }, saveBtn, statusEl)),
    );
  }
}
