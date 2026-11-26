/**
 * Build the 3D scene for an area from open data, in the camera's ENU frame.
 * Buildings and tree crowns; the ground comes from ground.ts.
 *
 *   npm -w pipeline run scene -- tlv-core
 *
 * Sources per region (places.ts `sources`): Tel Aviv-Yafo municipal buildings + canopy ("tlv"),
 * LGL LoD2 buildings + nDOM1 tree crowns ("lgl"), GUGiK LoD2/LoD1 buildings (with BDOT10k and OSM outlines of
 * those they lack) + NMPT crowns ("gugik"), ZG3D LoD2 buildings + OSM trees and crowns generated from OSM land
 * cover ("zg3d", greenery.ts), else OSM buildings + trees. Regions with look "styled" (and Zagreb, drawn the
 * same way for its painter) also take roof/facade looks, tall towers and landmarks from OSM, and get tunnel
 * portals and bridge models.
 *
 * Output: data/derived/<area>/scene/<tx>_<ty>.json — objects visible in each render tile:
 *   b: buildings  [ring (ENU x,y pairs, CCW), height above ground, style, groundHint]
 *   m: LoD2 meshes [style, roof kind, roof xyz[], wall xyz+facade[], footprint ring, height, seed]
 *   t: tree crowns [x, y, radius, crown height above ground, species (zg3d only: species.ts)]
 *   s: bushes and hedges [x, y, radius, top above ground] (preset bushes; only where there are some)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openArea } from "./areas.ts";
import { CAMERA, ecefToEnu, enuToLlh, enuToPixel, llhToEcef } from "./camera.ts";
import { isBridge } from "./bridges.ts";
import { crowns } from "./canopy.ts";
import { styleOf } from "./styles.ts";
import { powerLines } from "./power.ts";
import { playLayout, playPieces } from "./playgrounds.ts";
import { parkLayout, parkPieces } from "./parking.ts";
import { barriers } from "./barriers.ts";
import { type Road, roofsOnPosts, streetFurniture, streetLamps } from "./props.ts";
import { roadWidth } from "./roadspec.ts";
import { greenery, osmTreeCrown } from "./greenery.ts";
import { ARCADES, arcade, LOOKS, type MeshRef, PAINT, PLACED, type Piece, REBUILDS, type Rings, STADIUMS, stadiumStands, STRUCTURES, type Structure, TOPS, TOWERS, UMBRELLAS, umbrellas } from "./landmarks.ts";
import { frame } from "./frame.ts";
import { groupEnds, portal, tunnelEnds } from "./portals.ts";
import { BRIDGES } from "./bridgemodels.ts";
import { deckHeight } from "./bridges.ts";
import { bushes, foliageSeen, fromPuwg, gugikBuildings, gugikNdom, type OsmOutline, toPuwg } from "./gugik.ts";
import { lod2Files, rasterSampler } from "./lgl.ts";
import { localOsm } from "./osmlocal.ts";
import { alkisKind, type Lod2Building, parseLod2, triangulate, type V3 } from "./lod2.ts";
import { DERIVED, RAW, readJson } from "./paths.ts";
import { REGIONS } from "./places.ts";
import { fromUtm, toUtm } from "./utm.ts";
import { zg3dBuildings } from "./zg3d.ts";

/** a.push(...b) without spreading: a whole city's hedges or meshes overflow the call stack as arguments */
function pushAll<T>(a: T[], b: Iterable<T>) { for (const x of b) a.push(x); }

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

const centre = (r: P2[]): P2 => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
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

/**
 * LoD2 building -> [facade style, roof kinds] from its ALKIS building function (31001_<code>), AdV roof type
 * and height. Facade styles: 0 old plaster, 1 post-war plaster, 2 public/sandstone, 3 tower, 4 shed, 5 office,
 * 12 multi-storey car park (11 is masonry, portals.ts; 6–10 are Zagreb's, renderer.ts).
 * Roof kinds: 0 red tile, 1 brown tile, 2 slate, 3 gravel, 4 copper, 5 dark membrane, 6 green roof, 7 parking deck;
 * encoded pitched * 10 + flat, since roofs of mixed form (AdV 5000) have both and the renderer picks per plane.
 */
/** Muted roof colours for OSM roof:colour names and roof:material (the house palette, not CSS red). */
const ROOF_NAMED: Record<string, number[]> = {
  red: [0.74, 0.36, 0.25], darkred: [0.58, 0.28, 0.22], brown: [0.56, 0.38, 0.28], orange: [0.80, 0.48, 0.30],
  grey: [0.52, 0.53, 0.56], gray: [0.52, 0.53, 0.56], darkgrey: [0.38, 0.39, 0.42], darkgray: [0.38, 0.39, 0.42],
  lightgrey: [0.70, 0.70, 0.70], lightgray: [0.70, 0.70, 0.70], silver: [0.70, 0.71, 0.73], black: [0.28, 0.28, 0.30],
  white: [0.86, 0.85, 0.82], green: [0.45, 0.66, 0.56], beige: [0.80, 0.74, 0.62], blue: [0.42, 0.50, 0.62],
};
const ROOF_MATERIAL: Record<string, number[]> = {
  roof_tiles: ROOF_NAMED.red, tiles: ROOF_NAMED.red, slate: [0.44, 0.46, 0.50], metal: [0.62, 0.64, 0.66],
  zinc: [0.60, 0.62, 0.64], tin: [0.62, 0.64, 0.66], copper: [0.45, 0.70, 0.60], concrete: [0.74, 0.74, 0.72],
  gravel: [0.86, 0.84, 0.79], tar_paper: [0.40, 0.40, 0.42], asphalt: [0.40, 0.40, 0.42], glass: [0.58, 0.68, 0.74],
  grass: [0.56, 0.68, 0.40], plants: [0.56, 0.68, 0.40], eternit: [0.56, 0.56, 0.55],
};
/**
 * `tiles` = false: roof_tiles alone says nothing about the colour (Zagreb, where an import tagged half the city
 * with it); the renderer's own red and brown tile then varies per building.
 */
