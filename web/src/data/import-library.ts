// Admin tool: copy the library's record files from the bucket (`<Model>/<key>.json`, put there by
// `apricity sync push`) into the AppSync tables, so the hosted app can browse them (Kanbus 368367).
// Idempotent (get, then create or update by key), parents before children, never aborts on one bad record.

import contractJson from "../../../contract/apricity.contract.json";
import { currentAccount, type Account } from "./auth.js";
import { client } from "./client.js";

interface ContractField {
  name: string;
  type: string;
  isRequired: boolean;
  isArray: boolean;
  kind: "scalar" | "enum" | "customType" | "model";
}
interface ContractModel {
  name: string;
  fields: Record<string, ContractField>;
  primaryKey: string[];
  relationships: Array<{ field: string; kind: string; target: string; references: string }>;
  authRules: Array<{ allow: string; ownerField?: string; identityClaim?: string; groups?: string[]; operations?: string[] }>;
  ownerFields: string[];
}
export interface Contract {
  models: Record<string, ContractModel>;
  enums: Record<string, string[]>;
  customTypes: Record<string, Record<string, ContractField>>;
}
const CONTRACT = contractJson as unknown as Contract;

export type ImportPhase = "checking" | "listing" | "importing" | "done";
export interface ImportProgress {
  phase: ImportPhase;
  model?: string;
  /** Records handled so far / found for this model (total is known after listing). */
  done: number;
  total: number;
  created: number;
  updated: number;
  failed: number;
}
export interface ImportSummary {
  created: number;
  updated: number;
  failed: Array<{ key: string; error: string }>;
  perModel: Record<string, { found: number; created: number; updated: number; failed: number }>;
  aborted: boolean;
}

/** Thrown before anything is read or written when the signed-in user may not import. */
export class ImportNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportNotAllowedError";
  }
}

export interface StorageApi {
  list(input: { path: string; options?: { pageSize?: number; nextToken?: string } }): Promise<{ items: Array<{ path: string }>; nextToken?: string }>;
  downloadData(input: { path: string }): { result: Promise<{ body: { text(): Promise<string> } }> };
}
export interface ImportDeps {
  storage?: StorageApi;
  client?: any;
  account?: () => Promise<Account | null>;
  contract?: Contract;
  concurrency?: number;
}

/** Models that live only in the cloud, never in a library: ratings and their tallies, handles, comments, and the activity feed. */
export const CLOUD_ONLY = new Set(["Rating", "Tally", "Handle", "Comment", "Activity", "ActivityEvent"]);

/** Models parents-first: a model comes after every model it `belongsTo`. Stable in contract order. */
export function importOrder(contract: Contract = CONTRACT): string[] {
  const names = Object.keys(contract.models).filter((m) => !CLOUD_ONLY.has(m));
  const parents = (m: string) => contract.models[m].relationships.filter((r) => r.kind === "belongsTo").map((r) => r.target);
  const out: string[] = [];
  const visiting = new Set<string>();
  const visit = (m: string) => {
    if (out.includes(m)) return;
    if (visiting.has(m)) throw new Error(`Relationship cycle through ${m}`);
    visiting.add(m);
    for (const p of parents(m)) if (contract.models[p]) visit(p);
    visiting.delete(m);
    out.push(m);
  };
  names.forEach(visit);
  return out;
}

const isLocalIdentity = (v: unknown) => typeof v === "string" && (v === "local" || v.startsWith("local::"));

function convertValue(field: ContractField, v: unknown, contract: Contract, where: string): unknown {
  if (field.isArray) {
    if (!Array.isArray(v)) throw new Error(`${where} must be a list`);
    return v.map((x, i) => convertValue({ ...field, isArray: false }, x, contract, `${where}[${i}]`));
  }
  if (field.kind === "customType") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${where} must be an object`);
    return convertObject(contract.customTypes[field.type], v as Record<string, unknown>, contract, where);
  }
  if (field.kind === "enum") {
    if (typeof v !== "string" || !contract.enums[field.type]?.includes(v)) throw new Error(`${where}: ${JSON.stringify(v)} is not a ${field.type}`);
    return v;
  }
  switch (field.type) {
    case "AWSJSON":
      // The API takes AWSJSON as a JSON *string*; the files hold either that string or the parsed value.
      return typeof v === "string" ? v : JSON.stringify(v);
    case "Int":
      if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${where} must be an integer`);
      return v;
    case "Float":
      if (typeof v !== "number") throw new Error(`${where} must be a number`);
      return v;
    case "Boolean":
      if (typeof v !== "boolean") throw new Error(`${where} must be true or false`);
      return v;
    default:
      if (typeof v !== "string") throw new Error(`${where} must be text`);
      return v;
  }
}

function convertObject(fields: Record<string, ContractField>, rec: Record<string, unknown>, contract: Contract, where: string) {
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(fields)) {
    if (f.kind === "model") continue;
    const v = rec[name];
    if (v === undefined || v === null) {
      if (f.isRequired) throw new Error(`${where}${name} is required`);
      continue;
    }
    out[name] = convertValue(f, v, contract, `${where}${name}`);
  }
  return out;
}

/**
 * Record file -> API input. Drops `__typename`, relationship fields and anything the contract does not know;
 * turns a.json values into JSON strings (also inside custom types), checks enums, numbers and required fields,
 * and swaps the migrator's local identity (`local::migrator`, `local`) in owner/judge fields for the importer's.
 */
