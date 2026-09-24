/**
 * Matching rules for conformance tests (from STEPS.md)
 *
 * Subset match: an expected object matches an actual object when every expected key matches.
 * Markers: "<any>", "<absent>", "<uuid>", "<datetime>"
 * Numbers compare numerically: 1 equals 1.0
 * Arrays inside objects match exactly: same length, element by element with subset match
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export class MatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchError";
  }
}

/**
 * Check if a value is a UUID
 */
export function isUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return UUID_PATTERN.test(value);
}

/**
 * Check if a value is an ISO-8601 datetime
 */
export function isDatetime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return DATETIME_PATTERN.test(value);
}

/**
 * Check if expected and actual match according to the matching rules
 * - Subset match (all expected keys present in actual)
 * - Markers: "<any>", "<absent>", "<uuid>", "<datetime>"
 * - Numeric equality (1 === 1.0)
 * - Arrays: same length, element-wise subset match
 */
export function matches(expected: unknown, actual: unknown): boolean {
  // Marker: <any> - present and not null
  if (expected === "<any>") {
    return actual !== null && actual !== undefined;
  }

  // Marker: <absent> - missing or null
  if (expected === "<absent>") {
    return actual === null || actual === undefined;
  }

  // Marker: <uuid>
  if (expected === "<uuid>") {
    return isUuid(actual);
  }

  // Marker: <datetime>
  if (expected === "<datetime>") {
    return isDatetime(actual);
  }

  // Numeric equality
  if (typeof expected === "number" && typeof actual === "number") {
    return expected === actual;
  }

  // Exact type match required for non-numbers
  if (typeof expected !== typeof actual) {
    return false;
  }

  // String equality
  if (typeof expected === "string") {
    return expected === actual;
  }

  // Boolean equality
  if (typeof expected === "boolean") {
    return expected === actual;
  }

  // Null
  if (expected === null) {
    return actual === null;
  }

  // Array: same length, element-wise subset match
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (expected.length !== actual.length) return false;
    return expected.every((exp, i) => matches(exp, actual[i]));
  }

  // Object: subset match
  if (typeof expected === "object") {
    if (typeof actual !== "object" || actual === null) return false;

    for (const key in expected) {
      if (!(key in actual)) return false;
      if (!matches((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Validate that expected matches actual, throw MatchError if not
 */
export function assertMatches(expected: unknown, actual: unknown, path = ""): void {
  if (!matches(expected, actual)) {
    const pathStr = path ? ` at ${path}` : "";
    throw new MatchError(`Expected${pathStr}: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

/**
 * Validate that an array has exactly N items
 */
export function assertHasNItems(data: unknown, n: number, path = ""): void {
  if (!Array.isArray(data)) {
    const pathStr = path ? ` at ${path}` : "";
    throw new MatchError(`Expected${pathStr} array, got: ${typeof data}`);
  }
  if (data.length !== n) {
    const pathStr = path ? ` at ${path}` : "";
    throw new MatchError(`Expected${pathStr} ${n} items, got ${data.length}`);
  }
}

/**
 * Get value at dotted path (e.g., "items.0.id")
 */
export function getAtPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    if (typeof current !== "object") return undefined;

    const index = parseInt(part, 10);
    if (!isNaN(index)) {
      if (Array.isArray(current)) {
        current = current[index];
      } else {
        return undefined;
      }
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

/**
 * Check if arrays match exactly (same length, each item subset-matches)
 */
export function arrayMatchesExact(expected: unknown[], actual: unknown[]): boolean {
  if (!Array.isArray(actual)) return false;
  if (expected.length !== actual.length) return false;
  return expected.every((exp, i) => matches(exp, actual[i]));
}

/**
 * Check if expected items match actual items in any order
 * (each expected subset-matches exactly one actual)
 */
export function arrayMatchesAnyOrder(expected: unknown[], actual: unknown[]): boolean {
  if (!Array.isArray(actual)) return false;
  if (expected.length !== actual.length) return false;

  const used = new Set<number>();

  for (const exp of expected) {
    let found = false;
    for (let i = 0; i < actual.length; i++) {
      if (!used.has(i) && matches(exp, actual[i])) {
        used.add(i);
        found = true;
        break;
      }
    }
    if (!found) return false;
  }

  return true;
}
