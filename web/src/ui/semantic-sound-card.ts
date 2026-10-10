import { playingKey, playSample, stopFeed } from "../audio/feed-audio";
import { href } from "../route";
import type { HybridSearchState } from "../semantic/hybrid-controller";
import { el } from "./dom";
import { go } from "./at";
import { PlayButton, type PlayState } from "./play-button";
import { semanticSoundRoutes, soundHostState, type SemanticSoundMatch } from "./semantic-sound";

const seconds = (value: number) => `${value.toFixed(value < 10 ? 2 : 1).replace(/\.0+$/, "")} s`;

/** A compact existing-feed-style card for a current canonical record and a scored passage. */
export class SemanticSoundCard {
  readonly root: HTMLElement;
  private state: PlayState = { kind: "idle" };
  private readonly key: string;
  private readonly play: PlayButton;

  constructor(private readonly match: SemanticSoundMatch) {
    const { entry, hit } = match;
    const clip = entry.clip;
    const sample = entry.sample;
    const isClip = !!clip;
    // The current canonical parent owns navigation and audio location, not retrieval card hints.
    const routes = semanticSoundRoutes(match);
    const { path, card: route } = routes;
    const title = clip?.name ?? sample?.title ?? entry.base.title;
    this.key = `semantic:${hit.identity.semanticId}`; // windows on one parent never share an audition key.
    this.play = new PlayButton("sample", () => void this.toggle(path));
    const link = el("a", { className: "feed-title", href: href(route), textContent: title });
    link.addEventListener("click", (event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); go(route); });
    this.root = el(
      "article", { className: "feed-card sound-card" },
      el("div", { className: "sound-stage" }, this.play.root),
      el("div", { className: "feed-body" },
          el("div", { className: "feed-head" }, el("div", { className: "feed-titles" }, link,
          isClip ? this.parentLink(routes.parent, clip!.sampleTitle) : el("div", { className: "feed-by" }, "Sample passage"))),
        el("div", { className: "sound-range" }, `${seconds(hit.timeRange.start)}–${seconds(hit.timeRange.end)}`),
      ),
    );
  }

  private parentLink(route: { page: "samples"; sample: string }, title: string) {
    const parent = el("a", { className: "feed-by", href: href(route), textContent: `Clip · from ${title}` });
    parent.addEventListener("click", (event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); go(route); });
    return parent;
  }

  private async toggle(path: string) {
    if (playingKey() === this.key) return stopFeed();
    const report = (state: PlayState) => { this.state = state; this.play.set(state); };
    await playSample(this.key, path, [this.match.hit.playback.start, this.match.hit.playback.end], report);
  }
}

export function semanticStatus(state: HybridSearchState, retry: () => void): HTMLElement | null {
  if (state.phase === "idle" || state.phase === "ready") return null;
  if (state.phase === "error") {
    const box = el("div", { className: "sound-status bad" }, "Sound matches unavailable. ");
    const button = el("button", { type: "button", className: "btn link" }, "Retry");
    button.addEventListener("click", retry);
    box.append(button);
    return box;
  }
  const status = soundHostState(state.query, state, true);
  const label = status.kind === "status" ? status.text : "Finding sound matches…";
  return el("div", { className: "sound-status", ariaLive: "polite" }, label);
}
