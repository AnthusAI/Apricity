import { defineFunction } from "@aws-amplify/backend";

export const preSignUp = defineFunction({
  name: "apricity-pre-sign-up",
  entry: "./handler.ts",
  timeoutSeconds: 10,
  memoryMB: 256,
  resourceGroupName: "auth",
  environment: {
    // "true" while sign-in is Google only: native email sign-ups are refused.
    GOOGLE_ONLY: process.env.APRICITY_GOOGLE_AUTH === "true" ? "true" : "false",
  },
});
