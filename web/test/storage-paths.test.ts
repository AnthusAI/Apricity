import { test } from "node:test";
import assert from "node:assert/strict";

// Amplify's own check, the one `ampx pipeline-deploy` runs (its package exports don't expose it, hence the path).
import { validateStorageAccessPaths } from "../node_modules/@aws-amplify/backend-storage/lib/validate_storage_access_paths.js";
import { PUBLIC_FILE_FOLDERS, storageAccess } from "../amplify/storage/resource.ts";

// A stand-in for Amplify's `allow` builder: every call chains, so the rules evaluate without a backend.
const chain: any = new Proxy(() => chain, { get: () => chain, apply: () => chain });

test("the storage access paths pass Amplify's deploy-time validation", () => {
  const paths = Object.keys(storageAccess(chain));
  assert.doesNotThrow(() => validateStorageAccessPaths(paths));
});

test("every library folder under files/ has a rule, and cycle renders are per identity", () => {
  const paths = Object.keys(storageAccess(chain));
  for (const folder of PUBLIC_FILE_FOLDERS) assert.ok(paths.includes(`files/${folder}/*`), folder);
  assert.ok(paths.includes("files/cycles/{entity_id}/*"));
  assert.ok(!paths.includes("files/*"));
});
