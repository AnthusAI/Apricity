import { test } from "node:test";
import assert from "node:assert";
import {
  matches,
  isUuid,
  isDatetime,
  assertMatches,
  assertHasNItems,
  getAtPath,
  arrayMatchesExact,
  arrayMatchesAnyOrder,
  MatchError,
} from "./match.js";

test("isUuid", async (t) => {
  await t.test("accepts valid UUIDs", () => {
    assert.ok(isUuid("550e8400-e29b-41d4-a716-446655440000"));
    assert.ok(isUuid("123e4567-e89b-12d3-a456-426614174000"));
  });

  await t.test("rejects invalid UUIDs", () => {
    assert.ok(!isUuid("not-a-uuid"));
    assert.ok(!isUuid("550e8400e29b41d4a716446655440000"));
    assert.ok(!isUuid(123));
    assert.ok(!isUuid(null));
  });
});

test("isDatetime", async (t) => {
  await t.test("accepts valid ISO-8601 datetimes", () => {
    assert.ok(isDatetime("2026-09-24T00:00:00.000Z"));
    assert.ok(isDatetime("2026-09-24T12:34:56.789Z"));
    assert.ok(isDatetime("2026-09-24T00:00:00Z"));
  });

  await t.test("rejects invalid datetimes", () => {
    assert.ok(!isDatetime("2026-09-24"));
    assert.ok(!isDatetime("2026-09-24T00:00:00"));
    assert.ok(!isDatetime("not-a-datetime"));
    assert.ok(!isDatetime(null));
  });
});

test("matches - markers", async (t) => {
  await t.test("<any> matches non-null values", () => {
    assert.ok(matches("<any>", "value"));
    assert.ok(matches("<any>", 0));
    assert.ok(matches("<any>", false));
    assert.ok(matches("<any>", {}));
    assert.ok(!matches("<any>", null));
    assert.ok(!matches("<any>", undefined));
  });

  await t.test("<absent> matches null or undefined", () => {
    assert.ok(matches("<absent>", null));
    assert.ok(matches("<absent>", undefined));
    assert.ok(!matches("<absent>", "value"));
    assert.ok(!matches("<absent>", false));
  });

  await t.test("<uuid> matches UUID strings", () => {
    assert.ok(matches("<uuid>", "550e8400-e29b-41d4-a716-446655440000"));
    assert.ok(!matches("<uuid>", "not-a-uuid"));
  });

  await t.test("<datetime> matches ISO-8601 datetimes", () => {
    assert.ok(matches("<datetime>", "2026-09-24T00:00:00.000Z"));
    assert.ok(!matches("<datetime>", "2026-09-24"));
  });
});

test("matches - numeric equality", async (t) => {
  await t.test("compares numbers numerically", () => {
    assert.ok(matches(1, 1));
    assert.ok(matches(1, 1.0));
    assert.ok(matches(1.5, 1.5));
    assert.ok(!matches(1, 2));
    assert.ok(!matches(1, "1"));
  });
});

test("matches - arrays", async (t) => {
  await t.test("matches arrays element-wise", () => {
    assert.ok(matches([1, 2, 3], [1, 2, 3]));
    assert.ok(matches([1.0, 2, 3], [1, 2.0, 3]));
    assert.ok(!matches([1, 2, 3], [1, 2]));
    assert.ok(!matches([1, 2, 3], [1, 2, 3, 4]));
  });

  await t.test("matches nested arrays with subset matching", () => {
    assert.ok(matches([{ id: 1 }, { id: 2 }], [{ id: 1, extra: "x" }, { id: 2, extra: "y" }]));
    assert.ok(!matches([{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 3 }]));
  });
});

