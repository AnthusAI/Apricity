import { CognitoJwtVerifier } from "aws-jwt-verify";
import { FetchError } from "aws-jwt-verify/error";
import type { Jwks, JwksCache } from "aws-jwt-verify/jwk";

export type SemanticAuthContext = Readonly<{ curator: boolean }>;
export type TokenVerifier = Readonly<{ verify: (token: string) => Promise<SemanticAuthContext> }>;
export class AuthenticationError extends Error { constructor(readonly code: "invalid_token" | "auth_unavailable", readonly retryable: boolean) { super(code); this.name = "AuthenticationError"; } }
type CognitoVerifierOptions = Readonly<{ userPoolId: string; clientId: string; jwks?: Jwks; jwksCache?: JwksCache }>;

/** Verifies Cognito access tokens against the configured user pool and client. */
export function createCognitoTokenVerifier(options: CognitoVerifierOptions): TokenVerifier {
  const verifier = CognitoJwtVerifier.create(
    { userPoolId: options.userPoolId, clientId: options.clientId, tokenUse: "access" },
    options.jwksCache ? { jwksCache: options.jwksCache } : undefined,
  );
  if (options.jwks) verifier.cacheJwks(options.jwks);
  return { async verify(token) {
    try {
      // Offline JWKS are intentionally verified synchronously, so an unknown kid cannot become a network request.
      const payload = options.jwks ? verifier.verifySync(token) : await verifier.verify(token);
      // RFC 7519 requires the current time to be strictly before exp. The verifier
      // checks expiration when present, so require a finite NumericDate and enforce
      // the exclusive boundary ourselves without a grace period.
      if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) {
        throw new AuthenticationError("invalid_token", false);
      }
      const groups = payload["cognito:groups"];
      return { curator: Array.isArray(groups) && groups.some((group) => group === "curators" || group === "admins") };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw error instanceof FetchError ? new AuthenticationError("auth_unavailable", true) : new AuthenticationError("invalid_token", false);
    }
  } };
}
/** Missing authorization remains public; malformed authorization is never downgraded to a guest. */
export async function authenticate(authorization: string | undefined, verifier: TokenVerifier): Promise<SemanticAuthContext> {
  if (authorization === undefined) return { curator: false };
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) throw new AuthenticationError("invalid_token", false);
  return verifier.verify(match[1]);
}
