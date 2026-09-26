// Where a sound came from and what its license asks: the "License and credits" panel on a sample (and its clips), and
// the "Credits" a score lists for every recording it plays. Curators can also write a recording's provenance down, or
// say a sample comes from another recording (single drum hits uploaded one by one, from a kit).

import { el } from "./dom";
import { citation, creditsOf, documented, LICENSES, licenseOf, type LicenseCode, type Provenance } from "../data/licenses";

/** Copy text, and say so on the button for a moment. */
function copyButton(label: string, text: () => string): HTMLButtonElement {
  const b = el("button", { type: "button", className: "btn" }, label) as HTMLButtonElement;
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text());
      b.textContent = "Copied ✓";
    } catch {
      b.textContent = "Couldn't copy";
    }
    setTimeout(() => (b.textContent = label), 1500);
  });
  return b;
}

const link = (href: string, text: string) => el("a", { href, target: "_blank", rel: "noopener" }, text);

/** What a license asks of whoever uses the sound. */
function asks(rec: Provenance): string[] {
  const l = licenseOf(rec);
  if (!l) return [];
  const out: string[] = [];
  out.push(l.credit === "required" ? "Credit required: use the citation below." : "No restrictions; credit is a courtesy.");
  if (l.shareAlike) out.push(`Share-alike: anything you make with it must be shared under ${l.name}.`);
  return out;
}

export interface EditDeps {
  recordings: () => Promise<Provenance[]>;
  update: (id: string, fields: Partial<Provenance>) => Promise<void>;
  relink: (recordingId: string) => Promise<void>;
  changed: () => void;
}

/** The "License and credits" panel for a sample's recording; `edit` (curators) adds the provenance editor. */
export function licensePanel(rec: Provenance | null, edit?: EditDeps): HTMLElement {
  const box = el("section", { className: "license" });
  const l = licenseOf(rec);
  const ok = documented(rec);
  const badge = ok && l ? (l.url ? el("a", { className: "lic-badge", href: l.url, target: "_blank", rel: "noopener" }, l.name) : el("span", { className: "lic-badge" }, l.name)) : el("span", { className: "lic-badge missing" }, "No license documented");
  box.append(el("h3", {}, "License and credits"), el("div", { className: "lic-head" }, badge, ...(ok ? [] : [el("span", { className: "hint" }, "Only curators see this sample until its provenance is written down.")])));
  if (rec && ok) {
    box.append(el("ul", { className: "lic-asks" }, ...asks(rec).map((a) => el("li", {}, a))));
    const text = citation(rec);
    box.append(el("blockquote", { className: "lic-cite" }, text), el("div", { className: "lic-actions" }, copyButton("Copy credit", () => text)));
  }
  if (rec) {
    const facts: [string, Node | string | null][] = [
      ["Recording", rec.title ?? null],
      ["Performer", rec.performer ?? null],
      ["Composed", rec.composed ? String(rec.composed) : null],
      ["Recorded", rec.recorded ?? null],
      ["From", rec.credit ?? null],
      ["Rights", rec.rights ?? null],
      ["Source", rec.sourcePage ? link(rec.sourcePage, rec.sourcePage.replace(/^https?:\/\//, "")) : null],
      ["File", rec.url ? link(rec.url, "original file") : null],
    ];
    box.append(el("dl", { className: "lic-facts" }, ...facts.filter(([, v]) => v).flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v as Node | string)])));
  }
  if (edit && rec) box.append(editor(rec, edit));
  return box;
}

/** A curator's form: the recording's license and credit, or "same recording as" another one. */
function editor(rec: Provenance, d: EditDeps): HTMLElement {
  const details = el("details", { className: "lic-edit" }, el("summary", {}, "Edit provenance (curators)"));
  const license = el("select", { name: "license" }) as HTMLSelectElement;
  license.append(el("option", { value: "" }, "— read from the rights text —"), ...Object.values(LICENSES).map((l) => el("option", { value: l.code }, l.name)));
  license.value = rec.license && rec.license in LICENSES ? rec.license : "";
  const field = (label: string, name: keyof Provenance, value: string | null | undefined, hint = "") =>
    el("label", {}, el("span", {}, label), el("input", { name, value: value ?? "", placeholder: hint }));
  const err = el("span", { className: "cmt-err", role: "alert" });
  const save = el("button", { type: "button", className: "btn primary" }, "Save provenance");
  const form = el(
    "div",
    { className: "lic-form" },
    el("label", {}, el("span", {}, "License"), license),
    field("Credit names", "author", rec.author, "e.g. Alexander Holm"),
    field("Source page", "sourcePage", rec.sourcePage, "https://…"),
    field("Rights note", "rights", rec.rights),
    field("Credit line (optional; replaces the generated one)", "attribution", rec.attribution),
    el("div", { className: "cmt-actions" }, save, err),
  );
  save.addEventListener("click", async () => {
    save.disabled = true;
    err.textContent = "";
    const val = (n: string) => ((form.querySelector(`[name="${n}"]`) as HTMLInputElement).value.trim() || null);
    try {
      await d.update(rec.id!, { license: (license.value || null) as LicenseCode | null, author: val("author"), sourcePage: val("sourcePage"), rights: val("rights"), attribution: val("attribution") });
      d.changed();
    } catch (e) {
      err.textContent = (e as Error).message;
      save.disabled = false;
    }
  });

  // Or: this sample is part of another recording (whose provenance is already written down).
  const same = el("select", { ariaLabel: "Same recording as" }) as HTMLSelectElement;
  const relink = el("button", { type: "button", className: "btn" }, "Link");
  void d.recordings().then((list) => {
    same.append(el("option", { value: "" }, "Same recording as…"), ...list.filter((r) => r.id !== rec.id && documented(r)).map((r) => el("option", { value: r.id! }, r.title ?? r.id!)));
  });
  relink.addEventListener("click", async () => {
    if (!same.value) return;
    relink.disabled = true;
    try {
      await d.relink(same.value);
      d.changed();
    } catch (e) {
      err.textContent = (e as Error).message;
      relink.disabled = false;
    }
  });
  details.append(form, el("p", { className: "hint" }, "Or, if this sample was cut from a recording that's already documented (a single hit from a kit):"), el("div", { className: "cmt-actions" }, same, relink));
  return details;
}

/** A score's credits: one citation per recording it plays, and the share-alike notice when any asks for it. */
export function scoreCredits(recs: Provenance[], curator: boolean, based: string | null = null): HTMLElement {
  const c = creditsOf(recs);
  const lines = c.lines.filter((l) => l.documented || curator);
  const all = () => [...(based ? [based] : []), ...lines.filter((l) => l.documented).map((l) => l.text), ...(c.shareAlike ? [`This work is shared under ${c.shareAlike.name} (${c.shareAlike.url}).`] : [])].join("\n");
  return el(
    "section",
    { className: "credits" },
    el("h3", {}, "Credits"),
    ...(based ? [el("p", { className: "lic-based" }, based)] : []),
    ...(c.shareAlike ? [el("p", { className: "lic-sa" }, `Share-alike: this uses sounds under ${c.shareAlike.name}, so what you make with it must be shared under ${c.shareAlike.name} too.`)] : []),
    el("ol", { className: "credit-list" }, ...lines.map((l) => el("li", { className: l.documented ? "" : "missing" }, l.documented ? l.text : `${l.title}: no license documented (only curators see this).`))),
    ...(lines.some((l) => l.documented) ? [el("div", { className: "lic-actions" }, copyButton("Copy credits", all))] : []),
  );
}
