import { connectCatalog } from "../apricity";
import { playSample, playingKey, stopFeed } from "../audio/feed-audio";
import { getClusters, type ClusterCard, type ClusterDetail, type ClusterLeaderboard, type ClusterMap, type ClusterMapPoint } from "../data/audio-clusters";
import { href, sampleKey, type Route } from "../route";
import { go } from "./at";
import { el } from "./dom";
import { PlayButton, type PlayState } from "./play-button";

type CurrentCard = ClusterCard & { path: string; route: Route; parent: Route; title: string };
type VisibleMapPoint = Omit<ClusterMapPoint, "cards"> & { cards: CurrentCard[] };
const seconds = (value: number) => `${value.toFixed(value < 10 ? 2 : 1).replace(/\.0+$/, "")} s`;
const MAP_LIST_PAGE = 50;

/** Public, read-only published cluster exploration. It deliberately has no draft or curator path. */
export class SoundClustersView {
  private abort: AbortController | null = null;
  private generation = 0;

  constructor(private readonly root: HTMLElement) {}

  dispose() {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    stopFeed();
  }

  async show(route: Route) {
    this.dispose();
    const generation = this.generation;
    if (route.invalidSoundCluster || route.invalidSoundQuery) return this.renderState("invalid", "This sound-cluster link is invalid.");
    this.renderState("loading", "Loading published sound clusters…");
    const abort = (this.abort = new AbortController());
    const preset = route.preset ?? "useful";
    try {
      const result = await getClusters(route.clusterId ? { view: "detail", cluster: route.clusterId, run: route.run, preset, order: route.members ?? "similarity" } : route.soundMap ? { view: "map", run: route.run, preset, limit: 10_000 } : { view: "leaderboard", run: route.run, preset, order: route.soundOrder ?? "samples" }, { signal: abort.signal });
      if (generation !== this.generation) return;
      if ("clusters" in result) await this.renderLeaderboard(result, route, generation);
      else if ("members" in result) await this.renderDetail(result, route, generation);
      else await this.renderMap(result, route, generation);
    } catch (error) {
      if (generation !== this.generation || (error as DOMException)?.name === "AbortError") return;
      const status = (error as { status?: number }).status;
      this.renderState(status === 404 ? "empty" : status === 503 ? "retry" : "unavailable", status === 404 ? "No published sound cluster matches this selection." : status === 503 ? "Published sound clusters are temporarily unavailable." : (error as Error).message, status === 503 ? () => void this.show(route) : undefined);
    }
  }

  private renderState(kind: string, text: string, retry?: () => void) {
    this.root.replaceChildren();
    const box = el("div", { className: `cluster-state ${kind}`, role: "status", textContent: text });
    if (retry) { const button = el("button", { type: "button", className: "btn", textContent: "Retry" }); button.addEventListener("click", retry); box.append(" ", button); }
    this.root.append(box);
  }

  private controls(route: Route, detail = false) {
    const preset = route.preset ?? "useful";
    const order = detail ? (route.members ?? "similarity") : (route.soundOrder ?? "samples");
    const wrap = el("div", { className: "cluster-controls", ariaLabel: "Sound cluster options" });
    const select = (label: string, value: string, options: readonly string[], change: (value: string) => Route) => {
      const input = el("select", { ariaLabel: label }) as HTMLSelectElement;
      for (const option of options) input.append(el("option", { value: option, textContent: option[0]!.toUpperCase() + option.slice(1), selected: option === value }));
      input.addEventListener("change", () => go(change(input.value)));
      return input;
    };
    wrap.append(el("label", {}, "Preset", select("Preset", preset, ["broad", "useful", "fine"], (value) => ({ ...route, preset: value as Route["preset"] }))));
    wrap.append(el("label", {}, detail ? "Members" : "Rank", select(detail ? "Member ordering" : "Leaderboard ordering", order, detail ? ["similarity", "rating"] : ["samples", "clips"], (value) => detail ? { ...route, members: value as Route["members"] } : { ...route, soundOrder: value as Route["soundOrder"] })));
    return wrap;
  }