function roofRgb(t: Record<string, string>, tiles = true): number[] | null {
  const c = (t["roof:colour"] ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(c)?.[1];
  let rgb: number[] | null = null;
  if (hex) {
    const h = hex.length === 3 ? [...hex].map((d) => d + d).join("") : hex;
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const m = (rgb[0] + rgb[1] + rgb[2]) / 3; // mapped colours tend to the vivid: pull 25 % towards their grey
    rgb = rgb.map((v) => v * 0.75 + m * 0.25);
  } else rgb = ROOF_NAMED[c] ?? (!tiles && /^(roof_)?tiles$/.test(t["roof:material"] ?? "") ? null : ROOF_MATERIAL[t["roof:material"] ?? ""]) ?? null;
  return rgb && rgb.map((v) => Math.round(v * 100) / 100);
}

/** Facade style (see style()) and wall colour from OSM building:material / building:colour. */
const WALL_NAMED: Record<string, number[]> = {
  grey: [0.80, 0.79, 0.76], gray: [0.80, 0.79, 0.76], lightgrey: [0.86, 0.86, 0.84], lightgray: [0.86, 0.86, 0.84],
  darkgrey: [0.62, 0.62, 0.62], darkgray: [0.62, 0.62, 0.62], white: [0.96, 0.95, 0.92], beige: [0.92, 0.86, 0.72],
  yellow: [0.96, 0.89, 0.66], cream: [0.95, 0.91, 0.81], red: [0.78, 0.48, 0.40], brown: [0.66, 0.52, 0.42],
  orange: [0.92, 0.70, 0.50], pink: [0.94, 0.82, 0.78], blue: [0.72, 0.80, 0.88], green: [0.76, 0.84, 0.74],
};
function wallLook(t: Record<string, string>): { style: number | null; wall: number[] | null } {
  const m = t["building:material"] ?? "";
  const style = /stone|sandstone|limestone|marble|granite/.test(m) ? 2 : /glass/.test(m) ? 3 : /concrete|metal|steel/.test(m) ? 5 : null;
  const c = (t["building:colour"] ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(c)?.[1];
  let wall: number[] | null = WALL_NAMED[c] ?? null;
  if (hex) {
    const h = hex.length === 3 ? [...hex].map((d) => d + d).join("") : hex;
    const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255), mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
    wall = rgb.map((v) => Math.min(1, (v * 0.6 + mean * 0.4) * 0.5 + 0.48)); // walls stay light in the house style
  }
  return { style, wall: wall && wall.map((v) => Math.round(v * 100) / 100) };
}

function lod2Style(b: Lod2Building): [number, number] {
  if (b.fn === "zg3d") return zg3dStyle(b);
  const [s, roofKind] = lod2StyleOf(b), kind = b.kind ?? alkisKind(b.fn);
  return [s !== 4 && MONUMENTAL.has(kind) ? 6 : s, roofKind]; // preset: monumental walls for these kinds
}
function lod2StyleOf(b: Lod2Building): [number, number] {
  const kind = b.kind ?? alkisKind(b.fn), flatOnly = b.roofType === "1000";
  const r = hash(Math.round(b.center[0] * 1e6) ^ Math.round(b.center[1] * 1e6));
  const r2 = hash(Math.round(b.center[1] * 1e6) * 7 + 3);
  const tile = r < 0.55 ? 0 : r < 0.82 ? 1 : 2;
  const flat = r2 < 0.55 ? 3 : r2 < 0.85 || b.roofRgb ? 5 : 6; // no made-up green roof where the roof's colour is measured
  const k = (pitched: number, f: number) => pitched * 10 + f;
  if (kind === "structure") return [4, k(2, 5)];                                 // canopies, other structures
  const code = b.fn.split("_")[1] ?? "";
  if (code === "2461" || code === "2462") return [12, k(2, 7)];                  // ALKIS Parkhaus / Parkdeck: open decks, parking roof
  if (kind === "small" || b.height < 3.5) return [4, k(tile, 5)];
  if (kind === "church") return [2, k(r < 0.3 ? 4 : 2, 3)];                     // churches: slate, some copper
  if (b.height >= 45) return [3, k(2, 5)];
  if (kind === "public") return [2, k(r < 0.15 ? 4 : tile, flat)];             // public: sandstone
  if ((kind === "commercial" || kind === "industrial") && (flatOnly || b.height > 18)) return [r2 < 0.5 ? 5 : 1, k(tile, flat)]; // offices, shops: ribbon or punched windows
  if (kind === "industrial") return [4, k(tile, 5)];                            // production, storage
  return [flatOnly ? 1 : 0, k(tile, flat)];
}

/**
 * Height a ZG3D building stands above the ground on its uphill side. Its walls run down to the terrain at every
 * corner, so on Gornji grad's slopes (and on Kaptol) zmax - base counts the hill too and a four-storey house
 * would pass for a tower: count from the lowest wall point at a quarter of the corners instead. Walls that start
 * on a lower neighbour's roof raise the corners too, so this takes off at most a third of the height.
 */
const standingOf = new WeakMap<Lod2Building, number>(); // asked for up to 5 times per building
function standing(b: Lod2Building) {
  let h = standingOf.get(b);
  if (h === undefined) standingOf.set(b, (h = standingNow(b)));
  return h;
}
function standingNow(b: Lod2Building) {
  const low = new Map<string, number>();
  for (let i = 0; i + 4 < b.wall.length; i += 5) {
    const k = `${Math.round(b.wall[i] * 2)},${Math.round(b.wall[i + 1] * 2)}`;
    low.set(k, Math.min(low.get(k) ?? Infinity, b.wall[i + 2]));
  }
  let top = -Infinity;
  for (let i = 2; i < b.roof.length; i += 3) top = Math.max(top, b.roof[i]);
  if (!low.size || !Number.isFinite(top)) return b.height;
  const zs = [...low.values()].sort((x, y) => x - y);
  return Math.max(b.height * 0.67, Math.min(b.height, top - zs[Math.floor(zs.length / 4)]));
}

/**
 * ZG3D has no building function or roof type: style from height, footprint size and roof form.
 * Zagreb's centre is plastered Austro-Hungarian blocks under red-brown tile (dark sheet metal on many of the
 * larger ones); Novi Zagreb and the post-war estates are flat-roofed prefab slabs and towers (style 6),
 * offices glass (3, set from the OSM building use in the mesh loop below).
 */
function zg3dStyle(b: Lod2Building): [number, number] {
  const flatOnly = b.roofType === "1000", A = Math.abs(area2(b.footprint)), h = standing(b);
  const r = hash(Math.round(b.center[0] * 1e6) ^ Math.round(b.center[1] * 1e6));
  const r2 = hash(Math.round(b.center[1] * 1e6) * 7 + 3);
  const tile = r < 0.55 ? 0 : r < 0.8 || A < 600 ? 1 : 2; // red and brown tile; a fifth of the big blocks dark sheet
  const flat = r2 < 0.62 ? 3 : r2 < 0.94 ? 5 : 6;          // grey bitumen, light membrane, few green roofs
  const k = (pitched: number, f: number) => pitched * 10 + f;
  if (h < 3.5 || (A < 40 && h < 6)) return [4, k(tile, 5)];               // garages, sheds, kiosks
  if (h >= 45) return flatOnly ? [6, k(2, 3)] : [2, k(r < 0.6 ? 4 : 2, 3)]; // high-rises; pitched: church towers (copper, sheet)
  if (flatOnly && A > 2500 && h < 14 && elongation(b.footprint) <= 4) return [4, k(2, 5)]; // halls, warehouses, malls (not the long 4–5 storey slabs)
  if (flatOnly) return [h > 19 ? (r2 < 0.8 ? 6 : 5) : r2 < 0.3 ? 5 : 1, k(tile, flat)]; // post-war slabs, modern and 1930s blocks
  if (A > 1500 && h > 12) return [2, k(r < 0.3 ? 4 : tile, flat)];        // big pitched: public buildings
  return [h > 9 || r2 < 0.35 ? 0 : 1, k(tile, flat)];                     // houses and old town blocks
}
/** length / width of a footprint along its longest edge */
function elongation(r: P2[]) {
  let ax = 1, ay = 0, best = 0;
  for (let i = 0; i < r.length; i++) {
    const dx = r[(i + 1) % r.length][0] - r[i][0], dy = r[(i + 1) % r.length][1] - r[i][1], L = Math.hypot(dx, dy);
    if (L > best) { best = L; ax = dx / L; ay = dy / L; }
  }
  const u = r.map((p) => p[0] * ax + p[1] * ay), v = r.map((p) => -p[0] * ay + p[1] * ax);
  return (Math.max(...u) - Math.min(...u)) / Math.max(1, Math.max(...v) - Math.min(...v));
}
/**
 * OSM building uses that settle a ZG3D building's façade: offices glass, flats prefab concrete; housing is never a
 * windowless hall, industry, shops and sports halls always are (when low and flat). "housing" = building=yes with levels.
 */
const OFFICE = /^(office|commercial|hotel|retail|government)$/, FLATS = /^(apartments|residential|dormitory|house|terrace|housing)$/;
const HALL = /^(industrial|warehouse|retail|commercial|sports_hall|supermarket|manufacture|hangar|storage_tank|garages)$/;

const name = process.argv[2] ?? "tlv-core";
const area = openArea(name);
const bbox = area.bbox;
const region = REGIONS[area.region];
/**
 * Styled look (places.ts `look`): OSM looks and landmarks on the LoD2 meshes, tunnel portals, bridge models. Zagreb
 * (sources "zg3d") gets them too: its LoD2 is drawn the same way (page/renderer.ts) for its painter.
 */
const STYLED = region.look === "styled" || region.sources === "zg3d";
/** Building kinds drawn with monumental walls (styles.ts). */
const MONUMENTAL = new Set(styleOf(region.style).monumental);

/**
 * Façade features from what a building is used for (BDOT10k functions; drawn by page/renderer.ts), bits:
 * 16 known (then no made-up shop fronts), 1 shop fronts on the ground floor (a shop, restaurant, pharmacy or
 * bank in it, also downstairs in a home), 2 balcony stacks (blocks of flats: 4+ storeys, or 3 under a flat
 * roof), 4 garage doors, 8 a retail box (a market: blank walls, an entrance, a sign band), 32 a shed or barn
 * door, 64 hall doors (warehouses, workshops). 0: the source says nothing.
 */
const RETAIL = new Set(["obiekt handlowo-usługowy", "dom towarowy lub handlowy", "restauracja", "apteka", "bank"]);
function facadeFlags(b: Lod2Building): number {
  if (!b.use) return 0;
  const uses = b.uses ?? [b.use], area = Math.abs(area2(b.footprint)), st = b.storeys ?? 0;
  const market = b.use === "hipermarket lub supermarket" || ((b.use === "dom towarowy lub handlowy" || b.use === "obiekt handlowo-usługowy") && area >= 800);
  let f = 16;
  if (market && st <= 2) f |= 8;
  else if (uses.some((u) => RETAIL.has(u))) f |= 1;
  if (b.use === "budynek wielorodzinny" && (st >= 4 || (st >= 3 && b.roofType === "1000"))) f |= 2;
  if (b.use === "garaż") f |= 4;
  if (b.use === "budynek gospodarczy" || b.use === "budynek produkcyjny zwierząt hodowlanych") f |= 32;
  if (/^(magazyn|produkcyjny|warsztat remontowo-naprawczy|stacja obsługi pojazdów)$/.test(b.use) && area >= 250) f |= 64;
  return f;
}
/** Buildings are LoD2 meshes and tree crowns come from a surface model (LGL, GUGiK), not from OSM. */
const LOD2 = region.sources === "lgl" || region.sources === "gugik";
/** Geoid undulation: orthometric (MSL) + this = ellipsoid height. */
const GEOID = region.geoidM;
const raw = join(RAW, name);
/** OSM buildings become meshes with roofs (osmMesh): the ones ZG3D lacks, or every one in a styled region with no 3D
 *  source (OSM only); trees and crowns from OSM there too. */
const OSM_MESH = region.sources === "zg3d" || (!region.sources && STYLED);
if (!existsSync(join(DERIVED, name, "ground", "meta.json"))) throw new Error(`run: npm run ground -- ${name}`);
// terrain from ground.ts: objects are binned by where they really stand
const gmeta = readJson(join(DERIVED, name, "ground", "meta.json"));
const gbuf = readFileSync(join(DERIVED, name, "ground", "height.bin"));
const gh = new Float32Array(gbuf.buffer, gbuf.byteOffset, gbuf.length / 4);
function groundAt(x: number, y: number) {
  const ix = Math.min(gmeta.nx - 1, Math.max(0, Math.round((x - gmeta.x0) / gmeta.step)));
  const iy = Math.min(gmeta.ny - 1, Math.max(0, Math.round((y - gmeta.y0) / gmeta.step)));
  return gh[iy * gmeta.nx + ix];
}
const out = join(DERIVED, name, "scene");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

type Building = { ring: P2[]; h: number; s: number; g: number | null };
const buildings: Building[] = [];
const tlvCover: P2[][] = [];
/** municipal footprints with their holes, for the OSM 3D swap (1a) */
const tlvRecs: Array<{ b: Building; holes: P2[][]; id: number }> = [];

const trees: Array<[number, number, number, number, number?]> = [];
const shrubs: Array<[number, number, number, number]> = []; // bushes and hedges (preset bushes)
const mappedTrees: P2[] = []; // zg3d: OSM natural=tree, which generated crowns keep clear of
const meshes: Lod2Building[] = [];

// 1. Tel Aviv-Yafo municipal buildings: surveyed heights.
const tlv = region.sources === "tlv" ? readJson(join(raw, "tlv_buildings.geojson")) : { features: [] };
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
    const b = { ring, h: Math.max(3, h), s: style(h, kind, p.id_binyan ?? buildings.length, p.year), g: p.min_height ? p.min_height + GEOID : null };
    buildings.push(b);
    tlvCover.push(ring);
    tlvRecs.push({ b, holes: poly.slice(1).map((r: number[][]) => ringFromLonLat(r)).filter(Boolean) as P2[][], id: p.id_binyan });
  }
}
if (region.sources === "tlv") console.log(`  tlv buildings: ${buildings.length}`);
const osm = readJson(join(raw, "osm.json"));

// 1a. OSM 3D shapes (Simple 3D Buildings) for the municipal buildings they change most. The municipal layer
// has one height per footprint: a podium can carry its tower's height (Azrieli Center: the mall at 187 m)
// and a tower on a podium is one block. OSM buildings and building:parts give the shape. Only the top N
// (--parts N, default 10) are swapped, so the rest of the render still matches the paintings; the swapped
// buildings go to data/derived/<area>/osm-parts.json for `paint --parts`.
const PARTS_N = Number(process.argv.find((a, i) => process.argv[i - 1] === "--parts") ?? process.argv.find((a) => a.startsWith("--parts="))?.slice(8) ?? 10);
const swapped: Array<{ id: number; name: string; lat: number; lon: number; was: number; now: number; px: number[] }> = [];
if (region.sources === "tlv" && existsSync(join(raw, "osm_parts.json")) && PARTS_N > 0) {
  const num = (v?: string) => { const x = parseFloat((v ?? "").replace(",", ".")); return Number.isFinite(x) ? x : 0; };
  type Shape = { ring: P2[]; top: number; c: P2; a: number; part: boolean; outline?: boolean; id: string; name: string };
  const shapes: Shape[] = [], seen = new Set<string>();
  for (const el of [...readJson(join(raw, "osm_parts.json")).elements, ...osm.elements]) {
    const t = el.tags ?? {}, id = `${el.type}${el.id}`;
    if (seen.has(id) || !(t.building || t["building:part"]) || el.type === "node") continue;
    seen.add(id);
    if (t.building === "roof" || t["building:part"] === "roof" || t.location === "underground") continue;
    const coords = el.type === "way" ? el.geometry?.map((q: any) => [q.lon, q.lat])
      : el.members?.find((m: any) => m.role === "outer" && m.geometry)?.geometry.map((q: any) => [q.lon, q.lat]);
    const ring = coords?.length >= 4 ? ringFromLonLat(coords) : null;
    const levels = num(t["building:levels"]), top = num(t.height) || (levels ? levels * FLOOR + 1 : 0);
    if (!ring || !top) continue;
    shapes.push({ ring, top, c: centre(ring), a: Math.abs(area2(ring)), part: !!t["building:part"] && !t.building, id, name: t["name:en"] ?? t.name ?? "" });
  }
  const grid = <V>(items: V[], at: (v: V) => P2) => {
    const g = new Map<string, V[]>();
    for (const v of items) { const [x, y] = at(v), k = `${Math.floor(x / 60)}_${Math.floor(y / 60)}`; (g.get(k) ?? g.set(k, []).get(k)!).push(v); }
    return (p: P2, r: number) => {
      const out: V[] = [];
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) out.push(...(g.get(`${Math.floor(p[0] / 60) + dx}_${Math.floor(p[1] / 60) + dy}`) ?? []));
      return out;
    };
  };
  const samples = (ring: P2[], n: number) => {
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]), st = Math.max(1, Math.sqrt(Math.abs(area2(ring))) / n), out: P2[] = [];
    for (let x = Math.min(...xs) + st / 2; x < Math.max(...xs); x += st)
      for (let y = Math.min(...ys) + st / 2; y < Math.max(...ys); y += st) if (inside([x, y], ring)) out.push([x, y]);
    return { pts: out, cell: st * st };
  };
  // an outline whose parts cover it is not drawn (S3DB); one only partly split into parts (the Azrieli mall)
  // still stands under them at its own height
  const partsNear = grid(shapes.filter((s) => s.part), (s) => s.c);
  for (const s of shapes) if (!s.part) {
    const mine = partsNear(s.c, Math.ceil(Math.sqrt(s.a) / 60) + 1).filter((p) => inside(p.c, s.ring));
    if (!mine.length) continue;
    const { pts } = samples(s.ring, 20);
    s.outline = pts.filter((q) => mine.some((p) => inside(q, p.ring))).length >= 0.85 * pts.length;
  }
  const drawn = shapes.filter((s) => !s.outline);
  const shapesNear = grid(drawn, (s) => s.c), recsNear = grid(tlvRecs, (r) => centre(r.b.ring));
  const inRec = (p: P2, r: (typeof tlvRecs)[number]) => inside(p, r.b.ring) && !r.holes.some((h) => inside(p, h));
  type Cand = { rec: (typeof tlvRecs)[number]; own: Shape[]; change: number; now: number };
  const cands: Cand[] = [];
  for (const rec of tlvRecs) {
    const m = rec.b, A = Math.abs(area2(m.ring));
    if (A < 150 || m.h < 25) continue;
    const R = Math.ceil(Math.max(...m.ring.map((p) => Math.hypot(p[0] - centre(m.ring)[0], p[1] - centre(m.ring)[1]))) / 60) + 2;
    // OSM shapes mostly (≥ 50 %) inside this footprint
    const own = shapesNear(centre(m.ring), R).filter((s) => { const { pts } = samples(s.ring, 12); return pts.length > 0 && pts.filter((p) => inRec(p, rec)).length / pts.length >= 0.5; });
    if (!own.length) continue;
    const others = recsNear(centre(m.ring), R).filter((o) => o !== rec && Math.abs(area2(o.b.ring)) < A);
    const { pts, cell } = samples(m.ring, 40);
    let n = 0, cov = 0, change = 0;
    for (const p of pts) {
      if (!inRec(p, rec)) continue;
      n++;
      if (others.some((o) => inRec(p, o))) { cov++; continue; } // a tower mapped on its own in the municipal layer
      const tops = own.filter((s) => inside(p, s.ring)).map((s) => s.top);
      if (tops.length) { cov++; change += Math.abs(Math.max(...tops) - m.h) * cell; }
    }
    const now = Math.max(...own.map((s) => s.top));
    const touching = others.filter((o) => inRec(centre(o.b.ring), rec) || o.b.ring.some((q) => inRec(q, rec)));
    // trust OSM when it agrees on the top, or when a tower in the footprint explains the municipal height
    const agrees = now >= 0.8 * m.h && now <= 1.25 * m.h, podium = touching.some((o) => o.b.h >= 0.8 * m.h);
    if (n && cov / n >= 0.85 && (agrees || podium)) cands.push({ rec, own, change, now });
  }
  cands.sort((a, b) => b.change - a.change);
  const used = new Map<string, (typeof swapped)[number]>(), gone = new Set<Building>();
  for (const c of cands) {
    if (swapped.length >= PARTS_N) break;
    if (gone.has(c.rec.b)) continue; // a duplicate footprint of one already swapped
    const m = c.rec.b, add = c.own.filter((s) => !used.has(s.id));
    const pxBox = (r: P2[], lo: number, hi: number) => r.flatMap(([x, y]) => [enuToPixel([x, y, lo]), enuToPixel([x, y, hi])]);
    const g0 = Math.min(...m.ring.map(([x, y]) => groundAt(x, y))) - 3;
    const bounds = (px: P2[]) => [Math.min(...px.map((p) => p[0])), Math.min(...px.map((p) => p[1])), Math.max(...px.map((p) => p[0])), Math.max(...px.map((p) => p[1]))].map(Math.round);
    if (!add.length) { // its OSM shapes went to a building already swapped: a second municipal copy of it, dropped too
      const owner = used.get(c.own[0].id)!, b = bounds(pxBox(m.ring, g0, g0 + 6 + m.h));
      owner.px = [Math.min(owner.px[0], b[0]), Math.min(owner.px[1], b[1]), Math.max(owner.px[2], b[2]), Math.max(owner.px[3], b[3])];
      gone.add(m); buildings.splice(buildings.indexOf(m), 1);
      console.log(`  osm 3D: #${c.rec.id} is a copy of #${owner.id}, dropped`);
      continue;
    }
    // municipal duplicates of this footprint (Azrieli Sarona is mapped twice) go with it
    const dups = recsNear(centre(m.ring), 3).filter((o) => o !== c.rec && !gone.has(o.b) && Math.abs(area2(o.b.ring)) > 0.7 * Math.abs(area2(m.ring)) && Math.abs(area2(o.b.ring)) < 1.4 * Math.abs(area2(m.ring)) && (() => { const { pts } = samples(o.b.ring, 12); return pts.length > 0 && pts.filter((p) => inRec(p, c.rec)).length / pts.length >= 0.5; })());
    const px = [...pxBox(m.ring, g0, g0 + 6 + m.h), ...dups.flatMap((o) => pxBox(o.b.ring, g0, g0 + 6 + o.b.h)), ...add.flatMap((s) => pxBox(s.ring, g0, g0 + 6 + s.top))];
    for (const b of [m, ...dups.map((o) => o.b)]) { gone.add(b); buildings.splice(buildings.indexOf(b), 1); }
    for (const s of add) buildings.push({ ring: s.ring, h: s.top, s: style(s.top, m.s === 2 ? "public" : "regular", c.rec.id), g: m.g });
    const [lat, lon] = enuToLlh([...centre(m.ring), 0]);
    const nm = [...new Set(c.own.map((s) => s.name).filter(Boolean))].join(" / ");
    const entry = { id: c.rec.id, name: nm, lat, lon, was: m.h, now: c.now, px: bounds(px) };
    swapped.push(entry);
    for (const s of add) used.set(s.id, entry);
    console.log(`  osm 3D: #${c.rec.id} ${nm || "(unnamed)"} ${Math.round(m.h)} m -> ${add.length} OSM shape(s) up to ${Math.round(c.now)} m${dups.length ? `, ${dups.length} duplicate(s) dropped` : ""}`);
  }
  console.log(`  osm 3D: ${swapped.length} of ${cands.length} candidate buildings swapped (--parts ${PARTS_N})`);
}

