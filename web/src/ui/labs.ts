// The "Your labs" page (Kanbus apricitus-e59a0b): a person's sit-downs with a scene. /labs lists your labs, newest
// first, each with its brief, its scene and how many of its cycles are waiting for your verdict. /labs/<id> shows the
// lab's scene, its cycles newest first ("waiting for you" when a cycle is open and you haven't saved a verdict, with
// a link to rate it on /listen), and a short history of the picks you've already made. Signed-in only, like Listen.

import "./labs.css";
import { el } from "./dom";
import { api, labs, cycles, me } from "../apricity";
import { href, PAGE_OF_KIND, type Route } from "../route";
import { go, opened } from "./at";
import { timeAgo } from "./time";
import type { CycleRecord, VerdictRecord } from "../data/cycles";
import type { LabRecord } from "../data/labs";
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

function sceneLink(item: ScoreItem | null, fallbackId: string): HTMLElement {
  if (!item) return el("span", { className: "labs-scene-missing" }, `(score ${fallbackId} no longer available)`);
  return link({ page: PAGE_OF_KIND[item.kind], score: item.path }, item.title, "labs-scene-link");
}

export class LabsView {
  root: HTMLElement;
  private listHost = el("div", { className: "labs-list" });
  private detailHost = el("div", { className: "labs-detail", hidden: true });
  private shown: string | null = null;
  private seq = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    root.append(el("div", { className: "labs-page" }, this.listHost, this.detailHost));
  }

  /** Show "Your labs", or one lab by id. Called from main.ts's routing. */
  async show(labId: string | null) {
    const seq = ++this.seq;
    this.shown = labId;
    this.detailHost.hidden = !labId;
    this.listHost.hidden = !!labId;
    if (!labId) return this.showList(seq);
    return this.showDetail(labId, seq);
  }

  private showSignInPrompt(host: HTMLElement, text: string) {
    const btn = el("button", { type: "button", className: "btn primary" }, "Sign in");
    btn.addEventListener("click", signIn);
    host.replaceChildren(el("h1", {}, "Your labs"), el("div", { className: "labs-signin" }, el("p", {}, text), btn));
  }

  // ---------------------------------------------------------------- the list: your labs, newest first

  private async showList(seq: number) {
    this.listHost.replaceChildren(el("div", { className: "labs-loading" }, "Loading…"));
    const who = await me().catch(() => null);
    if (seq !== this.seq) return;
    if (!who) return this.showSignInPrompt(this.listHost, "Sign in to see your labs.");
    try {
      const store = await labs();
      const mine = await store.myLabs();
      if (seq !== this.seq) return;
      opened({ page: "labs" }, "auto");
      if (!mine.length) {
        this.listHost.replaceChildren(
          el("h1", {}, "Your labs"),
          el("p", { className: "labs-intro" }, "A lab is your sit-down with a scene: a scene, and every listening cycle you publish while working it."),
          el("div", { className: "empty" }, "You haven't started a lab yet — see the lab CLI: ", el("code", {}, "scripts/lab start"), "."),
        );
        return;
      }
      const [scenes, waiting] = await Promise.all([
        Promise.all(mine.map((l) => api.scoreById(l.sceneScoreId).catch(() => null))),
        Promise.all(mine.map((l) => this.waitingCount(l.id))),
      ]);
      if (seq !== this.seq) return;
      this.listHost.replaceChildren(
        el("h1", {}, "Your labs"),
        el("p", { className: "labs-intro" }, "A lab is your sit-down with a scene: a scene, and every listening cycle you publish while working it."),
        el(
          "ul",
          { className: "labs-cards" },
          ...mine.map((l, i) => {
            const row = el(
              "a",
              { className: "labs-card", href: href({ page: "labs", lab: l.id }) },
              el(
                "div",
                { className: "labs-card-main" },
                el("span", { className: "labs-card-title" }, l.title),
                el("span", { className: "labs-card-scene" }, sceneLink(scenes[i], l.sceneScoreId)),
                l.brief ? el("span", { className: "labs-card-brief" }, l.brief) : "",
              ),
              el(
                "div",
                { className: "labs-card-meta" },
                el("span", {}, timeAgo(l.createdAt)),
                l.status === "closed" ? el("span", { className: "badge" }, "closed") : "",
                waiting[i] > 0 ? el("span", { className: "badge waiting" }, `${waiting[i]} waiting for you`) : "",
              ),
            );
            row.addEventListener("click", (e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              go({ page: "labs", lab: l.id });
            });
            return el("li", {}, row);
          }),
        ),
      );
    } catch (e) {
      if (seq === this.seq) this.listHost.replaceChildren(el("h1", {}, "Your labs"), el("div", { className: "empty" }, `Couldn't load your labs: ${(e as Error).message}`));
    }
  }

  /** How many of a lab's cycles are open and still lack your verdict. */
  private async waitingCount(labId: string): Promise<number> {
    const [labStore, cycleStore] = await Promise.all([labs(), cycles()]);
    const cs = await labStore.cyclesFor(labId);
    const open = cs.filter((c) => c.status === "open");
    const verdicts = await Promise.all(open.map((c) => cycleStore.verdict(c.id).catch(() => null)));
    return verdicts.filter((v) => v === null).length;
  }

  // ---------------------------------------------------------------- one lab: its scene, its cycles, your history

  private async showDetail(labId: string, seq: number) {
    this.detailHost.replaceChildren(el("div", { className: "labs-loading" }, "Loading…"));
    const who = await me().catch(() => null);
    if (seq !== this.seq) return;
    if (!who) return this.showSignInPrompt(this.detailHost, "Sign in to see this lab.");
    try {
      const store = await labs();
      const lab = await store.lab(labId);
      if (seq !== this.seq) return;
      if (!lab) {
        this.detailHost.replaceChildren(el("div", { className: "labs-back" }, link({ page: "labs" }, "← Your labs")), el("div", { className: "empty" }, "That lab doesn't exist, or you can't see it."));
        return;
      }
      opened({ page: "labs", lab: labId }, "auto", lab.title);
      await this.renderLab(lab, seq);
    } catch (e) {
      if (seq === this.seq)
        this.detailHost.replaceChildren(el("div", { className: "labs-back" }, link({ page: "labs" }, "← Your labs")), el("div", { className: "empty" }, `Couldn't load this lab: ${(e as Error).message}`));
    }
  }

  private async renderLab(lab: LabRecord, seq: number) {
    const [labStore, cycleStore, scene] = await Promise.all([labs(), cycles(), api.scoreById(lab.sceneScoreId).catch(() => null)]);
    const cs = await labStore.cyclesFor(lab.id);
    if (seq !== this.seq) return;
    const verdicts = await Promise.all(cs.map((c) => cycleStore.verdict(c.id).catch(() => null)));
    if (seq !== this.seq) return;

    const cycleRow = (c: CycleRecord, mine: VerdictRecord | null) => {
      const waitingForYou = c.status === "open" && !mine;
      const row = el(
        "li",
        { className: "labs-cycle-row" },
        el(
          "div",
          { className: "labs-cycle-main" },
          el("span", { className: "labs-cycle-title" }, c.title),
          el("span", { className: "labs-cycle-question" }, c.question || ""),
        ),
        el(
          "div",
          { className: "labs-cycle-meta" },
          el("span", {}, `${c.options.length} option${c.options.length === 1 ? "" : "s"}`),
          el("span", {}, timeAgo(c.createdAt)),
          c.status === "closed" ? el("span", { className: "badge" }, "closed") : "",
          waitingForYou ? el("span", { className: "badge waiting" }, "waiting for you") : mine ? el("span", { className: "badge saved" }, `your pick: ${mine.best}`) : "",
          link({ page: "listen", listenCycle: c.id }, waitingForYou ? "Rate it" : "View", "labs-cycle-link"),
        ),
      );
      return row;
    };

    const picks = cs
      .map((c, i) => ({ c, v: verdicts[i] }))
      .filter((x): x is { c: CycleRecord; v: VerdictRecord } => x.v !== null);

    this.detailHost.replaceChildren(
      el("div", { className: "labs-back" }, link({ page: "labs" }, "← Your labs")),
      el("h1", {}, lab.title),
      ...(lab.brief ? [el("p", { className: "labs-brief" }, lab.brief)] : []),
      el("p", { className: "labs-scene-line" }, "Scene: ", sceneLink(scene, lab.sceneScoreId)),
      ...(lab.status === "closed" ? [el("p", { className: "badge" }, "This lab is closed.")] : []),
      el("h2", {}, "Cycles"),
      cs.length
        ? el("ul", { className: "labs-cycles" }, ...cs.map((c, i) => cycleRow(c, verdicts[i])))
        : el("div", { className: "empty" }, "No listening cycles have been published into this lab yet."),
      el("h2", {}, "Your picks"),
      picks.length
        ? el(
            "ul",
            { className: "labs-history" },
            ...picks.map(({ c, v }) =>
              el(
                "li",
                { className: "labs-history-row" },
                el("span", { className: "labs-history-title" }, c.title),
                el("span", { className: "labs-history-pick" }, `→ ${v.best === "same" ? "can't tell them apart" : `option ${v.best}`}`),
                el("span", { className: "labs-history-when" }, timeAgo(v.savedAt)),
              ),
            ),
          )
        : el("div", { className: "empty" }, "You haven't rated any of this lab's cycles yet."),
    );
  }
}
