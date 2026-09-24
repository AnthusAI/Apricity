import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "../amplify/data/resource.js";
import Ajv2020 from "ajv/dist/2020";

const GENERATOR_VERSION = "1.0.0";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(scriptDir, "..");
const repoRoot = resolve(webDir, "..");
const contractDir = join(repoRoot, "contract");
const dataResourcePath = join(webDir, "amplify/data/resource.ts");
const authResourcePath = join(webDir, "amplify/auth/resource.ts");
const storageResourcePath = join(webDir, "amplify/storage/resource.ts");
const schemaPath = join(scriptDir, "contract.schema.json");

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const fs = (await import("fs")).promises;
    const tempDir = (await import("fs")).mkdtempSync(join(tmpdir(), "ripple-contract-"));
    try {
      await generate(tempDir);
      const diff = compareGenerated(tempDir, contractDir);
      if (diff.length > 0) {
        for (const d of diff) console.error("- " + d);
        process.exit(1);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    await generate(contractDir);
  }
}

async function generate(outDir: string) {
  mkdirSync(outDir, { recursive: true });

  const directiveSdl = schema.transform().schema;
  const generateModels = (await import("@aws-amplify/graphql-generator")).generateModels;
  const introspectionOutput = await generateModels({ schema: directiveSdl, target: "introspection" });

  let introspectionJson: any = null;
  for (const content of Object.values(introspectionOutput)) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.models) {
        introspectionJson = parsed;
        break;
      }
    } catch (e) {
      //
    }
  }
  if (!introspectionJson) throw new Error("No introspection JSON found");

  let appSyncSdl: string;
  try {
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");
    const cdk = await import("aws-cdk-lib");
    const cognito = await import("aws-cdk-lib/aws-cognito");
    const { AmplifyGraphqlApi, AmplifyGraphqlDefinition } = await import("@aws-amplify/graphql-api-construct");

    const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "apricitus-contract-"));
    try {
      const oldWarn = console.warn;
      console.warn = () => {};
      const app = new cdk.App({ outdir: tempOutDir } as any);
      const stack = new cdk.Stack(app, "Contract", { env: { account: "000000000000", region: "us-east-1" } });
      const pool = new cognito.UserPool(stack, "Pool");
      new AmplifyGraphqlApi(stack, "Api", {
        definition: AmplifyGraphqlDefinition.fromString(directiveSdl),
        authorizationModes: {
          defaultAuthorizationMode: "AMAZON_COGNITO_USER_POOLS",
          userPoolConfig: { userPool: pool },
          apiKeyConfig: { expires: cdk.Duration.days(365) },
        },
      } as any);
      app.synth();
      console.warn = oldWarn;
      const files = fs.readdirSync(tempOutDir);
      let found = false;
      for (const f of files) {
        if (f.startsWith("asset.") && f.endsWith(".graphql")) {
          appSyncSdl = fs.readFileSync(path.join(tempOutDir, f), "utf8");
          found = true;
          break;
        }
      }
      if (!found) throw new Error("No synthesized SDL");
    } finally {
      fs.rmSync(tempOutDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error("CDK synthesis failed:", (e as Error).message);
    process.exit(1);
  }

  const contract: any = { version: "", models: {}, enums: {}, customTypes: {}, authRules: {}, storage: { paths: [] } };

  for (const [n, d] of Object.entries(introspectionJson.enums || {}))
    contract.enums[n] = (d as any).values || [];

  for (const [n, d] of Object.entries(introspectionJson.nonModels || {})) {
    const f: any = {};
    for (const [fn, fd] of Object.entries((d as any).fields || {})) {
      const fld = fd as any;
      const kind = typeof fld.type === "string" ? "scalar" : (fld.type?.enum ? "enum" : (fld.type?.nonModel ? "customType" : (fld.type?.model ? "model" : "scalar")));
      f[fn] = {
        name: fn,
        type: typeof fld.type === "string" ? fld.type : fld.type?.name || "unknown",
        isRequired: fld.isRequired || false,
        isArray: fld.isArray || false,
        kind,
      };
    }
    contract.customTypes[n] = f;
  }

  for (const [mn, md] of Object.entries(introspectionJson.models || {})) {
    const m: any = { name: mn, fields: {}, primaryKey: [], indexes: [], relationships: [], authRules: [], ownerFields: [] };
    for (const [fn, fd] of Object.entries((md as any).fields || {})) {
      const fld = fd as any;
      const fieldType = (function() {
        if (typeof fld.type === "string") return fld.type;
        if (fld.type?.model) return fld.type.model;
        if (fld.type?.nonModel) return fld.type.nonModel;
        if (fld.type?.enum) return fld.type.enum;
        return "unknown";
      })();
      const kind = typeof fld.type === "string" ? "scalar" : (fld.type?.enum ? "enum" : (fld.type?.model ? "model" : (fld.type?.nonModel ? "customType" : "scalar")));
      m.fields[fn] = {
        name: fn,
        type: fieldType,
        isRequired: fld.isRequired || false,
        isArray: fld.isArray || false,
        kind,
      };
      if (fld.association) {
        const t = typeof fld.type === "string" ? fld.type : (fld.type?.model || fld.type?.nonModel || "unknown");
        const refs = (fld.association.associatedWith && fld.association.associatedWith[0]) || (fld.association.targetNames && fld.association.targetNames[0]) || "";
        m.relationships.push({
          field: fn,
          kind: fld.isArray ? "hasMany" : (fld.association.connectionType === "HAS_ONE" ? "hasOne" : "belongsTo"),
          target: t,
          references: refs,
        });
      }
    }
    for (const a of (md as any).attributes || []) {
      if (a.type === "key") {
        const kf = a.properties.fields || [];
        if (!a.properties.name) m.primaryKey = kf;
        else
          m.indexes.push({
            name: a.properties.name,
            queryField: a.properties.queryField,
            partitionField: kf[0],
            sortFields: kf.slice(1),
            sortArgument: kf.length > 1 ? kf[1] : undefined,
          });
      } else if (a.type === "auth") {
        m.authRules = a.properties.rules || [];
        for (const r of m.authRules) {
          if (r.ownerField && !m.ownerFields.includes(r.ownerField)) m.ownerFields.push(r.ownerField);
        }
      }
    }
    contract.models[mn] = m;
  }

  for (const m of Object.values(contract.models)) {
    for (const r of (m as any).relationships) {
      if (r.kind === "hasMany") {
        const t = contract.models[r.target];
        const idx = t && (t as any).indexes.find((i: any) => i.partitionField === r.references);
        r.childIndex = idx ? idx.queryField : undefined;
        r.implicit = !idx;
      }
    }
  }

  const ss = readFileSync(storageResourcePath, "utf8");
  for (const m of ss.matchAll(/"([^"]+)":\s*\[([\s\S]*?)\],/g)) {
    const p = m[1];
    const at = m[2];
    const rd = new Set<string>();
    const wr = new Set<string>();
    for (const gm of at.matchAll(/allow\.groups\(\["([^"]+)"\]\)\.to\(\["([^\]]+)"\]\)/g)) {
      const g = gm[1];
      const o = gm[2];
      if (o.includes("read")) rd.add(g);
      if (o.includes("write") || o.includes("delete")) wr.add(g);
    }
    if (at.includes('allow.entity("identity")')) {
      for (const em of at.matchAll(/allow\.entity\([^)]+\)\.to\(\[([^\]]+)\]\)/g)) {
        const o = em[1];
        if (o.includes("read")) rd.add("owner");
        if (o.includes("write") || o.includes("delete")) wr.add("owner");
      }
    }
    contract.storage.paths.push({ path: p, readable: [...rd], writable: [...wr] });
  }

  for (const [mn, m] of Object.entries(contract.models)) contract.authRules[mn] = (m as any).authRules;

  const ds = readFileSync(dataResourcePath, "utf8");
  const as = readFileSync(authResourcePath, "utf8");
  const ss2 = readFileSync(storageResourcePath, "utf8");
  const vs = [GENERATOR_VERSION, ds, as, ss2].join("\n");
  contract.version = createHash("sha256").update(vs).digest("hex").slice(0, 16);

  // Validate contract against schema
  const schemaJson = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020();
  const validate = ajv.compile(schemaJson);
  if (!validate(contract)) {
    console.error("Contract validation failed:");
    for (const error of validate.errors || []) {
      const path = error.instancePath || "/";
      const message = error.message || "unknown error";
      console.error(`  ${path}: ${message}`);
    }
    process.exit(1);
  }

  const writeJson = (p: string, o: any) => writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
  writeJson(join(outDir, "apricitus.contract.json"), contract);
  writeJson(join(outDir, "model-introspection.json"), introspectionJson);
  writeFileSync(join(outDir, "appsync.graphql"), appSyncSdl.trim() + "\n");
  writeFileSync(join(outDir, "model-schema.graphql"), directiveSdl.trim() + "\n");
  writeFileSync(join(outDir, "contract.schema.json"), readFileSync(schemaPath, "utf8"));
  writeJson(join(outDir, "schema-version.json"), {
    contractVersion: contract.version,
    sha256Hashes: {
      "web/amplify/data/resource.ts": createHash("sha256").update(ds).digest("hex"),
      "web/amplify/auth/resource.ts": createHash("sha256").update(as).digest("hex"),
      "web/amplify/storage/resource.ts": createHash("sha256").update(ss2).digest("hex"),
    },
  });

  console.log("Contract generated successfully");
}

function compareGenerated(t: string, o: string): string[] {
  const diffs = [];
  for (const f of [
    "apricitus.contract.json",
    "model-introspection.json",
    "appsync.graphql",
    "model-schema.graphql",
    "contract.schema.json",
    "schema-version.json",
  ]) {
    const exp = join(o, f);
    const act = join(t, f);
    if (!existsSync(exp) || !existsSync(act)) {
      diffs.push(f + " missing");
      continue;
    }
    const ec = readFileSync(exp, "utf8");
    const ac = readFileSync(act, "utf8");
    if (ec !== ac) diffs.push(f + " differs");
  }
  return diffs;
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
