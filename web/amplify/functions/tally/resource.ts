import { defineFunction } from "@aws-amplify/backend";

// Keeps the public star tallies in step with the private ratings (a DynamoDB stream on the Rating table; wired in
// backend.ts).
export const tally = defineFunction({
  name: "apricity-tally",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 256,
  resourceGroupName: "data",
});
