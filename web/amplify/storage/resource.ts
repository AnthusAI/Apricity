import { defineStorage } from "@aws-amplify/backend";
import contract from "../../../contract/apricity.contract.json";

/**
 * The bucket's key space is the Apricity library folder layout, key for key
 * (design/storage.md, "Sync and the bucket layout"). `apricity sync push` writes a library's
 * files under the same relative paths, and `apricity serve` serves the library's `files/` folder
 * at `/files/<key>`, so the web app's file paths are the same in both modes:
 *
 *   files/audio/<clipId>/<original-filename>   audio, stems, slices and clips
 *   files/analysis/<clipId>/<sha256>.json      analysis attachments
 *   files/documents/<recordingId>/<file>.pdf   documents
 *   <Model>/<key>.json                         one file per record, as Virtuus writes them
 *
 * Machine-local scratch (`.virtuus/`, the sync state, `apricity-library.json`) is never synced.
 *
 * Access: every signed-in user (members, curators, admins) can read and play back. Only the
 * `admins` group writes the library layout. `apricity sync` uses the caller's own AWS
 * credentials (the bucket owner's), so these rules govern browser access. User uploads stay
 * owner-only under `uploads/{entity_id}/`.
 */
// Users in a Cognito group get THAT group's AWS role, not the generic authenticated one, so every group that may read
// needs its own rule here: members and curators read, admins read and write.
const readAll = (allow: any) => [
  allow.authenticated.to(["read"]),
  allow.groups(["members", "curators"]).to(["read"]),
  allow.groups(["admins"]).to(["read", "write", "delete"]),
];

// One record folder per model in the data contract (Recording/, Clip/, Slice/, ...).
const recordFolders = Object.keys((contract as { models: Record<string, unknown> }).models);

export const storage = defineStorage({
  name: "apricityFiles",
  isDefault: true,
  access: (allow) => ({
    "files/*": readAll(allow),
    // The home page hero demo plays these; they are public, so signed-out visitors hear it too.
    "files/hero/*": [allow.guest.to(["read"])],
    ...Object.fromEntries(recordFolders.map((model) => [`${model}/*`, readAll(allow)])),
    "uploads/{entity_id}/*": [allow.entity("identity").to(["read", "write", "delete"])],
  }),
});
