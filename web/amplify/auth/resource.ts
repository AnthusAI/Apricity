import { defineAuth, secret } from "@aws-amplify/backend";
import { preSignUp } from "./pre-sign-up/resource";
import { postConfirmation } from "./post-confirmation/resource";

// Default OAuth redirect URLs for the Apricity web app
// Overridable via APRICITY_OAUTH_REDIRECT_URLS env var (comma-separated)
const DEFAULT_AUTH_REDIRECT_URLS = [
  "http://localhost:5173/",
  "http://127.0.0.1:5181/",
];

function resolveAuthRedirectUrls(): string[] {
  let raw = "";
  if (typeof process !== "undefined" && process.env.APRICITY_OAUTH_REDIRECT_URLS) {
    raw = process.env.APRICITY_OAUTH_REDIRECT_URLS;
  }
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_AUTH_REDIRECT_URLS;
  return trimmed
    .split(",")
    .map((url: string) => url.trim())
    .filter((url: string) => url.length > 0);
}

function resolveCognitoDomainPrefix(): string | undefined {
  if (typeof process !== "undefined" && process.env.APRICITY_COGNITO_DOMAIN_PREFIX) {
    const prefix = process.env.APRICITY_COGNITO_DOMAIN_PREFIX.trim();
    if (prefix.length > 0) {
      return prefix;
    }
  }
  return undefined;
}

// Sign-in is Google only. Cognito is still the identity store underneath (Amplify's auth is always a user pool;
// Google federates through it), but no email/password sign-up exists once Google is on. Google needs the branch
// secrets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, which exist once the owner has created a Google OAuth client;
// until APRICITY_GOOGLE_AUTH=true is set for the branch, the pool falls back to email sign-in only so the site can
// deploy. Switching the login methods replaces the user pool, so
// do it before anyone has signed up.
function googleAuthEnabled(): boolean {
  return typeof process !== "undefined" && process.env.APRICITY_GOOGLE_AUTH === "true";
}

const oauthUrls = {
  callbackUrls: resolveAuthRedirectUrls(),
  logoutUrls: resolveAuthRedirectUrls(),
  ...(resolveCognitoDomainPrefix() ? { domainPrefix: resolveCognitoDomainPrefix() } : {}),
};

export const auth = defineAuth({
  // Amplify requires email or phone on the pool even for Google sign-in. Email stays on the pool as an attribute;
  // native email sign-ups are refused by the pre-sign-up trigger while APRICITY_GOOGLE_AUTH=true, so Google is the only way in.
  loginWith: googleAuthEnabled()
    ? {
        email: true,
        externalProviders: {
          google: {
            clientId: secret("GOOGLE_CLIENT_ID"),
            clientSecret: secret("GOOGLE_CLIENT_SECRET"),
            scopes: ["email", "profile", "openid"],
            attributeMapping: {
              email: "email",
            },
          },
          ...oauthUrls,
        },
      }
    : { email: true },
  groups: ["members", "curators", "admins"],
  triggers: {
    preSignUp,
    postConfirmation,
  },
  access: (allow) => [
    allow.resource(postConfirmation).to(["addUserToGroup"]),
  ],
});
