import { Given, When, Then, Before, After } from "@cucumber/cucumber";
import { generateClient } from "aws-amplify/api";
import { ConformanceWorld, Identity, ApiResult, LastCall } from "./world.js";
import {
  matches,
  assertMatches,
  assertHasNItems,
  getAtPath,
  arrayMatchesExact,
  arrayMatchesAnyOrder,
} from "./match.js";
import type { Schema } from "../../amplify/data/resource.js";

// ============================================================================
// Setup / Teardown
// ============================================================================

Before(async function (this: ConformanceWorld, _: any) {
  // Set target mode from process.env.TARGET (local or sandbox)
  const target = process.env.TARGET || "local";
  this.targetMode = target === "sandbox" ? "sandbox" : "local";

  // Default identity
  this.identity = { sub: "anonymous", groups: [] };
  this.remembered.clear();
});

After(async function (this: ConformanceWorld) {
  // Cleanup
  this.clients.clear();
});

// ============================================================================
// Identity
// ============================================================================

Given("I am user {string} in groups {string}", async function (this: ConformanceWorld, user: string, groupsStr: string) {
  this.identity = {
    sub: user,
    groups: groupsStr ? groupsStr.split(",").map((g) => g.trim()) : [],
  };
});

// ============================================================================
// Model Operations - Create
// ============================================================================

When("I create a {word} with:", async function (this: ConformanceWorld, model: string, jsonStr: string) {
  const input = JSON.parse(jsonStr) as Record<string, unknown>;
  const substituted = this.substituteInJson(input) as Record<string, unknown>;

  const client = await this.getClient();
  const result: any = await (client.models as any)[model].create(substituted);

  // Amplify returns {data, errors} without throwing
  this.result = {
    data: result.data ?? null,
    errors: result.errors ?? [],
  };
});

// ============================================================================
// Model Operations - Get
// ============================================================================

When("I get a {word} with key:", async function (this: ConformanceWorld, model: string, jsonStr: string) {
  const keyObj = JSON.parse(jsonStr) as Record<string, unknown>;
  const substituted = this.substituteInJson(keyObj) as Record<string, unknown>;

  const client = await this.getClient();
  const result: any = await (client.models as any)[model].get(substituted);

  this.result = {
    data: result.data ?? null,
    errors: result.errors ?? [],
  };
});

When("I get a {word} with:", async function (this: ConformanceWorld, model: string, jsonStr: string) {
  const options = JSON.parse(jsonStr) as {
    key: Record<string, unknown>;
    selectionSet?: string[];
  };
  const key = this.substituteInJson(options.key) as Record<string, unknown>;
  const selectionSet = options.selectionSet;

  const client = await this.getClient();
  const result: any = await (client.models as any)[model].get(key, { selectionSet });

  this.result = {
    data: result.data ?? null,
    errors: result.errors ?? [],
  };
});

// ============================================================================
// Model Operations - Update
// ============================================================================

When("I update a {word} with:", async function (this: ConformanceWorld, model: string, jsonStr: string) {
  const input = JSON.parse(jsonStr) as Record<string, unknown>;
  const substituted = this.substituteInJson(input) as Record<string, unknown>;

  const client = await this.getClient();
  const result: any = await (client.models as any)[model].update(substituted);

  this.result = {
    data: result.data ?? null,
    errors: result.errors ?? [],
  };
});

// ============================================================================
// Model Operations - Delete
// ============================================================================

When("I delete a {word} with key:", async function (this: ConformanceWorld, model: string, jsonStr: string) {
  const keyObj = JSON.parse(jsonStr) as Record<string, unknown>;
  const substituted = this.substituteInJson(keyObj) as Record<string, unknown>;

  const client = await this.getClient();
  const result: any = await (client.models as any)[model].delete(substituted);

  this.result = {
    data: result.data ?? null,
    errors: result.errors ?? [],
  };
});

// ============================================================================
// Model Operations - List
// ============================================================================

When("I list {word} with:", async function (this: ConformanceWorld, model: string, jsonStr: string) {
  const options = JSON.parse(jsonStr) as Record<string, unknown>;
  const substituted = this.substituteInJson(options) as Record<string, unknown>;

  const client = await this.getClient();
  const result: any = await (client.models as any)[model].list(substituted);

  this.result = {
    data: result.data ?? null,
    errors: result.errors ?? [],
    nextToken: result.nextToken ?? null,
  };

  // Save for pagination
  this.lastCall = {
    model,
    options: substituted,
  };
});

