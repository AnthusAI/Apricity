import { SEMANTIC_EMBEDDING_SPACE, type SemanticSearchHit } from "../semantic/contracts";
import { relatedAudio, type RelatedAudioRequest, type RelatedAudioResponse } from "../data/related-audio";
import type { SemanticSoundMatch } from "./semantic-sound";
import { el } from "./dom";

export type RelatedAudioState = { phase: "idle" | "loading"; hits: [] } | { phase: "ready"; hits: SemanticSearchHit[] } | { phase: "awaiting_analysis"; hits: [] } | { phase: "error"; hits: []; error: unknown };
type Request = (request: RelatedAudioRequest, options?: { signal?: AbortSignal }) => Promise<RelatedAudioResponse>;
type BeforeRequest = () => Promise<void>;

/** Generation-gated related retrieval: changing detail, clearing, or retrying cannot repaint stale cards. */
export class RelatedAudioController {
  state: RelatedAudioState = { phase: "idle", hits: [] };
  private generation = 0;
  private abort: AbortController | null = null;
  private last: Omit<RelatedAudioRequest, "embeddingSpace"> | null = null;
  private lastAttempt: (() => Promise<void>) | null = null;
  private disposed = false;
  constructor(private readonly options: { request?: Request; onState?: (state: RelatedAudioState) => void } = {}) {}
  async load(request: Omit<RelatedAudioRequest, "embeddingSpace">, before?: BeforeRequest) {
    if (this.disposed) return;
    this.last = { ...request };
    this.lastAttempt = () => this.load(this.last!, before);
    const generation = ++this.generation;
    this.abort?.abort(); this.abort = new AbortController();
    this.set({ phase: "loading", hits: [] });
    try {
      if (before) await before();
      if (this.disposed || generation !== this.generation) return;
      const response = await (this.options.request ?? relatedAudio)({ embeddingSpace: SEMANTIC_EMBEDDING_SPACE, ...request }, { signal: this.abort.signal });
      if (this.disposed || generation !== this.generation) return;
      this.set(response.state === "awaiting_analysis" ? { phase: "awaiting_analysis", hits: [] } : { phase: "ready", hits: response.hits });
    } catch (error) {
      if (this.disposed || generation !== this.generation || (error instanceof DOMException && error.name === "AbortError")) return;
      this.set({ phase: "error", hits: [], error });
    }
  }
  prepare() { if (!this.disposed && this.state.phase === "idle") this.set({ phase: "loading", hits: [] }); }
  clear() { ++this.generation; this.abort?.abort(); this.abort = null; this.last = null; this.lastAttempt = null; if (this.state.phase !== "idle") this.set({ phase: "idle", hits: [] }); }
  dispose() { if (this.disposed) return; this.disposed = true; this.clear(); }
  fail(error: unknown) { if (this.disposed) return; ++this.generation; this.abort?.abort(); this.abort = null; this.set({ phase: "error", hits: [], error }); }
  retry() { return !this.disposed && this.lastAttempt ? this.lastAttempt() : Promise.resolve(); }
  private set(state: RelatedAudioState) { this.state = state; this.options.onState?.(state); }
}

/** Existing-style playable cards plus only truthful loading/empty/awaiting/failure states. */
export class RelatedAudio {
  readonly root = el("section", { className: "related-audio", ariaLabel: "Related by sound" });
  readonly controller: RelatedAudioController;
  private wasConnected = false;
  private disposed = false;
  constructor(private readonly options: { request?: Request; resolve: (hit: SemanticSearchHit) => SemanticSoundMatch | null; active: () => boolean; card?: (match: SemanticSoundMatch) => HTMLElement }) {
    this.controller = new RelatedAudioController({ request: options.request, onState: () => this.render() });
    this.render();
  }
  load(request: Omit<RelatedAudioRequest, "embeddingSpace">, before?: BeforeRequest) { if (!this.disposed && this.options.active()) void this.controller.load(request, before); }
  prepare() { if (!this.disposed) this.controller.prepare(); }
  dispose() { this.disposed = true; this.controller.dispose(); }
  fail(error: unknown) { if (!this.disposed) this.controller.fail(error); }
  private render() {
    if (this.root.isConnected) this.wasConnected = true;
    if (this.disposed || !this.options.active() || (this.wasConnected && !this.root.isConnected)) return this.controller.clear();
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
    if (this.options.card) return this.drawCardsWith(state, heading, this.options.card);
    const { SemanticSoundCard } = await import("./semantic-sound-card");
    this.drawCardsWith(state, heading, (match) => new SemanticSoundCard(match).root);
  }
  private drawCardsWith(state: Extract<RelatedAudioState, { phase: "ready" }>, heading: HTMLElement, card: (match: SemanticSoundMatch) => HTMLElement) {
    if (this.disposed || this.controller.state !== state || !this.options.active()) return;
    const cards = state.hits.map(this.options.resolve).filter((match): match is SemanticSoundMatch => !!match).slice(0, 6).map(card);
    this.root.replaceChildren(heading, ...(cards.length ? [el("div", { className: "feed-grid" }, ...cards)] : [el("div", { className: "sound-status" }, "No related sounds are available.")]));
  }
}
