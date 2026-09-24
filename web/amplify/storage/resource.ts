import { defineStorage } from "@aws-amplify/backend";

export const storage = defineStorage({
  name: "apricitusFiles",
  isDefault: true,
  access: (allow) => ({
    // Catalog files: readable by members, writable by curators
    "audio/*": [
      allow.groups(["members"]).to(["read"]),
      allow.groups(["curators"]).to(["read", "write", "delete"]),
    ],
    "analysis/*": [
      allow.groups(["members"]).to(["read"]),
      allow.groups(["curators"]).to(["read", "write", "delete"]),
    ],
    "documents/*": [
      allow.groups(["members"]).to(["read"]),
      allow.groups(["curators"]).to(["read", "write", "delete"]),
    ],
    // User uploads: owner-only access via entity_id path parameter
    "uploads/{entity_id}/*": [
      allow.entity("identity").to(["read", "write", "delete"]),
    ],
  }),
});
