// Public handles (`@ryan`): the name people see on scores and clips instead of an account id. A handle is a Handle
// record whose id is the handle, so the first create wins; its owner is stamped by AppSync. The whole list is small and
// public, so it is read once and cached (forgotten when this person claims a new handle).

import { client } from "./client.js";

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
const SHAPE = /^[a-z][a-z0-9_-]*$/;
const RESERVED = new Set([
  "admin", "admins", "apricity", "curator", "curators", "examples", "guest", "help", "local", "me", "member", "members",
  "mod", "moderator", "root", "someone", "support", "system", "you", "yours",
]);

/** The handle as stored: trimmed, without a leading `@`, lowercase. */
export const normalizeHandle = (h: string) => h.trim().replace(/^@/, "").toLowerCase();

/** Why a handle can't be used, or null when it can (availability is checked separately). */
export function handleProblem(raw: string): string | null {
  const h = normalizeHandle(raw);
  if (h.length < HANDLE_MIN) return `At least ${HANDLE_MIN} characters.`;
  if (h.length > HANDLE_MAX) return `At most ${HANDLE_MAX} characters.`;
  if (!SHAPE.test(h)) return "Start with a letter; then letters, digits, - or _.";
  if (RESERVED.has(h)) return "That one is reserved.";
  return null;
}

/** A first guess from an email address: its local part, cleaned up to a valid handle (or "" when nothing fits). */
export function suggestHandle(email: string | null | undefined): string {
  let h = normalizeHandle((email ?? "").split("@")[0] ?? "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, HANDLE_MAX);
  if (h && h.length < HANDLE_MIN) h = h.padEnd(HANDLE_MIN, "0");
  return handleProblem(h) ? "" : h;
}

export interface HandleRow {
  id: string;
  owner?: string | null;
  createdAt?: string | null;
}

/**
 * Owner → handle. An owner is stored either as the Cognito username or as `sub::username`; both forms (and each half)
 * find the handle. When one person briefly has two (mid-change), the newest wins.
 */
export class Handles {
  private byOwner = new Map<string, HandleRow[]>(); // newest first

  constructor(rows: HandleRow[]) {
    const newest = [...rows].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    for (const r of newest) {
      if (!r.owner) continue;
      for (const k of new Set([r.owner, ...r.owner.split("::")])) this.byOwner.set(k, [...(this.byOwner.get(k) ?? []), r]);
    }
  }

  /** The handle of an owner value, without the `@`. */
  of(owner: string | null | undefined): string | undefined {
    if (!owner) return undefined;
    for (const k of [owner, ...owner.split("::")]) {
      const r = this.byOwner.get(k)?.[0];
      if (r) return r.id;
    }
    return undefined;
  }

  /** The first handle among a person's owner values (see `Me.owners`). */
  mine(owners: string[]): string | undefined {
    for (const o of owners) {
      const h = this.of(o);
      if (h) return h;
    }
    return undefined;
  }

  /** Every handle row one person has (all owner forms). */
  rowsOf(owners: string[]): HandleRow[] {
    const out = new Map<string, HandleRow>();
    for (const o of owners) for (const k of [o, ...o.split("::")]) for (const r of this.byOwner.get(k) ?? []) out.set(r.id, r);
    return [...out.values()];
  }
}

/** Who made something, as a list shows it: "yours", "by @ryan", or "" when nobody has a handle for it. */
export function byline(names: Handles | null, owner: string | null | undefined, mine: boolean): string {
  if (mine) return "yours";
  const h = names?.of(owner);
  return h ? `by @${h}` : "";
}

let cached: Promise<Handles> | null = null;

/** Every handle (cached). Never throws: without handles, names just fall back. */
export function handles(): Promise<Handles> {
  cached ??= (async () => {
    const rows: HandleRow[] = [];
    try {
      let nextToken: string | null | undefined;
      do {
        const r = await client().models.Handle.list({ limit: 1000, nextToken });
        rows.push(...((r.data ?? []) as HandleRow[]));
        nextToken = r.nextToken;
      } while (nextToken);
    } catch {
      /* no handles to show */
    }
    return new Handles(rows);
  })();
  return cached;
}

export function forgetHandles(): void {
  cached = null;
}

/** Whether nobody has the handle yet. */
export async function handleFree(raw: string): Promise<boolean> {
  const r = await client().models.Handle.get({ id: normalizeHandle(raw) });
  return !r.data;
}

/**
 * Take a handle for the signed-in person, then drop their older ones. A taken handle fails the create (the id exists),
 * which comes back as "taken" rather than an error.
 */
export async function claimHandle(raw: string, owners: string[]): Promise<{ ok: true; handle: string } | { ok: false; why: string }> {
  const h = normalizeHandle(raw);
  const problem = handleProblem(h);
  if (problem) return { ok: false, why: problem };
  const before = (await handles()).rowsOf(owners);
  if (before.some((r) => r.id === h)) return { ok: true, handle: h };
  const r = await client().models.Handle.create({ id: h });
  if (r.errors?.length) {
    const taken = r.errors.some((e: { errorType?: string; message?: string }) => /ConditionalCheckFailed/i.test(`${e.errorType} ${e.message}`));
    return { ok: false, why: taken ? `@${h} is taken.` : r.errors[0].message ?? "Couldn't save the handle." };
  }
  for (const old of before) await client().models.Handle.delete({ id: old.id }).catch(() => undefined);
  forgetHandles();
  if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("apricity:handles-changed"));
  return { ok: true, handle: h };
}
