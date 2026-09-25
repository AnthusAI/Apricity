import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decidePreSignUp } from "./pre-sign-up-decision";

const flags = (d: ReturnType<typeof decidePreSignUp>) => [d.allow, d.autoConfirm, d.autoVerifyEmail];

describe("decidePreSignUp", () => {
  it("any Google account is allowed and auto-confirmed", () => {
    assert.deepEqual(flags(decidePreSignUp("PreSignUp_ExternalProvider", "anyone@gmail.com", true)), [true, true, true]);
    assert.deepEqual(flags(decidePreSignUp("PreSignUp_ExternalProvider", "someone@example.org", false)), [true, true, true]);
  });
  it("Google only refuses email/password sign-ups", () => {
    const d = decidePreSignUp("PreSignUp_SignUp", "a@b.co", true);
    assert.deepEqual(flags(d), [false, false, false]);
    assert.equal(d.reason, "Sign in with Google");
  });
  it("otherwise email/password sign-ups are allowed with email verification", () =>
    assert.deepEqual(flags(decidePreSignUp("PreSignUp_SignUp", "a@b.co", false)), [true, false, false]));
  it("a missing email is refused", () => {
    assert.deepEqual(flags(decidePreSignUp("PreSignUp_ExternalProvider", undefined, true)), [false, false, false]);
    assert.deepEqual(flags(decidePreSignUp("PreSignUp_SignUp", "", false)), [false, false, false]);
  });
});
