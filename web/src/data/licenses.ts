// Every sound in Apricity is cleared: public domain or openly licensed, with where it came from written down. This is
// what each license asks, how a recording's license is known (its own `license` field, or read from its rights text
// the way scripts/breakdown.py reads it), and the credit line its license asks for. Pure: tested in
// test/licenses.test.ts.

export type LicenseCode = "public-domain" | "us-gov" | "loc-free" | "cc0-1.0" | "cc-by-3.0" | "cc-by-4.0" | "cc-by-sa-3.0" | "cc-by-sa-4.0";

export interface License {
  code: LicenseCode;
  name: string;
  url?: string;
  /** Must the work be credited (CC BY and BY-SA), or is credit a courtesy? */
  credit: "required" | "courtesy";
  /** Must what you make with it be shared under the same license? */
  shareAlike: boolean;
}

export const LICENSES: Record<LicenseCode, License> = {
  "public-domain": { code: "public-domain", name: "Public domain", credit: "courtesy", shareAlike: false },
  "us-gov": { code: "us-gov", name: "U.S. Government work (public domain)", url: "https://www.usa.gov/government-copyright", credit: "courtesy", shareAlike: false },
  "loc-free": { code: "loc-free", name: "Free to use and reuse (Library of Congress)", url: "https://www.loc.gov/free-to-use/", credit: "courtesy", shareAlike: false },
  "cc0-1.0": { code: "cc0-1.0", name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", credit: "courtesy", shareAlike: false },
  "cc-by-3.0": { code: "cc-by-3.0", name: "CC BY 3.0", url: "https://creativecommons.org/licenses/by/3.0/", credit: "required", shareAlike: false },
  "cc-by-4.0": { code: "cc-by-4.0", name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", credit: "required", shareAlike: false },
  "cc-by-sa-3.0": { code: "cc-by-sa-3.0", name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/", credit: "required", shareAlike: true },
  "cc-by-sa-4.0": { code: "cc-by-sa-4.0", name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/", credit: "required", shareAlike: true },
};

/** What a recording says about itself (the Recording record's fields). */
export interface Provenance {
  id?: string;
  title?: string | null;
  collection?: string | null;
  performer?: string | null;
  composed?: number | null;
  recorded?: string | null;
  credit?: string | null;
  rights?: string | null;
  sourcePage?: string | null;
  url?: string | null;
  license?: string | null;
  licenseUrl?: string | null;
  author?: string | null;
  attribution?: string | null;
}

/** A recording's license: its own `license` field, else read from its rights text. Null: not documented. */
export function licenseOf(rec: Provenance | null | undefined): License | null {
  if (!rec) return null;
  if (rec.license && rec.license in LICENSES) return LICENSES[rec.license as LicenseCode];
  const r = (rec.rights ?? "").toLowerCase();
  if (!r.trim()) return null;
  const cc = /cc[ -](by(?:-sa)?)[ -]?(\d\.\d)/.exec(r);
  if (cc) return LICENSES[`cc-${cc[1]}-${cc[2]}` as LicenseCode] ?? null;
  if (/\bcc0\b/.test(r)) return LICENSES["cc0-1.0"];
  if (/work of the u\.?s\.? government/.test(r)) return LICENSES["us-gov"];
  if (/public domain/.test(r)) return LICENSES["public-domain"];
  if (/free to use and reuse/.test(r)) return LICENSES["loc-free"];
  return null;
}

/** Who a required credit names: `author`, else the credit line up to its first comma ("Alexander Holm"). */
export function authorOf(rec: Provenance): string | null {
  if (rec.author?.trim()) return rec.author.trim();
  const fromRights = /cc[ -]by(?:-sa)? ?[\d.]*,\s*([^;.]+)/i.exec(rec.rights ?? "")?.[1]?.trim();
  return fromRights || rec.credit?.split(",")[0]?.trim() || null;
}

/** Documented: a license is known and, when it asks for credit, there is someone to credit. */
export function documented(rec: Provenance | null | undefined): boolean {
  const l = licenseOf(rec);
  return !!l && (l.credit === "courtesy" || !!authorOf(rec!));
}

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/**
 * The credit line for a recording (title, author, source, license, as Creative Commons asks), or its `attribution`
 * when a curator wrote one. Licenses that ask for credit also say what Apricity changed.
 */
export function citation(rec: Provenance): string {
  if (rec.attribution?.trim()) return rec.attribution.trim();
  const l = licenseOf(rec);
  const title = `“${rec.title ?? "Untitled"}”`;
  const source = rec.sourcePage ?? rec.url;
  const licenseUrl = rec.licenseUrl ?? l?.url;
  if (l?.credit === "required") {
    const by = authorOf(rec);
    return `${title}${by ? ` by ${by}` : ""}${source ? ` (${bare(source)})` : ""}, ${l.name}${licenseUrl ? ` (${bare(licenseUrl)})` : ""}. Sliced, time-stretched and re-pitched in Apricity.`;
  }
  const facts = [
    rec.composed ? `composed ${rec.composed}` : null,
    rec.recorded ? `recorded ${rec.recorded}${rec.performer ? ` by ${rec.performer}` : ""}` : rec.performer ? `by ${rec.performer}` : null,
  ].filter(Boolean);
  const credit = rec.credit?.trim().replace(/\.$/, "");
  return `${title}${facts.length ? `, ${facts.join(", ")}` : ""}.${credit ? ` ${credit}.` : ""}${l ? ` ${l.name}.` : ""}${source ? ` ${bare(source)}` : ""}`.trim();
}

export interface Credits {
  lines: { id?: string; title: string; text: string; documented: boolean; license: License | null }[];
  /** The share-alike license anything made with these must be shared under, if any asks. */
  shareAlike: License | null;
}

/** The credits for a set of recordings: one line each (in the order given, once each), and any share-alike notice. */
export function creditsOf(recs: Provenance[]): Credits {
  const seen = new Set<string>();
  const lines: Credits["lines"] = [];
  let shareAlike: License | null = null;
  for (const r of recs) {
    const key = r.id ?? r.title ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    const license = licenseOf(r);
    if (license?.shareAlike && !shareAlike) shareAlike = license;
    lines.push({ id: r.id, title: r.title ?? "Untitled", text: citation(r), documented: documented(r), license });
  }
  return { lines, shareAlike };
}
