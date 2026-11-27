/**
 * A region's map shape (places.ts `outline`): an OSM boundary relation from the region's extract plus
 * extra boxes, as a union of polygons. Fetch and render skip what lies outside, export fades the map
 * edge along it (instead of along the areas' bboxes).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeRegion, llhToPixel } from "./camera.ts";
import { RAW } from "./paths.ts";
import { REGIONS } from "./places.ts";

type Pt = [number, number];

/** Outer rings of the region's outline as [lat, lon] (null: the region has none). Cached per relation in data/raw/osm/. */
export function outlineLatLon(region = activeRegion()): Pt[][] | null {
  const R = REGIONS[region], o = R.outline;
  if (!o) return null;
  if (!R.osmExtract) throw new Error(`${region}: outline needs osmExtract`);
  const rings: Pt[][] = [];
  for (const id of o.relations) rings.push(...relationRings(R.osmExtract, id).map((r) => o.clip ? clipRing(r, o.clip) : r)
    .map((r) => o.westOf ? clipWestOf(r, o.westOf) : r));
  for (const r of rings) if (r.length > 1 && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1]) r.pop(); // GeoJSON repeats the first vertex
  for (let i = rings.length - 1; i >= 0; i--) if (rings[i].length < 3) rings.splice(i, 1); // wholly outside the clip
  for (const [s, w, n, e] of o.add ?? []) rings.push([[s, w], [s, e], [n, e], [n, w]]);
  return rings;
}

/** Sutherland–Hodgman: a [lat, lon] ring cut to a box [s, w, n, e] (concave rings keep zero-width seams on the cut). */
function clipRing(ring: Pt[], [s, w, n, e]: [number, number, number, number]): Pt[] {
  const planes: Array<[number, number, 1 | -1]> = [[0, s, 1], [0, n, -1], [1, w, 1], [1, e, -1]]; // axis, value, keep side
  let out = ring;
  for (const [ax, v, side] of planes) {
    const src = out, inside = (p: Pt) => (p[ax] - v) * side >= 0;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) {
        const t = (v - a[ax]) / (b[ax] - a[ax]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  }
  return out;
}

/** The line's longitude at a latitude (linear between its points, constant beyond its ends). */
function lonAt(line: Pt[], lat: number) {
  if (lat <= line[0][0]) return line[0][1];
  if (lat >= line.at(-1)![0]) return line.at(-1)![1];
  for (let k = 1; k < line.length; k++)
    if (lat <= line[k][0]) { const [a, b] = [line[k - 1], line[k]], t = (lat - a[0]) / (b[0] - a[0] || 1); return a[1] + (b[1] - a[1]) * t; }
  return line.at(-1)![1];
}

/**
 * A [lat, lon] ring cut to what lies west of `line` (south to north; outline.westOf). Sutherland–Hodgman against the
 * line as one boundary: crossings found by bisection, and between leaving and re-entering, the line's own points
 * are added so the cut edge follows it.
 */
export function clipWestOf(ring: Pt[], line: Pt[]): Pt[] {
  const side = (p: Pt) => p[1] - lonAt(line, p[0]); // < 0 west (kept)
  const cross = (a: Pt, b: Pt): Pt => {
    let lo = 0, hi = 1;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2, p: Pt = [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m]; if ((side(p) < 0) === (side(a) < 0)) lo = m; else hi = m; }
    return [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
  };
  const out: Pt[] = [];
  let exit: Pt | null = null;
  const along = (from: Pt, to: Pt) => { // the line's points between two crossings, in walking order
    const pts = line.filter((p) => (p[0] - from[0]) * (p[0] - to[0]) < 0);
    return from[0] < to[0] ? pts : pts.reverse();
  };
  // start at a kept vertex so every exit is followed by its entry
  const start = ring.findIndex((p) => side(p) < 0);
  if (start < 0) return [];
  for (let n = 0; n < ring.length; n++) {
    const a = ring[(start + n) % ring.length], b = ring[(start + n + 1) % ring.length];
    const ain = side(a) < 0, bin = side(b) < 0;
    if (ain) out.push(a);
    if (ain && !bin) { exit = cross(a, b); out.push(exit); }
    if (!ain && bin) { const entry = cross(a, b); if (exit) out.push(...along(exit, entry)); out.push(entry); exit = null; }
  }
  return out;
}

function relationRings(extract: string, id: number): Pt[][] {
  const dir = join(RAW, "osm"), cache = join(dir, `outline-${id}.json`);
  if (!existsSync(cache)) {
    const pbf = join(dir, extract.split("/").pop()!);
    if (!existsSync(pbf)) throw new Error(`${pbf} missing: run fetch for an area of the region first`);
    mkdirSync(dir, { recursive: true });
    const rel = join(dir, `rel-${process.pid}.osm.pbf`), geo = join(dir, `rel-${process.pid}.geojson`);
    execFileSync("osmium", ["getid", "-r", "-O", "-o", rel, pbf, `r${id}`], { stdio: "ignore" });
    execFileSync("osmium", ["export", "-O", "-f", "geojson", "-o", geo, rel], { stdio: "ignore" });
    // the relation's area is the largest polygon (member ways tagged as areas come out too)
    const f = JSON.parse(readFileSync(geo, "utf8")).features.filter((f: any) => /Polygon/.test(f.geometry.type))
      .sort((a: any, b: any) => JSON.stringify(b.geometry).length - JSON.stringify(a.geometry).length)[0];
    rmSync(rel); rmSync(geo);
    if (!f) throw new Error(`relation ${id} has no closed outline in ${pbf}`);
    const polys: number[][][][] = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    // outer rings only, ~10 m simplified (thousands of border vertices -> a few hundred)
    writeFileSync(cache, JSON.stringify(polys.map((p) => simplify(p[0].map(([lon, lat]) => [lat, lon] as Pt), 1e-4))));
  }
  return JSON.parse(readFileSync(cache, "utf8"));
}

const pixelCache = new Map<string, Pt[][] | null>();
/** The outline in global art pixels at the region's typical ground height (like areaPolygon). */
export function outlinePixels(): Pt[][] | null {
  const region = activeRegion();
  if (!pixelCache.has(region)) {
    const rings = outlineLatLon(region);
    pixelCache.set(region, rings && rings.map((r) => r.map(([lat, lon]) => llhToPixel(lat, lon, REGIONS[region].groundH))));
  }
  return pixelCache.get(region)!;
}

/**
 * Distance (art px) from a point to the outline's outer border, 0 outside. Border pieces shared by two
 * rings (town borders, the airport box inside them) are not edges of the union and don't count.
 */
interface EdgeIndex {
  /** outer border segments, bucketed by CELL² cells (each segment in every cell its bbox touches) */
  cells: Map<string, Array<[Pt, Pt]>>;
  all: Array<[Pt, Pt]>;
  /** every ring segment by BAND-high horizontal band, for the inside test: [ring, a, b] */
  bands: Map<number, Array<[number, Pt, Pt]>>;
  rings: number;
}
const CELL = 1024, BAND = 256;
const edgeCache = new Map<string, EdgeIndex>();
function edgeIndex(rings: Pt[][]): EdgeIndex {
  const region = activeRegion();
  if (!edgeCache.has(region)) {
    const TOL = 160; // 40 m: simplified shared borders don't coincide exactly
    const near = (q: Pt, r: Pt[]) => insideRing(q, r) || r.some((a, i) => segDist(q, a, r[(i + 1) % r.length]) < TOL);
    const all: Array<[Pt, Pt]> = [], cells = new Map<string, Array<[Pt, Pt]>>(), bands = new Map<number, Array<[number, Pt, Pt]>>();
    rings.forEach((r, k) => r.forEach((a, i) => {
      const b = r[(i + 1) % r.length];
      for (let y = Math.floor(Math.min(a[1], b[1]) / BAND); y <= Math.floor(Math.max(a[1], b[1]) / BAND); y++) {
        if (!bands.has(y)) bands.set(y, []);
        bands.get(y)!.push([k, a, b]);
      }
      const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (rings.some((o, j) => j !== k && near(m, o))) return; // shared border: not an edge of the union
      all.push([a, b]);
      for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
        for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
          const c = `${x}_${y}`;
          if (!cells.has(c)) cells.set(c, []);
          cells.get(c)!.push([a, b]);
        }
    }));
    edgeCache.set(region, { cells, all, bands, rings: rings.length });
  }
  return edgeCache.get(region)!;
}