export function toApiInput(model: string, rec: Record<string, unknown>, account: Pick<Account, "sub" | "username">, contract: Contract = CONTRACT) {
  const m = contract.models[model];
  const out = convertObject(m.fields, rec, contract, "");
  for (const f of m.ownerFields) {
    if (!isLocalIdentity(out[f])) continue;
    const claim = m.authRules.find((r) => r.allow === "owner" && r.ownerField === f)?.identityClaim;
    out[f] = claim === "sub" ? account.sub : account.username;
  }
  return out;
}

const keyOf = (model: string, input: Record<string, unknown>, contract: Contract) =>
  Object.fromEntries(contract.models[model].primaryKey.map((k) => [k, input[k]]));

const messageOf = (errors: unknown): string =>
  (Array.isArray(errors) ? errors : [errors]).map((e: any) => e?.message ?? String(e)).join("; ") || "unknown error";

/** Get, then create or update. Returns which one happened; throws Error with the API's message. */
async function upsert(api: any, model: string, input: Record<string, unknown>, contract: Contract): Promise<"created" | "updated"> {
  const m = api.models[model];
  if (!m) throw new Error(`the client has no model ${model}`);
  const got = await m.get(keyOf(model, input, contract));
  if (got.errors?.length) throw new Error(messageOf(got.errors));
  if (got.data) {
    const fields = contract.models[model].fields;
    const update: Record<string, unknown> = { ...input };
    delete update.createdAt;
    delete update.updatedAt;
    // Mirror the file: optional fields it no longer has are cleared.
    for (const [n, f] of Object.entries(fields)) {
      if (f.kind !== "model" && !f.isRequired && !(n in update) && n !== "createdAt" && n !== "updatedAt") update[n] = null;
    }
    const res = await m.update(update);
    if (res.errors?.length) throw new Error(messageOf(res.errors));
    return "updated";
  }
  // The create input has no createdAt/updatedAt (AppSync sets them), so they are never sent. The old code retried
  // without them only when the error NAMED them; the real message ("a field that is not defined for input object type")
  // does not, so every record failed.
  const { createdAt: _c, updatedAt: _u, ...rest } = input;
  const res = await m.create(rest);
  if (res.errors?.length) throw new Error(messageOf(res.errors));
  return "created";
}

/** Every `<Model>/…json` key under the root-level prefix, following pagination. */
export async function listModelKeys(storage: StorageApi, model: string, signal?: AbortSignal): Promise<string[]> {
  const keys: string[] = [];
  let nextToken: string | undefined;
  do {
    if (signal?.aborted) break;
    const page = await storage.list({ path: `${model}/`, options: { pageSize: 1000, nextToken } });
    for (const it of page.items) if (it.path.endsWith(".json")) keys.push(it.path);
    nextToken = page.nextToken;
  } while (nextToken);
  return keys;
}

export async function importLibraryFromBucket(
  { onProgress, signal }: { onProgress?: (p: ImportProgress) => void; signal?: AbortSignal } = {},
  deps: ImportDeps = {},
): Promise<ImportSummary> {
  const contract = deps.contract ?? CONTRACT;
  const concurrency = deps.concurrency ?? 8;
  const emit = (p: ImportProgress) => onProgress?.(p);
  const zero = { done: 0, total: 0, created: 0, updated: 0, failed: 0 };

  emit({ phase: "checking", ...zero });
  const account = await (deps.account ?? currentAccount)();
  if (!account) throw new ImportNotAllowedError("Sign in first: importing needs an administrator account.");
  if (!account.groups.includes("admins")) throw new ImportNotAllowedError("Your account is not in the admins group, so it cannot import the library.");
  if (!account.groups.includes("curators"))
    throw new ImportNotAllowedError("Records can only be written by the curators group. Add your account to curators as well as admins, sign in again, and retry.");

  const storage = deps.storage ?? ((await import("aws-amplify/storage")) as unknown as StorageApi);
  const api = deps.client ?? client();

  const summary: ImportSummary = { created: 0, updated: 0, failed: [], perModel: {}, aborted: false };
  for (const model of importOrder(contract)) {
    if (signal?.aborted) break;
    const stats = { found: 0, created: 0, updated: 0, failed: 0 };
    summary.perModel[model] = stats;
    const progress = (phase: ImportPhase, done: number) =>
      emit({ phase, model, done, total: stats.found, created: stats.created, updated: stats.updated, failed: stats.failed });

    progress("listing", 0);
    let keys: string[];
    try {
      keys = await listModelKeys(storage, model, signal);
    } catch (err) {
      summary.failed.push({ key: `${model}/`, error: `could not list: ${(err as Error).message}` });
      stats.failed += 1;
      continue;
    }
    stats.found = keys.length;
    let done = 0;
    let next = 0;
    progress("importing", 0);
    const worker = async () => {
      while (next < keys.length && !signal?.aborted) {
        const key = keys[next++];
        try {
          const text = await (await storage.downloadData({ path: key }).result).body.text();
          const parsed = JSON.parse(text);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
          const outcome = await upsert(api, model, toApiInput(model, parsed, account, contract), contract);
          stats[outcome] += 1;
          summary[outcome] += 1;
        } catch (err) {
          stats.failed += 1;
          summary.failed.push({ key, error: (err as Error).message ?? String(err) });
        }
        progress("importing", ++done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
  }
  summary.aborted = !!signal?.aborted;
  emit({ phase: "done", ...zero, created: summary.created, updated: summary.updated, failed: summary.failed.length });
  return summary;
}
