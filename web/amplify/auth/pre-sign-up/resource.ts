import { defineFunction } from "@aws-amplify/backend";

export const preSignUp = defineFunction({
  name: "apricity-pre-sign-up",
  entry: "./handler.ts",
  timeoutSeconds: 10,
  memoryMB: 256,
  resourceGroupName: "auth",
  environment: {
    // Comma-separated allowed sign-up emails, from the branch environment variable APRICITY_ALLOWED_EMAILS at deploy
    // time. It is a list of addresses, not a credential, so it is a plain environment variable. Empty allows nobody.
    // "true" while sign-in is Google only: native email sign-ups are refused.
    GOOGLE_ONLY: process.env.APRICITY_GOOGLE_AUTH === "true" ? "true" : "false",
    ALLOWED_EMAILS: process.env.APRICITY_ALLOWED_EMAILS ?? "",
  },
});
