// Tags on scores: short lowercase words its owner gives it ("techno", "deep-house"), each with a leaderboard at
// /tags/<tag>. They live on the Score record, not in the text (# starts a comment there). Pure (test/tags.test.ts).

export const MAX_TAGS = 8;
const MIN = 2;
const MAX = 24;

/** A tag as stored: lowercase letters, digits and single hyphens, 2–24 long; null when nothing is left. */
export function normalizeTag(raw: string): string | null {
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // é → e
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX)
    .replace(/-+$/, "");
  return t.length >= MIN ? t : null;
}

/**
 * Tags from what someone typed: "#Techno deep house, lounge" → techno, deep-house, lounge. Commas and #s separate tags;
 * without either, the words are one tag. Deduplicated, at most MAX_TAGS.
 */
export function parseTags(text: string): string[] {
  const parts = /[,#]/.test(text) ? text.split(/[,#]/) : [text];
  const out: string[] = [];
  for (const p of parts) {
    const t = normalizeTag(p);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_TAGS);
}

/** Add tags to a list (in order, no repeats, at most MAX_TAGS). */
export const withTags = (have: readonly string[], add: readonly string[]) => [...new Set([...have, ...add])].slice(0, MAX_TAGS);

/** How many scores use each tag, most used first (ties by name). */
export function tagCounts(scores: readonly { tags?: readonly (string | null)[] | null }[]): { tag: string; count: number }[] {
  const n = new Map<string, number>();
  for (const s of scores) for (const t of new Set(s.tags ?? [])) if (t) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