// 1b. LoD2 buildings (real roofs) and tree crowns from a surface model: LGL (LoD2, nDOM1) or GUGiK
// (LoD2 + LoD1 2024, NMPT − NMT).
if (LOD2) {
  const m = 0.002; // buildings whose centre is just outside still reach into edge tiles
  const box = [bbox[0] - m, bbox[1] - m, bbox[2] + m, bbox[3] + m];
  let ndom: (x: number, y: number) => number, toXy = toUtm, fromXy = fromUtm;
  if (region.sources === "lgl") {
    for (const f of lod2Files(box)) {
      const bs = parseLod2(f.xml, box, GEOID);
      pushAll(meshes, bs);
      process.stdout.write(`\r  lod2: ${meshes.length} buildings (${f.name.split("/").pop()})        `);
    }
    process.stdout.write("\n");
    ndom = (await rasterSampler("ndom1", box)).px;
  } else {
    // OSM outlines (fetch.ts osm-buildings.json): closed outer rings
    const outlines: OsmOutline[] = [], file = join(raw, "osm-buildings.json");
    if (existsSync(file)) for (const el of readJson(file).elements) {
      const rings = el.type === "way" ? [el.geometry] : (el.members ?? []).filter((m: any) => m.role === "outer").map((m: any) => m.geometry);
      for (const g of rings) if (g?.length >= 4 && g[0].lat === g.at(-1).lat && g[0].lon === g.at(-1).lon)
        outlines.push({ id: `osm-${el.type}-${el.id}`, ring: g.map((q: any) => [q.lat, q.lon]), tags: el.tags ?? {} });
    }
    else console.log(`  no ${file}: run fetch for the OSM outlines of buildings the 3D models lack`);
    pushAll(meshes, await gugikBuildings(region.teryt ?? [], box, GEOID, outlines));
    ndom = gugikNdom(box);
    toXy = toPuwg; fromXy = fromPuwg;
  }
  const cs = crowns(ndom, box, meshes.flatMap((b) => b.xy), toXy);
  // GUGiK: crowns the orthophoto shows no foliage at are structures LoD2 leaves out (canopies, entrance roofs)
  const foliage = region.sources === "gugik" ? await foliageSeen(cs) : null;
  // On rail land and building sites the surface model is mostly masts, trains, cranes and containers:
  // keep only crowns that are clearly trees there (wide and tall).
  const noTrees: Array<{ r: P2[]; b: number[] }> = [];
  for (const el of readJson(join(raw, "ground.json")).elements) {
    if (!/^(railway|construction)$/.test(el.tags?.landuse ?? "")) continue;
    const rings = el.type === "way" ? [el.geometry] : (el.members ?? []).filter((m: any) => m.role === "outer" && m.geometry).map((m: any) => m.geometry);
    for (const g of rings) {
      const r = g && g.length >= 4 ? ringFromLonLat(g.map((q: any) => [q.lon, q.lat])) : null;
      if (r) noTrees.push({ r, b: [Math.min(...r.map((q) => q[0])), Math.min(...r.map((q) => q[1])), Math.max(...r.map((q) => q[0])), Math.max(...r.map((q) => q[1]))] });
    }
  }
  // Bridges: the surface model holds the deck above the bare-earth gap, read as crowns. Drop crowns on
  // the deck (a tree under it is hidden by it anyway).
  const decks: P2[][] = [];
  for (const el of readJson(join(raw, "ground.json")).elements) {
    if (el.type !== "way" || !isBridge(el.tags ?? {}) || !(el.tags.highway || el.tags.railway) || !(el.geometry?.length >= 2)) continue;
    decks.push(el.geometry.map((q: any) => { const e = toEnu(q.lon, q.lat); return [e[0], e[1]] as P2; }));
  }
  const segDist = (p: P2, a: P2, b: P2) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
  };
  const onDeck = (p: P2) => decks.some((l) => l.some((a, i) => i > 0 && segDist(p, l[i - 1], a) < 4));
  // ... and inside bridge outlines (a bridge whose tracks OSM has not opened yet has no way), and on water,
  // where the surface model is noise and boats
  const over: Array<{ r: P2[][]; b: number[] }> = [];
  for (const el of readJson(join(raw, "ground.json")).elements) {
    const t = el.tags ?? {};
    if (t.man_made !== "bridge" && !(t.natural === "water" || t.waterway === "riverbank")) continue;
    const rings = (el.type === "way" ? [el.geometry] : (el.members ?? []).filter((m: any) => m.geometry).map((m: any) => m.geometry))
      .filter((g: any) => g && g.length >= 4).map((g: any) => ringFromLonLat(g.map((q: any) => [q.lon, q.lat]))).filter(Boolean) as P2[][];
    if (!rings.length) continue;
    const all = rings.flat();
    over.push({ r: rings, b: [Math.min(...all.map((q) => q[0])), Math.min(...all.map((q) => q[1])), Math.max(...all.map((q) => q[0])), Math.max(...all.map((q) => q[1]))] });
  }
  const overWater = (p: P2) => over.some(({ r, b }) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && r.filter((q) => inside(p, q)).length % 2 === 1);
  // Tall buildings: where the surface model and the LoD2 walls disagree by a metre or two, the wall's top
  // edge reads as a tall, slim crown beside it (the Bonatzbau tower grew a row of 55 m "trees"). LGL nDOM1 only.
  const tall = region.sources !== "lgl" ? [] : meshes.filter((b) => b.height > 25).flatMap((b) => b.xy.map((r) => {
    const xs = r.map((q) => q[0]), ys = r.map((q) => q[1]);
    return { r, h: b.height, box: [Math.min(...xs) - 4, Math.min(...ys) - 4, Math.max(...xs) + 4, Math.max(...ys) + 4] };
  }));
  const wallEdge = (c: { e: number; n: number; h: number }) => tall.some(({ r, h, box }) => c.h > 0.6 * h &&
    c.e >= box[0] && c.e <= box[2] && c.n >= box[1] && c.n <= box[3] && (inside([c.e, c.n], r) || r.some((q, i) => segDist([c.e, c.n], r[(i + r.length - 1) % r.length], q) < 4)));
  let masked = 0, bridged = 0, bare = 0, edges = 0;
  for (const [i, c] of cs.entries()) {
    if (foliage && !foliage[i]) { bare++; continue; }
    const [lat, lon] = fromXy(c.e, c.n), p = toEnu(lon, lat);
    if (onDeck([p[0], p[1]]) || overWater([p[0], p[1]])) { bridged++; continue; }
    if (wallEdge(c)) { edges++; continue; }
    // there, cranes and masts are tall and slim: a tree is wide for its height and under ~25 m
    if ((c.r < 4 || c.h < 8 || (region.sources === "lgl" && (c.h > 25 || c.h > 6 * c.r))) && noTrees.some(({ r, b }) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && inside([p[0], p[1]], r))) { masked++; continue; }
    trees.push([p[0], p[1], c.r, Math.max(c.r * 0.6 + 1, c.h - c.r * 0.85)]);
  }
  // preset bushes: the low surface model where the photo is green, off buildings and crowns (gugik.ts bushes)
  if (region.sources === "gugik" && STYLED && styleOf(region.style).bushes) {
    const kept = cs.filter((_, i) => !foliage || foliage[i]);
    for (const b of await bushes(ndom, meshes.flatMap((m) => m.xy), kept, box)) {
      const [lat, lon] = fromXy(b.e, b.n), p = toEnu(lon, lat);
      if (!onDeck([p[0], p[1]]) && !overWater([p[0], p[1]])) shrubs.push([p[0], p[1], b.r, b.h]);
    }
    console.log(`  bushes and hedges: ${shrubs.length}`);
  }
  console.log(`  ${region.sources === "lgl" ? "ndom1" : "nmpt − nmt"} tree crowns: ${cs.length - masked - bridged - bare - edges} (${masked} dropped on rail land / building sites, ${bridged} on bridges or water${foliage ? `, ${bare} with no foliage on the orthophoto` : ""}${edges ? `, ${edges} tall-building edges` : ""})`);
}

