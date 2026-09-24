import { defineAuth, secret } from "@aws-amplify/backend";
import { preSignUp } from "./pre-sign-up/resource";
import { postConfirmation } from "./post-confirmation/resource";

// Default OAuth redirect URLs for the Apricitus web app
// Overridable via APRICITUS_OAUTH_REDIRECT_URLS env var (comma-separated)
const DEFAULT_AUTH_REDIRECT_URLS = [
  "http://localhost:5173/",
  "http://127.0.0.1:5181/",
];

function resolveAuthRedirectUrls(): string[] {
  let raw = "";
  if (typeof process !== "undefined" && process.env.APRICITUS_OAUTH_REDIRECT_URLS) {
    raw = process.env.APRICITUS_OAUTH_REDIRECT_URLS;
  }
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_AUTH_REDIRECT_URLS;
  return trimmed
    .split(",")
    .map((url: string) => url.trim())
    .filter((url: string) => url.length > 0);
}

function resolveCognitoDomainPrefix(): string | undefined {
  if (typeof process !== "undefined" && process.env.APRICITUS_COGNITO_DOMAIN_PREFIX) {
    const prefix = process.env.APRICITUS_COGNITO_DOMAIN_PREFIX.trim();
    if (prefix.length > 0) {
      return prefix;
    }
  }
  return undefined;
}

export const auth = defineAuth({
  loginWith: {
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
      callbackUrls: resolveAuthRedirectUrls(),
      logoutUrls: resolveAuthRedirectUrls(),
      ...(resolveCognitoDomainPrefix() ? { domainPrefix: resolveCognitoDomainPrefix() } : {}),
    },
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
