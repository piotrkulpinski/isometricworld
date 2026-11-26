/**
 * Build the ground an area stands on, from open data only:
 *   terrain  Copernicus GLO-30 (a surface model: buildings are removed with a morphological
 *            opening + blur, which is plenty for flat Gush Dan), sea/lakes flattened from OSM;
 *            regions with sources "lgl": LGL DGM1 (1 m bare earth, sampled on a 3 m grid, no
 *            filtering; Copernicus only where DGM1 has no data), rivers left at their surveyed level;
 *            regions with sources "zg3d": Copernicus fitted to the surveyed base of every ZG3D building
 *            sources "gugik": GUGiK NMT the same way, but still water gets one level and river areas a smoothed
 *            surface (NMT is interpolated across water, wavy enough for the hillshade to draw a "bottom")
 *   surface  OSM roads at real widths, pavements, landuse, parks, beach, water, rail; regions with
 *            look "styled" keep meadows, vineyards, allotments and orchards as their own kinds
 *
 *   npm -w pipeline run ground -- tlv-core
 *
 * Output: data/derived/<area>/ground/meta.json     grid origin/step/size (ENU meters)
 *         data/derived/<area>/ground/height.bin    Float32 ENU "up" of the ground per grid node
 *         data/derived/<area>/ground/features.json drawable features in ENU (see Feature)
 */
import { bridgeEnds, carried, isBridge, type GraphWay } from "./bridges.ts";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { openArea } from "./areas.ts";
import { ecefToEnu, enuToLlh, llhToEcef } from "./camera.ts";
import { fromPuwg, gugikTerrain, orthoChunks, toPuwg } from "./gugik.ts";
import { lawns } from "./lawns.ts";
import { playLayout } from "./playgrounds.ts";
import { parkLayout } from "./parking.ts";
import { rasterSampler, toUtm } from "./lgl.ts";
import { DERIVED, RAW, readJson } from "./paths.ts";
import { REGIONS } from "./places.ts";
import { ROAD, isOneway, isPedestrianised, roadWidth } from "./roadspec.ts";
import { styleOf } from "./styles.ts";
import { zg3dBases } from "./zg3d.ts";

type P2 = [number, number];
const MARGIN = 0.02;
const R_EARTH = 6371000;

/**
 * k: kind (drawn by page/renderer.ts), r: polygon rings (even-odd) or l: polyline,
 * w: line width (m), o: one-way, n: lanes, y: layer (bridges above)
 */
/** p: the street's pavements (bit 1 left, 2 right of its direction; unset both), u: the surface (surfaceOf), both
 *  only with the preset's `streetDetail`; s: a track line's surface kind (trackKind); ref: a runway's designators;
 *  sh: a sheltered platform */
export interface Feature { k: string; r?: P2[][]; l?: P2[]; w?: number; o?: 1; n?: number; y?: number; j?: number[][]; v?: number; b?: 1; e?: number[]; s?: string; p?: number; u?: string; ref?: string; sh?: 1 }

const name = process.argv[2] ?? "tlv-core";
const area = openArea(name);
const region = REGIONS[area.region];
/** 1 m bare-earth terrain (LGL DGM1, GUGiK NMT): a finer grid, no filtering, rivers at their surveyed level. */
const DGM = region.sources === "lgl" || region.sources === "gugik";
/** Styled look (places.ts `look`): meadows, vineyards, allotments and orchards drawn as their own kinds. */
const STYLED = region.look === "styled";
/** Preset `streetDetail`: pavements where OSM maps them, separately mapped ones drawn as such, OSM surfaces. */
const DETAIL = STYLED && styleOf(region.style).streetDetail;
/** Preset `lawns`: lawns where the orthophoto is green (lawns.ts; GUGiK's orthophoto). */
const LAWNS = STYLED && styleOf(region.style).lawns && region.sources === "gugik";
/** Preset `waterDetail`: watercourses as lines, treatment basins murky, dry (intermittent) reservoirs a grassy
 *  basin (page/ground.ts draws the water's depth). */
const WATER_DETAIL = STYLED && styleOf(region.style).waterDetail;
/** Preset `closedLines`: closed roads and paths (one-way roundabouts, loops) simplified as rings, not collapsed. */
const CLOSED_LINES = STYLED && styleOf(region.style).closedLines;
/** preset repaint: rail yards and platforms beside open-air track (page/ground.ts draws them) */
const REPAINT = STYLED && styleOf(region.style).repaint;
/** Preset `parkedCars`: the stall lines of the parking lots (parking.ts; the cars: scene.ts). */
const PARKED = STYLED && styleOf(region.style).parkedCars;
/** Preset `playgrounds`: rubber safety pads and sandpits of the playgrounds (playgrounds.ts). */
const PLAYGROUNDS = STYLED && styleOf(region.style).playgrounds;
/** Preset `bridgeDetail`: bridge decks carried on to their abutments (below). */
const BRIDGE_DETAIL = STYLED && styleOf(region.style).bridgeDetail;
/** Preset `carFreePaving`: streets closed to ordinary traffic are drawn as pedestrian paving (roadspec isPedestrianised). */
const CAR_FREE_PAVING = STYLED && styleOf(region.style).carFreePaving;
/** Geoid undulation: orthometric (MSL) + this = ellipsoid height (= sea level). */
const GEOID = region.geoidM;
/** Terrain grid posting (m) and how far past the area it reaches (deg; the render footprint of an edge tile). */
const STEP = DGM ? 3 : 10, TMARGIN = DGM ? 0.008 : MARGIN;
const [S, W, N, E] = area.bbox;
const bb = [S - MARGIN, W - MARGIN, N + MARGIN, E + MARGIN];
const out = join(DERIVED, name, "ground");
mkdirSync(out, { recursive: true });

const toEnu = (lon: number, lat: number): P2 => { const p = ecefToEnu(llhToEcef(lat, lon, 0)); return [p[0], p[1]]; };
const r1 = (v: number) => Math.round(v * 10) / 10;

// ---- geometry helpers --------------------------------------------------------------------------
function simplifyLine(r: P2[], tol: number): P2[] {
  if (r.length <= 2) return r;
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
  return r.filter((_, i) => keep[i]).map(([x, y]) => [r1(x), r1(y)]);
}

