// Amplify's browser auth picks the sign-in return address by taking the FIRST listed URL whose text contains the
// current hostname. "https://play.apricity.anth.us/" contains "apricity.anth.us", so the apex must be listed before
// the play hostname or a sign-in started on the apex would land on play. Each hostname must reach its own URL.
export const PRODUCTION_AUTH_REDIRECT_URLS = [
  "https://apricity.anth.us/",
  "https://play.apricity.anth.us/",
];

export const DEVELOPMENT_AUTH_REDIRECT_URLS = [
  "http://localhost:5173/",
  "http://127.0.0.1:5181/",
];

export const DEFAULT_AUTH_REDIRECT_URLS = [...DEVELOPMENT_AUTH_REDIRECT_URLS, ...PRODUCTION_AUTH_REDIRECT_URLS];

export function resolveAuthRedirectUrls(commaSeparatedOverride: string | undefined): string[] {
  const trimmedOverride = (commaSeparatedOverride ?? "").trim();
  if (!trimmedOverride) return DEFAULT_AUTH_REDIRECT_URLS;
  return trimmedOverride
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}
