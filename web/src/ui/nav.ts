// The top bar's navigation, at any width. The tabs sit in the bar while they fit; when they don't, a menu button takes
// their place and opens a menu that fills the screen: one column on a phone, as many as fit on a wider one, and every
// page with a line saying what it's for. Escape, the × or choosing a page closes it.

import { el } from "./dom";
import type { Page } from "../route";

export interface NavItem {
  page: Page;
  /** The bar's tab for it (`data-tab`), when it has one. */
  tab?: string;
  label: string;
  sub: string;
  href: string;
}

export const NAV: NavItem[] = [
  { page: "home", tab: "home", label: "Home", sub: "What people are making: the best rated first, or the newest", href: "/" },
  { page: "scores", tab: "scores", label: "Scores", sub: "Songs, mashed up from real recordings", href: "/scores" },
  { page: "beats", tab: "beats", label: "Beats", sub: "Drum patterns on the step grid", href: "/beats" },
  { page: "chords", tab: "chords", label: "Chords", sub: "Progressions on the chord harp", href: "/chords" },
  { page: "melodies", tab: "melodies", label: "Melodies", sub: "Tunes on the piano roll", href: "/melodies" },
  { page: "clips", tab: "clips", label: "Clips", sub: "Loops, hits and phrases cut from samples", href: "/clips" },
  { page: "samples", tab: "samples", label: "Samples", sub: "Public-domain and open recordings, analyzed", href: "/samples" },
  { page: "tags", tab: "tags", label: "Tags", sub: "Leaderboards for #techno, #lounge and the rest", href: "/tags" },
  { page: "help", tab: "docs", label: "Help", sub: "The language, the tools, and how it all works", href: "/help" },
  { page: "about", tab: "about", label: "About", sub: "What Apricity is, and where its sounds come from", href: "/about" },
  { page: "how-it-works", tab: "how-it-works", label: "How it works", sub: "The ML and audio analysis behind every sound", href: "/how-it-works" },
  { page: "listen", tab: "listen", label: "Listen", sub: "Rate blind candidates from a listening cycle", href: "/listen" },
];

/** How much more room than they need the tabs must have to come back out of the menu (a scrollbar coming and going,
 * a status line changing, mustn't flip them back and forth). */
const SLACK = 24;

/**
 * Watch the bar: collapse its tabs into the menu button when they don't fit. `go` follows a chosen page (a plain
 * click; a middle click opens a new tab through the link itself).
 */
export function mountNav(bar: HTMLElement, tabs: HTMLElement, go: (page: Page) => void) {
  const button = el("button", { type: "button", className: "nav-toggle", ariaLabel: "Menu", title: "All pages" });
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "nav-menu");
  tabs.before(button);

  const close = el("button", { type: "button", className: "nav-close", ariaLabel: "Close the menu", textContent: "×" });
  const grid = el("div", { className: "nav-grid" });
  const menu = el("div", { id: "nav-menu", className: "nav-menu", role: "dialog", ariaLabel: "Pages", hidden: true }, el("div", { className: "nav-head" }, el("span", { className: "nav-title" }, "Apricity"), close), grid);
  document.body.append(menu);

  let opener: HTMLElement | null = null;
  const shut = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    document.body.classList.remove("nav-open");
    button.setAttribute("aria-expanded", "false");
    opener?.focus();
  };
  const open = () => {
    const here = document.body.dataset.tab ?? "";
    grid.replaceChildren(
      ...NAV.map((n) => {
        const a = el("a", { className: "nav-item", href: n.href }, el("span", { className: "nav-label" }, n.label), el("span", { className: "nav-sub" }, n.sub));
        if (n.tab === here) a.setAttribute("aria-current", "page");
        a.addEventListener("click", (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          shut();
          go(n.page);
        });
        return a;
      }),
    );
    opener = document.activeElement as HTMLElement | null;
    menu.hidden = false;
    document.body.classList.add("nav-open");
    button.setAttribute("aria-expanded", "true");
    (grid.querySelector<HTMLElement>('[aria-current="page"]') ?? grid.querySelector<HTMLElement>("a"))?.focus();
  };
  button.addEventListener("click", () => (menu.hidden ? open() : shut()));
  close.addEventListener("click", shut);
  document.addEventListener("keydown", (e) => e.key === "Escape" && shut());
  window.addEventListener("popstate", shut);

  // The tabs' room is the bar less everything else in it (the brand, the transport, search, the account badge). That
  // doesn't change when the tabs fold into the menu, so folding can't undo its own reason (measuring the tabs' own box
  // did: they flickered in and out many times a second). Collapse when they don't fit; come back with SLACK to spare.
  const roomForTabs = () => {
    const cs = getComputedStyle(bar);
    const gap = parseFloat(cs.columnGap) || 0;
    let room = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    let shown = 0;
    for (const c of bar.children) {
      if (c === tabs || c === button || !(c instanceof HTMLElement) || c.hidden || getComputedStyle(c).display === "none") continue;
      room -= c.getBoundingClientRect().width;
      shown++;
    }
    return room - gap * shown; // a gap between the tabs and each other thing
  };
  // What the tabs themselves take (the strip stretches to fill the bar, so its own width says nothing).
  const tabsNeed = () => {
    const gap = parseFloat(getComputedStyle(tabs).columnGap) || 0;
    const links = [...tabs.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.hidden);
    return links.reduce((w, a) => w + a.getBoundingClientRect().width, 0) + gap * Math.max(0, links.length - 1);
  };
  const fit = () => {
    const collapsed = bar.classList.contains("nav-collapsed");
    const need = tabsNeed();
    const room = roomForTabs();
    const collapse = collapsed ? need + SLACK > room : need > room;
    if (collapse !== collapsed) bar.classList.toggle("nav-collapsed", collapse);
    if (!collapse) shut();
  };
  const watch = new ResizeObserver(fit);
  watch.observe(bar);
  // What's beside the tabs changes size too (the transport's status line, the search box growing while you type).
  for (const c of bar.children) if (c !== tabs && c !== button) watch.observe(c);
  void document.fonts?.ready.then(fit);
  fit();
}