/** Douglas-Peucker on a closed ring: split at the vertex farthest from the start (a zero chord keeps nothing). */
function simplifyRing(r: P2[], tol: number): P2[] {
  let far = 0;
  r.forEach((p, i) => { if (Math.hypot(p[0] - r[0][0], p[1] - r[0][1]) > Math.hypot(r[far][0] - r[0][0], r[far][1] - r[0][1])) far = i; });
  if (far === 0) return [];
  return [...simplifyLine(r.slice(0, far + 1), tol).slice(0, -1), ...simplifyLine([...r.slice(far), r[0]], tol)];
}

/** Join way pieces sharing endpoints into chains (closed rings where they close). */
function joinWays(pieces: P2[][]): P2[][] {
  const key = (p: P2) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const left = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const out: P2[][] = [];
  while (left.length) {
    let chain = left.pop()!;
    for (let grown = true; grown && key(chain[0]) !== key(chain.at(-1)!);) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i], a = key(p[0]), b = key(p.at(-1)!);
        if (a === key(chain.at(-1)!)) chain = [...chain, ...p.slice(1)];
        else if (b === key(chain.at(-1)!)) chain = [...chain, ...p.slice(0, -1).reverse()];
        else if (b === key(chain[0])) chain = [...p, ...chain.slice(1)];
        else if (a === key(chain[0])) chain = [...p.slice(1).reverse(), ...chain];
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    out.push(chain);
  }
  return out;
}
const closed = (c: P2[]) => c.length > 3 && c[0][0] === c.at(-1)![0] && c[0][1] === c.at(-1)![1];

/** Scanline fill of even-odd polygon rings over the grid: cb(ix, iy) for nodes inside. */
function fillGrid(rings: P2[][], g: Grid, cb: (i: number) => void) {
  let y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const iy0 = Math.max(0, Math.ceil((y0 - g.y0) / STEP)), iy1 = Math.min(g.ny - 1, Math.floor((y1 - g.y0) / STEP));
  for (let iy = iy0; iy <= iy1; iy++) {
    const y = g.y0 + iy * STEP, xs: number[] = [];
    for (const r of rings)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil((xs[k] - g.x0) / STEP)), b = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.x0) / STEP));
      for (let ix = a; ix <= b; ix++) cb(iy * g.nx + ix);
    }
  }
}

// ---- OSM features --------------------------------------------------------------------------
const PATH: Record<string, number> = { pedestrian: 5, footway: 2.2, path: 1.6, cycleway: 2, steps: 2.5, bridleway: 2, corridor: 2 };

const GRASS = /^(grass|dirt|ground|earth|unpaved)$/;

/** A street's pavements from OSM `sidewalk*` tags: bit 1 left, 2 right of its direction ("separate": drawn as its
 *  own way, "no": none); undefined where OSM says nothing (then both). */
function sidewalkSides(t: Record<string, string>): number | undefined {
  const side = (v?: string) => (v === undefined ? undefined : v === "yes");
  let left = side(t["sidewalk:left"] ?? t["sidewalk:both"]), right = side(t["sidewalk:right"] ?? t["sidewalk:both"]);
  const s = t.sidewalk;
  if (s === "both" || s === "yes") { left ??= true; right ??= true; }
  else if (s === "left") { left ??= true; right ??= false; }
  else if (s === "right") { left ??= false; right ??= true; }
  else if (s) { left ??= false; right ??= false; } // no, none, separate
  if (left === undefined && right === undefined) return undefined;
  return ((left ?? true) ? 1 : 0) | ((right ?? true) ? 2 : 0);
}

/** An OSM surface as drawn (asphalt and unknown: undefined, the default). */
function surfaceOf(s?: string): string | undefined {
  if (!s) return undefined;
  if (/^(paving_stones|paving_stones:.*|bricks|interlock|concrete:plates|concrete_slabs)$/.test(s)) return "paving";
  if (/^(sett|cobblestone|unhewn_cobblestone)$/.test(s)) return "sett";
  if (/^(gravel|fine_gravel|compacted|pebblestone)$/.test(s)) return "gravel";
  if (/^(ground|dirt|earth|mud|sand|unpaved)$/.test(s)) return "dirt";
  if (/^(grass|grass_paver)$/.test(s)) return "grass";
  if (/^(concrete|concrete:lanes)$/.test(s)) return "concrete";
  return undefined;
}
/**
 * A track's ground by its surface: only running tracks are red tartan. Racecourses and riding tracks are sand,
 * gravel or grass (the Zagreb Hipodrom: a grass gallop track, a gravel trotting track, a sand training track).
 */
function trackKind(t: Record<string, string>): string {
  const s = t.surface ?? "";
  if (/^(sand|dirt|earth|ground|unpaved|compacted|clay)$/.test(s)) return "sand";
  if (/^(gravel|fine_gravel|pebblestone)$/.test(s)) return "gravel";
  if (/^(grass|grass_paver)$/.test(s)) return "park";
  if (/^(asphalt|concrete|paved)$/.test(s)) return "tarmac";
  return /horse_racing|equestrian/.test(t.sport ?? "") ? "sand" : "track";
}
/**
 * Fields are not all one colour: a shade per field, from its crop where mapped (index into the ground page's
 * FIELD palette: 0 wheat/cereal, 1 maize, 2 grass/hay, 3 vegetables, 4 rapeseed), else from the OSM id (5+).
 */
function fieldShade(t: Record<string, string>, id: number): number {
  const c = t.crop ?? "";
  if (/wheat|barley|cereal|rye|oat|spelt|triticale/.test(c)) return 0;
  if (/corn|maize/.test(c)) return 1;
  if (/grass|hay|forage|clover/.test(c)) return 2;
  if (/vegetable|strawberr|potato|beet|cabbage/.test(c)) return 3;
  if (/rape/.test(c)) return 4;
  return 5 + ((Math.imul(id, 2654435761) >>> 0) % 7);
}