When("I list all {word} with:", async function (this: ConformanceWorld, model: string, jsonStr: string) {
  const options = JSON.parse(jsonStr) as Record<string, unknown>;
  const substituted = this.substituteInJson(options) as Record<string, unknown>;

  const allItems: any[] = [];
  let nextToken: string | null = null;
  let pages = 0;

  const client = await this.getClient();

  do {
    const callOptions: Record<string, unknown> = {
      ...substituted,
      nextToken: nextToken ?? undefined,
    };

    const result: any = await (client.models as any)[model].list(callOptions);

    // Stop on errors
    if (result.errors && result.errors.length > 0) {
      this.result = {
        data: null,
        errors: result.errors,
        nextToken: null,
        pages,
      };
      return;
    }

    allItems.push(...(result.data || []));
    nextToken = result.nextToken ?? null;
    pages++;
  } while (nextToken);

  this.result = {
    data: allItems,
    errors: [],
    nextToken: null,
    pages,
  };

  // Save for pagination
  this.lastCall = {
    model,
    options: substituted,
  };
});

// ============================================================================
// Model Operations - Query
// ============================================================================

When("I query {word} by {word} with:", async function (this: ConformanceWorld, model: string, queryField: string, jsonStr: string) {
  const options = JSON.parse(jsonStr) as {
    key: Record<string, unknown>;
    filter?: Record<string, unknown>;
    limit?: number;
    nextToken?: string;
    sortDirection?: string;
    selectionSet?: string[];
  };

  const key = this.substituteInJson(options.key) as Record<string, unknown>;
  const filter = options.filter ? (this.substituteInJson(options.filter) as Record<string, unknown>) : undefined;

  const client = await this.getClient();
  const queryFn = (client.models as any)[model][queryField];

  const result: any = await queryFn(key, {
    filter,
    limit: options.limit,
    nextToken: options.nextToken,
    sortDirection: options.sortDirection,
    selectionSet: options.selectionSet,
  });

  this.result = {
    data: result.data ?? null,
    errors: result.errors ?? [],
    nextToken: result.nextToken ?? null,
  };

  // Save for pagination
  this.lastCall = {
    model,
    queryField,
    options: {
      key,
      filter,
      limit: options.limit,
      sortDirection: options.sortDirection,
      selectionSet: options.selectionSet,
    },
  };
});

When("I query all {word} by {word} with:", async function (this: ConformanceWorld, model: string, queryField: string, jsonStr: string) {
  const options = JSON.parse(jsonStr) as {
    key: Record<string, unknown>;
    filter?: Record<string, unknown>;
    limit?: number;
    nextToken?: string;
    sortDirection?: string;
    selectionSet?: string[];
  };

  const key = this.substituteInJson(options.key) as Record<string, unknown>;
  const filter = options.filter ? (this.substituteInJson(options.filter) as Record<string, unknown>) : undefined;

  const allItems: any[] = [];
  let nextToken: string | null = null;
  let pages = 0;

  const client = await this.getClient();
  const queryFn = (client.models as any)[model][queryField];

  do {
    const result: any = await queryFn(key, {
      filter,
      limit: options.limit,
      nextToken: nextToken ?? undefined,
      sortDirection: options.sortDirection,
      selectionSet: options.selectionSet,
    });

    // Stop on errors
    if (result.errors && result.errors.length > 0) {
      this.result = {
        data: null,
        errors: result.errors,
        nextToken: null,
        pages,
      };
      return;
    }

    allItems.push(...(result.data || []));
    nextToken = result.nextToken ?? null;
    pages++;
  } while (nextToken);

  this.result = {
    data: allItems,
    errors: [],
    nextToken: null,
    pages,
  };

  // Save for pagination
  this.lastCall = {
    model,
    queryField,
    options: {
      key,
      filter,
      limit: options.limit,
      sortDirection: options.sortDirection,
      selectionSet: options.selectionSet,
    },
  };
});

// ============================================================================
// Pagination
// ============================================================================