// 1c. ZG3D LoD2 buildings. Their heights are surveyed but the terrain is Copernicus (30 m): each building is
// moved to the terrain under its footprint, so none floats or sinks (walls reach 1 m below ground anyway).
if (region.sources === "zg3d") {
  const m = 0.002; // buildings whose centre is just outside still reach into edge tiles
  const box: [number, number, number, number] = [bbox[0] - m, bbox[1] - m, bbox[2] + m, bbox[3] + m];
  const bs = zg3dBuildings(box, GEOID, readJson(join(RAW, "zg3d", "index.json")));
  const shifts: number[] = [];
  for (const b of bs) {
    const fc = centre(b.footprint), d = Math.min(...b.footprint.map(([x, y]) => groundAt(x, y)), groundAt(...fc)) - b.base;
    for (let i = 2; i < b.roof.length; i += 3) b.roof[i] += d;
    for (let i = 2; i < b.wall.length; i += 5) b.wall[i] += d;
    b.base += d;
    shifts.push(d);
    tlvCover.push(b.footprint); // OSM fills in only buildings ZG3D lacks
  }
  pushAll(meshes, bs);
  shifts.sort((a, b) => a - b);
  const q = (f: number) => shifts.length ? shifts[Math.floor(f * (shifts.length - 1))].toFixed(1) : "-";
  console.log(`  zg3d: ${bs.length} buildings; moved to terrain by ${q(0.05)} / ${q(0.5)} / ${q(0.95)} m (5/50/95 %)`);
}

// 2. OSM buildings where the municipal layer has nothing (Ramat Gan, Givatayim, Bnei Brak…).
const coverGrid = new Map<string, P2[][]>(); // 50 m grid of municipal footprints for overlap tests
for (const r of tlvCover) {
  const k = `${Math.floor(r[0][0] / 50)}_${Math.floor(r[0][1] / 50)}`;
  if (!coverGrid.has(k)) coverGrid.set(k, []);
  coverGrid.get(k)!.push(r);
}
const covered = (pt: P2) => {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    if (coverGrid.get(`${Math.floor(pt[0] / 50) + dx}_${Math.floor(pt[1] / 50) + dy}`)?.some((r) => inside(pt, r))) return true;
  return false;
};
/**
 * An OSM building ZG3D lacks (newer than the survey), as a LoD2-like mesh so it takes the palette, façades and
 * roof furniture of its surveyed neighbours: gabled or hipped on a four-cornered outline (roof:shape, or houses
 * without one), else flat. `addRoof`: the height came from levels, so the roof goes on top of it.
 */
function osmMesh(ring: P2[], h: number, t: Record<string, string>, addRoof: boolean): Lod2Building {
  const base = Math.min(...ring.map(([x, y]) => groundAt(x, y)));
  const roof: number[] = [], wall: number[] = [];
  const shape = t["roof:shape"] ?? (/^(house|detached|semidetached_house|farm|garage|shed|barn|farm_auxiliary)$/.test(t.building) ? "gabled" : "flat");
  let along = 0;
  const side = (a: P2, b: P2, za: number, zb: number) => { // vertical quad base … za (at a) / zb (at b), outward for CCW rings
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const v = (p: P2, s: number, z: number) => wall.push(p[0], p[1], base + z, along + s, z);
    v(a, 0, 0); v(b, L, 0); v(b, L, zb); v(a, 0, 0); v(b, L, zb); v(a, 0, za);
    along += L;
  };
  let r = ring;
  const pitched = r.length === 4 && /^(gabled|hipped|half-hipped|gabled_height_moved)$/.test(shape);
  if (pitched) {
    const len = (i: number) => Math.hypot(r[(i + 1) % 4][0] - r[i][0], r[(i + 1) % 4][1] - r[i][1]);
    if (len(1) > len(0)) r = [r[1], r[2], r[3], r[0]];          // p0→p1 and p2→p3 are the long sides
    const short = (len(1) + len(3)) / 2, long = (len(0) + len(2)) / 2;
    const rh = Math.min(parseFloat(t["roof:height"]) || 0.42 * short, 0.6 * h);
    if (addRoof) h += rh;
    const eave = h - rh, mid = (a: P2, b: P2): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let r0 = mid(r[3], r[0]), r1 = mid(r[1], r[2]);
    const hip = shape === "hipped" && long > short;
    if (hip) { // ridge pulled in by half the short side at both ends
      const d: P2 = [(r1[0] - r0[0]) / long, (r1[1] - r0[1]) / long], k = short / 2;
      r0 = [r0[0] + d[0] * k, r0[1] + d[1] * k]; r1 = [r1[0] - d[0] * k, r1[1] - d[1] * k];
    }
    const P = (p: P2, z: number) => [p[0], p[1], base + z];
    roof.push(...P(r[0], eave), ...P(r[1], eave), ...P(r1, h), ...P(r[0], eave), ...P(r1, h), ...P(r0, h));
    roof.push(...P(r[2], eave), ...P(r[3], eave), ...P(r0, h), ...P(r[2], eave), ...P(r0, h), ...P(r1, h));
    for (let i = 0; i < 4; i++) side(r[i], r[(i + 1) % 4], eave, eave);
    for (const [a, b, q] of [[r[1], r[2], r1], [r[3], r[0], r0]] as Array<[P2, P2, P2]>) {
      if (hip) roof.push(...P(a, eave), ...P(b, eave), ...P(q, h));
      else { // gable: a wall triangle up to the ridge
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        wall.push(...P(a, eave), 0, eave, ...P(b, eave), L, eave, ...P(q, h), L / 2, h);
      }
    }
  } else {
    for (let i = 0; i < r.length; i++) side(r[i], r[(i + 1) % r.length], h, h);
    for (const tri of triangulate([r.map(([x, y]) => [x, y, base + h] as V3)]) ?? []) for (const v of tri) roof.push(...v);
  }
  const c = centre(ring);
  return { id: "osm", fn: "zg3d", roofType: pitched ? "3100" : "1000", height: h, base, roof, wall, footprint: ring, center: [c[1] / 1e5, c[0] / 1e5], xy: [] };
}

let osmCount = 0;
// styled regions: OSM roof:colour / roof:material, building:colour / building:material per footprint or building part
// tall towers (TV towers…): LoD2 has only a stump, OSM often has the whole shape as building:parts with min_height
const tallTowers: Array<{ ring: P2[]; h: number; name?: string }> = [];
const structures: Array<{ rings: Rings; structure: Structure; t: Record<string, string> }> = []; // landmarks.ts STRUCTURES
const tops: Array<{ ring: P2[]; name: string }> = []; // landmarks.ts TOPS
const fountains: Array<{ ring?: P2[]; at?: P2 }> = [];
const arcades: Array<{ ring: P2[]; name: string }> = []; // landmarks.ts ARCADES
const rebuilds: Array<{ ring: P2[]; key: string }> = []; // landmarks.ts REBUILDS
const parts: Array<{ ring: P2[]; h: number; min: number; t: Record<string, string> }> = [];
const looks: Array<{ ring: P2[]; area: number; roof: number[] | null; style: number | null; wall: number[] | null; bare?: boolean; use?: string; historic?: 1 | 2 }> = [];
/** preset historicFacades: 2 a church, castle or palace (stone), 1 another historic building (old plaster), 0 neither */
const HISTORIC_FACADES = STYLED && styleOf(region.style).historicFacades;
function historicOf(t: Record<string, string>): 0 | 1 | 2 {
  if (t.amenity === "place_of_worship" || /^(church|cathedral|chapel|basilica|monastery|synagogue|temple|mosque|castle|palace)$/.test(t.building ?? "")
    || /^(castle|church|palace|monastery|manor)$/.test(t.historic ?? "")) return 2;
  const y = parseInt(t.start_date ?? "", 10);
  return t.historic || t.heritage || (y > 0 && y < 1945) ? 1 : 0;
}
for (const el of osm.elements) {
  const t = { ...el.tags, ...(LOOKS[el.tags?.name] ?? {}) };
  // structures built on their OSM outline (landmarks.ts STRUCTURES): a graduation tower's brushwood walls
  const structure = STYLED && el.type !== "node" ? STRUCTURES.find((s) => s.match(t)) : undefined;
  if (structure) {
    const rings = osmRings(el);
    if (rings.outer.length) structures.push({ rings, structure, t });
    continue;
  }
  if (t.amenity === "fountain" && LOD2) { // nDOM reads fountain sculptures as tree crowns
    if (el.type === "node") { const q = toEnu(el.lon, el.lat); fountains.push({ at: [q[0], q[1]] }); }
    else if (el.type === "way" && el.geometry?.length >= 4) { const ring = ringFromLonLat(el.geometry.map((q: any) => [q.lon, q.lat])); if (ring) fountains.push({ ring }); }
    if (!t.building) continue;
  }
  if (el.type === "node" && t.natural === "tree") {
    if (LOD2) continue; // the surface model's crowns include them
    const p = toEnu(el.lon, el.lat);
    if (OSM_MESH) { trees.push(osmTreeCrown(t, p[0], p[1])); mappedTrees.push([p[0], p[1]]); continue; } // size, species from tags
    trees.push([p[0], p[1], 3, 6]); continue;
  }
  const monument = STYLED && !t.building && !t["building:part"] && el.type === "way" && (t.name ?? "") in TOWERS; // Jubiläumssäule
  const styledLook = STYLED && (!!(t.building || t["building:part"]) || monument);
  if (!styledLook && (!t.building || t.building === "roof" || t.location === "underground")) continue;
  const coords = el.type === "way" ? el.geometry?.map((q: any) => [q.lon, q.lat])
    : el.members?.find((m: any) => (m.role === "outer" || m.role === "outline") && m.geometry)?.geometry.map((q: any) => [q.lon, q.lat]); // outline: type=building relations
  if (!coords || coords.length < 4) continue;
  const ring = ringFromLonLat(coords);
  if (!ring) continue;
  if (styledLook) {
    const h = parseFloat(t.height);
    if (monument) { tallTowers.push({ ring, h, name: t.name }); continue; }
    if ((/^(tower|communications_tower)$/.test(t.man_made ?? "") && h >= 60) || (t.building && (t.name ?? "") in TOWERS)) tallTowers.push({ ring, h, name: t.name });
    if (t.name && t.name in TOPS) tops.push({ ring, name: t.name });
    if (t.name && t.name in ARCADES && t.building) arcades.push({ ring, name: t.name });
    if (t.wikidata && t.wikidata in REBUILDS && t.building) rebuilds.push({ ring, key: t.wikidata });
    if (t["building:part"] && h) parts.push({ ring, h, min: parseFloat(t.min_height) || 0, t });
    const kind = t.building === "yes" && t["building:levels"] ? "housing" : t.building ?? "";
    const use = OSM_MESH && (OFFICE.test(kind) || FLATS.test(kind) || HALL.test(kind)) ? kind : undefined;
    const paint = PAINT[t.name] ?? {}; // Zagreb landmarks: colours as rendered
    const w = wallLook(t);
    const hist = HISTORIC_FACADES ? historicOf(t) : 0;
    const look = { ring, area: Math.abs(area2(ring)), roof: paint.roof ?? roofRgb(t, !OSM_MESH), style: paint.style ?? w.style, wall: paint.wall ?? w.wall, bare: t.name in LOOKS || t.name in PAINT, use, ...(hist ? { historic: hist } : {}) }; // landmarks: no solar panels etc.
    if (look.roof || look.wall || look.style !== null || look.bare || look.use || hist) looks.push(look);
    // ZG3D (2008/2019–22 surveys) misses newer buildings: OSM ones not on a ZG3D footprint are built below, and
    // without a 3D source every OSM building is (not open structures: Dolac's upper market is building=marketplace
    // over the stalls ZG3D does have)
    if (OSM_MESH && (!t.building || /^(roof|marketplace|carport|construction|ruins)$/.test(t.building) || t.location === "underground")) continue;
  }
  if (LOD2) continue; // the buildings are LoD2 meshes: OSM footprints only carry their looks
  const c: P2 = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
  if (covered(c)) continue;
  // ZG3D: a perimeter block's centre lies in its courtyard; count it covered when a third of the points
  // inside its outline (a 3 m grid, at most ~100) stand on surveyed footprints
  if (region.sources === "zg3d") {
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const st = Math.max(3, Math.sqrt(((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 100));
    let ins = 0, cov = 0;
    for (let x = Math.min(...xs) + st / 2; x < Math.max(...xs); x += st)
      for (let y = Math.min(...ys) + st / 2; y < Math.max(...ys); y += st)
        if (inside([x, y], ring)) { ins++; if (covered([x, y])) cov++; }
    if (ins && cov / ins > 0.33) continue;
  }
  const levels = parseFloat(t["building:levels"]);
  let h = parseFloat(t.height) || (levels ? levels * FLOOR + 1 : 0);
  if (!h) h = Math.abs(area2(ring)) > 1500 ? 14 : ["house", "garage", "shed", "kiosk"].includes(t.building) ? 5 : 13;
  if (OSM_MESH) {
    meshes.push(osmMesh(ring, h, t, !t.height));
    osmCount++;
    continue;
  }
  buildings.push({ ring, h, s: style(h, t.amenity || t.building === "school" ? "public" : "regular", el.id), g: null });
  osmCount++;
}
if (fountains.length) {
  const n0 = trees.length;
  for (let i = trees.length - 1; i >= 0; i--) {
    const p: P2 = [trees[i][0], trees[i][1]];
    if (fountains.some((f) => (f.ring ? inside(p, f.ring) : Math.hypot(p[0] - f.at![0], p[1] - f.at![1]) < 3))) trees.splice(i, 1);
  }
  console.log(`  fountains: ${fountains.length}, ${n0 - trees.length} crown(s) on them dropped`);
}
console.log(`  osm buildings (outside municipal layer): ${osmCount}`);
if (looks.length) console.log(`  osm roof/wall looks: ${looks.length}`);
// preset historicFacades: historic and religious buildings from the full OSM outlines too (osm.json has only those with
// looks of their own: Wawel castle is only in osm-buildings.json)
if (HISTORIC_FACADES && existsSync(join(raw, "osm-buildings.json"))) {
  let n = 0;
  for (const el of readJson(join(raw, "osm-buildings.json")).elements as any[]) {
    const hist = el.type === "node" ? 0 : historicOf(el.tags ?? {});
    if (!hist) continue;
    for (const ring of osmRings(el).outer) { looks.push({ ring, area: Math.abs(area2(ring)), roof: null, style: null, wall: null, historic: hist }); n++; }
  }
  console.log(`  historic façades: ${n} OSM outlines`);
}
// the smallest OSM footprint (a building:part before its building) holding a LoD2 building's centre, per attribute; 50 m grid
looks.sort((a, b) => a.area - b.area);
const lookGrid = new Map<string, typeof looks>();
for (const r of looks) {
  const xs = r.ring.map((p) => p[0]), ys = r.ring.map((p) => p[1]);
  for (let gx = Math.floor(Math.min(...xs) / 50); gx <= Math.floor(Math.max(...xs) / 50); gx++)
    for (let gy = Math.floor(Math.min(...ys) / 50); gy <= Math.floor(Math.max(...ys) / 50); gy++) {
      const k = `${gx}_${gy}`;
      if (!lookGrid.has(k)) lookGrid.set(k, []);
      lookGrid.get(k)!.push(r);
    }
}
const lookAt = (pt: P2) => {
  const hits = lookGrid.get(`${Math.floor(pt[0] / 50)}_${Math.floor(pt[1] / 50)}`)?.filter((r) => inside(pt, r.ring)) ?? [];
  return { roof: hits.find((r) => r.roof)?.roof ?? null, style: hits.find((r) => r.style !== null)?.style ?? null, wall: hits.find((r) => r.wall)?.wall ?? null, bare: hits.some((r) => r.bare), use: hits.find((r) => r.use)?.use, historic: Math.max(0, ...hits.map((r) => r.historic ?? 0)) };
};

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
const can = region.sources === "tlv" ? readJson(join(raw, "tlv_canopy.geojson")) : { features: [] };
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
// 3c. No canopy layer (Zagreb, OSM-only regions): crowns for woods, parks, cemeteries, scrub, orchards and tree
// rows come from OSM land cover (greenery.ts), clear of buildings, roads, water and the trees OSM maps one by one.
if (OSM_MESH) {
  // natural=tree_row is in neither osm.json nor ground.json: cut once from the region's extract
  const rowsFile = join(DERIVED, name, "tree-rows.json");
  if (!existsSync(rowsFile) && region.osmExtract) {
    const [s, w, n, e] = bbox, m = 0.005;
    writeFileSync(rowsFile, JSON.stringify(await localOsm(region.osmExtract, [s - m, w - m, n + m, e + m], (type, t) => type === "way" && t.natural === "tree_row")));
  }
  // the area plus what its edge tiles show beyond it
  const corners = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]].map(([la, lo]) => toEnu(lo, la)), pad = 250;
  const box: [number, number, number, number] = [Math.min(...corners.map((c) => c[0])) - pad, Math.min(...corners.map((c) => c[1])) - pad,
    Math.max(...corners.map((c) => c[0])) + pad, Math.max(...corners.map((c) => c[1])) + pad];
  const t0 = Date.now();
  const g = greenery({
    ground: readJson(join(raw, "ground.json")).elements,
    rows: existsSync(rowsFile) ? readJson(rowsFile).elements : [],
    mapped: mappedTrees,
    buildings: [...meshes.map((b) => b.footprint), ...buildings.map((b) => b.ring)],
    box,
    toXY: (lon, lat) => { const p = toEnu(lon, lat); return [p[0], p[1]]; },
    msl: (x, y) => groundAt(x, y) - GEOID,
  });
  for (const c of g.crowns) trees.push(c); // too many for a spread push
  console.log(`  osm trees: ${mappedTrees.length}; generated crowns: ${g.crowns.length} in ${((Date.now() - t0) / 1000).toFixed(1)} s (${Object.entries(g.stats).map(([k, v]) => `${k} ${v}`).join(", ")})`);
}
console.log(`  tree crowns: ${trees.length}`);

