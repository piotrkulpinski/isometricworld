/**
 * Open Graph / Twitter card image per city: 1200×630 of the city's painted view (the published map
 * tiles, or the export cache first), with the city name (the site name for the home page) and the source credits.
 *
 *   npx tsx src/og.ts [index] [city ...]   # default: all → web/public/og/index.jpg and og/<city>.jpg
 *
 * A site with its own name (SITE_NAME, site.ts) gets og/<its slug>.jpg for `/` instead of index.jpg, from its
 * home city (SITE_HOME), and "all" means the cities it serves.
 *
 * The image shows the map, so the source credits (© OpenStreetMap contributors, Copernicus) are drawn
 * on it, as on the map.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { CAMERA, llhToPixel, useRegion } from "./camera.ts";
import { HOSTING } from "./hosting.ts";
import { ROOT, WEB_CACHE, WEB_STATE, readJson } from "./paths.ts";
import { CITIES, DEFAULT_CITY, REGIONS } from "./places.ts";
import { siteCities, siteConfig } from "./site.ts";

const W = 1200, H = 630;
const TS = 512, NATIVE_Z = 8, FORMAT = "avif"; // as export.ts
const BG = { r: 14, g: 15, b: 18 };
const OUT = join(ROOT, "web", "public", "og");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function tile(region: string, hashes: Record<string, string>, z: number, x: number, y: number): Promise<Buffer | null> {
  const rel = `tiles/map/${z}/${x}/${y}.${FORMAT}`, local = join(WEB_CACHE, "regions", region, rel);
  if (existsSync(local)) return readFileSync(local);
  const v = hashes[`${z}/${x}_${y}`];
  if (!v) return null; // no tile there: background
  const r = await fetch(`${HOSTING.origin}/regions/${region}/${rel}?v=${v}`);
  if (!r.ok) throw new Error(`${rel}: ${r.status} from ${HOSTING.origin}`);
  return Buffer.from(await r.arrayBuffer());
}

async function og(slug: string, heading: string, name: string) {
  const city = CITIES[slug];
  if (!city) throw new Error(`unknown city ${slug}`);
  const region = REGIONS[city.region];
  useRegion(city.region);
  // tile hashes: the unpublished export first, then what is published
  const states = [join(WEB_CACHE, `${city.region}.state.json`), join(WEB_STATE, `${city.region}.json`)].filter(existsSync);
  const hashes: Record<string, string> = Object.assign({}, ...states.reverse().map((f) => readJson(f).layers?.map?.hashes ?? {}));

  // the city's opening view, a bit tighter (a card is small): 70 % of widthM across
  const [cx, cy] = llhToPixel(city.center[0], city.center[1], 25);
  const viewW = (city.widthM * 0.7) / CAMERA.mpp, viewH = viewW * (H / W);
  const z = Math.min(NATIVE_Z, NATIVE_Z - Math.floor(Math.log2(viewW / W)));
  const f = 2 ** (z - NATIVE_Z), span = TS / f;
  const x0 = cx - viewW / 2, y0 = cy - viewH / 2;
  const cw = Math.round(viewW * f), ch = Math.round(viewH * f);
  const parts: OverlayOptions[] = [];
  for (let ty = Math.floor(y0 / span); ty <= Math.floor((y0 + viewH) / span); ty++)
    for (let tx = Math.floor(x0 / span); tx <= Math.floor((x0 + viewW) / span); tx++) {
      const b = await tile(city.region, hashes, z, tx, ty);
      // sharp composites must lie inside the canvas: pad by a tile on every side, crop after
      if (b) parts.push({ input: await sharp(b).png().toBuffer(), left: Math.round((tx * span - x0) * f) + TS, top: Math.round((ty * span - y0) * f) + TS });
    }
  if (!parts.length) throw new Error(`${slug}: no published tiles around the city`);
  const canvas = await sharp({ create: { width: cw + 2 * TS, height: ch + 2 * TS, channels: 3, background: BG } }).composite(parts).png().toBuffer();
  const map = await sharp(canvas).extract({ left: TS, top: TS, width: cw, height: ch }).resize(W, H, { kernel: "lanczos3" }).png().toBuffer();

  // every source credit, without the "Painted with AI" label (clips keep it)
  const credits = region.credits.join(" · ").split(" · ").filter((c) => !/painted with ai/i.test(c));
  // wrapped at " · " so every credit stays on the card (~120 characters of 17 px text fit across)
  const lines: string[] = [];
  for (const c of credits) {
    const last = lines.length - 1;
    if (last >= 0 && (lines[last] + " · " + c).length <= 115) lines[last] += " · " + c;
    else lines.push(c);
  }
  const band = 90 + (lines.length - 1) * 24;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0e0f12" stop-opacity="0.78"/><stop offset="1" stop-color="#0e0f12" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bot" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0e0f12" stop-opacity="0"/><stop offset="1" stop-color="#0e0f12" stop-opacity="0.7"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="220" fill="url(#top)"/>
  <rect y="${H - band}" width="${W}" height="${band}" fill="url(#bot)"/>
  <g font-family="Helvetica Neue, Helvetica, Arial, sans-serif" fill="#fff">
    <text x="56" y="104" font-size="68" font-weight="700" letter-spacing="-1">${esc(heading)}</text>
    <text x="58" y="148" font-size="28" font-weight="400" fill-opacity="0.88">An isometric city map from open data</text>
    ${lines.map((l, i) => `<text x="58" y="${H - 26 - (lines.length - 1 - i) * 24}" font-size="17" fill-opacity="0.9">${esc(l)}</text>`).join("\n    ")}
  </g>
</svg>`;
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.jpg`);
  writeFileSync(file, await sharp(map).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 86, mozjpeg: true }).toBuffer());
  console.log(`  ${file} (z${z}, ${parts.length} tiles)`);
}

const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// the home page (/) opens the default city (or the site's home city): same view, the site name as the heading
const site = siteConfig();
if (!names.length || names.includes("index")) await og(site.home || DEFAULT_CITY, site.name, site.homeOg);
for (const slug of names.length ? names.filter((n) => n !== "index") : siteCities(site)) await og(slug, CITIES[slug]?.title ?? slug, slug);
