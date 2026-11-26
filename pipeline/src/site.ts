/**
 * What the built site is: its name, the city `/` opens, the regions it serves and who made it. Unset, it is
 * Isometric World (isometriccity.com): every city, a city picker at `/`. A maker hosting their own map from
 * their own bucket sets these in .env (see .env.example and docs/hosting-isometrickrakow.md):
 *
 *   SITE_NAME=Isometric Kraków
 *   SITE_HOME=krakow                     # `/` opens this city's map instead of the city picker
 *   SITE_REGIONS=wieliczka               # only these regions' cities get pages (the bucket has no others)
 *   SITE_DESCRIPTION=…                   # meta description of `/`
 *   SITE_MAKERS=Made by [Piotr Kulpiński](https://kulpinski.dev) · Wieliczka by [Maciek Chmura](https://maciek.cloud/)
 *   SITE_SOURCE=https://github.com/<you>/isometricworld   # the code this site was built from (ODbL: the method)
 *   SITE_ICONS=/sites/isometric-krakow   # folder in web/public with this site's favicon set
 *   SITE_REDIRECTS=wieliczka:krakow      # old city links this site no longer builds → a city it does (301)
 *
 * With SITE_MAKERS set, the map footer shows those lines instead of the region's makers, followed by
 * "Built on Isometric World by Dmytro Krasun".
 */
import { CITIES } from "./places.ts";

const env = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const UPSTREAM = {
  name: "Isometric World",
  url: "https://isometriccity.com",
  source: "https://github.com/krasun/isometricworld",
  author: { text: "Dmytro Krasun", href: "https://dmytrokrasun.com" },
};

export interface Site {
  name: string;
  /** city slug `/` opens; empty: the city picker */
  home: string;
  /** regions served; empty: all */
  regions: string[];
  description: string;
  /** "Made by [Name](url) · …": shown instead of the region's makers; empty: the region's own */
  makers: string;
  source: string;
  /** path prefix of the favicon set in web/public, "" for the default one */
  icons: string;
  /** file name (no extension) of the social card of `/` in web/public/og */
  homeOg: string;
  /** old city slug → city slug it now opens (301, query kept) */
  redirects: Record<string, string>;
}

const slug = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").replace(/ł/g, "l").replace(/Ł/g, "L")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function siteConfig(): Site {
  const e = env();
  const name = e.SITE_NAME || UPSTREAM.name, home = e.SITE_HOME || "";
  if (home && !CITIES[home]) throw new Error(`SITE_HOME=${home} is not a city in places.ts`);
  return {
    name, home,
    regions: list(e.SITE_REGIONS),
    description: e.SITE_DESCRIPTION || (home ? `${CITIES[home].title}: an isometric city map from open data.` : "Isometric city maps from open data."),
    makers: e.SITE_MAKERS || "",
    source: e.SITE_SOURCE || UPSTREAM.source,
    icons: (e.SITE_ICONS || "").replace(/\/+$/, ""),
    homeOg: name === UPSTREAM.name ? "index" : slug(name),
    redirects: Object.fromEntries(list(e.SITE_REDIRECTS).map((pair) => {
      const [from, to] = pair.split(":").map((s) => s.trim());
      if (!/^[a-z0-9-]+$/.test(from ?? "") || !CITIES[to ?? ""]) throw new Error(`SITE_REDIRECTS: "${pair}" is not <old-slug>:<city slug>`);
      return [from, to];
    })),
  };
}

/** the cities this site builds pages for */
export const siteCities = (site: Site) =>
  Object.keys(CITIES).filter((c) => !site.regions.length || site.regions.includes(CITIES[c].region));

/** "[text](url)" links in an env line → HTML (everything else escaped) */
export function linkify(line: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let out = "", last = 0;
  for (const m of line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    out += esc(line.slice(last, m.index)) + `<a href="${esc(m[2])}">${esc(m[1])}</a>`;
    last = m.index! + m[0].length;
  }
  return out + esc(line.slice(last));
}
