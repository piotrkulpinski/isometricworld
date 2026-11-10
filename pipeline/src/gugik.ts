/**
 * GUGiK 3D building models (Poland's national mapping agency, CC BY 4.0).
 *
 * LoD2 2017: ground, wall and roof faces per BDOT10k building, roofs fitted to airborne LiDAR.
 * LoD1 2024: one prism per building, with `measuredHeight` the median of the LiDAR points inside the
 * footprint (so towers and steep roofs come out flat): only used for buildings LoD2 lacks.
 * Both are downloaded per powiat (county) as zips of CityGML sheets in EPSG:2180 (PUWG 1992) +
 * EVRF2007 heights.
 *
 * https://www.geoportal.gov.pl/pl/dane/inne-dane/modele-3d-budynkow/
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RAW } from "./paths.ts";


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

const ALPHA = [
  N_ / 2 - (2 / 3) * N_ ** 2 + (5 / 16) * N_ ** 3 + (41 / 180) * N_ ** 4,
  (13 / 48) * N_ ** 2 - (3 / 5) * N_ ** 3 + (557 / 1440) * N_ ** 4,
  (61 / 240) * N_ ** 3 - (103 / 140) * N_ ** 4,
  (49561 / 161280) * N_ ** 4,
];
const E_ = Math.sqrt(F * (2 - F));

/** [lon, lat] in degrees -> PUWG 1992 [easting, northing] (m). */
export function lonLatToPuwg92(lon: number, lat: number): [number, number] {
  const phi = (lat * Math.PI) / 180, lam = ((lon - LON0) * Math.PI) / 180;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - E_ * Math.atanh(E_ * Math.sin(phi)));
  const xi1 = Math.atan2(t, Math.cos(lam)), eta1 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 4; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
  }
  return [FE + K0 * M_FACTOR * eta, FN + K0 * M_FACTOR * xi];
}

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

/** One LoD1 building: footprint ring [lon, lat][], height above ground (m), ground elevation (m, EVRF2007). */
export interface GugikBuilding { id: string; ring: number[][]; h: number; z: number }

/** One LoD2 face: 0 ground, 1 wall, 2 roof; points [lon, lat, elevation (m, EVRF2007)]. */
export interface GugikFace { k: 0 | 1 | 2; pts: number[][] }
/** One LoD2 building: its faces, footprint ring (largest ground face, [lon, lat][]) and lowest elevation. */
export interface GugikMesh { id: string; faces: GugikFace[]; ring: number[][]; z: number; h: number }

const DOWNLOAD = {
  lod1: (teryt: string) => `https://opendata.geoportal.gov.pl/InneDane/Budynki3D/LOD1/2024/12/${teryt}.zip`,
  lod2: (teryt: string) => `https://opendata.geoportal.gov.pl/InneDane/Budynki3D/LOD2/${teryt}_gml.zip`,
};

/** Download and unpack a powiat's sheets once (data/raw/gugik/<lod>-<teryt>/); returns the GML files. */
function sheets(lod: "lod1" | "lod2", teryt: string) {
  const dir = join(RAW, "gugik", `${lod}-${teryt}`);
  const list = () => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".gml")).map((f) => join(dir, f)) : [];
  if (list().length) return list();
  mkdirSync(dir, { recursive: true });
  const zip = join(RAW, "gugik", `${lod}-${teryt}.zip`);
  if (!existsSync(zip)) {
    console.log(`  gugik: downloading ${DOWNLOAD[lod](teryt)}`);
    execFileSync("curl", ["-sSfL", "-o", zip, DOWNLOAD[lod](teryt)], { stdio: "inherit" });
  }
  execFileSync("unzip", ["-o", "-q", zip, "-d", dir], { stdio: "inherit" });
  return list();
}

/** Does a sheet's envelope (EPSG:2180 easting/northing) touch the bbox? Reads only the file's header. */
function sheetTouches(xml: string, [s, w, n, e]: [number, number, number, number]) {
  const m = /<gml:lowerCorner>([^<]+)<\/gml:lowerCorner>\s*<gml:upperCorner>([^<]+)</.exec(xml.slice(0, 4000));
  if (!m) return true;
  const [x0, y0] = m[1].trim().split(/\s+/).map(Number), [x1, y1] = m[2].trim().split(/\s+/).map(Number);
  const [lo0, la0] = puwg92ToLonLat(x0, y0), [lo1, la1] = puwg92ToLonLat(x1, y1);
  return !(Math.max(la0, la1) < s || Math.min(la0, la1) > n || Math.max(lo0, lo1) < w || Math.min(lo0, lo1) > e);
}

