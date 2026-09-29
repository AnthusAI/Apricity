// A section's items (Scores, Beats, Chords, Melodies, Clips, Samples), each with the text search matches and the row a
// card is drawn from. The top bar's search reads every section; a section's page reads its own. Every item of the kind
// is here, not only those with news on the home page (the Clips section is mostly clips analysis found).

import type { ClipItem, ScoreItem, ScoreKind } from "./catalog";
import type { SampleSummary } from "../apricity";
import type { RankedRow } from "./ranked";
import type { HomeKind } from "./home-feed";
import type { DayTally, Standing } from "./rank-window";
import type { Handles } from "./handles";

export type Section = "scores" | "beats" | "chords" | "melodies" | "clips" | "samples";
export const SECTIONS: Section[] = ["scores", "beats", "chords", "melodies", "clips", "samples"];
export const SECTION_LABEL: Record<Section, string> = { scores: "Scores", beats: "Beats", chords: "Chords", melodies: "Melodies", clips: "Clips", samples: "Samples" };
export const KIND_OF_SECTION: Partial<Record<Section, ScoreKind>> = { scores: "song", beats: "beat", chords: "chords", melodies: "melody" };

export interface Entry {
  id: string;
  createdAt: string | null;
  owner: string | null;
  /** What search matches: its title, #tags, the @handle of who made it, and (a sample) its key and tempo. */
  text: string;
  /** The row its card is drawn from (stars filled in by `rowOf`). */
  base: Omit<RankedRow, "stars" | "ratings" | "sort" | "list" | "id">;
  score?: ScoreItem;
  clip?: ClipItem;
  sample?: SampleSummary;
}

const at = (iso: string | null | undefined, secs = 0) => iso || new Date(secs * 1000).toISOString();
const who = (names: Handles | null, owner: string | null | undefined) => {
  const h = names?.of(owner);
  return h ? `@${h}` : "";
};

export function scoreEntry(s: ScoreItem, names: Handles | null): Entry {
  return {
    id: s.id,
    createdAt: s.createdAt,
    owner: s.owner,
    text: [s.title, ...s.tags.map((t) => `#${t}`), who(names, s.owner)].join(" "),
    base: { targetType: "score", targetId: s.id, kind: s.kind as HomeKind, title: s.title, owner: s.owner, path: s.path, tags: s.tags, lastAt: at(s.createdAt, s.modified) },
    score: s,
  };
}

export function clipEntry(c: ClipItem, names: Handles | null): Entry {
  return {
    id: c.id,
    createdAt: c.createdAt,
    owner: c.owner,
    text: [c.name, c.sampleTitle, c.samplePath, c.kind ?? "", who(names, c.owner)].join(" "),
    base: { targetType: "clip", targetId: c.id, kind: "clip", title: c.name, owner: c.owner, path: c.samplePath, samplePath: c.samplePath, clipStart: c.start, clipEnd: c.end, tags: [], lastAt: at(c.createdAt), from: c.sampleTitle },
    clip: c,
  };
}

export function sampleEntry(s: SampleSummary): Entry {
  return {
    id: s.id,
    createdAt: s.createdAt ?? null,
    owner: null,
    text: [s.title, s.group, s.key, s.camelot ?? "", s.bpm ? `${Math.round(s.bpm)} bpm` : "", s.credit ?? ""].join(" "),
    base: { targetType: "sample", targetId: s.id, kind: "sample", title: s.title, owner: null, path: s.path.startsWith("samples/") ? s.path : `samples/${s.path}`, tags: [], lastAt: at(s.createdAt) },
    sample: s,
  };
}

/** The card row of an entry, with its stars in the window it's ranked in. */
export function rowOf(e: Entry, standing: Standing): RankedRow {
  return { ...e.base, id: e.id, list: "", sort: "", stars: standing.average, ratings: standing.count };
}

/** Whether an entry matches a search: every word of it appears (any case; "#techno" and "techno" both find the tag). */
export function matches(e: Pick<Entry, "text">, q: string): boolean {
  const text = e.text.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w) || (w.startsWith("#") && text.includes(w.slice(1))));
}

/** Every item of a section (hidden ones left out for readers who aren't curators), and its tally rows. */
export async function load(section: Section): Promise<{ entries: Entry[]; tallies: () => Promise<DayTally[]> }> {
  const [{ api, ratings }, { handles }] = await Promise.all([import("../apricity"), import("./handles")]);
  const names = await handles();
  const kind = KIND_OF_SECTION[section];
  if (kind) {
    const { scores } = await api.scores();
    return { entries: scores.filter((s) => s.kind === kind).map((s) => scoreEntry(s, names)), tallies: async () => (await ratings()).tallies("score") };
  }
  if (section === "clips") return { entries: (await api.clips()).map((c) => clipEntry(c, names)), tallies: async () => (await ratings()).tallies("clip") };
  return { entries: (await api.samples()).samples.map(sampleEntry), tallies: async () => (await ratings()).tallies("sample") };
}
