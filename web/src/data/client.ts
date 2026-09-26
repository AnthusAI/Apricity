// Web data layer: client bootstrap and mode selection.

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/api";
import type { Schema } from "../../amplify/data/resource";

/** Who `apricity serve` says is working locally (`custom.apricity.identity` in its outputs). */
export interface LocalIdentity {
  sub: string;
  username?: string;
  groups?: string[];
}

interface AmplifyOutputs {
  data?: {
    url: string;
    aws_region: string;
    api_key: string;
    default_authorization_type: string;
    authorization_types: string[];
    model_introspection?: object;
  };
  custom?: {
    apricity?: {
      mode?: "local" | "cloud";
      identity?: LocalIdentity;
    };
  };
}

let cachedMode: "local" | "cloud" = "cloud";
let cachedIdentity: LocalIdentity | null = null;
let cachedClient: any = null;
let signedIn: Promise<boolean> | null = null;

/**
 * Bootstrap the data layer: fetch /amplify_outputs.json, configure Amplify,
 * and determine the mode (local or cloud).
 */
export async function bootstrap(): Promise<"local" | "cloud"> {
  try {
    const response = await fetch("/amplify_outputs.json");
    if (!response.ok) {
      throw new Error(`Failed to fetch amplify_outputs.json: ${response.statusText}`);
    }
    const outputs: AmplifyOutputs = await response.json();

    // Configure Amplify
    Amplify.configure(outputs as any);

    // Determine mode. Amplify.configure keeps only the parts of `custom` it knows, so the local identity is kept here.
    cachedMode = outputs.custom?.apricity?.mode ?? "cloud";
    cachedIdentity = outputs.custom?.apricity?.identity ?? null;
    // Who is signed in decides how the cloud API is called; forget it whenever that changes. (Registered here, before
    // any view listens for the same event, so a view that reloads on it already reads with the new session.)
    if (typeof document !== "undefined") document.addEventListener("apricity:auth-changed", () => (signedIn = null));
    return cachedMode;
  } catch (error) {
    console.error("Failed to bootstrap data layer:", error);
    cachedMode = "cloud"; // Default to cloud mode on error
    return cachedMode;
  }
}

/** The local identity from the outputs (null in the cloud, or before bootstrap). */
export function localIdentity(): LocalIdentity | null {
  return cachedIdentity;
}

/**
 * Get the current mode (local or cloud).
 */
export function mode(): "local" | "cloud" {
  return cachedMode;
}

/** Whether someone is signed in (cached until the next `apricity:auth-changed`). */
function isSignedIn(): Promise<boolean> {
  signedIn ??= import("aws-amplify/auth")
    .then((a) => a.fetchAuthSession())
    .then((s) => !!s.tokens?.idToken)
    .catch(() => false);
  return signedIn;
}

/**
 * Pick the client for each call by who is calling: the site is public, so a guest reads through the identity pool
 * (its unauthenticated role) and a signed-in person through the user pool, which is what owner rules and group rules
 * see. Every `client().models.<Model>.<operation>(...)` resolves the session first.
 */
export function authAware(userPool: any, guest: any, signed: () => Promise<boolean>): any {
  const models = new Proxy(
    {},
    {
      get: (_, model: string) =>
        new Proxy(
          {},
          { get: (_, op: string) => async (...args: unknown[]) => ((await signed()) ? userPool : guest).models[model][op](...args) },
        ),
    },
  );
  return { models };
}

/**
 * Get the Amplify data client, lazily instantiated. Locally (`apricity serve`) it is the API-key client Amplify was
 * configured with; in the cloud it picks the user pool or the identity pool per call (authAware).
 */
export function client(): any {
  if (!cachedClient) {
    cachedClient =
      cachedMode === "local"
        ? generateClient()
        : authAware(generateClient({ authMode: "userPool" }), generateClient({ authMode: "identityPool" }), isSignedIn);
  }
  return cachedClient;
}
