// Every breakdown bundle in this folder, baked from a score by scripts/breakdown.py. Adding a bundle
// is all it takes to show it: the landing gallery lists them, and docs pages embed one by name
// (a ```breakdown <slug>``` block).

import type { FlowData } from "../ui/flow/model";

const bundles = import.meta.glob("./*.json", { eager: true, import: "default" }) as Record<string, FlowData>;

/** The landing hero's own breakdown; the gallery shows the rest. */
export const HERO = "hero";

export const breakdowns: FlowData[] = Object.entries(bundles)
  .map(([file, d]) => ({ ...d, slug: d.slug ?? file.slice(2, -".json".length) }))
  .sort((a, b) => (a.title ?? a.slug!).localeCompare(b.title ?? b.slug!));

export const breakdown = (slug: string) => breakdowns.find((b) => b.slug === slug);