When("I ask for the next page", async function (this: ConformanceWorld) {
  if (!this.lastCall) {
    throw new Error("No previous list or query call to paginate from");
  }

  if (!this.result.nextToken) {
    throw new Error("No nextToken in result to paginate with");
  }

  const client = await this.getClient();

  if (this.lastCall.queryField) {
    // Query call
    const queryFn = (client.models as any)[this.lastCall.model][this.lastCall.queryField];
    const key = this.lastCall.options.key as Record<string, unknown>;

    const callOptions: Record<string, unknown> = {
      ...this.lastCall.options,
      key: undefined, // key is not part of the options object
      nextToken: this.result.nextToken,
    };
    const result: any = await queryFn(key, callOptions);

    this.result = {
      data: result.data ?? null,
      errors: result.errors ?? [],
      nextToken: result.nextToken ?? null,
    };
  } else {
    // List call
    const callOptions: Record<string, unknown> = {
      ...this.lastCall.options,
      nextToken: this.result.nextToken,
    };
    const result: any = await (client.models as any)[this.lastCall.model].list(callOptions);

    this.result = {
      data: result.data ?? null,
      errors: result.errors ?? [],
      nextToken: result.nextToken ?? null,
    };
  }
});

When("I ask for the next page with token {string}", async function (this: ConformanceWorld, token: string) {
  if (!this.lastCall) {
    throw new Error("No previous list or query call to paginate from");
  }

  const substituted = this.substituteInJson(token) as string;

  const client = await this.getClient();

  if (this.lastCall.queryField) {
    // Query call
    const queryFn = (client.models as any)[this.lastCall.model][this.lastCall.queryField];
    const key = this.lastCall.options.key as Record<string, unknown>;

    const callOptions: Record<string, unknown> = {
      ...this.lastCall.options,
      key: undefined,
      nextToken: substituted,
    };
    const result: any = await queryFn(key, callOptions);

    this.result = {
      data: result.data ?? null,
      errors: result.errors ?? [],
      nextToken: result.nextToken ?? null,
    };
  } else {
    // List call
    const callOptions: Record<string, unknown> = {
      ...this.lastCall.options,
      nextToken: substituted,
    };
    const result: any = await (client.models as any)[this.lastCall.model].list(callOptions);

    this.result = {
      data: result.data ?? null,
      errors: result.errors ?? [],
      nextToken: result.nextToken ?? null,
    };
  }
});

// ============================================================================
// Fixtures
// ============================================================================

Given("these {word} records exist:", async function (this: ConformanceWorld, model: string, jsonStr: string) {
  const items = JSON.parse(jsonStr) as Record<string, unknown>[];

  const client = await this.getClient();

  for (const item of items) {
    const substituted = this.substituteInJson(item) as Record<string, unknown>;

    try {
      const data = await (client.models as any)[model].create(substituted);
      // If we want to track created items, we could do that here
    } catch (error) {
      throw new Error(`Failed to create ${model}: ${(error as Error).message}`);
    }
  }
});

Given("I remember data field {string} as {string}", function (this: ConformanceWorld, fieldPath: string, name: string) {
  this.rememberDataField(fieldPath, name);
});

// ============================================================================
// Assertions - Call Result
// ============================================================================

Then("the call succeeds", function (this: ConformanceWorld) {
  if (this.result.errors && this.result.errors.length > 0) {
    throw new Error(`Expected call to succeed, but got errors: ${JSON.stringify(this.result.errors)}`);
  }
});

Then("the call fails", function (this: ConformanceWorld) {
  if (!this.result.errors || this.result.errors.length === 0) {
    throw new Error("Expected call to fail, but it succeeded");
  }
});

Then("the error type is {string}", function (this: ConformanceWorld, expectedType: string) {
  if (!this.result.errors || this.result.errors.length === 0) {
    throw new Error("Expected error, but call succeeded");
  }
  const actualType = this.result.errors[0].errorType || "Unknown";
  if (actualType !== expectedType) {
    throw new Error(`Expected error type "${expectedType}", got "${actualType}"`);
  }
});

Then("the error message contains {string}", function (this: ConformanceWorld, substring: string) {
  if (!this.result.errors || this.result.errors.length === 0) {
    throw new Error("Expected error, but call succeeded");
  }
  const message = this.result.errors[0].message.toLowerCase();
  if (!message.includes(substring.toLowerCase())) {
    throw new Error(`Expected error message to contain "${substring}", got "${this.result.errors[0].message}"`);
  }
});