function areaKind(t: Record<string, string>): string | null {
  const lu = t.landuse, le = t.leisure, na = t.natural, am = t.amenity;
  if (WATER_DETAIL && t.water === "wastewater") return "wastewater";
  const wet = na === "water" || t.water || t.waterway === "riverbank" || lu === "basin" || lu === "reservoir";
  // dry detention and retention reservoirs (intermittent=yes): a grassy basin the stream runs through, full only in a flood
  if (WATER_DETAIL && wet && (t.intermittent === "yes" || (t.seasonal !== undefined && t.seasonal !== "no"))) return "drybasin";
  if (wet) return "water";
  if (le === "swimming_pool") return "pool";
  // golf courses: bunkers, greens and tees, fairways (over the course's lawn)
  if (t.golf === "bunker") return "bunker";
  if (t.golf === "green" || t.golf === "tee") return "green";
  if (t.golf === "fairway" || t.golf === "driving_range") return "fairway";
  if (t.golf === "rough") return "park";
  // airfields: runways, taxiways, aprons drawn as areas by surface (EDTQ: asphalt and grass side by side)
  if (/^(runway|taxiway|apron|helipad)$/.test(t.aeroway ?? "")) return GRASS.test(t.surface ?? "") ? "airgrass" : "tarmac";
  if (na === "beach" || na === "sand") return "sand";
  if (le === "pitch" && /equestrian|horse_racing/.test(t.sport ?? "")) return "sand"; // riding arenas
  if (le === "pitch" || le === "stadium") return "pitch";
  if (le === "track") return trackKind(t);
  if (le === "playground") return "playground";
  if (na === "wood" || lu === "forest") return "wood";
  if (["scrub", "grassland", "heath", "wetland", "bare_rock"].includes(na)) return "scrub";
  if (lu === "cemetery" || am === "grave_yard") return "cemetery";
  if (STYLED && lu === "meadow") return "meadow";
  if (lu === "flowerbed") return "flowerbed";
  if (["park", "garden", "dog_park", "golf_course", "recreation_ground", "nature_reserve"].includes(le)
    || ["grass", "meadow", "village_green", "recreation_ground"].includes(lu)) return "park";
  if (STYLED && ["vineyard", "allotments", "orchard"].includes(lu)) return lu; // the Kessel's slopes: own colours and rows
  if (["farmland", "orchard", "allotments", "plant_nursery", "greenhouse_horticulture", "vineyard"].includes(lu)) return "farm";
  if (["construction", "brownfield", "greenfield", "landfill"].includes(lu)) return "dirt";
  if (am === "parking") return "parking";
  if (t["area:highway"] || t.place === "square" || (t.highway === "pedestrian" && t.area === "yes")
    || ["pier", "breakwater", "groyne"].includes(t.man_made))
    return /^(fine_gravel|gravel|compacted|pebblestone)$/.test(t.surface ?? "") ? "gravel" : "paving";
  if (["school", "university", "college", "hospital"].includes(am)) return "campus";
  if (t.aeroway === "aerodrome") return "park"; // a small airfield's grass (EDTQ Pattonville is also tagged landuse=military)
  if (REPAINT && lu === "railway") return "railyard"; // preset repaint: light gravel under the darker track beds
  if (["industrial", "port", "military", "depot", "garages"].includes(lu)) return "industrial";
  if (["commercial", "retail"].includes(lu)) return "commercial";
  if (lu === "residential") return "residential";
  return null;
}

const osm = readJson(join(RAW, name, "ground.json"));
// funicular tracks (Zagreb's Uspinjača) are only in rails.json (fetched since funiculars were added there): drawn as rail
if (existsSync(join(RAW, name, "rails.json")))
  osm.elements.push(...readJson(join(RAW, name, "rails.json")).elements.filter((e: any) => e.type === "way" && e.tags?.railway === "funicular"));
const features: Feature[] = [];
/** lakes, ponds, basins and river areas (river: flowing water, its surface falls along it) */
const water: Array<{ r: P2[][]; river: boolean }> = [];
const coast: P2[][] = [];
/** road node id -> how many road ways use it (2+ = junction), widest road there */
const nodeUse = new Map<number, { n: number; w: number; foot: boolean; y: number; k: string; p?: boolean }>();
const footNodes = new Set<number>();
const nodePos = new Map<number, [P2, P2, number]>(); // position, a neighbour along the road, road width
const geom = (g: Array<{ lat: number; lon: number }>) => g.map((q) => toEnu(q.lon, q.lat));
/** highways and railways as a node graph, for bridge joints (bridges.ts bridgeEnds); bridge features by OSM id */
const graph: GraphWay[] = [];
const deckFeatures = new Map<number, Feature>();

