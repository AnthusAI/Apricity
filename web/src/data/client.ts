// Web data layer: client bootstrap and mode selection.

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/api";
import type { Schema } from "../../amplify/data/resource";

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
    apricitus?: {
      mode?: "local" | "cloud";
      identity?: { sub: string; username?: string; groups?: string[] };
    };
  };
}

let cachedMode: "local" | "cloud" = "cloud";
let cachedClient: any = null;

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

    // Determine mode
    cachedMode = outputs.custom?.apricitus?.mode ?? "cloud";
    return cachedMode;
  } catch (error) {
    console.error("Failed to bootstrap data layer:", error);
    cachedMode = "cloud"; // Default to cloud mode on error
    return cachedMode;
  }
}

/**
 * Get the current mode (local or cloud).
 */
export function mode(): "local" | "cloud" {
  return cachedMode;
}

/**
 * Get the Amplify data client, lazily instantiated.
 * The authMode is determined by the Amplify.configure() call during bootstrap.
 */
export function client(): any {
  if (!cachedClient) {
    cachedClient = generateClient();
  }
  return cachedClient;
}
