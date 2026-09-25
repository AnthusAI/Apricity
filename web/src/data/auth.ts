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
 * Local mode: returns the identity from outputs.custom.apricity.identity
 * Cloud mode: delegates to aws-amplify/auth
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (mode() === "local") {
    // Local mode: return cached identity from Amplify config
    if (cachedIdentity) return cachedIdentity;

    const config = Amplify.getConfig();
    const customConfig = (config as any).custom?.apricity;
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

// ---- Cloud sign-in (Cognito email + password, optional Google). Thin wrappers over aws-amplify/auth.
// Passwords are only ever passed straight through to Cognito: never stored, logged or put in an Error.

/** The slice of aws-amplify/auth the wrappers use. Tests replace it with `setAuthApiLoader`. */
export interface AuthApi {
  signIn(input: { username: string; password: string }): Promise<{ isSignedIn: boolean; nextStep?: { signInStep?: string } }>;
  signUp(input: {
    username: string;
    password: string;
    options?: { userAttributes?: Record<string, string> };
  }): Promise<{ isSignUpComplete: boolean; nextStep?: { signUpStep?: string } }>;
  confirmSignUp(input: { username: string; confirmationCode: string }): Promise<{ isSignUpComplete: boolean }>;
  resendSignUpCode(input: { username: string }): Promise<unknown>;
  signOut(): Promise<void>;
  getCurrentUser(): Promise<{ userId: string; username?: string; signInDetails?: { loginId?: string } }>;
  fetchAuthSession(): Promise<{ tokens?: { idToken?: { payload?: Record<string, unknown> }; accessToken?: { payload?: Record<string, unknown> } } }>;
  signInWithRedirect(input: { provider: string }): Promise<void>;
}

let loadAuthApi: () => Promise<AuthApi> = async () => (await import("aws-amplify/auth")) as unknown as AuthApi;

/** Test hook: swap the aws-amplify/auth module for a stub. */
export function setAuthApiLoader(loader: (() => Promise<AuthApi>) | null): void {
  loadAuthApi = loader ?? (async () => (await import("aws-amplify/auth")) as unknown as AuthApi);
}

export type AuthStep =
  | { kind: "signed-in" }
  | { kind: "confirm-sign-up"; email: string }
  | { kind: "unsupported"; step: string };

export interface Account {
  /** Cognito `sub` (the `sub` identity claim) and `cognito:username` (the other one the contract uses). */
  sub: string;
  username: string;
  email: string;
  groups: string[];
  admin: boolean;
}

/** Errors shown to the person: a message and, when useful, the step the form should move to. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Turn a Cognito/Amplify error into a plain sentence. Never includes request input (passwords). */
export function friendlyAuthError(err: unknown): AuthError {
  const name = String((err as any)?.name ?? (err as any)?.code ?? "Error");
  const raw = String((err as any)?.message ?? "");
  switch (name) {
    case "UserLambdaValidationException":
      return new AuthError("This email address is not allowed to sign up. Apricity accounts are invite-only.", name);
    case "NotAuthorizedException":
      return /disabled/i.test(raw)
        ? new AuthError("This account is disabled.", name)
        : new AuthError("Wrong email or password.", name);
    case "UserNotFoundException":
      return new AuthError("Wrong email or password.", name);
    case "UserNotConfirmedException":
      return new AuthError("This account is not confirmed yet. Enter the code we emailed you.", name);
    case "UsernameExistsException":
      return new AuthError("An account with this email already exists. Sign in instead, or resend the confirmation code.", name);
    case "InvalidPasswordException":
      return new AuthError("That password is too weak. Use at least 8 characters with upper and lower case letters and a number.", name);
    case "InvalidParameterException":
      return new AuthError(raw.includes("password") ? "That password does not meet the requirements." : "Check the email address and try again.", name);
    case "CodeMismatchException":
      return new AuthError("That code is not right. Check the latest email and try again.", name);
    case "ExpiredCodeException":
      return new AuthError("That code has expired. Use “Resend code” to get a new one.", name);
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return new AuthError("Too many attempts. Wait a few minutes and try again.", name);
    case "NetworkError":
      return new AuthError("Could not reach the sign-in service. Check your connection.", name);
    case "EmptySignInUsername":
    case "EmptySignInPassword":
    case "EmptySignUpPassword":
      return new AuthError("Enter your email and password.", name);
    case "AuthAlreadySignedInException":
    case "UserAlreadyAuthenticatedException":
      return new AuthError("You are already signed in.", name);
    default:
      return new AuthError("Sign-in failed. Please try again.", name);
  }
}

/** Groups from a token payload (`cognito:groups`), tolerant of missing or odd shapes. */
export function groupsFromPayload(payload: Record<string, unknown> | undefined): string[] {
  const g = payload?.["cognito:groups"];
  return Array.isArray(g) ? g.filter((x): x is string => typeof x === "string") : [];
}

/** True when Amplify was configured with a hosted-UI (OAuth) domain, i.e. a social provider is set up. */
export function googleAvailable(): boolean {
  if (mode() === "local") return false;
  const oauth = (Amplify.getConfig() as any)?.Auth?.Cognito?.loginWith?.oauth;
  if (!oauth?.domain) return false;
  const providers: unknown = oauth.providers;
  return Array.isArray(providers) ? providers.some((p) => String(p).toLowerCase() === "google") : true;
}

/** Email + group info for the signed-in user; null when signed out (never throws). */
export async function currentAccount(): Promise<Account | null> {
  if (mode() === "local") return null;
  const api = await loadAuthApi();
  try {
    const user = await api.getCurrentUser();
    let payload: Record<string, unknown> | undefined;
    let access: Record<string, unknown> | undefined;
    try {
      const session = await api.fetchAuthSession();
      payload = session.tokens?.idToken?.payload;
      access = session.tokens?.accessToken?.payload;
    } catch {
      /* fall back to what getCurrentUser knows */
    }
    const groups = [...new Set([...groupsFromPayload(access), ...groupsFromPayload(payload)])];
    const email = (typeof payload?.email === "string" && payload.email) || user.signInDetails?.loginId || user.username || "signed in";
    return { sub: user.userId, username: user.username ?? user.userId, email, groups, admin: groups.includes("admins") };
  } catch {
    return null;
  }
}

function stepFromSignIn(email: string, r: { isSignedIn: boolean; nextStep?: { signInStep?: string } }): AuthStep {
  if (r.isSignedIn) return { kind: "signed-in" };
  const step = r.nextStep?.signInStep ?? "UNKNOWN";
  if (step === "CONFIRM_SIGN_UP") return { kind: "confirm-sign-up", email };
  if (step === "DONE") return { kind: "signed-in" };
  return { kind: "unsupported", step };
}

function announceAuthChanged(): void {
  if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("apricity:auth-changed"));
}