/** railway=platform ways, kept below only where an open-air track runs beside them (underground stations share the tag) */
const platforms: Array<{ g: P2[]; w: number; sh: boolean }> = [];
for (const el of osm.elements) {
  const t: Record<string, string> = el.tags ?? {};
  if (t.natural === "coastline" && el.geometry) { coast.push(geom(el.geometry)); continue; }
  if (t.railway === "platform") {
    if (el.type === "way" && el.geometry && t.tunnel !== "yes" && t.location !== "underground" && t.indoor !== "yes")
      platforms.push({ g: geom(el.geometry), w: Number(String(t.width).replace(",", ".")) || 3, sh: t.shelter === "yes" || t.covered === "yes" });
    continue;
  }
  let rings: P2[][] | null = null;
  if (el.type === "way" && el.geometry) {
    const g = geom(el.geometry);
    // a track way with a width is the track itself, closed or not (OSM: a closed leisure=track is a line unless area=yes)
    const trackLine = t.leisure === "track" && t.area !== "yes" && Number(String(t.width).replace(",", ".")) > 0;
    if (closed(g) && !(t.highway && t.area !== "yes") && !t.railway && !trackLine) rings = [g];
    else if (trackLine || t.highway || t.railway || ["breakwater", "groyne", "pier"].includes(t.man_made) || /^(runway|taxiway)$/.test(t.aeroway ?? "")) {
      // a closed way as a ring, overlapping its first segment so the loop has no butt-end notch where it closes
      const ring = CLOSED_LINES && closed(g) ? simplifyRing(g.slice(0, -1), 0.3) : [];
      const l = ring.length > 2 ? [...ring, ring[1]] : simplifyLine(g, 0.3);
      if (trackLine) { features.push({ k: "trackline", l, w: r1(Number(String(t.width).replace(",", "."))), s: trackKind(t) }); continue; }
      if (t.aeroway) { // runway / taxiway centre lines at their width (OSM width, else 30 m / 10 m)
        const w = Number(String(t.width).replace(",", ".")) || (t.aeroway === "runway" ? 30 : 10);
        features.push({ k: GRASS.test(t.surface ?? "") ? "grassway" : t.aeroway, l, w: r1(w), ...(t.ref ? { ref: t.ref } : {}) });
        continue;
      }
      const layer = Number(t.layer) || (t.bridge && t.bridge !== "no" ? 1 : 0);
      const deck = isBridge(t) ? { b: 1 as const } : {}; // own deck in the render (bridges.ts)
      if (el.nodes?.length === g.length) graph.push({ id: el.id, nodes: el.nodes, l: g, kind: t.railway ? "rail" : ROAD[t.highway] ? "road" : "path", bridge: isBridge(t) });
      if (t.railway) {
        const f: Feature = { k: "rail", l, ...(layer > 0 ? { y: layer } : {}), ...deck };
        features.push(f);
        if (deck.b) deckFeatures.set(el.id, f);
        continue;
      }
      if (t.man_made) { features.push({ k: "pier", l, w: Number(t.width) || 4 }); continue; }
      const paved = CAR_FREE_PAVING && ROAD[t.highway] && isPedestrianised(t); // drawn and treated as a pedestrian street
      const road = paved ? undefined : ROAD[t.highway], path = paved ? PATH.pedestrian : PATH[t.highway];
      if (!road && !path) continue;
      const oneway = isOneway(t);
      const lanes = Number(t.lanes) || 0;
      const w = road ? roadWidth(t) : Number(String(t.width).replace(",", ".")) || path;
      const kind = road ? (road[1] ? "street" : t.highway.startsWith("motorway") || t.highway.startsWith("trunk") ? "highway" : t.highway === "track" ? "dirtroad" : "lane") : t.highway === "cycleway" ? "cycle" : t.highway === "pedestrian" || paved ? "plaza"
        : DETAIL && t.footway === "sidewalk" ? "sidewalk" : "path";
      const sides = DETAIL && kind === "street" ? sidewalkSides(t) : undefined;
      if (road && el.nodes) for (const id of el.nodes) {
        const nd = nodeUse.get(id) ?? { n: 0, w: 0, foot: false, y: 0, k: kind };
        nd.n++; nd.y = Math.max(nd.y, layer);
        if (w > nd.w) { nd.w = w; nd.k = kind; }
        if (DETAIL && kind === "street" && sides !== 0) nd.p = true; // pavements round this corner
        nodeUse.set(id, nd);
      } else if (path && el.nodes && t.highway !== "steps") for (const id of el.nodes) footNodes.add(id);
      if (road && el.nodes) el.geometry.forEach((q: any, k: number) => nodePos.set(el.nodes[k], [toEnu(q.lon, q.lat), k > 0 ? toEnu(el.geometry[k - 1].lon, el.geometry[k - 1].lat) : toEnu(el.geometry[k + 1].lon, el.geometry[k + 1].lat), w]));
      const f: Feature = { k: kind, l, w: r1(w) };
      if (sides !== undefined) f.p = sides;
      const surface = DETAIL ? surfaceOf(t.surface) : undefined;
      if (surface) f.u = surface;
      if (oneway) f.o = 1;
      if (lanes) f.n = lanes;
      if (layer > 0) f.y = layer;
      Object.assign(f, deck);
      features.push(f);
      if (deck.b) deckFeatures.set(el.id, f);
      continue;
    }
  } else if (el.type === "relation" && el.members) {
    const outer = joinWays(el.members.filter((m: any) => m.type === "way" && m.geometry && m.role !== "inner").map((m: any) => geom(m.geometry)));
    const inner = joinWays(el.members.filter((m: any) => m.type === "way" && m.geometry && m.role === "inner").map((m: any) => geom(m.geometry)));
    rings = [...outer, ...inner].filter(closed);
    if (!rings.length) rings = null;
  }
  if (!rings) continue;
  const k = areaKind(t);
  if (!k) continue;
  const r = rings.map((q) => simplifyRing(q, 0.3)).filter((q) => q.length >= 4);
  if (!r.length) continue;
  features.push(k === "farm" || k === "meadow" ? { k, r, v: fieldShade(t, el.id) } : { k, r });
  if (k === "water" || k === "wastewater") water.push({ r, river: /^(river|canal|stream|rapids)$/.test(t.water ?? "") || t.waterway === "riverbank" });
}

if (REPAINT) {
  const segs = features.filter((f) => f.k === "rail" && !f.y).flatMap((f) => f.l!.slice(1).map((q, i) => [f.l![i], q] as const));
  const near = (p: P2) => segs.some(([a, b]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy) < 6;
  });
  let kept = 0;
  for (const p of platforms) {
    if (!p.g.some(near)) continue;
    const sh = p.sh ? { sh: 1 as const } : {};
    if (closed(p.g)) { const r = simplifyRing(p.g.slice(0, -1), 0.2); if (r.length >= 3) { features.push({ k: "platform", r: [r], ...sh }); kept++; } }
    else { features.push({ k: "platform", l: simplifyLine(p.g, 0.2), w: r1(p.w), ...sh }); kept++; }
  }
  console.log(`  platforms: ${kept} of ${platforms.length} beside open-air track`);
}

/** junction entry: [x, y, radius (half width + 3 m), layer, kind of the widest road, (streetDetail) 1 if a street
 *  with pavements meets there] */
