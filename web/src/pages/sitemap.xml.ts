/** /sitemap.xml: `/` and the city pages this site builds (pipeline/src/site.ts). */
import type { APIContext } from "astro";
import { siteCities, siteConfig } from "../../../pipeline/src/site.ts";

export function GET({ site }: APIContext) {
  const base = site ?? new URL("http://localhost/");
  const urls = ["/", ...siteCities(siteConfig()).map((c) => `/${c}`)].map((p) => new URL(p, base).href);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>
`;
  return new Response(body, { headers: { "Content-Type": "application/xml" } });
}