/**
 * Distance to the outer border, exact below `cap`; at or beyond it, some value ≥ cap (callers that clamp
 * at `cap` get the same result as an unbounded search, only without scanning every border segment).
 */
export function outlineEdgeDistance(p: Pt, cap = Infinity): number {
  const rings = outlinePixels();
  if (!rings) return Infinity;
  const ix = edgeIndex(rings);
  // inside any ring: ray cast to +x, only through the segments of p's band
  const odd = new Uint8Array(ix.rings);
  for (const [k, [xi, yi], [xj, yj]] of ix.bands.get(Math.floor(p[1] / BAND)) ?? [])
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) odd[k] ^= 1;
  if (!odd.includes(1)) return 0;
  let d = Infinity;
  if (!Number.isFinite(cap)) {
    for (const [a, b] of ix.all) d = Math.min(d, segDist(p, a, b));
    return d;
  }
  const r = Math.ceil(cap / CELL), cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
  for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++)
    for (const [a, b] of ix.cells.get(`${x}_${y}`) ?? []) d = Math.min(d, segDist(p, a, b));
  return Math.min(d, cap);
}

function segDist([x, y]: Pt, [ax, ay]: Pt, [bx, by]: Pt) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

export function insideRing([x, y]: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Is a lat/lon box [s, w, n, e] (grown by `marginDeg`) touching the outline? Sampled, for coarse culling. */
export function boxTouchesOutline([s, w, n, e]: number[], marginDeg = 0.01, region = activeRegion()) {
  const rings = outlineLatLon(region);
  if (!rings) return true;
  s -= marginDeg; w -= marginDeg * 1.5; n += marginDeg; e += marginDeg * 1.5;
  for (const r of rings) {
    if (r.some(([la, lo]) => la >= s && la <= n && lo >= w && lo <= e)) return true;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++)
      if (insideRing([s + ((n - s) * i) / 4, w + ((e - w) * j) / 4], r)) return true;
  }
  return false;
}

/** Douglas–Peucker on a closed ring. */
function simplify(ring: Pt[], tol: number): Pt[] {
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, dmax = tol;
    const [ax, ay] = ring[a], [bx, by] = ring[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = L > 1e-12 ? Math.abs(dy * (ring[i][0] - ax) - dx * (ring[i][1] - ay)) / L : Math.hypot(ring[i][0] - ax, ring[i][1] - ay);
      if (d > dmax) { dmax = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return ring.filter((_, i) => keep[i]);
}