const JUNCTION_KIND = ["dirtroad", "lane", "street", "highway"];
// Junctions (markings stop there) and zebra crossings (footpath meets a street mid-block).
const junctions: number[][] = [], zebras: number[][] = [];
for (const [id, u] of nodeUse) {
  const pos = nodePos.get(id);
  if (!pos) continue;
  const [[x, y], [nx, ny], w] = pos;
  if (u.n >= 2) junctions.push([r1(x), r1(y), r1(u.w / 2 + 3), u.y, JUNCTION_KIND.indexOf(u.k), ...(DETAIL ? [u.p ? 1 : 0] : [])]);
  else if (footNodes.has(id) && w >= 5) {
    const L = Math.hypot(nx - x, ny - y) || 1;
    zebras.push([r1(x), r1(y), Math.round(((nx - x) / L) * 1000) / 1000, Math.round(((ny - y) / L) * 1000) / 1000, r1(w)]);
  }
}
features.push({ k: "junctions", j: junctions } as Feature, { k: "zebras", j: zebras } as Feature);
console.log(`  ${junctions.length} junctions, ${zebras.length} zebra crossings`);

// Sea: the coastline has land on its left. Join it, close the open chain far offshore (west).
const chains = joinWays(coast);
const main = chains.filter((c) => !closed(c)).sort((a, b) => b.length - a.length)[0];
let sea: P2[][] = [];
if (main) {
  const off = 30000;
  const ring: P2[] = [...main, [main.at(-1)![0] - off, main.at(-1)![1]], [main[0][0] - off, main[0][1]]];
  sea = [simplifyLine(ring, 0.3), ...chains.filter(closed).map((c) => simplifyRing(c, 0.3))]; // closed = islands/breakwaters
  features.unshift({ k: "sea", r: sea });
  features.push({ k: "shore", l: simplifyLine(main, 0.3) });
}
console.log(`  features: ${features.length} (${chains.length} coastline chains)`);

// ---- terrain grid ------------------------------------------------------------------------------
interface Grid { x0: number; y0: number; nx: number; ny: number }
const tb = [S - TMARGIN, W - TMARGIN, N + TMARGIN, E + TMARGIN];
const corners = [[tb[0], tb[1]], [tb[0], tb[3]], [tb[2], tb[1]], [tb[2], tb[3]]].map(([la, lo]) => toEnu(lo, la));
const x0 = Math.floor(Math.min(...corners.map((c) => c[0])) / STEP) * STEP, x1 = Math.max(...corners.map((c) => c[0]));
const y0 = Math.floor(Math.min(...corners.map((c) => c[1])) / STEP) * STEP, y1 = Math.max(...corners.map((c) => c[1]));
const grid: Grid = { x0, y0, nx: Math.ceil((x1 - x0) / STEP) + 1, ny: Math.ceil((y1 - y0) / STEP) + 1 };

/**
 * Copernicus tiles: float32, 3600 rows, pixel centres at whole arc-seconds from the tile's SW-NW corner;
 * 3600 columns below 50° latitude, fewer further north (2400 at 50–60°: 1.5″ in longitude).
 */
async function loadDem() {
  const dir = join(RAW, "dem"), tiles = new Map<string, { t: Float32Array; w: number }>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".tif"))) {
    const m = f.match(/N(\d+)_00_E(\d+)_00/)!;
    const { data, info } = await sharp(join(dir, f)).extractChannel(0).raw({ depth: "float" }).toBuffer({ resolveWithObject: true });
    if (info.height !== 3600 || ![3600, 2400, 1800, 1200, 720, 360].includes(info.width)) throw new Error(`${f}: unexpected size ${info.width}×${info.height}`);
    tiles.set(`${Number(m[1])}_${Number(m[2])}`, { t: new Float32Array(data.buffer, data.byteOffset, data.length / 4), w: info.width });
  }
  return (lat: number, lon: number) => {
    const tile = tiles.get(`${Math.floor(lat)}_${Math.floor(lon)}`);
    if (!tile) return 0;
    const { t, w } = tile;
    const fx = (lon - Math.floor(lon)) * w, fy = (Math.floor(lat) + 1 - lat) * 3600;
    const ix = Math.min(w - 2, Math.floor(fx)), iy = Math.min(3598, Math.floor(fy)), ax = fx - ix, ay = fy - iy;
    const v = (x: number, y: number) => t[y * w + x];
    return (v(ix, iy) * (1 - ax) + v(ix + 1, iy) * ax) * (1 - ay) + (v(ix, iy + 1) * (1 - ax) + v(ix + 1, iy + 1) * ax) * ay;
  };
}

const dem = await loadDem();
/** 1 m bare earth at (lat, lon), NaN where it has no data */
const bare = region.sources === "lgl" ? await rasterSampler("dgm1", tb).then((s) => (lat: number, lon: number) => s.at(...toUtm(lat, lon)))
  : region.sources === "gugik" ? gugikTerrain(tb).atLatLon : null;