  private mapControls(route: Route, result: ClusterMap) {
    const wrap = el("div", { className: "cluster-controls", ariaLabel: "Sound map options" });
    const preset = route.preset ?? "useful";
    const input = el("select", { ariaLabel: "Preset" }) as HTMLSelectElement;
    for (const option of ["broad", "useful", "fine"] as const) input.append(el("option", { value: option, textContent: option[0]!.toUpperCase() + option.slice(1), selected: option === preset }));
    input.addEventListener("change", () => go({ page: "sounds", run: result.runId, preset: input.value as Route["preset"], soundMap: true }));
    const leaderboard: Route = { page: "sounds", run: result.runId, preset, soundOrder: "samples" };
    const link = el("a", { className: "btn", href: href(leaderboard), textContent: "Cluster leaderboard" });
    link.addEventListener("click", (event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); go(leaderboard); });
    wrap.append(el("label", {}, "Preset", input), link);
    return wrap;
  }

  private async current(cards: ClusterCard[], generation: number): Promise<CurrentCard[]> {
    const catalog = await connectCatalog();
    const [{ samples }, clips] = await Promise.all([catalog.samples(), catalog.clips()]);
    if (generation !== this.generation) return [];
    const parents = new Map(samples.map((sample) => [sample.id, sample]));
    const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
    const out: CurrentCard[] = [];
    for (const card of cards) {
      const sample = parents.get(card.sampleId);
      if (!sample) continue; // visibility changed after the service read; never show stale metadata.
      const parent = { page: "samples" as const, sample: sampleKey(sample.path) };
      if (card.kind === "saved_clip") {
        const clip = card.clipId ? clipsById.get(card.clipId) : undefined;
        if (!clip || clip.sampleId !== sample.id || clip.start !== card.start || clip.end !== card.end) continue;
        out.push({ ...card, path: sample.path, parent, route: { page: "clips", clip: { sample: sampleKey(sample.path), name: clip.name } }, title: clip.name });
      } else out.push({ ...card, path: sample.path, parent, route: parent, title: sample.title });
    }
    return out;
  }

  private async renderLeaderboard(result: ClusterLeaderboard, route: Route, generation: number) {
    const representativeSets = await Promise.all(result.clusters.map((row) => this.current(row.representatives, generation)));
    if (generation !== this.generation) return;
    this.root.replaceChildren(el("header", { className: "cluster-head" }, el("h1", { textContent: "Sound clusters" }), el("p", { textContent: "Published groups of related passages." }), this.controls({ ...route, run: result.runId, preset: result.preset })));
    const list = el("ol", { className: "cluster-list", ariaLabel: "Published sound clusters" });
    result.clusters.forEach((cluster, index) => {
      const reps = representativeSets[index] ?? [];
      const label = cluster.curatedLabel ?? cluster.suggestedLabel ?? "Unlabeled cluster";
      const marker = cluster.curatedLabel ? "" : cluster.suggestedLabel ? " (suggested)" : "";
      const target: Route = { page: "sounds", clusterId: cluster.clusterId, run: result.runId, preset: result.preset, members: "similarity" };
      const link = el("a", { href: href(target), textContent: label + marker });
      link.addEventListener("click", (event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); go(target); });
      const item = el("li", { className: "cluster-row" }, el("h2", {}, link), el("p", { className: "cluster-count", textContent: `${cluster.distinctSampleCount} samples · ${cluster.savedClipCount} clips` }));
      if (reps.length) { const section = el("div", { className: "cluster-representatives" }, el("h3", { textContent: "Representative passages" })); reps.forEach((card) => section.append(this.card(card))); item.append(section); }
      list.append(item);
    });
    if (!result.clusters.length) this.root.append(el("p", { className: "cluster-state empty", textContent: "No published sound clusters are available for this preset." }));
    else this.root.append(list);
  }

  private async renderDetail(result: ClusterDetail, route: Route, generation: number) {
    const [representatives, members] = await Promise.all([this.current(result.representatives, generation), this.current(result.members, generation)]);
    if (generation !== this.generation) return;
    const back: Route = { page: "sounds", run: result.runId, preset: route.preset ?? "useful", soundOrder: "samples" };
    const backLink = el("a", { href: href(back), textContent: "← All sound clusters" });
    backLink.addEventListener("click", (event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); go(back); });
    this.root.replaceChildren(el("header", { className: "cluster-head" }, backLink, el("h1", { textContent: "Sound cluster" }), this.controls({ ...route, run: result.runId, clusterId: result.clusterId }, true)));
    const render = (title: string, cards: CurrentCard[]) => { const section = el("section", { className: "cluster-members" }, el("h2", { textContent: title })); cards.forEach((card) => section.append(this.card(card))); return section; };
    if (representatives.length) this.root.append(render("Representative passages", representatives));
    if (members.length) this.root.append(render("More passages", members));
    if (!representatives.length && !members.length) this.root.append(el("p", { className: "cluster-state empty", textContent: "No currently playable passages remain in this cluster." }));
  }

  /** A canvas-free projection: the SVG remains inspectable, while the paged list is the keyboard alternative. */
  private async renderMap(result: ClusterMap, route: Route, generation: number) {
    const allCards = result.points.flatMap((point) => point.cards);
    const current = await this.current(allCards, generation);
    if (generation !== this.generation) return;
    const bySemantic = new Map<string, CurrentCard[]>();
    for (const card of current) bySemantic.set(card.semanticId, [...(bySemantic.get(card.semanticId) ?? []), card]);
    const points: VisibleMapPoint[] = result.points.map((point) => ({ ...point, cards: point.cards.flatMap((card) => bySemantic.get(card.semanticId) ?? []) })).filter((point) => point.cards.length > 0);
    const header = el("header", { className: "cluster-head" }, el("h1", { textContent: "Sound map" }), el("p", { textContent: "A two-dimensional view of published passages. Nearness is a browsing aid, not a measure of sound quality." }), this.mapControls(route, result));
    this.root.replaceChildren(header);
    if (!points.length) {
      this.root.append(el("p", { className: "cluster-state empty", textContent: "No currently playable passages are available on this published map." }));
      return;
    }
    const summary = result.truncated
      ? `Showing ${result.displayedCount.toLocaleString()} of ${result.totalVisibleCount.toLocaleString()} published passages; the map is capped at 10,000 points.`
      : `Showing ${result.displayedCount.toLocaleString()} published passages.`;
    const status = el("p", { className: "cluster-map-summary", textContent: summary });
    const figure = el("figure", { className: "cluster-map", ariaLabel: "Published sound map" });
    const caption = el("figcaption", { textContent: "Choose a point to inspect it. The list below is a keyboard-accessible alternative." });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 1000 620");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Sound-map projection. Use the point list below to explore with a keyboard.");
    const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
    const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.min(...ys), top = Math.max(...ys);
    const scale = (value: number, low: number, high: number, extent: number) => high === low ? extent / 2 : 24 + ((value - low) / (high - low)) * (extent - 48);
    const nodes = new Map<string, SVGCircleElement[]>();
    let selected: VisibleMapPoint | null = null;
    const detail = el("section", { className: "cluster-map-selection", ariaLive: "polite" }, el("h2", { textContent: "Selected passage" }), el("p", { textContent: "Choose a point or a passage in the list." }));
    const select = (point: VisibleMapPoint) => {
      selected = point;
      const selectedIds = new Set(point.clusterId ? points.filter((other) => other.clusterId === point.clusterId).map((other) => other.semanticId) : [point.semanticId]);
      for (const [semanticId, circles] of nodes) for (const circle of circles) circle.classList.toggle("selected", selectedIds.has(semanticId));
      detail.replaceChildren(el("h2", { textContent: point.clusterId ? "Selected cluster passage" : "Selected outlier passage" }));
      if (point.clusterId) {
        const target: Route = { page: "sounds", clusterId: point.clusterId, run: result.runId, preset: route.preset ?? "useful", members: "similarity" };
        const link = el("a", { className: "btn", href: href(target), textContent: "Open this cluster" });
        link.addEventListener("click", (event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); go(target); });
        detail.append(el("p", { textContent: "This point belongs to a published cluster." }), link);
      } else detail.append(el("p", { textContent: "This passage is an outlier in this clustering run." }));
      point.cards.forEach((card) => detail.append(this.card(card)));
      for (const row of list.querySelectorAll<HTMLElement>("[data-semantic-id]")) row.setAttribute("aria-current", String(row.dataset.semanticId === point.semanticId));
    };
    for (const point of points) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle") as SVGCircleElement;
      circle.setAttribute("cx", String(scale(point.x, left, right, 1000)));
      circle.setAttribute("cy", String(620 - scale(point.y, bottom, top, 620)));
      circle.setAttribute("r", point.clusterId ? "4" : "3");
      circle.classList.add("cluster-map-point", point.clusterId ? "clustered" : "outlier");
      circle.setAttribute("tabindex", "-1");
      circle.setAttribute("data-semantic-id", point.semanticId);
      circle.setAttribute("aria-label", `${point.cards[0]!.title}; ${point.clusterId ? "clustered passage" : "outlier passage"}`);
      circle.addEventListener("click", () => select(point));
      svg.append(circle);
      nodes.set(point.semanticId, [...(nodes.get(point.semanticId) ?? []), circle]);
    }
    figure.append(svg, caption);
    this.root.append(status, figure, detail);

    const list = el("ol", { className: "cluster-map-list", ariaLabel: "Sound-map passage list" });
    let page = 0;
    const pager = el("nav", { className: "cluster-map-pager", ariaLabel: "Sound-map passage pages" });
    const renderList = () => {
      list.replaceChildren();
      const start = page * MAP_LIST_PAGE;
      for (const point of points.slice(start, start + MAP_LIST_PAGE)) {
        const title = point.cards[0]!.title;
        const item = el("li", { dataSemanticId: point.semanticId });
        const button = el("button", { type: "button", className: "cluster-map-list-point", textContent: `${title} — ${point.clusterId ? "Clustered passage" : "Outlier"}` });
        button.addEventListener("click", () => select(point));
        item.append(button);
        list.append(item);
      }
      const totalPages = Math.ceil(points.length / MAP_LIST_PAGE);
      pager.replaceChildren();
      if (totalPages > 1) {
        const previous = el("button", { type: "button", className: "btn", textContent: "Previous passages", disabled: page === 0 });
        const next = el("button", { type: "button", className: "btn", textContent: "More passages", disabled: page + 1 >= totalPages });
        previous.addEventListener("click", () => { page--; renderList(); });
        next.addEventListener("click", () => { page++; renderList(); });
        pager.append(el("span", { textContent: `Passages ${start + 1}–${Math.min(start + MAP_LIST_PAGE, points.length)} of ${points.length}` }), previous, next);
      }
      if (selected) for (const row of list.querySelectorAll<HTMLElement>("[data-semantic-id]")) row.setAttribute("aria-current", String(row.dataset.semanticId === selected!.semanticId));
    };
    renderList();
    this.root.append(el("section", { className: "cluster-map-alternative" }, el("h2", { textContent: "Map passages" }), el("p", { textContent: "Browse this paged list with a keyboard, then open the selected cluster for its full detail." }), list, pager));
  }

  private card(card: CurrentCard) {
    let state: PlayState = { kind: "idle" };
    const key = `cluster:${card.semanticId}`;
    const play = new PlayButton("passage", () => void toggle());
    const toggle = async () => { if (playingKey() === key) return stopFeed(); await playSample(key, card.path, [card.start, card.end], (next) => { state = next; play.set(state); }); };
    const link = el("a", { href: href(card.route), textContent: card.title });
    link.addEventListener("click", (event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); go(card.route); });
    const parent = card.route.page === "clips" ? el("a", { href: href(card.parent), textContent: `From ${card.sampleTitle}` }) : null;
    parent?.addEventListener("click", (event) => { event.preventDefault(); go(card.parent); });
    return el("article", { className: "cluster-card" }, play.root, el("div", {}, link, parent ? el("div", { className: "cluster-parent" }, parent) : el("div", { className: "cluster-parent", textContent: "Sample passage" }), el("div", { className: "sound-range", textContent: `${seconds(card.start)}–${seconds(card.end)}` })));
  }
}
