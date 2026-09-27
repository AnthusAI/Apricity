import { defineFunction } from "@aws-amplify/backend";

// Keeps the Ranked table (design/scale.md): streams on the Activity, Tally and Score tables, and once a day every item
// again (wired in backend.ts).
export const ranking = defineFunction({
  name: "apricity-ranking",
  entry: "./handler.ts",
  timeoutSeconds: 300,
  memoryMB: 512,
  resourceGroupName: "data",
  schedule: "every day",
});
