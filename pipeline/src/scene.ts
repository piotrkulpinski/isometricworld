/**
 * Build the 3D scene for an area from open data, in the camera's ENU frame.
 * Buildings and tree crowns; the ground comes from ground.ts.
 *
 *   npm -w pipeline run scene -- tlv-core
 *
 * Output: data/derived/<area>/scene/<tx>_<ty>.json — objects visible in each render tile:
 *   b: buildings  [ring (ENU x,y pairs, CCW), height above ground, style, groundHint]
 *   t: tree crowns [x, y, radius, crown height above ground, conifer (1) or not (0)]
 *   m: building meshes [faces: [kind (1 wall, 2 roof), flat ENU x,y,z…], style, roof rgb or null] (GUGiK LoD2)
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openArea } from "./areas.ts";
import { CAMERA, ecefToEnu, enuToPixel, llhToEcef } from "./camera.ts";
import { elevationSampler } from "./elevation.ts";
import type { GugikBuilding, GugikMesh } from "./gugik.ts";
import { DERIVED, RAW, readJson } from "./paths.ts";
import { REGIONS } from "./places.ts";

type P2 = [number, number];
const T = CAMERA.tile;
const FLOOR = 3.2;

const toEnu = (lon: number, lat: number, h = 0): [number, number, number] => ecefToEnu(llhToEcef(lat, lon, h));

function area2(r: P2[]) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // > 0 = CCW
}

/** Douglas-Peucker on a closed ring. */
function simplify(r: P2[], tol: number): P2[] {
  if (r.length <= 4) return r;
  const keep = new Uint8Array(r.length);
  keep[0] = keep[r.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, r.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bi = -1;
    const [ax, ay] = r[a], [bx, by] = r[b];
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - r[i][1]) - (ax - r[i][0]) * (by - ay)) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return r.filter((_, i) => keep[i]);
}

function ringFromLonLat(coords: number[][]): P2[] | null {
  let r: P2[] = coords.map(([lon, lat]) => { const p = toEnu(lon, lat); return [p[0], p[1]] as P2; });
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  // closed ring: split at the vertex farthest from r[0] so both halves have a real chord
  let far = 0;
  r.forEach((p, i) => { if (Math.hypot(p[0] - r[0][0], p[1] - r[0][1]) > Math.hypot(r[far][0] - r[0][0], r[far][1] - r[0][1])) far = i; });
  if (far > 0) r = [...simplify(r.slice(0, far + 1), 0.35).slice(0, -1), ...simplify([...r.slice(far), r[0]], 0.35).slice(0, -1)];
  if (r.length < 3) return null;
  if (area2(r) < 0) r.reverse();
  return Math.abs(area2(r)) >= 6 ? r : null;
}