const n = grid.nx * grid.ny;
let h = new Float32Array(n);
const fine = new Uint8Array(n); // 1: bare-earth DGM1 (no filtering needed)
for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
  const x = grid.x0 + ix * STEP, y = grid.y0 + iy * STEP, i = iy * grid.nx + ix;
  const [lat, lon] = enuToLlh([x, y, 0]);
  const v = bare ? bare(lat, lon) : NaN;
  if (Number.isFinite(v)) { h[i] = v; fine[i] = 1; } else h[i] = dem(lat, lon);
}
const fineShare = fine.reduce((a, b) => a + b, 0) / n;
if (DGM) console.log(`  terrain: ${region.sources === "lgl" ? "DGM1" : "NMT"} on ${(fineShare * 100).toFixed(1)}% of the grid, Copernicus elsewhere`);
/** Separable min / max / box filter with radius r grid cells. */
function filter(a: Float32Array, r: number, op: "min" | "max" | "mean") {
  const pass = (src: Float32Array, horiz: boolean) => {
    const dst = new Float32Array(n);
    for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
      let acc = op === "min" ? Infinity : op === "max" ? -Infinity : 0, cnt = 0;
      for (let d = -r; d <= r; d++) {
        const x = horiz ? ix + d : ix, y = horiz ? iy : iy + d;
        if (x < 0 || y < 0 || x >= grid.nx || y >= grid.ny) continue;
        const v = src[y * grid.nx + x];
        acc = op === "min" ? Math.min(acc, v) : op === "max" ? Math.max(acc, v) : acc + v;
        cnt++;
      }
      dst[iy * grid.nx + ix] = op === "mean" ? acc / cnt : acc;
    }
    return dst;
  };
  return pass(pass(a, true), false);
}
// bare earth: opening removes blocks up to ~200 m across, then smooth twice (≈ gaussian); DGM1 is bare already
if (fineShare < 1) {
  const r = Math.round(100 / STEP), s = Math.round(40 / STEP);
  const smooth = filter(filter(filter(filter(h, r, "min"), r, "max"), s, "mean"), s, "mean");
  for (let i = 0; i < n; i++) if (!fine[i]) h[i] = smooth[i];
}
// ZG3D: the opened Copernicus surface is off by up to ±10 m (trees, dense blocks, the Gornji grad ridge).
// Every building's surveyed base is a bare-earth sample: spread their residuals over the grid (≈ gaussian,
// σ ≈ 25 m) and fade the correction out where buildings are sparse, back to plain Copernicus.
if (region.sources === "zg3d") {
  const num = new Float32Array(n), den = new Float32Array(n), at = (x: number, y: number) =>
    Math.round((y - grid.y0) / STEP) * grid.nx + Math.round((x - grid.x0) / STEP);
  const bases = zg3dBases(tb as [number, number, number, number], readJson(join(RAW, "zg3d", "index.json")));
  for (const [lat, lon, z] of bases) {
    const [x, y] = toEnu(lon, lat), i = at(x, y);
    if (i < 0 || i >= n || x < grid.x0 || y < grid.y0) continue;
    num[i] += z - h[i]; den[i] += 1;
  }
  const r = Math.round(20 / STEP), N0 = 0.02; // N0: mean building density (per cell) at which the fit is half trusted
  const sn = filter(filter(num, r, "mean"), r, "mean"), sd = filter(filter(den, r, "mean"), r, "mean");
  const fix: number[] = [];
  for (let i = 0; i < n; i++) if (!fine[i] && sd[i] > 0) { const c = sn[i] / (sd[i] + N0); h[i] += c; fix.push(c); }
  fix.sort((a, b) => a - b);
  const q = (f: number) => fix.length ? fix[Math.floor(f * (fix.length - 1))].toFixed(1) : "-";
  console.log(`  terrain fitted to ${bases.length} ZG3D building bases: correction ${q(0.05)} / ${q(0.5)} / ${q(0.95)} m (5/50/95 %)`);
}

// water: sea at 0 m; lakes/rivers at their lowest surrounding ground; land kept above the sea
const isWater = new Uint8Array(n);
if (sea.length) fillGrid(sea, grid, (i) => { isWater[i] = 1; h[i] = -0.4; });
for (const { r: w } of DGM ? [] : water) { // DGM1 already holds each river's surveyed level (and the Neckar's weirs)
  const idx: number[] = [];
  fillGrid(w, grid, (i) => idx.push(i));
  if (!idx.length) continue;
  const level = Math.max(0, Math.min(...idx.map((i) => h[i])) - 0.3);
  for (const i of idx) { if (!isWater[i]) h[i] = level; isWater[i] = 2; }
}
for (let i = 0; i < n; i++) if (!isWater[i]) h[i] = Math.max(h[i], 0.8);
// GUGiK NMT has no water surface: it is interpolated across a lake from its shores, wavy by half a metre and more,
// which the hillshade draws as a sculpted bottom. Still water gets one level, its lowest tenth (below the shores);
// a river area the mean of its own nodes within ~15 m, twice (no waves, its fall kept).
if (region.sources === "gugik") {
  const inside = new Uint8Array(n);
  for (const w of water) {
    const idx: number[] = [];
    fillGrid(w.r, grid, (i) => idx.push(i));
    if (!idx.length) continue;
    if (!w.river) {
      const v = idx.map((i) => h[i]).sort((a, b) => a - b), level = v[Math.floor((v.length - 1) * 0.1)];
      for (const i of idx) h[i] = level;
      continue;
    }
    for (const i of idx) inside[i] = 1;
    for (let pass = 0; pass < 2; pass++) {
      const next = idx.map((i) => {
        const ix = i % grid.nx, iy = (i - ix) / grid.nx;
        let s = 0, c = 0;
        for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
          const x = ix + dx, y = iy + dy, j = y * grid.nx + x;
          if (x >= 0 && y >= 0 && x < grid.nx && y < grid.ny && inside[j]) { s += h[j]; c++; }
        }
        return s / c;
      });
      idx.forEach((i, k) => (h[i] = next[k]));
    }
    for (const i of idx) inside[i] = 0;
  }
}