test("matches - subset matching", async (t) => {
  await t.test("matches objects with subset keys", () => {
    assert.ok(matches({ id: "x" }, { id: "x", name: "alice" }));
    assert.ok(!matches({ id: "x", name: "bob" }, { id: "x", name: "alice" }));
  });

  await t.test("matches nested objects", () => {
    assert.ok(
      matches(
        { user: { id: "x" } },
        { user: { id: "x", name: "alice" }, extra: "data" }
      )
    );
  });

  await t.test("matches with markers in objects", () => {
    assert.ok(
      matches(
        { id: "<uuid>", createdAt: "<datetime>" },
        { id: "550e8400-e29b-41d4-a716-446655440000", createdAt: "2026-09-24T00:00:00.000Z" }
      )
    );
  });
});

test("matches - type mismatches", async (t) => {
  await t.test("rejects type mismatches", () => {
    assert.ok(!matches({ a: 1 }, [1]));
    assert.ok(!matches("string", 123));
    assert.ok(!matches(true, 1));
  });
});

test("assertMatches", async (t) => {
  await t.test("throws MatchError when matching fails", () => {
    assert.throws(
      () => assertMatches({ id: "x" }, { id: "y" }),
      (err) => err instanceof MatchError
    );
  });

  await t.test("throws with path info", () => {
    assert.throws(
      () => assertMatches({ id: "x" }, { id: "y" }, "data.user"),
      (err) => err instanceof MatchError && err.message.includes("at data.user")
    );
  });
});

test("assertHasNItems", async (t) => {
  await t.test("passes for correct length", () => {
    assertHasNItems([1, 2, 3], 3);
  });

  await t.test("throws for wrong length", () => {
    assert.throws(
      () => assertHasNItems([1, 2], 3),
      (err) => err instanceof MatchError
    );
  });

  await t.test("throws for non-array", () => {
    assert.throws(
      () => assertHasNItems("not an array", 1),
      (err) => err instanceof MatchError
    );
  });
});

test("getAtPath", async (t) => {
  const obj = {
    id: "root",
    items: [{ id: "item1" }, { id: "item2" }],
    nested: { deep: { value: "found" } },
  };

  await t.test("gets top-level values", () => {
    assert.strictEqual(getAtPath(obj, "id"), "root");
  });

  await t.test("gets array elements by index", () => {
    assert.deepStrictEqual(getAtPath(obj, "items.0"), { id: "item1" });
    assert.deepStrictEqual(getAtPath(obj, "items.1"), { id: "item2" });
  });

  await t.test("gets nested object values", () => {
    assert.strictEqual(getAtPath(obj, "nested.deep.value"), "found");
  });

  await t.test("returns undefined for missing paths", () => {
    assert.strictEqual(getAtPath(obj, "missing"), undefined);
    assert.strictEqual(getAtPath(obj, "items.10"), undefined);
  });
});

test("arrayMatchesExact", async (t) => {
  await t.test("matches arrays with same items in same order", () => {
    assert.ok(arrayMatchesExact([{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 2 }]));
    assert.ok(arrayMatchesExact([{ id: 1 }], [{ id: 1, name: "alice" }]));
  });

  await t.test("rejects different order", () => {
    assert.ok(!arrayMatchesExact([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }]));
  });

  await t.test("rejects different lengths", () => {
    assert.ok(!arrayMatchesExact([{ id: 1 }], [{ id: 1 }, { id: 2 }]));
  });
});

test("arrayMatchesAnyOrder", async (t) => {
  await t.test("matches items in any order", () => {
    assert.ok(arrayMatchesAnyOrder([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }]));
    assert.ok(arrayMatchesAnyOrder([{ id: 1 }], [{ id: 1, extra: "data" }]));
  });

  await t.test("rejects different lengths", () => {
    assert.ok(!arrayMatchesAnyOrder([{ id: 1 }, { id: 2 }], [{ id: 1 }]));
  });

  await t.test("handles duplicate matches correctly", () => {
    // Each expected item should match exactly one actual item
    assert.ok(arrayMatchesAnyOrder([{ id: 1 }, { id: 1 }], [{ id: 1 }, { id: 1 }]));
    assert.ok(!arrayMatchesAnyOrder([{ id: 1 }, { id: 1 }], [{ id: 1 }]));
  });
});