// 4. Bin objects by the render tiles they can appear on (base … top, + margin).
type Bin = { b: Array<[P2[], number, number, number | null]>; m: unknown[]; t: Array<(typeof trees)[number]>; s?: Array<[number, number, number, number]> };
const bins = new Map<string, Bin>();
const add = (minx: number, miny: number, maxx: number, maxy: number, fn: (bin: Bin) => void) => {
  for (let ty = Math.floor((miny - 8) / T); ty <= Math.floor((maxy + 8) / T); ty++)
    for (let tx = Math.floor((minx - 8) / T); tx <= Math.floor((maxx + 8) / T); tx++) {
      const k = `${tx}_${ty}`;
      if (!bins.has(k)) bins.set(k, { b: [], m: [], t: [] });
      fn(bins.get(k)!);
    }
};
for (const b of buildings) {
  const gs = b.ring.map(([x, y]) => groundAt(x, y)), lo = Math.min(...gs) - 3, hi = Math.max(...gs) + 3 + b.h;
  const pts = b.ring.flatMap(([x, y]) => [enuToPixel([x, y, lo]), enuToPixel([x, y, hi])]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const ring = b.ring.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as P2);
  add(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (bin) => bin.b.push([ring, Math.round(b.h * 10) / 10, b.s, b.g && Math.round(b.g * 10) / 10]));
}
const c2 = (v: number) => Math.round(v * 100) / 100;
// 3b. Tall towers from OSM: replace the LoD2 mesh with the tower's building:parts (or its outline), extruded
// from min_height to height; colours straight from the part's tags.
type Mesh = (typeof meshes)[number] & { look?: { roof: number[] | null; wall: number[] | null; style: number | null; bare?: boolean | 1 | 2 | 3 } };
function prism(ring: P2[], base: number, min: number, h: number, look: Mesh["look"]): Mesh {
  const c = centre(ring), roof: number[] = [], wall: number[] = [];
  let along = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    roof.push(c[0], c[1], base + h, a[0], a[1], base + h, b[0], b[1], base + h);
    const v = (p: P2, s: number, z: number) => wall.push(p[0], p[1], base + z, s, z);
    v(a, along, min); v(b, along + L, min); v(b, along + L, h);
    v(a, along, min); v(b, along + L, h); v(a, along, h);
    along += L;
  }
  return { id: "osm-tower", fn: "osm_tower", roofType: "1000", height: h, base, roof, wall, footprint: ring, center: [0, 0], xy: [], look } as unknown as Mesh;
}
/** A way's or multipolygon's closed rings in ENU (members that are closed ways; others are left out). */
function osmRings(el: any): Rings {
  const ring = (g: any[]) => (g?.length >= 4 ? ringFromLonLat(g.map((q: any) => [q.lon, q.lat])) : null);
  if (el.type === "way") { const r = ring(el.geometry); return { outer: r ? [r] : [], inner: [] }; }
  const of = (role: string) => (el.members ?? []).filter((m: any) => m.role === role).map((m: any) => ring(m.geometry)).filter(Boolean) as P2[][];
  return { outer: of("outer"), inner: of("inner") };
}
const fromPiece = (p: Piece) => ({ id: "landmark", fn: "osm_landmark", roofType: "1000", center: [0, 0], xy: [], ...p }) as unknown as Mesh;
// landmarks rebuilt from their LoD2 meshes and OSM building:parts (Zagreb Cathedral's towers, St Mark's roof)
for (const rb of rebuilds) {
  const mine = meshes.filter((b) => inside(centre(b.footprint), rb.ring)) as unknown as MeshRef[];
  const pieces = REBUILDS[rb.key]({ ring: rb.ring, parts: parts.filter((p) => inside(centre(p.ring), rb.ring)), meshes: mine });
  pushAll(meshes, pieces.map(fromPiece));
  console.log(`  landmark ${rb.key}: ${mine.length} LoD2 mesh(es) -> ${pieces.length} piece(s)`);
}
const rebuilt = (r: P2[]) => rebuilds.some((rb) => inside(centre(r), rb.ring)); // their tall parts are done
for (const tw of tallTowers.filter((tw) => !rebuilt(tw.ring))) {
  const near = (p: P2) => inside(p, tw.ring) || tw.ring.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 3);
  const stump = meshes.filter((b) => near(centre(b.footprint)));
  const base = stump.length ? Math.min(...stump.map((b) => b.base)) : groundAt(...centre(tw.ring));
  for (const b of stump) meshes.splice(meshes.indexOf(b), 1);
  const model = tw.name ? TOWERS[tw.name] : undefined;
  if (model) {
    pushAll(meshes, model(centre(tw.ring), base).map(fromPiece));
    const tc = centre(tw.ring); // nDOM reads a slender column (or a drum's rim) as a tree crown
    for (let i = trees.length - 1; i >= 0; i--) {
      const p: P2 = [trees[i][0], trees[i][1]];
      if (Math.hypot(p[0] - tc[0], p[1] - tc[1]) < 6 || near(p) || tw.ring.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 2.5)) trees.splice(i, 1);
    }
    console.log(`  landmark ${tw.name}: ${stump.length} LoD2 part(s) -> model`);
    continue;
  }
  const mine = parts.filter((p) => near(centre(p.ring)));
  for (const p of mine.length ? mine : [{ ring: tw.ring, h: tw.h, min: 0, t: {} as Record<string, string> }]) {
    const w = wallLook(p.t), glazed = p.t["building:part"] !== "yes" || !!p.t["building:levels"];
    meshes.push(prism(p.ring, base, p.min, p.h, { roof: roofRgb(p.t), wall: w.wall, style: glazed ? 5 : 4 }));
  }
  console.log(`  tall tower ${Math.round(tw.h)} m: ${stump.length} LoD2 part(s) -> ${mine.length || 1} OSM part(s)`);
}
// rooftop landmarks (the Mercedes star on the Bahnhofsturm): on the highest LoD2 roof point inside the OSM outline
for (const tp of tops) {
  let top = -Infinity;
  for (const b of meshes) for (let i = 0; i < b.roof.length; i += 3)
    if (inside([b.roof[i], b.roof[i + 1]], tp.ring)) top = Math.max(top, b.roof[i + 2]);
  if (!Number.isFinite(top)) continue;
  // centre of the top face (a tower's flat roof, a lantern's cap), not of the outline (U-shaped palaces)
  let sx = 0, sy = 0, sn = 0;
  for (const b of meshes) for (let i = 0; i < b.roof.length; i += 3)
    if (b.roof[i + 2] > top - 0.3 && inside([b.roof[i], b.roof[i + 1]], tp.ring)) { sx += b.roof[i]; sy += b.roof[i + 1]; sn++; }
  pushAll(meshes, TOPS[tp.name]([sx / sn, sy / sn], top, region.headingDeg).map(fromPiece));
  console.log(`  landmark ${tp.name}: on the roof at ${top.toFixed(1)} m`);
}