// ============================================================================
// Assertions - Data
// ============================================================================

Then("data is null", function (this: ConformanceWorld) {
  if (this.result.data !== null) {
    throw new Error(`Expected data to be null, got: ${JSON.stringify(this.result.data)}`);
  }
});

Then("data matches:", function (this: ConformanceWorld, expectedJson: string) {
  const expected = JSON.parse(expectedJson);
  const substituted = this.substituteInJson(expected);
  assertMatches(substituted, this.result.data);
});

Then("data has {int} items", function (this: ConformanceWorld, count: number) {
  assertHasNItems(this.result.data, count);
});

Then("data contains exactly these items in any order:", function (this: ConformanceWorld, expectedJson: string) {
  const expected = JSON.parse(expectedJson) as unknown[];
  const substituted = this.substituteInJson(expected) as unknown[];

  if (!arrayMatchesAnyOrder(substituted, this.result.data as unknown[])) {
    throw new Error(
      `Array items do not match in any order.\nExpected: ${JSON.stringify(substituted)}\nGot: ${JSON.stringify(this.result.data)}`
    );
  }
});

Then("data contains exactly these items in this order:", function (this: ConformanceWorld, expectedJson: string) {
  const expected = JSON.parse(expectedJson) as unknown[];
  const substituted = this.substituteInJson(expected) as unknown[];

  if (!arrayMatchesExact(substituted, this.result.data as unknown[])) {
    throw new Error(
      `Array items do not match in order.\nExpected: ${JSON.stringify(substituted)}\nGot: ${JSON.stringify(this.result.data)}`
    );
  }
});

Then("data field {string} has {int} items", function (this: ConformanceWorld, fieldPath: string, count: number) {
  const value = getAtPath(this.result.data, fieldPath);
  assertHasNItems(value, count, fieldPath);
});

Then("data field {string} is {string}", function (this: ConformanceWorld, fieldPath: string, expectedStr: string) {
  const actual = getAtPath(this.result.data, fieldPath);
  const actualStr = actual === null ? "null" : String(actual);
  if (actualStr !== expectedStr) {
    throw new Error(
      `Expected data field "${fieldPath}" to be "${expectedStr}", got "${actualStr}"`
    );
  }
});

// ============================================================================
// Assertions - Pagination
// ============================================================================

Then("there is a next token", function (this: ConformanceWorld) {
  if (!this.result.nextToken) {
    throw new Error("Expected nextToken to be present and non-empty");
  }
});

Then("there is no next token", function (this: ConformanceWorld) {
  if (this.result.nextToken) {
    throw new Error(`Expected no nextToken, but got: ${this.result.nextToken}`);
  }
});

Then("{int} pages were fetched", function (this: ConformanceWorld, expectedPages: number) {
  if (this.result.pages !== expectedPages) {
    throw new Error(`Expected ${expectedPages} pages, but got ${this.result.pages}`);
  }
});

// ============================================================================
// Domain Operations (pending)
// ============================================================================

When(
  "I keep candidate {string} with:",
  async function (this: ConformanceWorld, candidateId: string, jsonStr: string) {
    const options = JSON.parse(jsonStr);
    const substituted = this.substituteInJson(options) as {
      stars?: number;
      tags?: string[];
      name?: string;
      crates?: string[];
    };
    const domainResult = await this.domain.keepCandidate(candidateId, substituted);
    this.result = {
      data: domainResult.data,
      errors: (domainResult.errors as Array<{ message: string; errorType?: string }>) || null,
    };
  }
);

When("I skip candidate {string}", async function (this: ConformanceWorld, candidateId: string) {
  const domainResult = await this.domain.skipCandidate(candidateId);
  this.result = {
    data: domainResult.data,
    errors: (domainResult.errors as Array<{ message: string; errorType?: string }>) || null,
  };
});

When("I put off candidate {string}", async function (this: ConformanceWorld, candidateId: string) {
  const domainResult = await this.domain.putOffCandidate(candidateId);
  this.result = {
    data: domainResult.data,
    errors: (domainResult.errors as Array<{ message: string; errorType?: string }>) || null,
  };
});

