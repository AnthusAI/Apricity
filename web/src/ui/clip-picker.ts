// Pick a clip from the library: a small dialog with a search box, used to add a pad (drum machine) or a string
// (chord harp). `rank` puts the likelier clips first (shots for pads, phrases and loops for strings).

import { el } from "./dom";
import { api, type ClipItem } from "../apricity";

export function pickClip(title: string, placeholder: string, rank: (c: ClipItem) => number = () => 0): Promise<ClipItem | null> {
  return new Promise((resolve) => {
    const dlg = el("dialog", { className: "clip-pick" });
    const search = el("input", { type: "search", placeholder, ariaLabel: "Find a clip" });
    const list = el("div", { className: "list" });
    const close = el("button", { type: "button", className: "btn" }, "Cancel");
    let chosen: ClipItem | null = null;
    close.addEventListener("click", () => dlg.close());
    dlg.append(el("h3", {}, title), search, list, el("div", { className: "toolbar" }, close));
    dlg.addEventListener("close", () => (dlg.remove(), resolve(chosen)));
    document.body.append(dlg);
    dlg.showModal();
    api
      .clips()
      .then((clips) => {
        const sorted = [...clips].sort((a, b) => rank(b) - rank(a));
        const show = () => {
          const q = search.value.trim().toLowerCase();
          const hits = sorted.filter((c) => !q || `${c.name} ${c.sampleTitle}`.toLowerCase().includes(q)).slice(0, 60);
          list.replaceChildren(
            ...hits.map((c) => {
              const row = el("button", { type: "button", className: "row" }, el("span", { className: "t" }, c.name), el("span", { className: "sub" }, `${c.sampleTitle} · ${(c.end - c.start).toFixed(2)} s`));
              row.addEventListener("click", () => ((chosen = c), dlg.close()));
              return row;
            }),
            ...(hits.length ? [] : [el("div", { className: "empty" }, "No clips match.")]),
          );
        };
        search.addEventListener("input", show);
        show();
      })
      .catch((e) => list.replaceChildren(el("div", { className: "empty" }, `Couldn't load clips: ${(e as Error).message}`)));
  });
}