// GUGiK NMT is bare earth with every structure taken out, a short underpass's roof too: a road or track over a tunnel
// (OSM tunnel=yes; the way above is rarely tagged a bridge) would dip into the cutting it crosses and step out of it.
// Along each tunnel, between its portals, every cross-section is filled from crest to crest: walking out from the
// tunnel's axis on each side, over the flat road bed (and up to 8 m of verges) and up the cutting's wall to where the
// ground stops rising, the surface between the two crests becomes a straight slope from one to the other. Only ever
// raised (a tunnel under a hill keeps its hill), never past a crest; water is left alone.
if (region.sources === "gugik") {
  const h0 = h.slice(), at = (x: number, y: number) => {
    const fx = Math.min(grid.nx - 1.001, Math.max(0, (x - grid.x0) / STEP)), fy = Math.min(grid.ny - 1.001, Math.max(0, (y - grid.y0) / STEP));
    const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, i = iy * grid.nx + ix;
    return (h0[i] * (1 - ax) + h0[i + 1] * ax) * (1 - ay) + (h0[i + grid.nx] * (1 - ax) + h0[i + grid.nx + 1] * ax) * ay;
  };
  const step = STEP / 2;
  let tunnels = 0, cells = 0;
  for (const file of ["roads.json", "rails.json"]) {
    const f = join(RAW, name, file);
    if (!existsSync(f)) continue;
    for (const el of readJson(f).elements ?? []) {
      const t: Record<string, string> = el.tags ?? {};
      if (el.type !== "way" || t.tunnel !== "yes" || !el.geometry || el.geometry.length < 2 || t.location === "underground") continue;
      const l = geom(el.geometry), road = (t.highway ? roadWidth(t) : 5) / 2;
      let raised = 0;
      for (let s = 1; s < l.length; s++) {
        const [a, b] = [l[s - 1], l[s]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 0.5) continue;
        const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy, ny = ux;
        for (let al = 0; al <= L; al += step) {
          const px = a[0] + ux * al, py = a[1] + uy * al;
          /** the crest on one side: [height, distance from the axis] */
          const crest = (sg: number) => {
            let best = at(px, py), dist = 0;
            for (let d = step; d <= road + 20; d += step) {
              const v = at(px + nx * d * sg, py + ny * d * sg);
              if (v > best + 0.05) { best = v; dist = d; } else if (d > road + 8 && d - dist > 4.5) break; // past the verges
            }
            return [best, dist];
          };
          const [lv, ld] = crest(1), [rv, rd] = crest(-1);
          if (ld + rd < 2) continue;
          for (let d = -rd; d <= ld; d += step / 2) {
            const ix = Math.round((px + nx * d - grid.x0) / STEP), iy = Math.round((py + ny * d - grid.y0) / STEP);
            if (ix < 0 || iy < 0 || ix >= grid.nx || iy >= grid.ny) continue;
            const i = iy * grid.nx + ix, lid = rv + ((lv - rv) * (d + rd)) / (ld + rd);
            if (!isWater[i] && lid > h[i] + 0.3) { h[i] = lid; raised++; }
          }
        }
      }
      if (raised) { tunnels++; cells += raised; }
    }
  }
  console.log(`  tunnels: ${tunnels} with their cutting under them filled crest to crest (${cells} cells)`);
}

// track beds (LGL): on the 3 m grid, nodes beside a track in a cutting sit on the cutting wall, so the draped
// track zig-zags up and down. Every open-air track on the ground gets a smooth long profile (lowest DGM1 point
// across the bed every metre, running median 15 m, then mean 20 m); nodes within the bed + one grid step take it,
// blending back to the terrain over the next 4 m; the nearest track wins where beds run side by side
if (region.sources === "lgl") {
  const at = (x: number, y: number) => {
    const fx = Math.max(0, Math.min(grid.nx - 1.001, (x - grid.x0) / STEP)), fy = Math.max(0, Math.min(grid.ny - 1.001, (y - grid.y0) / STEP));
    const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, v = (a: number, b: number) => h[b * grid.nx + a];
    return (v(ix, iy) * (1 - ax) + v(ix + 1, iy) * ax) * (1 - ay) + (v(ix, iy + 1) * (1 - ax) + v(ix + 1, iy + 1) * ax) * ay;
  };
  const FLAT = 2.7 + STEP, BLEND = 4;
  const best = new Float32Array(n).fill(Infinity), target = new Float32Array(n);
  let tracks = 0;
  for (const f of features) {
    if (f.k !== "rail" || f.y || f.b || !f.l || f.l.length < 2) continue;
    // resample every metre: position, direction, profile
    const pts: P2[] = [], cum: number[] = [];
    for (let i = 1; i < f.l.length; i++) {
      const a = f.l[i - 1], b = f.l[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = 0; s < L; s += 1) { pts.push([a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L]); cum.push((cum.at(-1) ?? -1) + 1); }
    }
    pts.push(f.l.at(-1)!);
    if (pts.length < 4) continue;
    const raw = pts.map((p, k) => {
      const q = pts[Math.min(pts.length - 1, k + 1)], o = pts[Math.max(0, k - 1)], dx = q[0] - o[0], dy = q[1] - o[1], L = Math.hypot(dx, dy) || 1;
      return Math.min(...[-1.5, 0, 1.5].map((c) => at(p[0] - (dy / L) * c, p[1] + (dx / L) * c)));
    });
    const win = (r: number, fn: (v: number[]) => number, src: number[]) =>
      src.map((_, k) => fn(src.slice(Math.max(0, k - r), Math.min(src.length, k + r + 1))));
    const med = win(7, (v) => [...v].sort((a, b) => a - b)[v.length >> 1], raw);
    const prof = win(10, (v) => v.reduce((a, b) => a + b, 0) / v.length, med);
    tracks++;
    // nodes near each 1 m piece take the profile there
    const R = FLAT + BLEND;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
      const gx0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - R - grid.x0) / STEP)), gx1 = Math.min(grid.nx - 1, Math.ceil((Math.max(a[0], b[0]) + R - grid.x0) / STEP));
      const gy0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - R - grid.y0) / STEP)), gy1 = Math.min(grid.ny - 1, Math.ceil((Math.max(a[1], b[1]) + R - grid.y0) / STEP));
      for (let iy = gy0; iy <= gy1; iy++) for (let ix = gx0; ix <= gx1; ix++) {
        const x = grid.x0 + ix * STEP, y = grid.y0 + iy * STEP, i = iy * grid.nx + ix;
        if (isWater[i]) continue;
        const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)), d = Math.hypot(x - a[0] - u * dx, y - a[1] - u * dy);
        if (d < R && d < best[i]) { best[i] = d; target[i] = prof[k - 1] + (prof[k] - prof[k - 1]) * u; }
      }
    }
  }
  let moved = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === Infinity) continue;
    const t = best[i] <= FLAT ? 1 : 1 - (best[i] - FLAT) / BLEND, s = t * t * (3 - 2 * t);
    const v = h[i] + (target[i] - h[i]) * s;
    if (Math.abs(v - h[i]) > 0.05) moved++;
    h[i] = v;
  }
  console.log(`  track beds: ${tracks} open-air track(s) levelled, ${moved} grid nodes moved`);
}

// orthometric -> ellipsoid -> ENU up (Earth curvature drops the ellipsoid below the tangent plane)
for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
  const x = grid.x0 + ix * STEP, y = grid.y0 + iy * STEP, i = iy * grid.nx + ix;
  h[i] = h[i] + GEOID - (x * x + y * y) / (2 * R_EARTH);
}

