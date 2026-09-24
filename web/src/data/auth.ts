// Web data layer: authentication facade with local and cloud backends.

import { Amplify } from "aws-amplify";
import { mode } from "./client.js";

interface AuthUser {
  userId: string;
  username?: string;
  signInDetails?: unknown;
}

interface CurrentUser {
  sub: string;
  username?: string;
  groups?: string[];
}

interface AuthSession {
  credentials?: unknown;
  userSub?: string;
  tokens?: unknown;
  identityId?: string;
}

let cachedIdentity: CurrentUser | null = null;

/**
 * Get the current user's identity.
 * Local mode: returns the identity from outputs.custom.apricitus.identity
 * Cloud mode: delegates to aws-amplify/auth
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (mode() === "local") {
    // Local mode: return cached identity from Amplify config
    if (cachedIdentity) return cachedIdentity;

    const config = Amplify.getConfig();
    const customConfig = (config as any).custom?.apricitus;
    const identity = customConfig?.identity;
    if (identity) {
      cachedIdentity = {
        sub: identity.sub,
        username: identity.username,
        groups: identity.groups,
      };
      return cachedIdentity;
    }
    return null;
  } else {
    // Cloud mode: use aws-amplify/auth
    const { getCurrentUser: amplifyGetCurrentUser } = await import("aws-amplify/auth");
    try {
      const user = await amplifyGetCurrentUser();
      return {
        sub: user.userId,
        username: user.username,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Sign in with a provider (Google).
 * Local mode: no-op (returns immediately)
 * Cloud mode: delegates to aws-amplify/auth
 */
export async function signInWithRedirect({
  provider,
}: {
  provider: "Google" | string;
}): Promise<void> {
  if (mode() === "local") {
    // Local mode: no-op
    return;
  } else {
    // Cloud mode: use aws-amplify/auth
    const { signInWithRedirect: amplifySignInWithRedirect } = await import("aws-amplify/auth");
    await amplifySignInWithRedirect({ provider: provider as any });
  }
}

/**
 * Sign out.
 * Local mode: no-op
 * Cloud mode: delegates to aws-amplify/auth
 */
export async function signOut(): Promise<void> {
  if (mode() === "local") {
    // Local mode: no-op
    cachedIdentity = null;
    return;
  } else {
    // Cloud mode: use aws-amplify/auth
    const { signOut: amplifySignOut } = await import("aws-amplify/auth");
    await amplifySignOut();
  }
}

/**
 * Get the owner value for Crate queries and Verdict upserts.
 * Returns `${sub}::${username}` in both local and cloud modes.
 * The username comes from the identity endpoint or aws-amplify/auth.
 */
export async function ownerValue(): Promise<string> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("No authenticated user");
  }
  const username = currentUser.username || "unknown";
  return `${currentUser.sub}::${username}`;
}

/**
 * Fetch the current auth session.
 * Local mode: returns a minimal session
 * Cloud mode: delegates to aws-amplify/auth
 */
export async function fetchAuthSession(): Promise<AuthSession | null> {
  if (mode() === "local") {
    // Local mode: return minimal session
    const user = await getCurrentUser();
    if (user) {
      return {
        userSub: user.sub,
      };
    }
    return null;
  } else {
    // Cloud mode: use aws-amplify/auth
    const { fetchAuthSession: amplifyFetchAuthSession } = await import("aws-amplify/auth");
    try {
      const session = await amplifyFetchAuthSession();
      return {
        credentials: session.credentials,
        userSub: session.userSub,
        tokens: session.tokens,
        identityId: session.identityId,
      };
    } catch {
      return null;
    }
  }
}
