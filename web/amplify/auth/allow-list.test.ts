import { describe, it } from "node:test";
import assert from "node:assert";
import { isAllowed } from "./allow-list";

describe("isAllowed", () => {
  it("should return true for exact email match", () => {
    assert.strictEqual(isAllowed("user@example.com", "user@example.com"), true);
  });

  it("should be case-insensitive", () => {
    assert.strictEqual(isAllowed("USER@EXAMPLE.COM", "user@example.com"), true);
    assert.strictEqual(
      isAllowed("user@example.com", "USER@EXAMPLE.COM"),
      true
    );
  });

  it("should handle multiple emails in list", () => {
    const list = "alice@example.com,bob@example.com,charlie@example.com";
    assert.strictEqual(isAllowed("alice@example.com", list), true);
    assert.strictEqual(isAllowed("bob@example.com", list), true);
    assert.strictEqual(isAllowed("charlie@example.com", list), true);
    assert.strictEqual(isAllowed("dave@example.com", list), false);
  });

  it("should handle whitespace in list", () => {
    const list = "alice@example.com, bob@example.com , charlie@example.com";
    assert.strictEqual(isAllowed("alice@example.com", list), true);
    assert.strictEqual(isAllowed("bob@example.com", list), true);
    assert.strictEqual(isAllowed("charlie@example.com", list), true);
  });

  it("should return false for email not in list", () => {
    assert.strictEqual(
      isAllowed("notallowed@example.com", "user@example.com"),
      false
    );
  });

  it("should return false for empty email", () => {
    assert.strictEqual(isAllowed("", "user@example.com"), false);
  });

  it("should return false for empty list", () => {
    assert.strictEqual(isAllowed("user@example.com", ""), false);
  });

  it("should return false for null-like values", () => {
    assert.strictEqual(isAllowed("", ""), false);
  });

  it("should handle list with empty entries", () => {
    const list = "alice@example.com,,bob@example.com";
    assert.strictEqual(isAllowed("alice@example.com", list), true);
    assert.strictEqual(isAllowed("bob@example.com", list), true);
  });
});