// colonnades (Königsbau): carved into the LoD2 front wall inside the OSM outline
for (const ac of arcades) {
  for (const b of meshes.filter((m) => inside(centre(m.footprint), ac.ring))) {
    const extra = arcade(b as any, ARCADES[ac.name]);
    pushAll(meshes, extra.map(fromPiece));
    if (extra.length) console.log(`  landmark ${ac.name}: colonnade carved`);
  }
  // nDOM reads the colonnade overhang as a row of crowns in front of it: drop crowns at the building
  const near = (p: P2) => inside(p, ac.ring) || ac.ring.some((a, i) => {
    const b = ac.ring[(i + 1) % ac.ring.length], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const f = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    return Math.hypot(p[0] - a[0] - f * dx, p[1] - a[1] - f * dy) < 5;
  });
  for (let i = trees.length - 1; i >= 0; i--) if (near([trees[i][0], trees[i][1]])) trees.splice(i, 1);
}
// platform shelters (ground.ts platforms with shelter=yes): glass-roofed units on teal posts along the platform's
// middle, like the SSB Stadtbahn stops (Pragsattel photos in ATTRIBUTION.md); hip roofs, so every slope is a wall
{
  const fp = join(DERIVED, name, "ground", "features.json");
  const allPlats = existsSync(fp) ? (readJson(fp) as Array<{ k: string; r?: P2[][]; l?: P2[]; w?: number; sh?: 1 }>).filter((f) => f.k === "platform") : [];
  const plats = allPlats.filter((f) => f.sh);
  // nDOM reads shelters, lamps and signs on platforms as tree crowns: no crowns on platforms
  const onPlat = (p: P2) => allPlats.some((f) => f.r ? inside(p, f.r[0]) : f.l!.slice(1).some((b, i) => {
    const a = f.l![i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy) < f.w! / 2;
  }));
  const nt = trees.length;
  if (allPlats.length) for (let i = trees.length - 1; i >= 0; i--) if (onPlat([trees[i][0], trees[i][1]])) trees.splice(i, 1);
  if (allPlats.length) console.log(`  platforms: ${nt - trees.length} crown(s) on them dropped`);
  const TEAL = [0.2, 0.58, 0.58], GLASS_ROOF = [0.52, 0.64, 0.72];
  let units = 0, roofed = 0;
  // LoD2 already has the big station roofs and canopies: no shelter where a building covers the spot (50 m grid)
  const cover = new Map<string, P2[][]>();
  for (const b of meshes) {
    const xs = b.footprint.map((p) => p[0]), ys = b.footprint.map((p) => p[1]);
    for (let gx = Math.floor(Math.min(...xs) / 50); gx <= Math.floor(Math.max(...xs) / 50); gx++)
      for (let gy = Math.floor(Math.min(...ys) / 50); gy <= Math.floor(Math.max(...ys) / 50); gy++) {
        const k = `${gx}_${gy}`; if (!cover.has(k)) cover.set(k, []); cover.get(k)!.push(b.footprint);
      }
  }
  const covered = (p: P2) => (cover.get(`${Math.floor(p[0] / 50)}_${Math.floor(p[1] / 50)}`) ?? []).some((r) => inside(p, r));
  for (const f of plats) {
    // long axis: the ring's or line's principal direction; width across it
    const pts = f.r ? f.r[0] : f.l!, c = centre(pts);
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - c[0]) ** 2; syy += (y - c[1]) ** 2; sxy += (x - c[0]) * (y - c[1]); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th), nx = -uy, ny = ux;
    const along = pts.map(([x, y]) => (x - c[0]) * ux + (y - c[1]) * uy), across = pts.map(([x, y]) => (x - c[0]) * nx + (y - c[1]) * ny);
    const s0 = Math.min(...along), s1 = Math.max(...along), L = s1 - s0;
    const W = f.r ? Math.max(...across) - Math.min(...across) : f.w ?? 3, o = f.r ? (Math.max(...across) + Math.min(...across)) / 2 : 0;
    if (L < 12 || W < 2) continue;
    const n = Math.max(1, Math.min(4, Math.floor((L * 0.6) / 9))), len = 6.5, half = Math.min(W * 0.42, 1.7);
    for (let k = 0; k < n; k++) {
      const sm = s0 + L / 2 + (k - (n - 1) / 2) * 9;
      const at = (s: number, q: number): P2 => [c[0] + ux * s + nx * (o + q), c[1] + uy * s + ny * (o + q)];
      const m = at(sm, 0), base = groundAt(m[0], m[1]);
      if (covered(m)) { roofed++; continue; }
      const look = { roof: GLASS_ROOF, wall: GLASS_ROOF, style: 4, bare: 3 as const };
      const roof: Piece = { roof: [], wall: [], footprint: [at(sm - len / 2, -half), at(sm + len / 2, -half), at(sm + len / 2, half), at(sm - len / 2, half)], height: 3.6, base, look };
      const frame: Piece = { roof: [], wall: [], footprint: roof.footprint, height: 2.8, base, look: { roof: TEAL, wall: TEAL, style: 4, bare: 3 } };
      const E = 2.6, F = 2.95, R = 4.1; // eave band bottom/top, ridge
      const v = (p: P2, z: number, sAl = 0): number[] => [p[0], p[1], base + z, sAl, z];
      const eave = [at(sm - len / 2, -half), at(sm + len / 2, -half), at(sm + len / 2, half), at(sm - len / 2, half)];
      // teal eave band all round (counter-clockwise from above if (u, n) is right-handed: it is)
      for (let i = 0; i < 4; i++) { const A = eave[i], B = eave[(i + 1) % 4]; frame.wall.push(...v(A, E), ...v(B, E), ...v(B, F), ...v(A, E), ...v(B, F), ...v(A, F)); }
      // hip roof: ridge along the unit, glass slopes
      const r0 = at(sm - len / 2 + half, 0), r1 = at(sm + len / 2 - half, 0);
      const tri = (a: number[], b: number[], cc: number[]) => roof.wall.push(...a, ...b, ...cc);
      tri(v(eave[0], F), v(eave[1], F), v(r1, R)); tri(v(eave[0], F), v(r1, R), v(r0, R));   // side -n
      tri(v(eave[2], F), v(eave[3], F), v(r0, R)); tri(v(eave[2], F), v(r0, R), v(r1, R));   // side +n
      tri(v(eave[1], F), v(eave[2], F), v(r1, R)); tri(v(eave[3], F), v(eave[0], F), v(r0, R)); // hips
      // two posts on the centre line
      for (const ds of [-len / 4, len / 4]) {
        const pc = at(sm + ds, 0), r = 0.13;
        const sq = [[-r, -r], [r, -r], [r, r], [-r, r]].map(([a, b]) => [pc[0] + a, pc[1] + b] as P2);
        for (let i = 0; i < 4; i++) { const A = sq[i], B = sq[(i + 1) % 4]; frame.wall.push(...v(A, 0), ...v(B, 0), ...v(B, E), ...v(A, 0), ...v(B, E), ...v(A, E)); }
      }
      meshes.push(fromPiece(roof), fromPiece(frame));
      units++;
    }
  }
  if (plats.length) console.log(`  platform shelters: ${units} on ${plats.length} sheltered platform(s), ${roofed} under LoD2 roofs skipped`);
}

// styled look: tunnel portals where roads and tracks go underground (portals.ts)
if (STYLED) {
  const ways = ["roads.json", "rails.json", "ground.json"].filter((f) => existsSync(join(raw, f)))
    .flatMap((f) => readJson(join(raw, f)).elements.filter((e: any) => e.type === "way"));
  // bridge decks: floor of the tunnel portals they run into, and the deck of the named bridge models
  const ends = existsSync(join(DERIVED, name, "ground", "bridge-ends.json")) ? readJson(join(DERIVED, name, "ground", "bridge-ends.json")) : {};
  const bridgeWays: Array<{ l: P2[]; dh: ReturnType<typeof deckHeight> }> = [];
  for (const e of ways) {
    const t = e.tags ?? {};
    if (!isBridge(t) || !(t.highway || t.railway) || !(e.geometry?.length >= 2)) continue;
    const l = e.geometry.map((q: any) => { const p = toEnu(q.lon, q.lat); return [p[0], p[1]] as P2; });
    bridgeWays.push({ l, dh: deckHeight(l, groundAt, ends[e.id]) });
  }
  const deckAt = (p: P2, within = 12) => {
    let best = within, z: number | null = null;
    for (const { l, dh } of bridgeWays) for (let i = 1; i < l.length; i++) {
      const a = l[i - 1], b = l[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      const f = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)), dist = Math.hypot(p[0] - a[0] - f * dx, p[1] - a[1] - f * dy);
      if (dist < best) { best = dist; z = dh.at(dh.cum[i - 1] + f * Math.sqrt(L2), p[0], p[1]); }
    }
    return z;
  };
  // tunnel portals (portals.ts); a road coming in on a bridge has the deck as its floor
  const groups = groupEnds(tunnelEnds(ways, (lon, lat) => { const e = toEnu(lon, lat); return [e[0], e[1]]; }));
  for (const g of groups) meshes.push(...portal(g, groundAt, (x, y) => deckAt([x, y], 6) ?? groundAt(x, y)).map(fromPiece));
  console.log(`  tunnel portals: ${groups.length}`);
  // catenary masts (electrified=contact_line, open air, on the ground): every 50 m, 2.6 m beside the track on the
  // side without a neighbouring track, an arm over the wire; parallel tracks share them (none within 15 m)
  {
    const lines = ways.filter((e: any) => {
      const t = e.tags ?? {};
      return /^(rail|light_rail)$/.test(t.railway ?? "") && t.electrified === "contact_line" && !(t.tunnel && t.tunnel !== "no")
        && !isBridge(t) && !(Number(t.layer) > 0) && t.covered !== "yes" && e.geometry?.length >= 2;
    }).map((e: any) => e.geometry.map((q: any) => { const p = toEnu(q.lon, q.lat); return [p[0], p[1]] as P2; }) as P2[]);
    // all open-air track segments on a 20 m grid, to find neighbours
    const segs = new Map<string, Array<[P2, P2]>>();
    for (const e of ways) {
      const t = e.tags ?? {};
      if (!t.railway || /platform|abandoned|razed|construction|proposed/.test(t.railway) || (t.tunnel && t.tunnel !== "no") || !(e.geometry?.length >= 2)) continue;
      const l = e.geometry.map((q: any) => { const p = toEnu(q.lon, q.lat); return [p[0], p[1]] as P2; }) as P2[];
      for (let i = 1; i < l.length; i++) {
        const k = (x: number, y: number) => `${Math.floor(x / 20)}_${Math.floor(y / 20)}`, ks = new Set<string>();
        const n = Math.ceil(Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]) / 10);
        for (let j = 0; j <= n; j++) ks.add(k(l[i - 1][0] + ((l[i][0] - l[i - 1][0]) * j) / n, l[i - 1][1] + ((l[i][1] - l[i - 1][1]) * j) / n));
        for (const kk of ks) { if (!segs.has(kk)) segs.set(kk, []); segs.get(kk)!.push([l[i - 1], l[i]]); }
      }
    }
    const trackNear = (p: P2, r: number) => {
      for (let gx = Math.floor((p[0] - r) / 20); gx <= Math.floor((p[0] + r) / 20); gx++)
        for (let gy = Math.floor((p[1] - r) / 20); gy <= Math.floor((p[1] + r) / 20); gy++)
          for (const [a, b] of segs.get(`${gx}_${gy}`) ?? []) {
            const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
            const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
            if (Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy) < r) return true;
          }
      return false;
    };
    const roofs = meshes.filter((m) => m.footprint.length >= 3 && (m as any).id !== "landmark").map((m) => m.footprint);
    const underRoof = (p: P2) => roofs.some((r) => Math.abs(r[0][0] - p[0]) < 400 && Math.abs(r[0][1] - p[1]) < 400 && inside(p, r));
    const MAST = [0.62, 0.64, 0.67], masts: P2[] = [];
    for (const l of lines) {
      let next = 25;
      for (let i = 1, s = 0; i < l.length; i++) {
        const a = l[i - 1], b = l[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 1e-6) continue;
        const u: P2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], v: P2 = [-u[1], u[0]];
        for (; next <= s + L; next += 50) {
          const p: P2 = [a[0] + u[0] * (next - s), a[1] + u[1] * (next - s)];
          if (masts.some((m) => Math.hypot(m[0] - p[0], m[1] - p[1]) < 15) || underRoof(p)) continue;
          const side = [1, -1].find((sd) => !trackNear([p[0] + v[0] * 2.6 * sd, p[1] + v[1] * 2.6 * sd], 2.2));
          if (!side) continue;
          const m: P2 = [p[0] + v[0] * 2.6 * side, p[1] + v[1] * 2.6 * side];
          const { piece, block } = frame(p, u, groundAt(m[0], m[1]));
          const pc = piece(-0.3, 0.3, Math.min(0, 2.6 * side) - 0.6, Math.max(0, 2.6 * side) + 0.6, 7.2, MAST);
          block(pc, -0.17, 0.17, 2.6 * side - 0.17, 2.6 * side + 0.17, 0, 7.2);                       // mast
          block(pc, -0.07, 0.07, Math.min(2.6 * side, -0.5 * side), Math.max(2.6 * side, -0.5 * side), 6.2, 6.4); // arm
          block(pc, -0.05, 0.05, -0.05, 0.05, 5.6, 6.2);                                                 // dropper
          meshes.push(fromPiece(pc));
          masts.push(m);
        }
        s += L;
      }
    }
    console.log(`  catenary masts: ${masts.length} on ${lines.length} electrified way(s)`);
  }
  // named bridges (bridgemodels.ts) on their OSM outline
  for (const e of ways) {
    const model = BRIDGES[e.tags?.wikidata ?? ""];
    if (!model || e.tags.man_made !== "bridge" || !(e.geometry?.length >= 4)) continue;
    const ring = e.geometry.map((q: any) => { const p = toEnu(q.lon, q.lat); return [p[0], p[1]] as P2; });
    pushAll(meshes, model(ring, { ground: groundAt, deckAt }).map(fromPiece));
    console.log(`  bridge ${e.tags.name}: model`);
  }
}
// structures on their OSM outline and models at measured points (landmarks.ts); the surface model reads both
// as tree crowns, so crowns on them go
const dropCrowns = (hit: (p: P2) => boolean) => {
  for (let i = trees.length - 1; i >= 0; i--) if (hit([trees[i][0], trees[i][1]])) trees.splice(i, 1);
  for (let i = shrubs.length - 1; i >= 0; i--) if (hit([shrubs[i][0], shrubs[i][1]])) shrubs.splice(i, 1);
};
for (const { rings, structure, t } of structures) {
  pushAll(meshes, structure.model(rings, groundAt, t).map(fromPiece));
  dropCrowns((p) => rings.outer.some((r) => inside(p, r)));
  console.log(`  structure ${t.name ?? t.man_made}: model`);
}
/**
 * Cut the solid LoD2 block within r m of c (a headframe's stand-in) off the building at the height of the roofs
 * around it, and cap the stump level there: roof triangles wholly inside go, walls wholly inside are cut at that
 * height (keeping what is below). The roofs around: the inner corners of roof triangles that reach into the circle.
 */
