import { defineFunction, secret } from "@aws-amplify/backend";

export const preSignUp = defineFunction({
  name: "apricity-pre-sign-up",
  entry: "./handler.ts",
  timeoutSeconds: 10,
  memoryMB: 256,
  resourceGroupName: "auth",
  environment: {
    ALLOWED_EMAILS: secret("ALLOWED_EMAILS"),
  },
});
