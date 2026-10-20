// What the static host needs to answer every client route with a real HTML document (HTTP 200) and what
// crawlers look for. The route list is route.ts's PAGES, so a new page cannot be forgotten.

import { PAGES, titleOf, type Page } from "../src/route.ts";

export const SITE_ORIGIN = "https://apricity.anth.us";

/** Pages that need a session or a query to mean anything; they are served but not listed for crawlers. */
const UNLISTED: Page[] = ["listen", "labs", "search"];

/** The URL paths that are routes, other than "/", which index.html already answers. */
export const routePaths = (): string[] => PAGES.filter((p) => p !== "home").map((p) => `/${p}`);

/** The document for one route: index.html with that route's title and address. */
export function routeHtml(indexHtml: string, page: Page): string {
  const title = titleOf({ page });
  const url = `${SITE_ORIGIN}/${page}`;
  return indexHtml
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace("</head>", `  <link rel="canonical" href="${url}" />\n  </head>`);
}

/** Where each route's document goes in the build output. */
export const routeFile = (page: Page): string => `${page}/index.html`;

export function sitemapXml(): string {
  const urls = ["/", ...PAGES.filter((p) => p !== "home" && !UNLISTED.includes(p)).map((p) => `/${p}`)];
  const entries = urls.map((u) => `  <url><loc>${SITE_ORIGIN}${u}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

export const robotsTxt = (): string => `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;
