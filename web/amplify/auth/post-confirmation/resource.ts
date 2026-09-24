import { defineFunction } from "@aws-amplify/backend";

export const postConfirmation = defineFunction({
  name: "apricity-post-confirmation",
  entry: "./handler.ts",
  timeoutSeconds: 10,
  memoryMB: 256,
  resourceGroupName: "auth",
});