const BUILDING = /<bldg:Building gml:id="([^"]+)">([\s\S]*?)<\/bldg:Building>/g;
const HEIGHT = /<bldg:measuredHeight[^>]*>([\d.]+)</;
const POSLIST = /<gml:posList>([^<]+)<\/gml:posList>/g;
const SURFACE = /<bldg:(GroundSurface|WallSurface|RoofSurface)\b[\s\S]*?<\/bldg:\1>/g;
const RING = /<gml:exterior>([\s\S]*?)<\/gml:exterior>/g;
const POS = /<gml:pos(?:List)?[^>]*>([^<]+)</g;

const inBbox = (ring: number[][], [s, w, n, e]: [number, number, number, number]) =>
  ring.some(([lon, lat]) => lat >= s && lat <= n && lon >= w && lon <= e);

/**
 * LoD1 buildings of a powiat whose footprint touches the bbox [south, west, north, east].
 * The footprint is the solid's lowest horizontal face (all Z equal to the minimum Z).
 */
export function lod1Buildings(teryt: string, bbox: [number, number, number, number]): GugikBuilding[] {
  const out: GugikBuilding[] = [];
  for (const file of sheets("lod1", teryt)) {
    const xml = readFileSync(file, "utf8");
    if (!sheetTouches(xml, bbox)) continue;
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
      if (!inBbox(ring, bbox)) continue;
      out.push({ id, ring, h, z: zMin });
    }
  }
  return out;
}

/**
 * LoD2 buildings (2017, roofs from airborne LiDAR): every ground, wall and roof face, so towers,
 * spires and pitched roofs keep their real shape.
 */
export function lod2Buildings(teryt: string, bbox: [number, number, number, number]): GugikMesh[] {
  const out: GugikMesh[] = [];
  for (const file of sheets("lod2", teryt)) {
    const xml = readFileSync(file, "utf8");
    if (!sheetTouches(xml, bbox)) continue;
    for (const [, id, body] of xml.matchAll(BUILDING)) {
      const faces: GugikFace[] = [];
      for (const [surface, type] of body.matchAll(SURFACE)) {
        const k = type === "GroundSurface" ? 0 : type === "WallSurface" ? 1 : 2;
        for (const [, ring] of surface.matchAll(RING)) {
          const v = [...ring.matchAll(POS)].flatMap(([, t]) => t.trim().split(/\s+/).map(Number)), pts: number[][] = [];
          for (let i = 0; i + 2 < v.length; i += 3) pts.push([...puwg92ToLonLat(v[i], v[i + 1]), v[i + 2]]);
          if (pts.length >= 4) faces.push({ k, pts: pts.slice(0, -1) }); // drop the closing point
        }
      }
      const grounds = faces.filter((f) => f.k === 0);
      if (!grounds.length) continue;
      const ring = grounds.reduce((a, b) => (b.pts.length > a.pts.length ? b : a)).pts.map(([lon, lat]) => [lon, lat]);
      if (!inBbox(ring, bbox)) continue;
      const zs = faces.flatMap((f) => f.pts.map((p) => p[2]));
      const z = Math.min(...zs);
      out.push({ id, faces, ring, z, h: Math.max(...zs) - z });
    }
  }
  return out;
}

/**
 * Write the area's GUGiK buildings: LoD2 meshes (data/raw/<area>/gugik_lod2.json) and the LoD1 2024
 * prisms (gugik_buildings.json), which fill in buildings put up after the 2017 LoD2 survey.
 */
export function fetchGugik(teryt: string[], bbox: [number, number, number, number], dir: string) {
  const lod1 = join(dir, "gugik_buildings.json"), lod2 = join(dir, "gugik_lod2.json");
  if (!existsSync(lod1)) {
    const b = teryt.flatMap((t) => lod1Buildings(t, bbox));
    writeFileSync(lod1, JSON.stringify(b));
    console.log(`  gugik lod1: ${b.length} buildings`);
  }
  if (!existsSync(lod2)) {
    const m = teryt.flatMap((t) => lod2Buildings(t, bbox));
    writeFileSync(lod2, JSON.stringify(m));
    console.log(`  gugik lod2: ${m.length} buildings`);
  }
}