function cutBlock(c: P2, r: number): { mesh: Mesh; cap: number } | null {
  const near = (b: number[], i: number) => Math.hypot(b[i] - c[0], b[i + 1] - c[1]) < r;
  let mesh: Mesh | null = null, top = -Infinity;
  for (const b of meshes as Mesh[]) for (let i = 0; i < b.roof.length; i += 9)
    if (near(b.roof, i) && near(b.roof, i + 3) && near(b.roof, i + 6)) {
      const z = Math.max(b.roof[i + 2], b.roof[i + 5], b.roof[i + 8]);
      if (z > top) { top = z; mesh = b; }
    }
  if (!mesh) return null;
  const b = mesh;
  let foot = -Infinity;
  for (let i = 0; i < b.roof.length; i += 9) {
    const ins = [0, 3, 6].filter((k) => near(b.roof, i + k));
    if (ins.length && ins.length < 3) for (const k of ins) foot = Math.max(foot, b.roof[i + k + 2]);
  }
  if (!Number.isFinite(foot)) { // a block standing on its own: its lowest wall
    foot = Infinity;
    for (let i = 0; i < b.wall.length; i += 5) if (near(b.wall, i)) foot = Math.min(foot, b.wall[i + 2]);
  }
  const cap = foot + 0.1, roof: number[] = [], wall: number[] = [], rim: P2[] = [];
  for (let i = 0; i < b.roof.length; i += 9) {
    const t = b.roof.slice(i, i + 9);
    if (!(near(t, 0) && near(t, 3) && near(t, 6)) || Math.min(t[2], t[5], t[8]) < cap) roof.push(...t);
  }
  for (let i = 0; i + 14 < b.wall.length; i += 15) {
    const tr = [0, 1, 2].map((k) => b.wall.slice(i + k * 5, i + k * 5 + 5));
    if (!tr.every((v) => Math.hypot(v[0] - c[0], v[1] - c[1]) < r)) { for (const v of tr) wall.push(...v); continue; }
    // the part below the cap (Sutherland–Hodgman on z), fan-triangulated
    const lo: number[][] = [];
    for (let k = 0; k < 3; k++) {
      const p = tr[k], q = tr[(k + 1) % 3], fp = p[2] - cap, fq = q[2] - cap;
      if (fp <= 0) lo.push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const f = fp / (fp - fq), x = p.map((v, j) => v + (q[j] - v) * f); lo.push(x); rim.push([x[0], x[1]]); }
      else if (fp === 0) rim.push([p[0], p[1]]);
    }
    for (let k = 1; k + 1 < lo.length; k++) for (const v of [lo[0], lo[k], lo[k + 1]]) wall.push(...v);
  }
  // the cap: the convex hull of where the walls were cut, level
  const hull = convexHull(rim);
  for (let k = 1; k + 1 < hull.length; k++) for (const q of [hull[0], hull[k], hull[k + 1]]) roof.push(q[0], q[1], cap);
  b.roof.splice(0, b.roof.length, ...roof);
  b.wall.splice(0, b.wall.length, ...wall);
  let h = 0;
  for (let i = 2; i < b.roof.length; i += 3) h = Math.max(h, b.roof[i] - b.base);
  b.height = h;
  return { mesh: b, cap };
}
/** Convex hull, counter-clockwise (monotone chain). */
function convexHull(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const turn = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [], upper: P2[] = [];
  for (const q of p) { while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
// football stadiums (landmarks.ts STADIUMS, by OSM name; LoD2 regions): the LoD2 stands between the pitch and the
// outline give way to open stands with seat rows and a canopy, and the crowns the surface model read on them go
if (LOD2 && STYLED) {
  const ground = readJson(join(raw, "ground.json")).elements as any[];
  for (const el of ground) {
    const look = STADIUMS[el.tags?.name as keyof typeof STADIUMS];
    if (!look || el.type === "node") continue;
    const rings = osmRings(el), outer = rings.outer[0];
    if (!outer) continue;
    // the pitch: the outline's inner ring, else the largest leisure=pitch inside it
    let pitch = rings.inner[0];
    if (!pitch) {
      const cands = ground.filter((g) => g.type === "way" && g.tags?.leisure === "pitch" && g.geometry?.length >= 4)
        .map((g) => ringFromLonLat(g.geometry.map((q: any) => [q.lon, q.lat]))).filter((r): r is P2[] => !!r && inside(centre(r), outer));
      pitch = cands.sort((a, b) => Math.abs(area2(b)) - Math.abs(area2(a)))[0];
    }
    if (!pitch) { console.warn(`  stadium ${el.tags.name}: no pitch inside its outline, skipped`); continue; }
    // the stands: LoD2 blocks inside the outline with a footprint corner within 50 m of the pitch (an outline that is
    // the whole sports ground, Wisła's, also holds training halls and offices); the stadium's own outline is their hull
    const near = (q: P2) => pitch.some((a, i) => {
      const b = pitch[(i + 1) % pitch.length], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      const u = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
      return Math.hypot(q[0] - a[0] - u * dx, q[1] - a[1] - u * dy) < 50;
    });
    const stands = meshes.filter((b) => inside(centre(b.footprint), outer) && !inside(centre(b.footprint), pitch) && b.footprint.some(near));
    if (!stands.length) continue; // not this area's (its buildings are another area's)
    const hull = convexHull([...stands.flatMap((b) => b.footprint), ...pitch]);
    const base = Math.min(...stands.map((b) => b.base));
    // canopy height: the stands' typical top (the tallest blocks are floodlight masts and stair towers)
    const hs = stands.map((b) => b.height).sort((a, b) => a - b), H = look.height ?? hs[Math.floor(hs.length * 0.6)];
    for (const b of stands) meshes.splice(meshes.indexOf(b), 1);
    pushAll(meshes, stadiumStands(hull, pitch, base, H, look).map(fromPiece));
    const n = trees.length;
    dropCrowns((p) => inside(p, hull)); // the pitch has no trees either: crowns there are the canopy's inner edge
    console.log(`  stadium ${el.tags.name}: ${stands.length} LoD2 stand(s) -> open stands ${H.toFixed(0)} m, ${n - trees.length} crown(s) on them dropped`);
  }
}
// GUGiK regions: crowns the surface model put inside stadium outlines (stands, canopies) are flagged; add the
// stadium to STADIUMS to rebuild it
if (region.sources === "gugik") for (const el of readJson(join(raw, "ground.json")).elements as any[]) {
  const t = el.tags ?? {};
  if (el.type === "node" || !(t.building === "stadium" || t.leisure === "stadium") || t.name in STADIUMS) continue;
  const rings = osmRings(el), outer = rings.outer[0];
  if (!outer) continue;
  // a closed arena named in LOOKS (Tauron Arena): a bare roof, even where osm.json predates the LOOKS entry
  if (t.building && t.name in LOOKS) for (const m of meshes as Mesh[]) if (inside(centre(m.footprint), outer)) m.look = { ...lookAt(centre(m.footprint)), bare: true };
  const roofed = meshes.filter((b) => inside(centre(b.footprint), outer));
  const n = trees.filter((tr) => { const p: P2 = [tr[0], tr[1]]; return inside(p, outer) && !rings.inner.some((r) => inside(p, r)) && roofed.some((b) => inside(p, b.footprint)); }).length;
  if (n) console.warn(`  check: ${n} crown(s) on the buildings of stadium ${t.name ?? el.id}: add it to landmarks STADIUMS`);
}
for (const pl of PLACED) {
  const [la, lo] = pl.at;
  if (la < bbox[0] - 0.002 || la > bbox[2] + 0.002 || lo < bbox[1] - 0.002 || lo > bbox[3] + 0.002) continue;
  const e = toEnu(lo, la), c: P2 = [e[0], e[1]];
  let base = groundAt(...c), ground = base, note = "model", under: Mesh | undefined;
  if (pl.cut) {
    const hit = cutBlock(c, pl.cut);
    if (!hit) { console.log(`  landmark ${pl.name}: no LoD2 block within ${pl.cut} m, skipped`); continue; }
    base = hit.cap; ground = hit.mesh.base; note = `LoD2 block cut at ${(hit.cap - ground).toFixed(1)} m -> model`;
    under = hit.mesh;
  } else if (pl.building) {
    under = (meshes as Mesh[]).find((m) => inside(c, m.footprint));
    if (under) ground = under.base;
  }
  if (under && pl.building) {
    const look = lookAt(centre(under.footprint));
    under.look = { ...look, wall: pl.building.wall ?? look.wall, roof: pl.building.roof ?? look.roof, style: pl.building.style ?? look.style };
  }
  pushAll(meshes, pl.model(c, base, ground).map(fromPiece));
  dropCrowns((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < pl.clear);
  console.log(`  landmark ${pl.name}: ${note}`);
}
// preset powerLines: pylons and conductors of the OSM high-voltage lines (power.ts); crowns at the pylons were
// the surface model reading their steel
if (STYLED && styleOf(region.style).powerLines && existsSync(join(raw, "osm-power.json"))) {
  const cs = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]].map(([la, lo]) => toEnu(lo, la));
  const ex = [Math.min(...cs.map((c) => c[0])) - 100, Math.min(...cs.map((c) => c[1])) - 100, Math.max(...cs.map((c) => c[0])) + 100, Math.max(...cs.map((c) => c[1])) + 100];
  const { pieces, towers } = powerLines(readJson(join(raw, "osm-power.json")), (lon, lat) => { const e = toEnu(lon, lat); return [e[0], e[1]]; }, groundAt,
    (p) => p[0] >= ex[0] && p[0] <= ex[2] && p[1] >= ex[1] && p[1] <= ex[3]);
  pushAll(meshes, pieces.map(fromPiece));
  dropCrowns((p) => towers.some((t) => Math.hypot(p[0] - t[0], p[1] - t[1]) < 4));
  console.log(`  power lines: ${towers.length} pylons, ${pieces.length - 2 * towers.length} spans`);
}
// preset playgrounds: the equipment (playgrounds.ts; its pads and sandpits are on the ground, ground.ts)
if (STYLED && styleOf(region.style).playgrounds && existsSync(join(raw, "osm-play.json"))) {
  const layout = playLayout(readJson(join(raw, "osm-play.json")), (lon, lat) => { const e = toEnu(lon, lat); return [e[0], e[1]]; });
  const pieces = playPieces(layout, groundAt);
  pushAll(meshes, pieces.map(fromPiece));
  console.log(`  playgrounds: ${layout.items.length} pieces of equipment`);
}
// presets streetLamps, roofsOnPosts (props.ts, osm-furniture.json)
const STYLE_PRESET = styleOf(region.style);
if (STYLED && (STYLE_PRESET.streetLamps || STYLE_PRESET.roofsOnPosts || STYLE_PRESET.streetFurniture) && existsSync(join(raw, "osm-furniture.json"))) {
  const furniture = readJson(join(raw, "osm-furniture.json")), en = (lon: number, lat: number): P2 => { const e = toEnu(lon, lat); return [e[0], e[1]]; };
  const cs = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]].map(([la, lo]) => toEnu(lo, la));
  const ex = [Math.min(...cs.map((c) => c[0])) - 50, Math.min(...cs.map((c) => c[1])) - 50, Math.max(...cs.map((c) => c[0])) + 50, Math.max(...cs.map((c) => c[1])) + 50];
  const inBox = (p: P2) => p[0] >= ex[0] && p[0] <= ex[2] && p[1] >= ex[1] && p[1] <= ex[3];
  // the nearest drivable road (roads.json) within `max` m: the point on it, its direction and width (30 m grid)
  const segs = new Map<string, Array<[P2, P2, number]>>();
  for (const w of readJson(join(raw, "roads.json")).elements) {
    const g: P2[] = (w.geometry ?? []).map((q: any) => en(q.lon, q.lat)), width = roadWidth(w.tags ?? {}) || 6;
    for (let i = 1; i < g.length; i++) {
      const [a, b] = [g[i - 1], g[i]];
      for (let cx = Math.floor(Math.min(a[0], b[0]) / 30); cx <= Math.floor(Math.max(a[0], b[0]) / 30); cx++)
        for (let cy = Math.floor(Math.min(a[1], b[1]) / 30); cy <= Math.floor(Math.max(a[1], b[1]) / 30); cy++)
          (segs.get(`${cx}_${cy}`) ?? segs.set(`${cx}_${cy}`, []).get(`${cx}_${cy}`)!).push([a, b, width]);
    }
  }
  const road = (p: P2, max: number): Road => {
    let best = max, out: Road = null;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [a, b, w] of segs.get(`${Math.floor(p[0] / 30) + i}_${Math.floor(p[1] / 30) + j}`) ?? []) {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (L * L)));
      const q: P2 = [a[0] + dx * t, a[1] + dy * t], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best) { best = d; out = { q, dir: [dx / L, dy / L], w }; }
    }
    return out;
  };
  if (STYLE_PRESET.streetFurniture) {
    const f = streetFurniture(furniture, en, groundAt, inBox, road);
    pushAll(meshes, f.pieces.map(fromPiece));
    console.log(`  street furniture: ${Object.entries(f.counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  }
  if (STYLE_PRESET.streetLamps) {
    const lamps = streetLamps(furniture, en, groundAt, inBox, (p) => road(p, 15)?.q ?? null);
    pushAll(meshes, lamps.pieces.map(fromPiece));
    console.log(`  street lamps: ${lamps.count}`);
  }
  if (STYLE_PRESET.roofsOnPosts) {
    // a building already there (its footprint holds the outline's centre); the surface model's height inside
    const fps = new Map<string, P2[][]>();
    for (const m of meshes as Mesh[]) { // buildings only: hand-built props (bare 3) carry a bounding box or a 100 m cell
      const f = m.footprint;
      if (!f?.length || (m as { look?: { bare?: number } }).look?.bare === 3) continue;
      const k = `${Math.floor(f[0][0] / 50)}_${Math.floor(f[0][1] / 50)}`; (fps.get(k) ?? fps.set(k, []).get(k)!).push(f);
    }
    const covered = (ring: P2[]) => {
      const c: P2 = [ring.reduce((a, q) => a + q[0], 0) / ring.length, ring.reduce((a, q) => a + q[1], 0) / ring.length];
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const f of fps.get(`${Math.floor(c[0] / 50) + i}_${Math.floor(c[1] / 50) + j}`) ?? []) if (inside(c, f)) return true;
      return false;
    };
    const nd = region.sources === "gugik" ? gugikNdom(bbox) : null;
    const seen = (ring: P2[]) => {
      if (!nd) return NaN;
      const xs = ring.map((q) => q[0]), ys = ring.map((q) => q[1]), v: number[] = [];
      for (let x = Math.min(...xs) + 0.5; x < Math.max(...xs); x += 1) for (let y = Math.min(...ys) + 0.5; y < Math.max(...ys); y += 1) {
        if (!inside([x, y], ring)) continue;
        const [la, lo] = enuToLlh([x, y, 0]), [px, py] = toPuwg(la, lo), h = nd(px, py);
        if (Number.isFinite(h)) v.push(h);
      }
      v.sort((a, b) => a - b);
      return v.length >= 4 ? v[v.length >> 1] : NaN;
    };
    const roofs = roofsOnPosts(furniture, en, groundAt, inBox, covered, seen);
    pushAll(meshes, roofs.map(fromPiece));
    console.log(`  roofs on posts: ${roofs.length / 2}`);
  }
}
// preset barriers: fences, walls, rails (pieces) and hedges (rows of bushes where the surface model found none)
if (STYLED && styleOf(region.style).barriers && existsSync(join(raw, "osm-barriers.json"))) {
  const cs = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]].map(([la, lo]) => toEnu(lo, la));
  const ex = [Math.min(...cs.map((c) => c[0])) - 50, Math.min(...cs.map((c) => c[1])) - 50, Math.max(...cs.map((c) => c[0])) + 50, Math.max(...cs.map((c) => c[1])) + 50];
  const near = new Map<string, P2[]>();
  for (const s of shrubs) { const k = `${Math.floor(s[0] / 2)}_${Math.floor(s[1] / 2)}`; (near.get(k) ?? near.set(k, []).get(k)!).push([s[0], s[1]]); }
  const nearBush = (x: number, y: number) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const q of near.get(`${Math.floor(x / 2) + i}_${Math.floor(y / 2) + j}`) ?? []) if (Math.hypot(q[0] - x, q[1] - y) < 1) return true;
    return false;
  };
  const b = barriers(readJson(join(raw, "osm-barriers.json")), (lon, lat) => { const e = toEnu(lon, lat); return [e[0], e[1]]; }, groundAt,
    (p) => p[0] >= ex[0] && p[0] <= ex[2] && p[1] >= ex[1] && p[1] <= ex[3], nearBush);
  pushAll(meshes, b.pieces.map(fromPiece));
  pushAll(shrubs, b.hedges);
  console.log(`  barriers: ${b.pieces.length} fences, walls and rails, ${b.hedges.length} hedge bushes, ${b.km.toFixed(0)} km`);
}
// preset parkedCars: cars on the parking lots and bays (parking.ts; the stall lines are on the ground, ground.ts)
if (STYLED && styleOf(region.style).parkedCars && existsSync(join(raw, "osm-parking.json"))) {
  const layout = parkLayout(readJson(join(raw, "osm-parking.json")), (lon, lat) => { const e = toEnu(lon, lat); return [e[0], e[1]]; });
  pushAll(meshes, parkPieces(layout, groundAt).map(fromPiece));
  console.log(`  parked cars: ${layout.cars.length}`);
}
// market umbrellas on named squares (Dolac)
if (region.sources === "zg3d") for (const el of readJson(join(raw, "ground.json")).elements) {
  const u = UMBRELLAS[el.tags?.name ?? ""];
  if (!u || !(el.tags.place === "square" || el.tags.highway === "pedestrian")) continue;
  const g = el.type === "way" ? el.geometry : el.members?.find((m: any) => m.role === "outer" && m.geometry)?.geometry;
  const ring = g && g.length >= 4 ? ringFromLonLat(g.map((q: any) => [q.lon, q.lat])) : null;
  if (!ring) continue;
  const ps = umbrellas(ring, groundAt, u, inside);
  pushAll(meshes, ps.map(fromPiece));
  console.log(`  umbrellas on ${el.tags.name}: ${ps.length ? "placed" : "none fit"}`);
}
for (const b of meshes as Mesh[]) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const see = (x: number, y: number, z: number) => {
    const [px, py] = enuToPixel([x, y, z]);
    minx = Math.min(minx, px); maxx = Math.max(maxx, px); miny = Math.min(miny, py); maxy = Math.max(maxy, py);
  };
  for (let i = 0; i < b.roof.length; i += 3) see(b.roof[i], b.roof[i + 1], b.roof[i + 2]);
  for (let i = 0; i < b.wall.length; i += 5) see(b.wall[i], b.wall[i + 1], b.wall[i + 2] - 1);
  let [s, roofKind] = lod2Style(b);
  const fc: P2 = [b.footprint.reduce((a, p) => a + p[0], 0) / b.footprint.length, b.footprint.reduce((a, p) => a + p[1], 0) / b.footprint.length];
  const look = b.look ?? lookAt(fc), roof = look.roof ?? b.roofRgb ?? null; // OSM roof:colour, else the source's measured one
  // Zagreb high-rises: offices glass or ribbon windows, flats prefab concrete, by their OSM building use
  const use = "use" in look ? (look.use as string | undefined) : undefined;
  if (b.fn === "zg3d" && use && (OFFICE.test(use) || FLATS.test(use)) && [3, 5, 6].includes(s) && standing(b) > 19) s = OFFICE.test(use) ? (standing(b) >= 45 ? 3 : 5) : 6;
  if (b.fn === "zg3d" && use && b.roofType === "1000") {
    const hs = standing(b);
    if (s === 4 && FLATS.test(use) && hs >= 6) s = hs > 19 ? 6 : 1;                                       // housing, not a hall
    else if (HALL.test(use) && !OFFICE.test(use) && hs < 14 && Math.abs(area2(b.footprint)) > 800) s = 4; // industry, depots, sports halls
  }
  if (s === 6 && b.fn === "zg3d" && region.sources !== "zg3d") s = 1; // OSM-built flats: prefab panels are Zagreb's (renderer.ts #ifdef ZG), post-war blocks elsewhere
  let facade = s === 12 ? s : look.style ?? s;
  // preset historicFacades: no glass tower or office façade on historic and religious buildings
  if (HISTORIC_FACADES && (facade === 3 || facade === 5)) {
    // its centre or any footprint corner in a historic outline (a castle tower standing half outside the castle's)
    const h = Math.max(b.kind === "church" ? 2 : 0, "historic" in look ? (look.historic as number) ?? 0 : 0,
      ...b.footprint.filter((_, i) => i % Math.max(1, Math.floor(b.footprint.length / 12)) === 0).map((p) => lookAt(p).historic ?? 0));
    if (h) facade = h === 2 ? 2 : 0;
  }
  const entry: unknown[] = [facade, roofKind, b.roof.map(c2), b.wall.map(c2), b.footprint.map(([x, y]) => [c2(x), c2(y)]), Math.round(b.height * 10) / 10, Math.floor(hash(b.base * 1000 + b.roof.length) * 1000)];
  const bare = ("bare" in look && look.bare) || null, flags = facadeFlags(b);
  if (roof || look.wall || bare || b.storeys || flags) entry.push(roof, look.wall);
  if (bare || b.storeys || flags) entry.push(bare);
  if (b.storeys || flags) entry.push(b.storeys ?? 0, flags); // the façade's window rows and features (renderer.ts)
  add(minx, miny, maxx, maxy, (bin) => bin.m.push(entry));
}
for (const t of trees) {
  const g = groundAt(t[0], t[1]);
  const a = enuToPixel([t[0], t[1], g - 3]), c = enuToPixel([t[0], t[1], g + 3 + t[3] + t[2]]);
  const r = t[2] / CAMERA.mpp;
  add(Math.min(a[0], c[0]) - r, Math.min(a[1], c[1]) - r, Math.max(a[0], c[0]) + r, Math.max(a[1], c[1]) + r,
    (bin) => bin.t.push(t.map((v) => Math.round(v! * 10) / 10) as (typeof trees)[number]));
}
for (const s of shrubs) {
  const g = groundAt(s[0], s[1]), r = s[2] / CAMERA.mpp;
  const a = enuToPixel([s[0], s[1], g - 3]), c = enuToPixel([s[0], s[1], g + 3 + s[3]]);
  add(Math.min(a[0], c[0]) - r, Math.min(a[1], c[1]) - r, Math.max(a[0], c[0]) + r, Math.max(a[1], c[1]) + r,
    (bin) => (bin.s ??= []).push(s.map((v) => Math.round(v * 10) / 10) as [number, number, number, number]));
}
for (const [k, v] of bins) writeFileSync(join(out, `${k}.json`), JSON.stringify(v.m.length ? v : { b: v.b, t: v.t, ...(v.s ? { s: v.s } : {}) }));
console.log(`  ${bins.size} tile bins -> ${out}`);
if (region.sources === "tlv") writeFileSync(join(DERIVED, name, "osm-parts.json"), JSON.stringify(swapped, null, 1));
if (!existsSync(join(DERIVED, name))) mkdirSync(join(DERIVED, name), { recursive: true });
