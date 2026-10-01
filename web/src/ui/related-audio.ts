import { SEMANTIC_EMBEDDING_SPACE, type SemanticSearchHit } from "../semantic/contracts";
import { relatedAudio, type RelatedAudioRequest, type RelatedAudioResponse } from "../data/related-audio";
import type { SemanticSoundMatch } from "./semantic-sound";
import { el } from "./dom";

export type RelatedAudioState = { phase: "idle" | "loading"; hits: [] } | { phase: "ready"; hits: SemanticSearchHit[] } | { phase: "awaiting_analysis"; hits: [] } | { phase: "error"; hits: []; error: unknown };
type Request = (request: RelatedAudioRequest, options?: { signal?: AbortSignal }) => Promise<RelatedAudioResponse>;

/** Generation-gated related retrieval: changing detail, clearing, or retrying cannot repaint stale cards. */
export class RelatedAudioController {
  state: RelatedAudioState = { phase: "idle", hits: [] };
  private generation = 0;
  private abort: AbortController | null = null;
  private last: Omit<RelatedAudioRequest, "embeddingSpace"> | null = null;
  constructor(private readonly options: { request?: Request; onState?: (state: RelatedAudioState) => void } = {}) {}
  async load(request: Omit<RelatedAudioRequest, "embeddingSpace">) {
    this.last = { ...request };
    const generation = ++this.generation;
    this.abort?.abort(); this.abort = new AbortController();
    this.set({ phase: "loading", hits: [] });
    try {
      const response = await (this.options.request ?? relatedAudio)({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, ...request }, { signal: this.abort.signal });
      if (generation !== this.generation) return;
      this.set(response.state === "awaiting_analysis" ? { phase: "awaiting_analysis", hits: [] } : { phase: "ready", hits: response.hits });
    } catch (error) {
      if (generation !== this.generation || (error instanceof DOMException && error.name === "AbortError")) return;
      this.set({ phase: "error", hits: [], error });
    }
  }
  prepare() { if (this.state.phase === "idle") this.set({ phase: "loading", hits: [] }); }
  clear() { ++this.generation; this.abort?.abort(); this.abort = null; this.last = null; if (this.state.phase !== "idle") this.set({ phase: "idle", hits: [] }); }
  fail(error: unknown) { ++this.generation; this.abort?.abort(); this.abort = null; this.set({ phase: "error", hits: [], error }); }
  retry() { return this.last ? this.load(this.last) : Promise.resolve(); }
  private set(state: RelatedAudioState) { this.state = state; this.options.onState?.(state); }
}

/** Existing-style playable cards plus only truthful loading/empty/awaiting/failure states. */
export class RelatedAudio {
  readonly root = el("section", { className: "related-audio", ariaLabel: "Related by sound" });
  readonly controller: RelatedAudioController;
  private wasConnected = false;
  constructor(private readonly options: { request?: Request; resolve: (hit: SemanticSearchHit) => SemanticSoundMatch | null; active: () => boolean }) {
    this.controller = new RelatedAudioController({ request: options.request, onState: () => this.render() });
    this.render();
  }
  load(request: Omit<RelatedAudioRequest, "embeddingSpace">) { if (this.options.active()) void this.controller.load(request); }
  prepare() { this.controller.prepare(); }
  dispose() { this.controller.clear(); }
  fail(error: unknown) { this.controller.fail(error); }
  private render() {
    if (this.root.isConnected) this.wasConnected = true;
    if (!this.options.active() || (this.wasConnected && !this.root.isConnected)) return this.controller.clear();
    const state = this.controller.state;
    if (state.phase === "idle") return this.root.replaceChildren();
    const heading = el("h2", {}, "Related by sound");
    if (state.phase === "loading") return this.root.replaceChildren(heading, el("div", { className: "sound-status", ariaLive: "polite" }, "Finding related sounds…"));
    if (state.phase === "awaiting_analysis") return this.root.replaceChildren(heading, el("div", { className: "sound-status" }, "Related sound is awaiting analysis."));
    if (state.phase === "error") { const retry = el("button", { type: "button", className: "btn link" }, "Retry"); retry.addEventListener("click", () => void this.controller.retry()); return this.root.replaceChildren(heading, el("div", { className: "sound-status bad" }, "Related sound is unavailable. ", retry)); }
    if (state.phase !== "ready") return;
    this.root.replaceChildren(heading, el("div", { className: "sound-status", ariaLive: "polite" }, "Preparing related sounds…"));
    void this.drawCards(state, heading);
  }
  private async drawCards(state: Extract<RelatedAudioState, { phase: "ready" }>, heading: HTMLElement) {
    const { SemanticSoundCard } = await import("./semantic-sound-card");
    if (this.controller.state !== state || !this.options.active()) return;
    const cards = state.hits.map(this.options.resolve).filter((match): match is SemanticSoundMatch => !!match).slice(0, 6).map((match) => new SemanticSoundCard(match).root);
    this.root.replaceChildren(heading, ...(cards.length ? cards : [el("div", { className: "sound-status" }, "No related sounds are available.")]));
  }
}