function inside([x, y]: P2, poly: P2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const hash = (n: number) => { let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; return (Math.imul(x, 0xc2b2ae35) >>> 0) / 2 ** 32; };

/**
 * Visual style index used by the renderer (palette + facade pattern):
 * 0 Bauhaus/International (pre-1950, white, ribbon windows) · 1 1950–90s residential (cream, balcony bands)
 * 2 public (stone) · 3 tower (glass curtain wall) · 4 shed · 5 modern mid-rise (light grey, big windows)
 */
function style(height: number, kind: string, id: number, year?: number | null) {
  if (height >= 55) return 3;
  if (kind === "public") return 2;
  if (kind === "temporary") return 4;
  if (year && year < 1950 && height < 25) return 0;
  if (year && year >= 1995) return 5;
  if (!year) return hash(id) < 0.3 ? 0 : hash(id) < 0.8 ? 1 : 5;
  return hash(id) < 0.25 ? 0 : 1;
}

const name = process.argv[2] ?? "tlv-core";
const { bbox, region } = openArea(name);
/** Geoid undulation of the region: orthometric (MSL) + this = ellipsoid height. */
const GEOID = REGIONS[region].geoid;
const GUGIK = REGIONS[region].buildings?.kind === "gugik";

/** Polish city styles (renderer palette): tall towers and churches stone (2), buildings newer than the
 *  2017 LoD2 survey modern (5), everything else historic tenement (1). */
const polishStyle = (h: number, newer: boolean) => (h >= 40 ? 2 : newer ? 5 : 1);
const raw = join(RAW, name);
const out = join(DERIVED, name, "scene");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

type Building = { ring: P2[]; h: number; s: number; g: number | null };
const buildings: Building[] = [];
const tlvCover: P2[][] = [];

// 1. Official buildings with surveyed heights. Tel Aviv-Yafo municipal GIS:
const tlvFile = join(raw, "tlv_buildings.geojson");
const tlv = existsSync(tlvFile) ? readJson(tlvFile) : { features: [] };
for (const f of tlv.features) {
  const p = f.properties, g = f.geometry;
  if (!g) continue;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const kind = ({ "מבנה ציבור": "public", "מבנה ארעי": "temporary", "תחנת אוטובוס": "shelter" } as Record<string, string>)[p.t_sug_mivne] ?? "regular";
  let h = p.gova_simplex_2019 || (p.ms_komot ? p.ms_komot * FLOOR + 1 : 0) || 4;
  if (kind === "shelter") h = 3;
  for (const poly of polys) {
    const ring = ringFromLonLat(poly[0]);
    if (!ring) continue;
    buildings.push({ ring, h: Math.max(3, h), s: style(h, kind, p.id_binyan ?? buildings.length, p.year), g: p.min_height ? p.min_height + GEOID : null });
    tlvCover.push(ring);
  }
}
// … or GUGiK (Poland). LoD2 2017 meshes first: real walls and roofs, so towers and spires keep their height.
type Mesh = { faces: Array<[number, number[]]>; s: number; ring: P2[]; roof: number[] | null };
const meshes: Mesh[] = [];
const lod2File = join(raw, "gugik_lod2.json");
for (const b of existsSync(lod2File) ? readJson<GugikMesh[]>(lod2File) : []) {
  const ring = ringFromLonLat(b.ring);
  if (!ring || b.h < 2) continue;
  const faces: Array<[number, number[]]> = b.faces.filter((f) => f.k !== 0).map((f) =>
    [f.k, f.pts.flatMap(([lon, lat, z]) => toEnu(lon, lat, z + GEOID).map((v) => Math.round(v * 100) / 100))]);
  meshes.push({ faces, s: polishStyle(b.h, false), ring, roof: null });
  tlvCover.push(ring);
}
console.log(`  lod2 meshes: ${meshes.length}`);
// … then LoD1 2024 prisms (footprint, LiDAR median height, ground elevation) for buildings LoD2 lacks.
const lod2Cover = new Map<string, P2[][]>();
for (const r of tlvCover) { const k = `${Math.floor(r[0][0] / 50)}_${Math.floor(r[0][1] / 50)}`; (lod2Cover.get(k) ?? lod2Cover.set(k, []).get(k)!).push(r); }
const inLod2 = (pt: P2) => {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    if (lod2Cover.get(`${Math.floor(pt[0] / 50) + dx}_${Math.floor(pt[1] / 50) + dy}`)?.some((r) => inside(pt, r))) return true;
  return false;
};
const gugikFile = join(raw, "gugik_buildings.json");
for (const b of existsSync(gugikFile) ? readJson<GugikBuilding[]>(gugikFile) : []) {
  const ring = ringFromLonLat(b.ring);
  if (!ring || b.h < 2) continue;
  if (meshes.length && inLod2([ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length])) continue;
  buildings.push({ ring, h: b.h, s: polishStyle(b.h, true), g: b.z + GEOID });
  tlvCover.push(ring);
}
console.log(`  official buildings: ${buildings.length}`);

// 2. OSM buildings where the municipal layer has nothing (Ramat Gan, Givatayim, Bnei Brak…).
const coverGrid = new Map<string, P2[][]>(); // 50 m grid of official footprints for overlap tests
for (const r of tlvCover) {
  const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
  for (let gx = Math.floor(Math.min(...xs) / 50); gx <= Math.floor(Math.max(...xs) / 50); gx++)
    for (let gy = Math.floor(Math.min(...ys) / 50); gy <= Math.floor(Math.max(...ys) / 50); gy++)
      (coverGrid.get(`${gx}_${gy}`) ?? coverGrid.set(`${gx}_${gy}`, []).get(`${gx}_${gy}`)!).push(r);
}
const covered = (pt: P2) => coverGrid.get(`${Math.floor(pt[0] / 50)}_${Math.floor(pt[1] / 50)}`)?.some((r) => inside(pt, r)) ?? false;
/** An OSM footprint duplicates official data when its centre or a third of its corners lie inside it. */
const duplicate = (ring: P2[], c: P2) => covered(c) || ring.filter((p) => covered(p)).length >= ring.length / 3;

// Roof colours from OSM tags (roof:material, roof:colour), matched onto the LoD2 mesh under the OSM building.
const meshGrid = new Map<string, Mesh[]>();
for (const m of meshes) {
  const xs = m.ring.map((p) => p[0]), ys = m.ring.map((p) => p[1]);
  for (let gx = Math.floor(Math.min(...xs) / 50); gx <= Math.floor(Math.max(...xs) / 50); gx++)
    for (let gy = Math.floor(Math.min(...ys) / 50); gy <= Math.floor(Math.max(...ys) / 50); gy++)
      (meshGrid.get(`${gx}_${gy}`) ?? meshGrid.set(`${gx}_${gy}`, []).get(`${gx}_${gy}`)!).push(m);
}
const NAMED: Record<string, number[]> = {
  grey: [0.52, 0.53, 0.55], gray: [0.52, 0.53, 0.55], darkgrey: [0.36, 0.37, 0.39], black: [0.2, 0.2, 0.22], red: [0.66, 0.3, 0.24],
  maroon: [0.5, 0.2, 0.18], brown: [0.48, 0.32, 0.24], green: [0.36, 0.56, 0.46], darkgreen: [0.22, 0.4, 0.3], white: [0.88, 0.88, 0.86],
  silver: [0.7, 0.71, 0.73], gold: [0.8, 0.66, 0.3], orange: [0.8, 0.45, 0.25], blue: [0.3, 0.42, 0.58],
};
function roofColour(t: Record<string, string>): number[] | null {
  if (t["roof:material"] === "copper") return [0.4, 0.62, 0.52]; // verdigris
  const c = (t["roof:colour"] ?? "").trim().toLowerCase();
  const hex = /^#?([0-9a-f]{6})$/.exec(c);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
  if (NAMED[c]) return NAMED[c];
  if (t["roof:material"] === "metal_sheet" || t["roof:material"] === "metal") return NAMED.grey;
  return null;
}

// Tree heights (Poland): GUGiK surface minus terrain over the crown, so old park trees stand tall.
const nmt = GUGIK ? elevationSampler("NMT") : null, nmpt = GUGIK ? elevationSampler("NMPT") : null;
function treeFromSurvey(lat: number, lon: number, conifer: boolean): [number, number] | null {
  if (!nmt || !nmpt) return null;
  let top = -Infinity;
  const ground = nmt(lat, lon);
  if (Number.isNaN(ground)) return null;
  for (const [dy, dx] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const v = nmpt(lat + (dy * 2) / 111320, lon + (dx * 2) / (111320 * Math.cos((lat * Math.PI) / 180)));
    if (!Number.isNaN(v)) top = Math.max(top, v);
  }
  const H = top - ground;
  if (!(H >= 3 && H <= 40)) return null; // no canopy here (or a roof): keep the default
  const r = conifer ? Math.min(4, Math.max(1.5, 0.18 * H)) : Math.min(7.5, Math.max(2.5, 0.3 * H));
  return [r, Math.max(1.5, H - r * 0.9)];
}
const osm = readJson(join(raw, "osm.json"));
let osmCount = 0;
const trees: number[][] = [];
let surveyed = 0;
for (const el of osm.elements) {
  const t = el.tags ?? {};
  if (el.type === "node" && t.natural === "tree") {
    const p = toEnu(el.lon, el.lat), conifer = t.leaf_type === "needleleaved";
    const size = treeFromSurvey(el.lat, el.lon, conifer);
    if (size) surveyed++;
    trees.push([p[0], p[1], ...(size ?? [3, 6]), conifer ? 1 : 0]);
    continue;
  }
  if (!t.building || t.building === "roof" || t.location === "underground") continue;
  const coords = el.type === "way" ? el.geometry?.map((q: any) => [q.lon, q.lat])
    : el.members?.find((m: any) => m.role === "outer" && m.geometry)?.geometry.map((q: any) => [q.lon, q.lat]);
  if (!coords || coords.length < 4) continue;
  const ring = ringFromLonLat(coords);
  if (!ring) continue;
  const c: P2 = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
  const roof = roofColour(t);
  if (roof) for (const m of meshGrid.get(`${Math.floor(c[0] / 50)}_${Math.floor(c[1] / 50)}`) ?? []) if (inside(c, m.ring)) m.roof = roof;
  if (GUGIK ? duplicate(ring, c) : covered(c)) continue;
  const levels = parseFloat(t["building:levels"]);
  let h = parseFloat(t.height) || (levels ? levels * FLOOR + 1 : 0);
  if (!h) h = Math.abs(area2(ring)) > 1500 ? 14 : ["house", "garage", "shed", "kiosk"].includes(t.building) ? 5 : 13;
  buildings.push({ ring, h, s: GUGIK ? polishStyle(h, false) : style(h, t.amenity || t.building === "school" ? "public" : "regular", el.id), g: null });
  osmCount++;
}
console.log(`  osm buildings (outside municipal layer): ${osmCount}`);
if (GUGIK) console.log(`  trees sized from the GUGiK surface model: ${surveyed}/${trees.length}; roofs coloured from OSM: ${meshes.filter((m) => m.roof).length}`);

// Bridges and decks recorded as buildings (Arlozorov / Savidor over the Ayalon): any footprint a
// motorway, trunk road or railway runs through for 20 m+ is not a building. Drop it; the road is drawn.
{
  const lines: P2[] = [];
  for (const el of readJson(join(raw, "ground.json")).elements) {
    const t = el.tags ?? {};
    if (el.type !== "way" || !el.geometry || !(/^(motorway|trunk)(_link)?$/.test(t.highway) || /^(rail|light_rail)$/.test(t.railway))) continue;
    const g: P2[] = el.geometry.map((q: any) => { const p = toEnu(q.lon, q.lat); return [p[0], p[1]] as P2; });
    for (let i = 1; i < g.length; i++) {
      const n = Math.ceil(Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]) / 5);
      for (let k = 0; k < n; k++) lines.push([g[i - 1][0] + ((g[i][0] - g[i - 1][0]) * k) / n, g[i - 1][1] + ((g[i][1] - g[i - 1][1]) * k) / n]);
    }
  }
  const grid = new Map<string, P2[]>();
  for (const p of lines) { const k = `${Math.floor(p[0] / 50)}_${Math.floor(p[1] / 50)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(p); }
  const before = buildings.length;
  for (let i = buildings.length - 1; i >= 0; i--) {
    const r = buildings[i].ring, xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
    let hits = 0;
    for (let gx = Math.floor(Math.min(...xs) / 50); gx <= Math.floor(Math.max(...xs) / 50); gx++)
      for (let gy = Math.floor(Math.min(...ys) / 50); gy <= Math.floor(Math.max(...ys) / 50); gy++)
        for (const p of grid.get(`${gx}_${gy}`) ?? []) if (inside(p, r)) hits++;
    if (hits >= 4) buildings.splice(i, 1);
  }
  console.log(`  dropped ${before - buildings.length} bridges/decks over motorways and rail`);
}

// 3. Tree crowns from 2024 canopy polygons: one crown per ~6 m cell inside each polygon.
const canFile = join(raw, "tlv_canopy.geojson");
const can = existsSync(canFile) ? readJson(canFile) : { features: [] };
for (const f of can.features) {
  const g = f.geometry;
  if (!g) continue;
  for (const poly of g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) {
    const ring = ringFromLonLat(poly[0]);
    if (!ring) continue;
    const A = Math.abs(area2(ring));
    if (A < 60) {
      const r = Math.sqrt(A / Math.PI);
      trees.push([ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length, r, 3 + r * 1.4]);
      continue;
    }
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]), step = 6;
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
      for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step)
        if (inside([x, y], ring)) {
          const j = hash(Math.round(x * 7 + y * 13));
          trees.push([x + (j - 0.5) * 2, y + (hash(Math.round(x * 3 - y * 5)) - 0.5) * 2, 3.6 + j * 1.2, 6 + j * 3]);
        }
  }
}
console.log(`  tree crowns: ${trees.length}`);

// 4. Bin objects by the render tiles they can appear on (base … top, + margin).
const bins = new Map<string, { b: Array<[P2[], number, number, number | null]>; t: number[][]; m: Array<[Array<[number, number[]]>, number, number[] | null]> }>();
const add = (minx: number, miny: number, maxx: number, maxy: number, fn: (bin: any) => void) => {
  for (let ty = Math.floor((miny - 8) / T); ty <= Math.floor((maxy + 8) / T); ty++)
    for (let tx = Math.floor((minx - 8) / T); tx <= Math.floor((maxx + 8) / T); tx++) {
      const k = `${tx}_${ty}`;
      if (!bins.has(k)) bins.set(k, { b: [], t: [], m: [] });
      fn(bins.get(k)!);
    }
};
const GROUND_GUESS = REGIONS[region].groundH + 20;
for (const b of buildings) {
  const pts = b.ring.flatMap(([x, y]) => [enuToPixel([x, y, GROUND_GUESS - 15]), enuToPixel([x, y, GROUND_GUESS + 25 + b.h])]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const ring = b.ring.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as P2);
  add(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (bin) => bin.b.push([ring, Math.round(b.h * 10) / 10, b.s, b.g && Math.round(b.g * 10) / 10]));
}
for (const m of meshes) {
  // the mesh itself, plus its footprint pushed 15 m down (the renderer may lower it onto the terrain)
  const pts = m.faces.flatMap(([, v]) => { const o: Array<[number, number]> = []; for (let i = 0; i < v.length; i += 3) o.push(enuToPixel([v[i], v[i + 1], v[i + 2]]), enuToPixel([v[i], v[i + 1], v[i + 2] - 15])); return o; });
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  add(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (bin) => bin.m.push([m.faces, m.s, m.roof]));
}
for (const t of trees) {
  const a = enuToPixel([t[0], t[1], GROUND_GUESS - 15]), c = enuToPixel([t[0], t[1], GROUND_GUESS + 25 + t[3] + t[2]]);
  const r = t[2] / CAMERA.mpp;
  add(Math.min(a[0], c[0]) - r, Math.min(a[1], c[1]) - r, Math.max(a[0], c[0]) + r, Math.max(a[1], c[1]) + r,
    (bin) => bin.t.push(t.map((v) => Math.round(v * 10) / 10)));
}
for (const [k, v] of bins) writeFileSync(join(out, `${k}.json`), JSON.stringify(v));
console.log(`  ${bins.size} tile bins -> ${out}`);
if (!existsSync(join(DERIVED, name))) mkdirSync(join(DERIVED, name), { recursive: true });
