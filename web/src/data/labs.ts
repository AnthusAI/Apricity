// Web data layer: labs (Kanbus apricitus-e59a0b) — a person's sit-down with a scene, grouping the listening cycles
// published while working it. Lab is "made"-style (allow.owner(), signed-in read, like Score/Crate): its `owner`
// field is the same "<sub>::<username>" the cloud writes for those (local: the library identity's sub), which is why
// `LabsDeps.owner` reads the *last* element of `me().owners` rather than reusing Cycles' bare-sub `judge`.

import { listAll } from "./catalog.js";
import type { CycleRecord } from "./cycles.js";

export interface LabRecord {
  id: string;
  title: string;
  brief?: string | null;
  sceneScoreId: string;
  status: "open" | "closed";
  owner?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface LabsDeps {
  client: () => any;
  /** The signed-in person's owner string, as Lab.owner stores it ("<sub>::<username>", or the local identity); null for a guest. */
  owner: () => Promise<string | null>;
}

function fail(errors: { message?: string }[]): never {
  throw new Error(errors.map((e) => e.message).join("; ") || "the server refused that");
}

/** A lab's cycles that are still open and have no verdict yet from `verdictCycleIds` (the ones the judge has saved). */
export function waitingCycles(cycles: Pick<CycleRecord, "id" | "status">[], verdictCycleIds: ReadonlySet<string>): Pick<CycleRecord, "id" | "status">[] {
  return cycles.filter((c) => c.status === "open" && !verdictCycleIds.has(c.id));
}

export class Labs {
  private cache: Promise<LabRecord[]> | null = null;
  private byId = new Map<string, Promise<LabRecord | null>>();
  private byLab = new Map<string, Promise<CycleRecord[]>>();
  constructor(private deps: LabsDeps) {}

  /** Forget what was loaded (after sign-in or sign-out). */
  reset() {
    this.cache = null;
    this.byId.clear();
    this.byLab.clear();
  }

  private get models() {
    return this.deps.client().models;
  }

  /** The signed-in person's labs, newest first; empty for a guest. */
  myLabs(): Promise<LabRecord[]> {
    this.cache ??= (async () => {
      const owner = await this.deps.owner();
      if (!owner) return [];
      const rows = await listAll<LabRecord>((nextToken) => this.models.Lab.labsByOwner({ owner }, { limit: 1000, nextToken }));
      return [...rows].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    })();
    this.cache.catch(() => (this.cache = null));
    return this.cache;
  }

  /** One lab by id; null if there is none (or it isn't visible to a guest). */
  lab(id: string): Promise<LabRecord | null> {
    let p = this.byId.get(id);
    if (!p) {
      p = (async () => {
        const r = await this.models.Lab.get({ id });
        if (r.errors?.length) fail(r.errors);
        return (r.data as LabRecord | null) ?? null;
      })();
      p.catch(() => this.byId.delete(id));
      this.byId.set(id, p);
    }
    return p;
  }

  /** A lab's cycles, newest first. */
  cyclesFor(labId: string): Promise<CycleRecord[]> {
    let p = this.byLab.get(labId);
    if (!p) {
      p = listAll<CycleRecord>((nextToken) => this.models.ListeningCycle.cyclesByLab({ labId }, { limit: 1000, nextToken })).then((cs) =>
        [...cs].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
      );
      p.catch(() => this.byLab.delete(labId));
      this.byLab.set(labId, p);
    }
    return p;
  }
}