writeFileSync(join(out, "height.bin"), Buffer.from(h.buffer));
writeFileSync(join(out, "meta.json"), JSON.stringify({ ...grid, step: STEP }));
// bridge decks: heights at both ends, joints between bridge ways interpolated (bridges.ts)
// off the grid: unknown (clamping to the edge gave decks the height of a hillside kilometres away)
const sample = (x: number, y: number) => {
  const fx = (x - grid.x0) / STEP, fy = (y - grid.y0) / STEP;
  if (fx < 0 || fy < 0 || fx > grid.nx - 1.001 || fy > grid.ny - 1.001) return null;
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, i = iy * grid.nx + ix;
  return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - ay) + (h[i + grid.nx] * (1 - ax) + h[i + grid.nx + 1] * ax) * ay;
};
// preset bridgeDetail: an OSM bridge often ends short of its abutment, over the gap the terrain model leaves under
// the bridge, so the road dips before the deck. Each abutment end (not a joint between bridge ways) runs on along
// its direction to where the embankment tops out: the first point within 0.3 m of the highest terrain in the
// next 15 m, at least 1 m (bridges.ts deckHeight, carried).
if (BRIDGE_DETAIL) {
  const endUse = new Map<number, number>();
  for (const w of graph) if (w.bridge) for (const n of [w.nodes[0], w.nodes.at(-1)!]) endUse.set(n, (endUse.get(n) ?? 0) + 1);
  let n = 0, total = 0;
  for (const w of graph) {
    if (!w.bridge || w.l.length < 2 || w.nodes.length !== w.l.length) continue;
    w.ext = ([0, 1] as const).map((i) => {
      if ((endUse.get(i ? w.nodes.at(-1)! : w.nodes[0]) ?? 0) > 1) return 0;
      const prof = Array.from({ length: 16 }, (_, s) => { const p = carried(w.l, i, s); return sample(p[0], p[1]) ?? NaN; }); // NaN: off the grid
      if (!prof.some(Number.isFinite)) return 0;
      const top = Math.max(...prof.filter(Number.isFinite)), s0 = prof.findIndex((v) => v >= top - 0.3);
      n++; total += s0;
      return Math.max(1, s0 + 0.5);
    }) as [number, number];
  }
  console.log(`  bridge ends carried to their abutments: ${n}, ${(total / Math.max(1, n)).toFixed(1)} m on average`);
}
// tunnel ends (ground.json has no tunnels; the raw roads/rails files do): decks running into a tunnel
const portals = new Set<number>();
for (const f of ["roads.json", "rails.json"]) {
  if (!existsSync(join(RAW, name, f))) continue;
  for (const e of readJson(join(RAW, name, f)).elements) if (e.tags?.tunnel === "yes" && e.nodes?.length) portals.add(e.nodes[0]).add(e.nodes.at(-1));
}
const ends = bridgeEnds(graph, sample, portals);
for (const [id, e] of ends) { const f = deckFeatures.get(id); if (f) f.e = e; }
writeFileSync(join(out, "bridge-ends.json"), JSON.stringify(Object.fromEntries(ends)));
// watercourses: rivers, streams, canals, ditches and drains above ground, at their OSM width or the usual one
if (WATER_DETAIL && existsSync(join(RAW, name, "osm-water.json"))) {
  const WIDTH: Record<string, number> = { river: 6, canal: 5, stream: 2, ditch: 1.2, drain: 1 };
  let n = 0;
  for (const el of readJson(join(RAW, name, "osm-water.json")).elements) {
    const t = el.tags ?? {};
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2 || (t.tunnel && t.tunnel !== "no") || t.location === "underground") continue;
    const w = Number(String(t.width ?? "").replace(",", ".")), l = simplifyLine(geom(el.geometry), 0.3);
    features.push({ k: "stream", l, w: r1(w > 0.3 && w < 60 ? w : WIDTH[t.waterway] ?? 1.5) });
    n++;
  }
  console.log(`  watercourses: ${n}`);
}
// parking lots: their stall lines (the cars on them: scene.ts)
if (PARKED && existsSync(join(RAW, name, "osm-parking.json"))) {
  const { lines } = parkLayout(readJson(join(RAW, name, "osm-parking.json")), (lon, lat) => toEnu(lon, lat));
  for (const l of lines) features.push({ k: "stalls", r: l.rings.map((r) => r.map(([x, y]) => [r1(x), r1(y)] as P2)) });
  console.log(`  parking: stall lines on ${lines.length} lots`);
}
// playgrounds: sandpits and the rubber pads under the equipment (the equipment itself: scene.ts)
if (PLAYGROUNDS && existsSync(join(RAW, name, "osm-play.json"))) {
  const { sand, pads } = playLayout(readJson(join(RAW, name, "osm-play.json")), (lon, lat) => toEnu(lon, lat));
  for (const r of sand) features.push({ k: "sandpit", r: [r.map(([x, y]) => [r1(x), r1(y)] as P2)] });
  for (const p of pads) features.push({ k: "playpad", r: [p.r.map(([x, y]) => [r1(x), r1(y)] as P2)], v: p.v });
  console.log(`  playgrounds: ${sand.length} sandpits, ${pads.length} safety pads`);
}
// lawns and gardens where the orthophoto is green, a feature per 128 m block (the area and ~700 m round it)
if (LAWNS) {
  const m = 0.006, box = [S - m, W - m, N + m, E + m], c = [[box[0], box[1]], [box[0], box[3]], [box[2], box[1]], [box[2], box[3]]].map(([la, lo]) => toPuwg(la, lo));
  const pbox = [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))];
  const blocks = await lawns(orthoChunks(box), pbox, (e, n) => { const [la, lo] = fromPuwg(e, n), [x, y] = toEnu(lo, la); return [r1(x), r1(y)]; });
  for (const r of blocks) features.push({ k: "lawn", r });
  console.log(`  lawns: ${blocks.length} blocks, ${blocks.reduce((a, b) => a + b.length, 0)} outlines from the orthophoto`);
}
writeFileSync(join(out, "features.json"), JSON.stringify(features));
let lo = Infinity, hi = -Infinity;
for (const v of h) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
console.log(`  terrain ${grid.nx}×${grid.ny} @ ${STEP} m, up ${lo.toFixed(1)}…${hi.toFixed(1)} m -> ${out}`);
