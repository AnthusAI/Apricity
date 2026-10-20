import { test } from "node:test";
import assert from "node:assert/strict";

import { PAGES } from "../src/route.ts";
import { robotsTxt, routeFile, routeHtml, routePaths, sitemapXml } from "../scripts/static-routes.ts";

const index = `<head>\n    <title>Apricity</title>\n    <meta property="og:url" content="https://apricity.anth.us/" />\n  </head>`;

test("every page except home is a static route", () => {
  assert.deepEqual(routePaths(), PAGES.filter((p) => p !== "home").map((p) => `/${p}`));
  assert.ok(routePaths().includes("/scores") && routePaths().includes("/about"));
  assert.equal(routeFile("scores"), "scores/index.html");
});

test("a route document carries its own title, address and canonical link", () => {
  assert.equal(
    routeHtml(index, "beats"),
    `<head>\n    <title>Beats · Apricity</title>\n    <meta property="og:url" content="https://apricity.anth.us/beats" />\n    <link rel="canonical" href="https://apricity.anth.us/beats" />\n  </head>`,
  );
});

test("robots.txt allows everything and names the sitemap", () => {
  assert.equal(robotsTxt(), "User-agent: *\nAllow: /\n\nSitemap: https://apricity.anth.us/sitemap.xml\n");
});

test("the sitemap lists home and every public page, and not the session-bound ones", () => {
  const xml = sitemapXml();
  assert.ok(xml.includes("<loc>https://apricity.anth.us/</loc>"));
  for (const p of PAGES.filter((p) => p !== "home" && !["listen", "labs", "search"].includes(p))) {
    assert.ok(xml.includes(`<loc>https://apricity.anth.us/${p}</loc>`), p);
  }
  for (const p of ["listen", "labs", "search"]) assert.ok(!xml.includes(`/${p}<`), p);
});
