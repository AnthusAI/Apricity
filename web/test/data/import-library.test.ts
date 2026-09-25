import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import contract from "../../../contract/apricity.contract.json" with { type: "json" };
import { importOrder, importLibraryFromBucket, listModelKeys, toApiInput, ImportNotAllowedError, type ImportDeps, type StorageApi } from "../../src/data/import-library.ts";

const FIX = join(import.meta.dirname, "..", "fixtures", "library");
const fixtures = (model: string) =>
  readdirSync(join(FIX, model)).map((f) => ({ key: `${model}/${f}`, rec: JSON.parse(readFileSync(join(FIX, model, f), "utf8")) as Record<string, any> }));
const models = Object.keys((contract as any).models);
const me = { sub: "sub-1", username: "user-1", email: "a@b.c", groups: ["admins", "curators"], admin: true };

/** In-memory bucket: every fixture under its key; `pageSize` forces pagination. */
function bucket(pageSize = 2, over: Record<string, string> = {}) {
  const files: Record<string, string> = {};
  for (const m of models) for (const f of fixtures(m)) files[f.key] = JSON.stringify(f.rec);
  Object.assign(files, over);
  const listCalls: string[] = [];
  const storage: StorageApi = {
    async list({ path, options }) {
      listCalls.push(`${path}@${options?.nextToken ?? ""}`);
      const all = Object.keys(files).filter((k) => k.startsWith(path)).sort();
      const start = Number(options?.nextToken ?? 0);
      const items = all.slice(start, start + pageSize).map((p) => ({ path: p }));
      return { items, nextToken: start + pageSize < all.length ? String(start + pageSize) : undefined };
    },
    downloadData: ({ path }) => ({
      result: files[path] === undefined ? Promise.reject(new Error("NoSuchKey")) : Promise.resolve({ body: { text: async () => files[path] } }),
    }),
  };
  return { storage, files, listCalls };
}

/** Fake data client: tables keyed by primary key; records the order of writes. */
function fakeClient(opts: { rejectTimestamps?: boolean; failIds?: string[] } = {}) {
  const tables: Record<string, Map<string, any>> = {};
  const writes: Array<{ op: string; model: string; input: any }> = [];
  const keyOf = (model: string, i: any) => (contract as any).models[model].primaryKey.map((k: string) => i[k]).join("|");
  const models_: any = {};
  for (const m of models) {
    const t = (tables[m] = new Map());
    models_[m] = {
      get: async (k: any) => ({ data: t.get(keyOf(m, k)) ?? null }),
      create: async (i: any) => {
        if (opts.failIds?.includes(i.id)) return { errors: [{ message: "Unauthorized" }] };
        // The real API's create input has no createdAt/updatedAt, and its message does not name the field.
        if (i.createdAt || i.updatedAt) return { errors: [{ message: `The variables input contains a field that is not defined for input object type 'Create${m}Input'` }] };
        writes.push({ op: "create", model: m, input: i });
        t.set(keyOf(m, i), i);
        return { data: i };
      },
      update: async (i: any) => {
        writes.push({ op: "update", model: m, input: i });
        t.set(keyOf(m, i), { ...t.get(keyOf(m, i)), ...i });
        return { data: i };
      },
    };
  }
  return { client: { models: models_ }, tables, writes };
}

const deps = (b: ReturnType<typeof bucket>, c: ReturnType<typeof fakeClient>, extra: Partial<ImportDeps> = {}): ImportDeps => ({
  storage: b.storage,
  client: c.client,
  account: async () => me,
  concurrency: 3,
  ...extra,
});

describe("import order", () => {
  it("puts every parent before its children, from the contract", () => {
    const order = importOrder();
    assert.deepEqual([...order].sort(), [...models].sort());
    for (const [m, def] of Object.entries<any>((contract as any).models))
      for (const r of def.relationships.filter((r: any) => r.kind === "belongsTo"))
        assert.ok(order.indexOf(r.target) < order.indexOf(m), `${r.target} before ${m}`);
  });
  it("rejects a relationship cycle", () => {
    const c: any = { models: { A: { relationships: [{ kind: "belongsTo", target: "B" }] }, B: { relationships: [{ kind: "belongsTo", target: "A" }] } } };
    assert.throws(() => importOrder(c), /cycle/);
  });
});

