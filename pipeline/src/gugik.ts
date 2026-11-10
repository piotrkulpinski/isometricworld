/**
 * GUGiK 3D building models (Poland's national mapping agency, CC BY 4.0).
 *
 * LoD1 2024: one prism per BDOT10k building, with `measuredHeight` from the LiDAR survey (median of
 * the points inside the footprint) and the ground elevation as the solid's lowest Z. Downloaded per
 * powiat (county) as a zip of CityGML sheets in EPSG:2180 (PUWG 1992) + EVRF2007 heights.
 *
 * https://www.geoportal.gov.pl/pl/dane/inne-dane/modele-3d-budynkow/
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RAW } from "./paths.ts";

const LOD1 = (teryt: string) => `https://opendata.geoportal.gov.pl/InneDane/Budynki3D/LOD1/2024/12/${teryt}.zip`;

// ---- EPSG:2180 (Transverse Mercator on GRS80, lon0 19°, k0 0.9993) -> WGS84 ------------------
const A = 6378137, F = 1 / 298.257222101, K0 = 0.9993, LON0 = 19, FE = 500000, FN = -5300000;
const N_ = F / (2 - F);
const M_FACTOR = A / (1 + N_) * (1 + N_ ** 2 / 4 + N_ ** 4 / 64);
// Krüger series (inverse), accurate to well under a millimetre within a TM zone.
const BETA = [
  N_ / 2 - (2 / 3) * N_ ** 2 + (37 / 96) * N_ ** 3 - (1 / 360) * N_ ** 4,
  (1 / 48) * N_ ** 2 + (1 / 15) * N_ ** 3 - (437 / 1440) * N_ ** 4,
  (17 / 480) * N_ ** 3 - (37 / 840) * N_ ** 4,
  (4397 / 161280) * N_ ** 4,
];
const DELTA = [
  2 * N_ - (2 / 3) * N_ ** 2 - 2 * N_ ** 3 + (116 / 45) * N_ ** 4,
  (7 / 3) * N_ ** 2 - (8 / 5) * N_ ** 3 - (227 / 45) * N_ ** 4,
  (56 / 15) * N_ ** 3 - (136 / 35) * N_ ** 4,
  (4279 / 630) * N_ ** 4,
];

/** PUWG 1992 easting/northing (m) -> [lon, lat] in degrees. */
export function puwg92ToLonLat(easting: number, northing: number): [number, number] {
  const xi = (northing - FN) / (K0 * M_FACTOR), eta = (easting - FE) / (K0 * M_FACTOR);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 4; j++) {
    xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  for (let j = 1; j <= 4; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  const lam = Math.atan2(Math.sinh(eta1), Math.cos(xi1));
  return [LON0 + (lam * 180) / Math.PI, (phi * 180) / Math.PI];
}

/** One building: footprint ring [lon, lat][], height above ground (m), ground elevation (m, EVRF2007). */
export interface GugikBuilding { id: string; ring: number[][]; h: number; z: number }

/** Download and unpack a powiat's LoD1 sheets once (data/raw/gugik/lod1-<teryt>/). */
function lod1Dir(teryt: string) {
  const dir = join(RAW, "gugik", `lod1-${teryt}`);
  if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".gml"))) return dir;
  mkdirSync(dir, { recursive: true });
  const zip = join(RAW, "gugik", `lod1-${teryt}.zip`);
  if (!existsSync(zip)) {
    console.log(`  gugik: downloading ${LOD1(teryt)}`);
    execFileSync("curl", ["-sSfL", "-o", zip, LOD1(teryt)], { stdio: "inherit" });
  }
  execFileSync("unzip", ["-o", "-q", zip, "-d", dir], { stdio: "inherit" });
  return dir;
}

const BUILDING = /<bldg:Building gml:id="([^"]+)">([\s\S]*?)<\/bldg:Building>/g;
const HEIGHT = /<bldg:measuredHeight[^>]*>([\d.]+)</;
const POSLIST = /<gml:posList>([^<]+)<\/gml:posList>/g;

/**
 * Buildings of a powiat whose footprint touches the bbox [south, west, north, east].
 * The footprint is the solid's lowest horizontal face (all Z equal to the minimum Z).
 */
export function lod1Buildings(teryt: string, [s, w, n, e]: [number, number, number, number]): GugikBuilding[] {
  const out: GugikBuilding[] = [];
  const dir = lod1Dir(teryt);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".gml"))) {
    const xml = readFileSync(join(dir, file), "utf8");
    for (const [, id, body] of xml.matchAll(BUILDING)) {
      const h = parseFloat(HEIGHT.exec(body)?.[1] ?? "");
      let foot: number[][] | null = null, zMin = Infinity;
      for (const [, list] of body.matchAll(POSLIST)) {
        const v = list.trim().split(/\s+/).map(Number), pts: number[][] = [];
        for (let i = 0; i + 2 < v.length; i += 3) pts.push([v[i], v[i + 1], v[i + 2]]);
        if (!pts.every((p) => p[2] === pts[0][2])) continue; // a wall
        if (pts[0][2] < zMin) { zMin = pts[0][2]; foot = pts; }
      }
      if (!foot || !Number.isFinite(h)) continue;
      const ring = foot.map(([x, y]) => puwg92ToLonLat(x, y));
      if (!ring.some(([lon, lat]) => lat >= s && lat <= n && lon >= w && lon <= e)) continue;
      out.push({ id, ring, h, z: zMin });
    }
  }
  return out;
}

/** Write the area's GUGiK buildings to data/raw/<area>/gugik_buildings.json. */
export function fetchGugik(teryt: string[], bbox: [number, number, number, number], file: string) {
  const b = teryt.flatMap((t) => lod1Buildings(t, bbox));
  writeFileSync(file, JSON.stringify(b));
  console.log(`  gugik lod1: ${b.length} buildings`);
}
