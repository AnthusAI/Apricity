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

// Google sign-in needs the branch secrets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, which only exist once the
// owner has created a Google OAuth client. Until APRICITY_GOOGLE_AUTH=true is set for the branch, the app uses
// email sign-in only (still restricted by the pre-sign-up allow-list).
function googleAuthEnabled(): boolean {
  return typeof process !== "undefined" && process.env.APRICITY_GOOGLE_AUTH === "true";
}

const oauthUrls = {
  callbackUrls: resolveAuthRedirectUrls(),
  logoutUrls: resolveAuthRedirectUrls(),
  ...(resolveCognitoDomainPrefix() ? { domainPrefix: resolveCognitoDomainPrefix() } : {}),
};

export const auth = defineAuth({
  loginWith: {
    email: true,
    ...(googleAuthEnabled()
      ? {
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
      : {}),
  },
  groups: ["members", "curators", "admins"],
  triggers: {
    preSignUp,
    postConfirmation,
  },
  access: (allow) => [
    allow.resource(postConfirmation).to(["addUserToGroup"]),
  ],
});
