/** Local curator-only draft review.  Public cluster browsing deliberately lives elsewhere. */
import { connectCatalog } from "../apricity";
import { playSample, playingKey, stopFeed } from "../audio/feed-audio";
import { curatorRequest, type CuratorPreview } from "../data/cluster-curator";
import type { ClusterCard } from "../data/audio-clusters";
import { bootstrap, clusterCuratorEnabled } from "../data/client";
import { href, sampleKey, type Route } from "../route";
import { go } from "./at";
import { el } from "./dom";
import { PlayButton, type PlayState } from "./play-button";

type CurrentCard = ClusterCard & { path: string; title: string; route: Route; parent: Route };
const RUN = /^[0-9a-f]{64}$/;
const seconds = (value: number) => `${value.toFixed(value < 10 ? 2 : 1).replace(/\.0+$/, "")} s`;

/** This view is only instantiated by main.ts after the trusted local flag is checked. */
export class SoundClusterReviewView {
  private abort: AbortController | null = null;
  private generation = 0;

  constructor(private readonly root: HTMLElement) {}

  dispose() { this.generation++; this.abort?.abort(); this.abort = null; stopFeed(); }

  async show(route: Route) {
    this.dispose();
    const generation = this.generation;
    await bootstrap();
    if (generation !== this.generation) return;
    if (!clusterCuratorEnabled()) return this.state("unavailable", "Curator review is not enabled on this local server.");
    if (route.invalidSoundQuery) return this.state("invalid", "This curator-review link is invalid.");
    this.landing(route, generation);
    if (route.run) await this.load(route.run, generation);
  }

  private state(kind: string, text: string) { this.root.replaceChildren(el("div", { className: `cluster-state ${kind}`, role: "status", textContent: text })); }

  private landing(route: Route, generation: number) {
    const input = el("input", { type: "text", className: "cluster-review-run", value: route.run ?? "", placeholder: "64-character draft run ID", ariaLabel: "Draft run ID", autocomplete: "off", spellcheck: false }) as HTMLInputElement;
    const button = el("button", { type: "button", className: "btn", textContent: "Open draft" });
    const error = el("p", { className: "cluster-review-hint", ariaLive: "polite" });
    const open = () => {
      const run = input.value.trim();
      if (!RUN.test(run)) { error.textContent = "Enter the exact 64-character draft run ID."; return; }
      go({ page: "sounds", soundReview: true, run });
    };
    button.addEventListener("click", open);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") open(); });
    this.root.replaceChildren(el("header", { className: "cluster-head" }, el("h1", { textContent: "Review sound-cluster draft" }), el("p", { textContent: "This is a local curator tool. Drafts are not public until you listen, approve, and explicitly publish them." })), el("div", { className: "cluster-review-open" }, el("label", {}, "Draft run ID", input), button), error);
    if (route.run && generation === this.generation) error.textContent = "Loading draft…";
  }

  private async load(runId: string, generation: number) {
    const abort = (this.abort = new AbortController());
    try {
      const preview = await curatorRequest({ op: "preview", runId }, { signal: abort.signal });
      if (generation !== this.generation || !("clusters" in preview)) return;
      await this.render(preview, generation);
    } catch (error) {
      if (generation !== this.generation || (error as DOMException)?.name === "AbortError") return;
      this.state("unavailable", (error as Error).message);
    }
  }

  private async current(cards: ClusterCard[], generation: number): Promise<CurrentCard[]> {
    const catalog = await connectCatalog();
    const [{ samples }, clips] = await Promise.all([catalog.samples(), catalog.clips()]);
    if (generation !== this.generation) return [];
    const sampleById = new Map(samples.map((sample) => [sample.id, sample]));
    const clipById = new Map(clips.map((clip) => [clip.id, clip]));
    const out: CurrentCard[] = [];
    for (const card of cards) {
      const sample = sampleById.get(card.sampleId);
      if (!sample) continue;
      const parent: Route = { page: "samples", sample: sampleKey(sample.path) };
      if (card.kind === "saved_clip") {
        const clip = card.clipId ? clipById.get(card.clipId) : undefined;
        if (!clip || clip.sampleId !== sample.id || clip.start !== card.start || clip.end !== card.end) continue;
        out.push({ ...card, path: sample.path, title: clip.name, route: { page: "clips", clip: { sample: sampleKey(sample.path), name: clip.name } }, parent });
      } else out.push({ ...card, path: sample.path, title: sample.title, route: parent, parent });
    }
    return out;
  }

