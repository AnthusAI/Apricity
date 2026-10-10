import { defineFunction } from "@aws-amplify/backend";

export const semantic = defineFunction({
  name: "apricity-semantic",
  entry: "./handler.ts",
  timeoutSeconds: 29,
  memoryMB: 512,
  resourceGroupName: "data",
});
