import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleUploadPolicy } from "../amplify/storage/cycle-upload-policy.ts";

test("group-role cycle uploads are restricted to that Cognito identity's object prefix", () => {
  const policy = cycleUploadPolicy("arn:aws:s3:::apricity-files");
  assert.deepEqual(policy.actions, ["s3:PutObject", "s3:DeleteObject"]);
  assert.deepEqual(policy.resources, [
    "arn:aws:s3:::apricity-files/files/cycles/${cognito-identity.amazonaws.com:sub}/*",
  ]);
});
