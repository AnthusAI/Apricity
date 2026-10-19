import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AUTH_REDIRECT_URLS, PRODUCTION_AUTH_REDIRECT_URLS, resolveAuthRedirectUrls } from "./redirect-urls";

// The same fallback rule Amplify's getRedirectUrl applies when the page path is not "/": the first listed URL whose
// text contains the page's hostname.
const firstRedirectUrlContainingHostname = (redirectUrls: string[], hostname: string) =>
  redirectUrls.find((redirectUrl) => redirectUrl.includes(hostname));

describe("resolveAuthRedirectUrls", () => {
  it("defaults include both production hostnames", () => {
    assert.ok(DEFAULT_AUTH_REDIRECT_URLS.includes("https://apricity.anth.us/"));
    assert.ok(DEFAULT_AUTH_REDIRECT_URLS.includes("https://play.apricity.anth.us/"));
  });
  it("a sign-in on each production hostname returns to that same hostname", () => {
    for (const productionUrl of PRODUCTION_AUTH_REDIRECT_URLS) {
      const hostname = new URL(productionUrl).hostname;
      assert.equal(firstRedirectUrlContainingHostname(DEFAULT_AUTH_REDIRECT_URLS, hostname), productionUrl);
    }
  });
  it("an explicit override replaces the defaults", () => {
    assert.deepEqual(resolveAuthRedirectUrls(" https://a.example/ , ,https://b.example/ "), ["https://a.example/", "https://b.example/"]);
    assert.deepEqual(resolveAuthRedirectUrls("   "), DEFAULT_AUTH_REDIRECT_URLS);
    assert.deepEqual(resolveAuthRedirectUrls(undefined), DEFAULT_AUTH_REDIRECT_URLS);
  });
});
