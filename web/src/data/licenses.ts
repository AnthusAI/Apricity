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

export type CombinedKind = "undetermined" | "share-alike" | "attribution" | "free";

export interface Combined {
  kind: CombinedKind;
  /** The license the music must carry: set for share-alike only. */
  license: License | null;
  title: string;
  summary: string;
  reasons: { title: string; license: License | null; why: string }[];
  /** Titles of recordings with no documented license (kind "undetermined"). */
  undocumented: string[];
}

const versionOf = (l: License) => parseFloat(l.code.split("-").pop() ?? "0") || 0;

/**
 * The license the finished music must carry, worked out from its recordings' licenses (each counted once):
 * undocumented sound => undetermined; else any share-alike => the highest share-alike version present; else any
 * CC BY => credit required; else free (public domain, U.S. Government, LoC free-to-use, CC0).
 */
export function combinedLicense(recs: Provenance[]): Combined {
  const seen = new Set<string>();
  const items: { title: string; license: License | null; ok: boolean }[] = [];
  for (const r of recs) {
    const key = r.id ?? r.title ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ title: r.title ?? "Untitled", license: licenseOf(r), ok: documented(r) });
  }
  const bad = items.filter((i) => !i.ok || !i.license);
  if (bad.length) {
    return {
      kind: "undetermined",
      license: null,
      title: "Undetermined",
      summary: "The license can't be computed until every sound has a documented license.",
      reasons: bad.map((i) => ({ title: i.title, license: i.license, why: "has no documented license" })),
      undocumented: bad.map((i) => i.title),
    };
  }
  const sa = items.filter((i) => i.license!.shareAlike);
  if (sa.length) {
    const top = sa.map((i) => i.license!).reduce((a, b) => (versionOf(b) > versionOf(a) ? b : a));
    return {
      kind: "share-alike",
      license: top,
      title: top.name,
      summary: `Share-alike: anything made with these sounds must be shared under ${top.name} or a later version.`,
      reasons: sa.map((i) => ({ title: i.title, license: i.license, why: `is ${i.license!.name}, a share-alike license` })),
      undocumented: [],
    };
  }
  const by = items.filter((i) => i.license!.credit === "required");
  if (by.length) {
    return {
      kind: "attribution",
      license: null,
      title: "Credit required (CC BY)",
      summary: "The music must credit these sounds, as the credit lines do. No other condition.",
      reasons: by.map((i) => ({ title: i.title, license: i.license, why: `is ${i.license!.name}, which requires credit` })),
      undocumented: [],
    };
  }
  return {
    kind: "free",
    license: null,
    title: "No conditions",
    summary: items.length ? "Every sound is public domain or free to use, so the music carries no conditions; credit is a courtesy." : "No sounds are used yet, so there are no conditions.",
    reasons: [],
    undocumented: [],
  };
}

export const NOT_LEGAL_ADVICE = "This covers the sounds' licenses only and is not legal advice.";

const quoted = (titles: string[]) => titles.map((t) => `"${t}"`).join(", ");

/** The plain-language explanation of a computed license, for the credits panel and the copyable credits. */
export function explainCombined(c: Combined, count: number): string {
  const head = `Computed from the licenses of the ${count} ${count === 1 ? "sound" : "sounds"} this score uses.`;
  const names = quoted(c.reasons.map((r) => r.title));
  switch (c.kind) {
    case "share-alike": {
      const l = c.license!;
      const why = c.reasons.length === 1 ? `${names} is ${c.reasons[0].license!.name}` : `${names} are share-alike (${[...new Set(c.reasons.map((r) => r.license!.name))].join(", ")})`;
      return `${head} Share-alike: ${why}, so anything made with ${c.reasons.length === 1 ? "it" : "them"} must be shared under ${l.name} or a later version.`;
    }
    case "attribution":
      return `${head} Credit required (CC BY): ${names} ${c.reasons.length === 1 ? "is" : "are"} CC BY, so the music must credit ${c.reasons.length === 1 ? "it" : "them"}. No other condition.`;
    case "free":
      return `${head} No conditions: ${count ? "every sound is public domain or free to use; credit is a courtesy" : "no sounds are used yet"}.`;
    default:
      return `${head} Undetermined: no license is documented for ${names}, so the license can't be computed.`;
  }
}

export interface Credits {
  lines: { id?: string; title: string; text: string; documented: boolean; license: License | null }[];
  /** The share-alike license anything made with these must be shared under, if any asks. */
  shareAlike: License | null;
  /** The license the finished music must carry, computed from every recording. */
  combined: Combined;
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
  return { lines, shareAlike, combined: combinedLicense(recs) };
}

/**
 * A fork's first credit: the score it was forked from, and the original when that's another score.
 * `Based on “beat-1b” by @bo, after “beat-1” by @ann.`
 */
export function basedOn(parent?: { id: string; title: string; by: string } | null, root?: { id: string; title: string; by: string } | null): string | null {
  if (!parent) return null;
  const after = root && root.id !== parent.id ? `, after “${root.title}” by ${root.by}` : "";
  return `Based on “${parent.title}” by ${parent.by}${after}.`;
}