describe("type conversion (real records)", () => {
  for (const m of models) {
    it(`${m}: every fixture converts and matches the contract`, () => {
      const def = (contract as any).models[m];
      for (const { rec } of fixtures(m)) {
        const out = toApiInput(m, rec, me);
        assert.ok(!("__typename" in out));
        for (const [k, f] of Object.entries<any>(def.fields)) {
          if (f.kind === "model") assert.ok(!(k in out));
          else if (f.isRequired) assert.ok(k in out, `${m}.${k} present`);
        }
        for (const k of Object.keys(out)) assert.ok(k in def.fields, `${m}.${k} is a contract field`);
        assert.ok(!JSON.stringify(out).includes("local::migrator"), "migrator identity replaced");
      }
    });
  }
  it("AWSJSON becomes a string, also nested in custom types", () => {
    const cand = toApiInput("Candidate", fixtures("Candidate")[0].rec, me);
    const p = (cand.proposers as any[])[0];
    assert.equal(typeof p.evidence, "string");
    assert.equal(p.evidence, "{}");
    const clip = toApiInput("Clip", fixtures("Clip")[0].rec, me);
    assert.equal(typeof clip.nameCounters, "string", "an already-string a.json is kept, not double-encoded");
    assert.doesNotThrow(() => JSON.parse(clip.nameCounters as string));
    assert.equal(toApiInput("Slice", { ...fixtures("Slice")[0].rec, evidence: { a: 1 } }, me).evidence, '{"a":1}');
  });
  it("keeps arrays and enums, swaps local owner and judge for the importer", () => {
    const clip = toApiInput("Clip", fixtures("Clip")[0].rec, me);
    assert.ok(Array.isArray(clip.aliases) && clip.role);
    assert.equal(toApiInput("Marker", fixtures("Marker")[0].rec, me).owner, "user-1", "cognito:username claim");
    assert.equal(toApiInput("Verdict", fixtures("Verdict")[0].rec, me).judge, "sub-1", "sub claim");
    assert.equal(toApiInput("Marker", { ...fixtures("Marker")[0].rec, owner: "someone" }, me).owner, "someone", "real owners are kept");
  });
  it("null and missing optionals are omitted", () => {
    const out = toApiInput("Recording", { ...fixtures("Recording")[0].rec, performer: null }, me);
    assert.ok(!("performer" in out));
  });
  it("rejects bad enums, types and missing required fields", () => {
    const s = fixtures("Slice")[0].rec;
    assert.throws(() => toApiInput("Slice", { ...s, kind: "banana" }, me), /not a Kind/);
    assert.throws(() => toApiInput("Slice", { ...s, start: "1" }, me), /must be a number/);
    assert.throws(() => toApiInput("Slice", { ...s, name: undefined }, me), /name is required/);
    assert.throws(() => toApiInput("Clip", { ...fixtures("Clip")[0].rec, audio: undefined }, me), /audio is required/);
  });
});

describe("listing", () => {
  it("follows nextToken until the last page and keeps only .json keys", async () => {
    const b = bucket(1, { "Recording/": "", "Recording/notes.txt": "x" });
    const keys = await listModelKeys(b.storage, "Recording");
    assert.deepEqual(keys, fixtures("Recording").map((f) => f.key).sort());
    assert.ok(b.listCalls.length >= 3, "several pages");
    assert.ok(b.listCalls.every((c) => c.startsWith("Recording/")), "root-level prefix, not files/");
  });
});

