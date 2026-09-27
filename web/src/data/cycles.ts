// Web data layer: listening cycles (Kanbus apricitus-2101dd) — a blind round of a score's candidates that a
// signed-in person rates. ListeningCycle is public-ish (signed-in reads only, so options stay blind to guests);
// CycleVerdict is owner-only, keyed by cycleId+judge where `judge` must be the caller's Cognito `sub` (the schema's
// `allow.ownerDefinedIn("judge").identityClaim("sub")` — not the `sub::username` shape Rating.owner uses).

import { listAll } from "./catalog.js";

export interface FileRef {
  key: string;
  sha256?: string | null;
  size?: number | null;
  contentType?: string | null;
}

export interface CycleOption {
  letter: string;
  scoreId: string;
  audio: FileRef;
}

export interface CycleRecord {
  id: string;
  title: string;
  question?: string | null;
  incumbentScoreId: string;
  options: CycleOption[];
  status: "open" | "closed";
  closedAt?: string | null;
  owner?: string | null;
  createdAt?: string | null;
}

export interface CycleNote {
  letter: string;
  note: string;
}

export interface VerdictRecord {
  cycleId: string;
  judge: string;
  /** A letter ("A".."D"), or "same": can't tell the options apart. */
  best: string;
  notes?: CycleNote[] | null;
  note?: string | null;
  savedAt: string;
}

export interface CyclesDeps {
  client: () => any;
  /** Who is judging: the signed-in Cognito `sub` (local mode: the library identity's sub); null for a guest. */
  judge: () => Promise<string | null>;
  now?: () => Date;
}

function fail(errors: { message?: string }[]): never {
  throw new Error(errors.map((e) => e.message).join("; ") || "the server refused that");
}

// ------------------------------------------------------------------ pure helpers (no client needed)

/** The letter of the option that is the incumbent ("the current version"), if the cycle has one. */
export const incumbentLetter = (cycle: Pick<CycleRecord, "options" | "incumbentScoreId">): string | null =>
  cycle.options.find((o) => o.scoreId === cycle.incumbentScoreId)?.letter ?? null;

/** The cycle's letters, in order (A, B, C, D as published). */
export const lettersOf = (cycle: Pick<CycleRecord, "options">): string[] => [...cycle.options].map((o) => o.letter).sort();

/** Is `best` a real choice for this cycle: one of its letters, or "same" (can't tell them apart)? */
export const validBest = (cycle: Pick<CycleRecord, "options">, best: string): boolean => best === "same" || cycle.options.some((o) => o.letter === best);

/** Whether a reveal (titles, links) should show: once you've saved a verdict, or the cycle has closed. */
export const revealed = (cycle: Pick<CycleRecord, "status">, mine: VerdictRecord | null): boolean => cycle.status === "closed" || mine !== null;

/**
 * Build the CycleVerdict to save from the form's state: per-letter note text (blank ones dropped) and the overall
 * note (trimmed). Pure so it's unit-testable without a client.
 */
export function buildVerdict(cycleId: string, judge: string, best: string, notesByLetter: Record<string, string>, note: string, now: Date): VerdictRecord {
  const notes = Object.keys(notesByLetter)
    .sort()
    .map((letter) => ({ letter, note: notesByLetter[letter].trim() }))
    .filter((n) => n.note.length > 0);
  return { cycleId, judge, best, notes, note: note.trim(), savedAt: now.toISOString() };
}

/** The note text saved for a letter, or "" (for pre-filling the form from a saved verdict). */
export function noteFor(verdict: Pick<VerdictRecord, "notes"> | null, letter: string): string {
  return verdict?.notes?.find((n) => n.letter === letter)?.note ?? "";
}

// ------------------------------------------------------------------ the client-backed store

export class Cycles {
  private cache: Promise<CycleRecord[]> | null = null;
  private mine = new Map<string, Promise<VerdictRecord | null>>();
  constructor(private deps: CyclesDeps) {}

  /** Forget what was loaded (after sign-in or sign-out). */
  reset() {
    this.cache = null;
    this.mine.clear();
  }

  private get models() {
    return this.deps.client().models;
  }

  /** Every open cycle, newest first. */
  openCycles(): Promise<CycleRecord[]> {
    this.cache ??= listAll<CycleRecord>((nextToken) => this.models.ListeningCycle.list({ filter: { status: { eq: "open" } }, limit: 1000, nextToken })).then((cs) =>
      [...cs].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    );
    this.cache.catch(() => (this.cache = null));
    return this.cache;
  }

  /** One cycle (open or closed), by id; null if there is none. */
  async cycle(id: string): Promise<CycleRecord | null> {
    const r = await this.models.ListeningCycle.get({ id });
    if (r.errors?.length) fail(r.errors);
    return (r.data as CycleRecord | null) ?? null;
  }

  /** Your saved verdict on a cycle, or null (a guest, or you haven't saved one yet). Cached until `reset()`. */
  verdict(cycleId: string): Promise<VerdictRecord | null> {
    let p = this.mine.get(cycleId);
    if (!p) {
      p = (async () => {
        const judge = await this.deps.judge();
        if (!judge) return null;
        const r = await this.models.CycleVerdict.get({ cycleId, judge });
        if (r.errors?.length) fail(r.errors);
        return (r.data as VerdictRecord | null) ?? null;
      })();
      p.catch(() => this.mine.delete(cycleId));
      this.mine.set(cycleId, p);
    }
    return p;
  }

  /** Save (upsert) your verdict on a cycle: editable until it closes. */
  async saveVerdict(cycleId: string, best: string, notesByLetter: Record<string, string>, note: string): Promise<VerdictRecord> {
    const judge = await this.deps.judge();
    if (!judge) throw new Error("Sign in to save a verdict");
    const had = await this.verdict(cycleId);
    const rec = buildVerdict(cycleId, judge, best, notesByLetter, note, this.deps.now?.() ?? new Date());
    const r = had ? await this.models.CycleVerdict.update(rec) : await this.models.CycleVerdict.create(rec);
    if (r.errors?.length) fail(r.errors);
    this.mine.set(cycleId, Promise.resolve(rec));
    return rec;
  }
}