  private async render(preview: CuratorPreview, generation: number) {
    const all = preview.clusters.flatMap((cluster) => cluster.representatives);
    const current = await this.current(all, generation);
    if (generation !== this.generation) return;
    const currentById = new Map(current.map((card) => [card.semanticId, card]));
    const present = preview.clusters.map((cluster) => ({ ...cluster, representatives: cluster.representatives.flatMap((card) => currentById.get(card.semanticId) ?? []) }));
    const top = el("header", { className: "cluster-head" }, el("a", { href: href({ page: "sounds" }), textContent: "← Published sounds" }), el("h1", { textContent: "Review sound-cluster draft" }), el("p", { textContent: `Draft ${preview.runId.slice(0, 12)}… · ${preview.preset} preset · revision ${preview.runRevision}` }));
    const status = el("p", { className: "cluster-review-hint", ariaLive: "polite" });
    const sections = el("div", { className: "cluster-review-list" });
    const reviewed = new Map<string, HTMLInputElement>();
    for (const cluster of present) {
      const label = el("input", { type: "text", value: cluster.curatedLabel ?? cluster.suggestedLabel ?? "", maxLength: 120, ariaLabel: `Label for ${cluster.clusterId}` }) as HTMLInputElement;
      const save = el("button", { type: "button", className: "btn", textContent: "Save label" });
      save.addEventListener("click", async () => {
        const value = label.value.trim();
        if (!value) { status.textContent = "A label must contain 1–120 characters."; return; }
        save.disabled = true;
        try { await curatorRequest({ op: "override", runId: preview.runId, clusterId: cluster.clusterId, label: value, expectedRunRevision: preview.runRevision }); go({ page: "sounds", soundReview: true, run: preview.runId }); }
        catch (error) { status.textContent = (error as Error).message; save.disabled = false; }
      });
      const title = cluster.curatedLabel ?? cluster.suggestedLabel ?? "Unlabeled cluster";
      const section = el("section", { className: "cluster-review-cluster" }, el("h2", { textContent: title }), el("label", { className: "cluster-review-label" }, "Curated label", label), save, el("p", { className: "cluster-review-hint", textContent: "Listen to every representative passage before checking it below." }));
      if (!cluster.representatives.length) section.append(el("p", { className: "cluster-review-hint", textContent: "No currently playable representative remains for this cluster; refresh or resolve the stale draft before approval." }));
      for (const card of cluster.representatives) {
        const checked = el("input", { type: "checkbox", ariaLabel: `I listened to ${card.title}` }) as HTMLInputElement;
        reviewed.set(card.semanticId, checked);
        section.append(el("div", { className: "cluster-review-passage" }, checked, this.card(card)));
      }
      sections.append(section);
    }
    const notes = el("textarea", { maxLength: 2000, placeholder: "What you listened for, and why this grouping is acceptable.", ariaLabel: "Listening review notes" }) as HTMLTextAreaElement;
    const affirm = el("input", { type: "checkbox" }) as HTMLInputElement;
    const reviewButton = el("button", { type: "button", className: "btn", textContent: "Approve listening review" });
    const required = [...reviewed.keys()];
    reviewButton.addEventListener("click", async () => {
      if (!affirm.checked || !notes.value.trim() || required.some((id) => !reviewed.get(id)?.checked)) { status.textContent = "Confirm that you listened to every listed representative and add review notes before approving."; return; }
      reviewButton.disabled = true;
      try { await curatorRequest({ op: "review", runId: preview.runId, reviewedSemanticIds: required, notes: notes.value.trim(), expectedRunRevision: preview.runRevision }); go({ page: "sounds", soundReview: true, run: preview.runId }); }
      catch (error) { status.textContent = (error as Error).message; reviewButton.disabled = false; }
    });
    const reviewForm = el("section", { className: "cluster-review-action" }, el("h2", { textContent: "Listening review" }), el("p", { textContent: "Approval is explicit and requires every currently playable representative to be checked." }), el("label", {}, "Review notes", notes), el("label", { className: "cluster-review-check" }, affirm, " I listened to every representative above and approve this draft for publication."), reviewButton);
    const publish = el("button", { type: "button", className: "btn", textContent: "Publish reviewed run", disabled: preview.review?.status !== "approved" });
    publish.addEventListener("click", async () => {
      if (!confirm("Publish this reviewed run? This makes it available to published sound-cluster readers.")) return;
      publish.disabled = true;
      try { await curatorRequest({ op: "publish", runId: preview.runId, expectedRunRevision: preview.runRevision, expectedPointerRevision: preview.pointerRevision }); this.root.replaceChildren(el("div", { className: "cluster-state", role: "status", textContent: "Published. The public Sounds view can now read this run." })); }
      catch (error) { status.textContent = (error as Error).message; publish.disabled = false; }
    });
    const publishAction = el("section", { className: "cluster-review-action" }, el("h2", { textContent: "Publish" }), preview.review?.status === "approved" ? el("p", { textContent: "This revision has an approved listening review. Publication is still a separate explicit action." }) : el("p", { textContent: "Publication stays disabled until this exact revision has an approved listening review." }), publish);
    this.root.replaceChildren(top, status, sections, reviewForm, publishAction);
  }

  private card(card: CurrentCard) {
    let state: PlayState = { kind: "idle" };
    const key = `cluster-review:${card.semanticId}`;
    const play = new PlayButton("passage", () => void toggle());
    const toggle = async () => { if (playingKey() === key) return stopFeed(); await playSample(key, card.path, [card.start, card.end], (next) => { state = next; play.set(state); }); };
    const link = el("a", { href: href(card.route), textContent: card.title });
    link.addEventListener("click", (event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); go(card.route); });
    return el("article", { className: "cluster-card" }, play.root, el("div", {}, link, el("div", { className: "sound-range", textContent: `${seconds(card.start)}–${seconds(card.end)}` })));
  }
}