describe("importLibraryFromBucket", () => {
  it("requires a signed-in admin (and curators, which writes need)", async () => {
    const b = bucket();
    const c = fakeClient();
    for (const [acct, msg] of [
      [null, /Sign in/],
      [{ ...me, groups: ["members"], admin: false }, /admins/],
      [{ ...me, groups: ["admins"] }, /curators/],
    ] as const) {
      await assert.rejects(importLibraryFromBucket({}, deps(b, c, { account: async () => acct as any })), (e: Error) => e instanceof ImportNotAllowedError && msg.test(e.message));
    }
    assert.equal(c.writes.length, 0);
    assert.equal(b.listCalls.length, 0, "nothing is read before the gate");
  });

  it("imports every model in dependency order and reports progress", async () => {
    const b = bucket();
    const c = fakeClient();
    const seen: string[] = [];
    const s = await importLibraryFromBucket({ onProgress: (p) => p.phase === "importing" && p.model && seen.push(p.model) }, deps(b, c));
    const total = models.reduce((n, m) => n + fixtures(m).length, 0);
    assert.equal(s.created, total);
    assert.equal(s.updated, 0);
    assert.deepEqual(s.failed, []);
    const order = importOrder();
    const firstWrite = (m: string) => c.writes.findIndex((w) => w.model === m);
    const lastWrite = (m: string) => c.writes.map((w) => w.model).lastIndexOf(m);
    for (const m of models) for (const r of (contract as any).models[m].relationships.filter((r: any) => r.kind === "belongsTo"))
      assert.ok(lastWrite(r.target) < firstWrite(m), `${r.target} fully written before ${m}`);
    assert.deepEqual([...new Set(seen)], order);
    assert.ok(c.writes.filter((w) => w.op === "create").every((w) => !("createdAt" in w.input) && !("updatedAt" in w.input)), "timestamps are never sent on create (AppSync sets them)");
  });

  it("is idempotent: a second run updates and creates nothing new", async () => {
    const b = bucket();
    const c = fakeClient();
    await importLibraryFromBucket({}, deps(b, c));
    const rows = models.map((m) => c.tables[m].size);
    const again = await importLibraryFromBucket({}, deps(b, c));
    assert.equal(again.created, 0);
    assert.equal(again.updated, rows.reduce((a, b) => a + b, 0));
    assert.deepEqual(models.map((m) => c.tables[m].size), rows);
    const upd = c.writes.filter((w) => w.op === "update");
    assert.ok(upd.every((w) => !("createdAt" in w.input) && !("updatedAt" in w.input)), "timestamps are not sent on update");
    assert.equal(upd.find((w) => w.model === "Recording" && w.input.id === "rec_uploads_announcer")!.input.performer, null, "absent optionals are cleared");
  });

  it("one bad record (bad JSON, bad enum, missing file, API error) does not abort the rest", async () => {
    const good = fixtures("Slice");
    const b = bucket(2, {
      "Slice/slc_bad_json.json": "{nope",
      "Slice/slc_bad_enum.json": JSON.stringify({ ...good[0].rec, id: "slc_bad_enum", kind: "banana" }),
      "Slice/slc_array.json": "[]",
    });
    const c = fakeClient({ failIds: [good[1].rec.id] });
    // a listed key whose download fails
    const list = b.storage.list;
    b.storage.list = async (i) => {
      const r = await list(i);
      return i.path === "Slice/" && !i.options?.nextToken ? { ...r, items: [...r.items, { path: "Slice/gone.json" }] } : r;
    };
    const s = await importLibraryFromBucket({}, deps(b, c));
    const keys = s.failed.map((f) => f.key).sort();
    assert.deepEqual(keys, ["Slice/gone.json", `Slice/${good[1].key.split("/")[1]}`, "Slice/slc_array.json", "Slice/slc_bad_enum.json", "Slice/slc_bad_json.json"].sort());
    assert.equal(s.perModel.Slice.created, 1);
    assert.ok(s.perModel.Score.created > 0 && s.perModel.ScoreRef.created > 0, "later models still imported");
  });

  it("imports every record even though the API rejects caller-set timestamps with an unnamed message", async () => {
    const b = bucket();
    const c = fakeClient({});
    const s = await importLibraryFromBucket({}, deps(b, c));
    assert.deepEqual(s.failed, []);
    assert.ok(c.writes.every((w) => !("createdAt" in w.input)));
  });

  it("stops between records when aborted and says so", async () => {
    const b = bucket();
    const c = fakeClient();
    const ctl = new AbortController();
    const s = await importLibraryFromBucket({ signal: ctl.signal, onProgress: (p) => p.model === "Clip" && p.phase === "listing" && ctl.abort() }, deps(b, c));
    assert.equal(s.aborted, true);
    assert.equal(c.tables.Slice.size, 0);
  });

  it("a model that cannot be listed is reported and the others continue", async () => {
    const b = bucket();
    const list = b.storage.list;
    b.storage.list = async (i) => {
      if (i.path === "Clip/") throw new Error("AccessDenied");
      return list(i);
    };
    const s = await importLibraryFromBucket({}, deps(b, fakeClient()));
    assert.deepEqual(s.failed.map((f) => f.key), ["Clip/"]);
    assert.ok(s.created > 0);
  });
});
