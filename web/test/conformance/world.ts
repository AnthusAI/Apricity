import { IWorldOptions, World } from "@cucumber/cucumber";
import { generateClient } from "aws-amplify/api";
import type { Schema } from "../../amplify/data/resource.js";
import { DomainContext, createRealDomainContext } from "./domain.js";
import { getAtPath } from "./match.js";

export interface Identity {
  sub: string;
  groups: string[];
}

export interface ApiResult {
  data: unknown;
  errors: Array<{ message: string; errorType?: string }> | null;
  nextToken?: string | null;
  pages?: number; // For "list all" calls
}

export interface LastCall {
  model: string;
  queryField?: string;
  options: Record<string, unknown>;
}

/**
 * Cucumber World for conformance tests
 */
export class ConformanceWorld extends World {
  // Current identity
  identity: Identity = { sub: "", groups: [] };

  // Last API call result
  result: ApiResult = { data: null, errors: null };

  // Last list/query call (for pagination)
  lastCall: LastCall | null = null;

  // Remembered values
  remembered: Map<string, unknown> = new Map();

  // Clients per user (for local testing with API key + identity header)
  clients: Map<string, any> = new Map();

  // Domain context (uses real domain.ts functions)
  domain: DomainContext = createRealDomainContext();

  // Target mode: "local" (API key + header) or "sandbox" (userPool auth)
  targetMode: "local" | "sandbox" = "local";

  // Pre-signed in users for sandbox mode
  signedInUsers: Map<string, boolean> = new Map();

  // Current scenario pickle (for tags)
  pickle: any;

  constructor(options: IWorldOptions) {
    super(options);
    this.pickle = (options as any).pickle;
  }

  /**
   * Get the data client for the current user
   */
  async getClient(): Promise<any> {
    if (!this.identity.sub) {
      throw new Error("No current identity set");
    }

    if (this.clients.has(this.identity.sub)) {
      return this.clients.get(this.identity.sub);
    }

    const client = this.createClient();
    this.clients.set(this.identity.sub, client);
    return client;
  }

  /**
   * Create a new client for the current user
   */
  private createClient(): any {
    if (this.targetMode === "local") {
      return this.createLocalClient();
    } else {
      return this.createSandboxClient();
    }
  }

  /**
   * Create local client (API key + identity header)
   */
  private createLocalClient(): any {
    const identityHeader = JSON.stringify({
      sub: this.identity.sub,
      groups: this.identity.groups,
    });

    return generateClient<Schema>({
      authMode: "apiKey",
      headers: {
        "x-apricity-identity": identityHeader,
      },
    });
  }

  /**
   * Create sandbox client (userPool auth)
   * Note: This requires the user to be signed in first
   */
  private createSandboxClient(): any {
    return generateClient<Schema>({
      authMode: "userPool",
    });
  }

  /**
   * Substitute ${name} and ${sub:user} in a string
   */
  substituteInString(value: string): string {
    // ${me} -> current sub
    value = value.replace(/\$\{me\}/g, this.identity.sub);

    // ${sub:user} -> sub of user
    value = value.replace(/\$\{sub:(\w+)\}/g, (match, user) => {
      return this.getUserSub(user);
    });

    // ${name} -> remembered value
    for (const [name, val] of this.remembered.entries()) {
      value = value.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(val));
    }

    return value;
  }

  /**
   * Get the actual sub for a user (for sandbox mode, resolves from SANDBOX_USERS)
   */
  private getUserSub(userName: string): string {
    if (this.targetMode === "sandbox") {
      // In sandbox mode, resolve from SANDBOX_USERS JSON
      const sandboxUsersJson = process.env.SANDBOX_USERS;
      if (sandboxUsersJson) {
        const sandboxUsers = JSON.parse(sandboxUsersJson) as Record<
          string,
          { username: string; password: string; groups: string[]; cognitoSub?: string }
        >;
        const userInfo = sandboxUsers[userName];
        if (userInfo && userInfo.cognitoSub) {
          return userInfo.cognitoSub;
        }
      }
    }
    // For local: user name is their sub
    return userName;
  }

  /**
   * Substitute ${...} in JSON data
   * For a whole string value that is "${name}", replace it with the actual value (keeping type)
   * Otherwise substitute text within strings
   */
  substituteInJson(obj: unknown): unknown {
    if (typeof obj === "string") {
      // Check if the entire string is a reference like "${name}"
      const match = obj.match(/^\$\{(\w+|me|sub:\w+)\}$/);
      if (match) {
        const name = match[1];
        if (name === "me") {
          return this.identity.sub;
        }
        if (name.startsWith("sub:")) {
          const user = name.slice(4);
          return this.getUserSub(user);
        }
        if (this.remembered.has(name)) {
          return this.remembered.get(name);
        }
        throw new Error(`Unknown remembered value: ${name}`);
      }
      // Substitute variables within the string
      return this.substituteInString(obj);
    }

    if (typeof obj === "object" && obj !== null) {
      if (Array.isArray(obj)) {
        return obj.map((item) => this.substituteInJson(item));
      }
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        result[key] = this.substituteInJson(val);
      }
      return result;
    }

    return obj;
  }

  /**
   * Remember a value from result data at a dotted path
   */
  rememberDataField(path: string, name: string): void {
    if (!this.result.data) {
      throw new Error("No data to remember from");
    }
    const value = getAtPath(this.result.data, path);
    if (value === undefined) {
      throw new Error(`No value at path ${path}`);
    }
    this.remembered.set(name, value);
  }
}
