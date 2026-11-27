/** /robots.txt: everything may be crawled; the sitemap lists the pages. */
import type { APIContext } from "astro";

export function GET({ site }: APIContext) {
  const sitemap = new URL("/sitemap.xml", site ?? new URL("http://localhost/")).href;
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`, { headers: { "Content-Type": "text/plain" } });
}
