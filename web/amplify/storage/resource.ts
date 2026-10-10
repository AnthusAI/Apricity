import { defineStorage } from "@aws-amplify/backend";
import contract from "../../../contract/apricity.contract.json";

/**
 * The bucket's key space is the Apricity library folder layout, key for key
 * (design/storage.md, "Sync and the bucket layout"). `apricity sync push` writes a library's
 * files under the same relative paths, and `apricity serve` serves the library's `files/` folder
 * at `/files/<key>`, so the web app's file paths are the same in both modes:
 *
 *   files/audio/<sampleId>/<original-filename>   audio: sources, stems, excerpts, uploads
 *   files/analysis/<sampleId>/<sha256>.json      analysis attachments
 *   files/documents/<recordingId>/<file>.pdf     documents
 *   <Model>/<key>.json                           one file per record, as Virtuus writes them
 *
 * Machine-local scratch (`.virtuus/`, the sync state, `apricity-library.json`) is never synced.
 *
 * Access: the site is public, so anyone can read and play back, guests included. Private records (verdicts,
 * crates, ratings) are readable only when signed in. Only the `admins` group writes the library layout. `apricity sync` uses the caller's own AWS
 * credentials (the bucket owner's), so these rules govern browser access. User uploads stay
 * owner-only under `uploads/{entity_id}/`.
 */
// Users in a Cognito group get THAT group's AWS role, not the generic authenticated one, so every group that may read
// needs its own rule here: members and curators read, admins read and write.
const readSignedIn = (allow: any) => [
  allow.authenticated.to(["read"]),
  allow.groups(["members", "curators"]).to(["read"]),
  allow.groups(["admins"]).to(["read", "write", "delete"]),
];
// Everything public: guests (signed-out visitors) read too.
const readAll = (allow: any) => [allow.guest.to(["read"]), ...readSignedIn(allow)];

// One record folder per model in the data contract (Recording/, Sample/, Clip/, ...). Private ones need sign-in.
const recordFolders = Object.keys((contract as { models: Record<string, unknown> }).models);
const PRIVATE = new Set(["Verdict", "Crate", "CrateItem", "Rating", "ListeningCycle", "CycleVerdict", "Lab"]);

// Every top-level folder under `files/` that the library writes. Amplify refuses a rule with an {entity_id} token under
// a broader path (a blanket "files/*" above "files/cycles/{entity_id}/*" fails the deploy), so `files/` is granted
// folder by folder; a new folder needs its own line here or the browser can't read it.
export const PUBLIC_FILE_FOLDERS = ["audio", "analysis", "documents", "breakdowns"];

// The access rules, as a function of Amplify's `allow` builder, so a test can check the paths with Amplify's own
// validator (test/storage-paths.test.ts); `tsc` and the unit tests don't run it, only the deploy does.
export const storageAccess = (allow: any) => ({
  // Audio, analysis, documents and the breakdowns' sound. (A more specific path REPLACES the broader grant, with an
  // explicit deny for every role it does not list.)
  ...Object.fromEntries(PUBLIC_FILE_FOLDERS.map((folder) => [`files/${folder}/*`, readAll(allow)])),
  // Listening-cycle renders (files/cycles/<identityId>/<cycleId>/<letter>.m4a): the lab CLI's cloud target uploads
  // these as the signed-in person's own identity-pool credentials (`apricity login`), so the key needs their entity
  // id in it for `allow.entity("identity")` to grant the write. Their blindness comes from the ListeningCycle
  // records, which only signed-in people can read (the keys hold random cycle ids), not from the bucket.
  "files/cycles/{entity_id}/*": [allow.entity("identity").to(["read", "write", "delete"]), ...readSignedIn(allow)],
  ...Object.fromEntries(recordFolders.map((model) => [`${model}/*`, PRIVATE.has(model) ? readSignedIn(allow) : readAll(allow)])),
  "uploads/{entity_id}/*": [allow.entity("identity").to(["read", "write", "delete"])],
});

export const storage = defineStorage({
  name: "apricityFiles",
  isDefault: true,
  access: storageAccess,
});
