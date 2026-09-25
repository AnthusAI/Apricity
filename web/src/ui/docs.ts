// Docs tab: the Markdown pages in /docs, bundled at build time (so they always match this build),
// with in-app links between pages, a table of contents, heading search, and highlighted
// `apricity` code blocks.

import { marked } from "marked";
import { breakdown } from "../breakdowns";
import { routeFor } from "../route";
import { highlightApr } from "./apr-highlight";
import { Breakdown } from "./breakdown/breakdown";
import { el } from "./dom";

const raw = import.meta.glob("../../../docs/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const ORDER = ["README.md", "concepts.md", "language.md", "yaml.md", "chords.md", "tools.md", "glossary.md"];

interface Page {
  file: string;
  title: string;
  md: string;
  headings: { level: number; text: string; id: string }[];
}

/** GitHub-style heading anchors, so links work the same here and on GitHub. */
export function slug(text: string) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\- ]/gu, "").replace(/\s/g, "-");
}

const strip = (md: string) => md.replace(/`([^`]*)`/g, "$1").replace(/\*\*?([^*]+)\*\*?/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

const pages: Page[] = Object.entries(raw)
  .map(([path, md]) => {
    const file = path.split("/").pop()!;
    let inCode = false;
    const headings: Page["headings"] = [];
    for (const line of md.split("\n")) {
      if (line.startsWith("```")) inCode = !inCode;
      const m = !inCode && /^(#{1,3}) (.+)$/.exec(line);
      if (m) headings.push({ level: m[1].length, text: strip(m[2]), id: slug(strip(m[2])) });
    }
    const title = file === "README.md" ? "Overview" : headings[0]?.text ?? file;
    return { file, title, md, headings };
  })
  .sort((a, b) => (ORDER.indexOf(a.file) + 1 || 99) - (ORDER.indexOf(b.file) + 1 || 99));

export class DocsView {
  root: HTMLElement;
  private nav = el("nav", { className: "docs-nav", ariaLabel: "Documentation pages" });
  private article = el("article", { className: "docs-page" });
  private search = el("input", { type: "search", placeholder: "Search headings and glossary…", ariaLabel: "Search help" });
  private results = el("div", { className: "docs-results" });
  current = pages[0]?.file ?? "README.md";

  constructor(root: HTMLElement) {
    this.root = root;
    this.search.addEventListener("input", () => this.renderResults());
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (this.results.querySelector("button") as HTMLButtonElement | null)?.click();
      if (e.key === "Escape") (this.search.value = ""), this.renderResults();
    });
    root.append(el("aside", { className: "sidebar docs-side" }, el("div", { className: "search" }, this.search), this.results, this.nav), el("div", { className: "docs-scroll" }, this.article));
    let start = this.current;
    try {
      start = localStorage.getItem("apricity.docs") ?? start;
    } catch {}
    this.open(pages.some((p) => p.file === start) ? start : this.current);
  }

  /** Show a page, optionally scrolled to a heading. */
  open(file: string, anchor?: string) {
    const page = pages.find((p) => p.file === file);
    if (!page) return;
    this.current = file;
    try {
      localStorage.setItem("apricity.docs", file);
    } catch {}
    this.article.innerHTML = marked.parse(page.md, { async: false }) as string;
    for (const h of this.article.querySelectorAll("h1, h2, h3, h4")) h.id = slug(h.textContent ?? "");
    for (const code of this.article.querySelectorAll("pre code.language-apr")) code.innerHTML = highlightApr(code.textContent ?? "");
    // ```breakdown <slug>``` embeds that breakdown (web/src/breakdowns/<slug>.json).
    for (const code of this.article.querySelectorAll("pre code.language-breakdown")) {
      const slug = (code.textContent ?? "").trim();
      const b = breakdown(slug);
      code.parentElement!.replaceWith(b ? new Breakdown(b, { variant: "card", open: (path) => (location.hash = routeFor(path, true)) }).root : el("p", { className: "hint" }, `No breakdown named “${slug}”.`));
    }
    for (const a of this.article.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const href = a.getAttribute("href")!;
      if (/^https?:/.test(href)) {
        a.target = "_blank";
        a.rel = "noopener";
        continue;
      }
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const [f, id] = href.split("#");
        this.open(f || this.current, id);
      });
    }
    this.renderNav();
    const scroller = this.article.parentElement!;
    if (anchor) {
      const target = this.article.querySelector(`#${CSS.escape(anchor)}`);
      target?.scrollIntoView({ block: "start" });
      target?.classList.add("flash");
      setTimeout(() => target?.classList.remove("flash"), 1200);
    } else {
      scroller.scrollTop = 0;
    }
  }

  private renderNav() {
    this.nav.replaceChildren(
      ...pages.flatMap((p) => {
        const link = el("button", { className: "row", type: "button" }, el("span", { className: "t" }, p.title));
        link.setAttribute("aria-current", String(p.file === this.current));
        link.addEventListener("click", () => this.open(p.file));
        if (p.file !== this.current || p.file === "glossary.md") return [link];
        // Contents of the open page: its sections.
        const toc = p.headings.filter((h) => h.level === 2).map((h) => {
          const b = el("button", { className: "toc", type: "button" }, h.text);
          b.addEventListener("click", () => this.open(p.file, h.id));
          return b;
        });
        return [link, ...toc];
      }),
    );
  }

  private renderResults() {
    const q = this.search.value.trim().toLowerCase();
    if (!q) return this.results.replaceChildren();
    const hits = pages.flatMap((p) => p.headings.filter((h) => h.level > 1 && h.text.toLowerCase().includes(q)).map((h) => ({ p, h })));
    this.results.replaceChildren(
      ...(hits.length
        ? hits.slice(0, 12).map(({ p, h }) => {
            const b = el("button", { className: "row", type: "button" }, el("span", { className: "t" }, h.text), el("span", { className: "sub" }, p.title));
            b.addEventListener("click", () => this.open(p.file, h.id));
            return b;
          })
        : [el("div", { className: "hint", style: "padding: 8px 12px" }, "No headings match.")]),
    );
  }
}