When(
  "I merge markup for sample {string} with:",
  async function (this: ConformanceWorld, sampleId: string, jsonStr: string) {
    const clips = JSON.parse(jsonStr);
    const substituted = this.substituteInJson(clips) as Array<{
      kind: string;
      start: number;
      end: number;
      rank?: number;
      evidence?: unknown;
    }>;
    const domainResult = await this.domain.mergeMarkup(sampleId, substituted);
    this.result = {
      data: domainResult.data,
      errors: (domainResult.errors as Array<{ message: string; errorType?: string }>) || null,
    };
  }
);

When(
  "I save score {string} with text:",
  async function (this: ConformanceWorld, scoreId: string, aprText: string) {
    const domainResult = await this.domain.saveScore(scoreId, aprText);
    this.result = {
      data: domainResult.data,
      errors: (domainResult.errors as Array<{ message: string; errorType?: string }>) || null,
    };
  }
);

Then("sample {string} has these active clips:", async function (this: ConformanceWorld, sampleId: string, expectedJson: string) {
  const expected = JSON.parse(expectedJson) as unknown[];
  const substituted = this.substituteInJson(expected) as unknown[];

  const client = await this.getClient();

  // Collect all active clips for this sample
  const allClips: any[] = [];
  let nextToken: string | null = null;

  do {
    const result: any = await client.models.Clip.clipsBySample(
      { sampleId },
      { nextToken: nextToken ?? undefined }
    );

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Failed to fetch clips: ${result.errors[0].message}`);
    }

    allClips.push(...(result.data || []));
    nextToken = result.nextToken ?? null;
  } while (nextToken);

  // Filter to active clips only
  const activeClips = allClips.filter((s: any) => !s.retired);

  if (!arrayMatchesExact(substituted, activeClips)) {
    throw new Error(
      `Active clips do not match in order.\nExpected: ${JSON.stringify(substituted)}\nGot: ${JSON.stringify(activeClips)}`
    );
  }
});

Then("sample {string} has these retired clips:", async function (this: ConformanceWorld, sampleId: string, expectedJson: string) {
  const expected = JSON.parse(expectedJson) as unknown[];
  const substituted = this.substituteInJson(expected) as unknown[];

  const client = await this.getClient();

  // Collect all retired clips for this sample
  const allClips: any[] = [];
  let nextToken: string | null = null;

  do {
    const result: any = await client.models.Clip.clipsBySample(
      { sampleId },
      { nextToken: nextToken ?? undefined }
    );

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Failed to fetch clips: ${result.errors[0].message}`);
    }

    allClips.push(...(result.data || []));
    nextToken = result.nextToken ?? null;
  } while (nextToken);

  // Filter to retired clips only
  const retiredClips = allClips.filter((s: any) => s.retired);

  if (!arrayMatchesExact(substituted, retiredClips)) {
    throw new Error(
      `Retired clips do not match in order.\nExpected: ${JSON.stringify(substituted)}\nGot: ${JSON.stringify(retiredClips)}`
    );
  }
});

// ============================================================================
// Checker Steps (full privilege list)
// ============================================================================

Then(
  "exactly {int} {word} records match:",
  async function (this: ConformanceWorld, expectedCount: number, model: string, filterJson: string) {
    const filter = JSON.parse(filterJson);
    const substituted = this.substituteInJson(filter);

    // Create a checker client (fully privileged with ALL groups)
    const checkerIdentity = { sub: "checker", groups: ["members", "curators", "admins"] };
    const checkerClient = generateClient<Schema>({
      authMode: "apiKey",
      headers: {
        "x-apricity-identity": JSON.stringify(checkerIdentity),
      },
    });

    // Collect all pages to avoid undercounting (limit applies before filter)
    const allItems: any[] = [];
    let nextToken: string | null = null;

    do {
      const result: any = await (checkerClient.models as any)[model].list({
        filter: substituted,
        nextToken: nextToken ?? undefined,
      });

      if (result.errors && result.errors.length > 0) {
        throw new Error(`Checker list failed: ${result.errors[0].message}`);
      }

      allItems.push(...(result.data || []));
      nextToken = result.nextToken ?? null;
    } while (nextToken);

    const count = allItems.length;

    if (count !== expectedCount) {
      throw new Error(`Expected ${expectedCount} records matching filter, got ${count}`);
    }
  }
);
