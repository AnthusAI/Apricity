import { describe, it } from "node:test";
import assert from "node:assert";
import { decidePreSignUp } from "./pre-sign-up-decision";

describe("decidePreSignUp", () => {
  const allowedList = "alice@example.com,bob@example.com";

  describe("missing email", () => {
    it("should reject sign-up when email is undefined", () => {
      const result = decidePreSignUp(
        "PreSignUp_SignUp",
        undefined,
        allowedList
      );
      assert.strictEqual(result.allow, false);
      assert.strictEqual(result.autoConfirm, false);
      assert.strictEqual(result.autoVerifyEmail, false);
    });

    it("should reject sign-up when email is empty string", () => {
      const result = decidePreSignUp("PreSignUp_SignUp", "", allowedList);
      assert.strictEqual(result.allow, false);
      assert.strictEqual(result.autoConfirm, false);
      assert.strictEqual(result.autoVerifyEmail, false);
    });
  });

  describe("email not in allowed list", () => {
    it("should reject email/password sign-up for disallowed email", () => {
      const result = decidePreSignUp(
        "PreSignUp_SignUp",
        "notallowed@example.com",
        allowedList
      );
      assert.strictEqual(result.allow, false);
      assert.strictEqual(result.autoConfirm, false);
      assert.strictEqual(result.autoVerifyEmail, false);
    });

    it("should reject external provider sign-up for disallowed email", () => {
      const result = decidePreSignUp(
        "PreSignUp_ExternalProvider",
        "notallowed@example.com",
        allowedList
      );
      assert.strictEqual(result.allow, false);
      assert.strictEqual(result.autoConfirm, false);
      assert.strictEqual(result.autoVerifyEmail, false);
    });
  });

  describe("email in allowed list - email/password sign-up", () => {
    it("should allow but not auto-confirm email/password sign-up", () => {
      const result = decidePreSignUp("PreSignUp_SignUp", "alice@example.com", allowedList);
      assert.strictEqual(result.allow, true);
      assert.strictEqual(result.autoConfirm, false);
      assert.strictEqual(result.autoVerifyEmail, false);
    });

    it("should handle case-insensitive email matching for email/password sign-up", () => {
      const result = decidePreSignUp(
        "PreSignUp_SignUp",
        "ALICE@EXAMPLE.COM",
        allowedList
      );
      assert.strictEqual(result.allow, true);
      assert.strictEqual(result.autoConfirm, false);
      assert.strictEqual(result.autoVerifyEmail, false);
    });
  });

  describe("email in allowed list - external provider (Google)", () => {
    it("should allow and auto-confirm Google sign-up for allowed email", () => {
      const result = decidePreSignUp(
        "PreSignUp_ExternalProvider",
        "alice@example.com",
        allowedList
      );
      assert.strictEqual(result.allow, true);
      assert.strictEqual(result.autoConfirm, true);
      assert.strictEqual(result.autoVerifyEmail, true);
    });

    it("should handle case-insensitive email matching for Google sign-up", () => {
      const result = decidePreSignUp(
        "PreSignUp_ExternalProvider",
        "BOB@EXAMPLE.COM",
        allowedList
      );
      assert.strictEqual(result.allow, true);
      assert.strictEqual(result.autoConfirm, true);
      assert.strictEqual(result.autoVerifyEmail, true);
    });

    it("should return correct reason for external provider", () => {
      const result = decidePreSignUp(
        "PreSignUp_ExternalProvider",
        "alice@example.com",
        allowedList
      );
      assert.match(result.reason || "", /external provider/i);
    });
  });

  describe("decision reasons", () => {
    it("should provide reason for allowed email/password sign-up", () => {
      const result = decidePreSignUp(
        "PreSignUp_SignUp",
        "alice@example.com",
        allowedList
      );
      assert.ok(result.reason);
      assert.match(result.reason, /email.*password/i);
    });

    it("should provide reason for rejected sign-up", () => {
      const result = decidePreSignUp(
        "PreSignUp_SignUp",
        "notallowed@example.com",
        allowedList
      );
      assert.ok(result.reason);
      assert.match(result.reason, /not in the allowed list/i);
    });

    it("should provide reason for missing email", () => {
      const result = decidePreSignUp("PreSignUp_SignUp", undefined, allowedList);
      assert.ok(result.reason);
      assert.match(result.reason, /missing email/i);
    });
  });

  describe("empty allowed list", () => {
    it("should reject all sign-ups when allowed list is empty", () => {
      const result = decidePreSignUp(
        "PreSignUp_SignUp",
        "alice@example.com",
        ""
      );
      assert.strictEqual(result.allow, false);
    });
  });
});