/** Email + password sign in. Throws AuthError; an unconfirmed user comes back as a confirm step. */
export async function signInWithPassword(email: string, password: string): Promise<AuthStep> {
  const api = await loadAuthApi();
  try {
    const step = stepFromSignIn(email, await api.signIn({ username: email.trim(), password }));
    if (step.kind === "signed-in") announceAuthChanged();
    return step;
  } catch (err) {
    const e = friendlyAuthError(err);
    if (e.code === "UserNotConfirmedException") return { kind: "confirm-sign-up", email };
    if (e.code === "UserAlreadyAuthenticatedException" || e.code === "AuthAlreadySignedInException") {
      announceAuthChanged();
      return { kind: "signed-in" };
    }
    throw e;
  }
}

/** Create an account; Cognito emails a confirmation code. Throws AuthError (e.g. email not allowed). */
export async function signUpWithPassword(email: string, password: string): Promise<AuthStep> {
  const api = await loadAuthApi();
  try {
    const r = await api.signUp({ username: email.trim(), password, options: { userAttributes: { email: email.trim() } } });
    if (r.isSignUpComplete) return { kind: "signed-in" };
    return { kind: "confirm-sign-up", email };
  } catch (err) {
    throw friendlyAuthError(err);
  }
}

/** Submit the emailed code. Afterwards the caller signs in with the password it still holds in the form. */
export async function confirmSignUpCode(email: string, code: string): Promise<void> {
  const api = await loadAuthApi();
  try {
    await api.confirmSignUp({ username: email.trim(), confirmationCode: code.trim() });
  } catch (err) {
    throw friendlyAuthError(err);
  }
}

export async function resendConfirmationCode(email: string): Promise<void> {
  const api = await loadAuthApi();
  try {
    await api.resendSignUpCode({ username: email.trim() });
  } catch (err) {
    throw friendlyAuthError(err);
  }
}

/** Sign out of Cognito (cloud) and tell the views. */
export async function signOutAccount(): Promise<void> {
  if (mode() === "local") return;
  const api = await loadAuthApi();
  try {
    await api.signOut();
  } catch (err) {
    throw friendlyAuthError(err);
  }
  announceAuthChanged();
}

/** Google via the hosted UI; leaves the page. */
export async function signInWithGoogle(): Promise<void> {
  const api = await loadAuthApi();
  try {
    await api.signInWithRedirect({ provider: "Google" });
  } catch (err) {
    throw friendlyAuthError(err);
  }
}
