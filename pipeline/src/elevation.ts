/**
 * GUGiK elevation models for Poland (CC BY 4.0), in EVRF2007 heights:
 *   NMT   terrain (bare earth), 1 m grid
 *   NMPT  surface (buildings, trees), 0.5 m grid in cities
 * Published as ARC/INFO ASCII grids, one per 1:5000 map sheet, in EPSG:2180. The download link of the
 * sheet covering a point comes from the index WMS (GetFeatureInfo), newest year first.
 *
 * https://www.geoportal.gov.pl/pl/dane/numeryczny-model-terenu-nmt/
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lonLatToPuwg92 } from "./gugik.ts";
import { RAW } from "./paths.ts";

export type Model = "NMT" | "NMPT";
const YEARS = ["2026", "2025", "2024", "2023iStarsze"];
const UA = { "User-Agent": "isometric-world/0.3 (open-data isometric map)" };

/** Download link of the newest sheet covering a point, or null. */
async function sheetAt(model: Model, lat: number, lon: number): Promise<string | null> {
  for (const year of YEARS) {
    const layer = `Skorowidze${model}${year}`;
    const q = new URLSearchParams({
      SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetFeatureInfo", LAYERS: layer, QUERY_LAYERS: layer, CRS: "EPSG:4326",
      BBOX: `${lat - 0.0005},${lon - 0.0005},${lat + 0.0005},${lon + 0.0005}`, WIDTH: "101", HEIGHT: "101", I: "50", J: "50",
      INFO_FORMAT: "text/html", FEATURE_COUNT: "10",
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(`https://mapy.geoportal.gov.pl/wss/service/PZGIK/${model}/WMS/SkorowidzeUkladEVRF2007?${q}`, { headers: UA, signal: AbortSignal.timeout(60_000) });
        const links = [...(await r.text()).matchAll(/https:\/\/opendata\.geoportal\.gov\.pl\/NumDaneWys\/[^"'<> ]+\.asc/g)].map((m) => m[0]);
        if (links.length) return links.at(-1)!;
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((res) => setTimeout(res, 3000 * attempt));
      }
    }
  }
  return null;
}

/** Download every sheet of `model` touching the bbox (+ margin) into data/raw/gugik/<model>/. */
export async function fetchElevation(model: Model, [s, w, n, e]: [number, number, number, number], margin = 0.003) {
  const dir = join(RAW, "gugik", model.toLowerCase());
  mkdirSync(dir, { recursive: true });
  const urls = new Set<string>();
  // sheets are ~2.3 km across: sample every ~0.004° (≈ 300-450 m)
  for (let lat = s - margin; lat <= n + margin + 1e-9; lat += 0.004)
    for (let lon = w - margin; lon <= e + margin + 1e-9; lon += 0.004) {
      const u = await sheetAt(model, Math.min(lat, n + margin), Math.min(lon, e + margin));
      if (u) urls.add(u);
    }
  for (const u of urls) {
    const file = join(dir, u.split("/").at(-1)!);
    if (existsSync(file)) continue;
    console.log(`  ${model.toLowerCase()}: downloading ${u}`);
    execFileSync("curl", ["-sSfL", "-o", `${file}.part`, u], { stdio: "inherit" });
    execFileSync("mv", [`${file}.part`, file]);
  }
  writeFileSync(join(dir, "index.json"), JSON.stringify([...new Set([...readIndex(dir), ...[...urls].map((u) => u.split("/").at(-1)!)])]));
  console.log(`  ${model.toLowerCase()}: ${urls.size} sheets`);
}

const readIndex = (dir: string): string[] => existsSync(join(dir, "index.json")) ? JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) : [];

interface Grid { x0: number; y0: number; cell: number; nx: number; ny: number; data: Float32Array; nodata: number }

/** Parse an ARC/INFO ASCII grid (rows from the top; xll/yll = lower-left corner of the lower-left cell). */
function readAsc(file: string): Grid {
  const text = readFileSync(file, "latin1");
  const head: Record<string, number> = {};
  let pos = 0;
  for (let i = 0; i < 6; i++) {
    const end = text.indexOf("\n", pos);
    const [k, v] = text.slice(pos, end).trim().split(/\s+/);
    head[k.toLowerCase()] = Number(v);
    pos = end + 1;
  }
  const nx = head.ncols, ny = head.nrows, data = new Float32Array(nx * ny);
  let i = 0, num = "";
  for (let c = pos; c < text.length && i < data.length; c++) {
    const ch = text.charCodeAt(c);
    if (ch <= 32) { if (num) { data[i++] = Number(num); num = ""; } } else num += text[c];
  }
  if (num && i < data.length) data[i++] = Number(num);
  const cell = head.cellsize;
  const x0 = head.xllcorner ?? head.xllcenter - cell / 2, y0 = head.yllcorner ?? head.yllcenter - cell / 2;
  return { x0, y0, cell, nx, ny, data, nodata: head.nodata_value ?? -9999 };
}

/**
 * Elevation sampler over the downloaded sheets of a model: (lat, lon) -> EVRF2007 height in metres,
 * or NaN outside the sheets. Bilinear inside a sheet.
 */
export function elevationSampler(model: Model) {
  const dir = join(RAW, "gugik", model.toLowerCase());
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".asc")) : [];
  const grids = files.map((f) => readAsc(join(dir, f)));
  // which axis is easting? EPSG:2180 sheets for Kraków have easting ~5.6e5 and northing ~2.4e5
  return (lat: number, lon: number) => {
    const [E, N] = lonLatToPuwg92(lon, lat);
    for (const g of grids) {
      // the grid's x is easting when x0 is in the easting range of the point, else the axes are swapped
      const swap = Math.abs(g.x0 - E) > Math.abs(g.x0 - N);
      const x = swap ? N : E, y = swap ? E : N;
      const fx = (x - g.x0) / g.cell - 0.5, fy = (g.y0 + g.ny * g.cell - y) / g.cell - 0.5;
      if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) continue;
      const ix = Math.min(g.nx - 2, Math.floor(fx)), iy = Math.min(g.ny - 2, Math.floor(fy)), ax = fx - ix, ay = fy - iy;
      const v = (cx: number, cy: number) => g.data[cy * g.nx + cx];
      const a = v(ix, iy), b = v(ix + 1, iy), c = v(ix, iy + 1), d = v(ix + 1, iy + 1);
      if ([a, b, c, d].some((t) => t === g.nodata)) continue;
      return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
    }
    return NaN;
  };
}
