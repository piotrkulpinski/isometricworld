/**
 * Export rendered/painted areas to the web viewer.
 *
 *   npm run export -- tlv-core [more areas…] [--data-only]
 *
 * All areas must belong to one region. Only files that differ from what is published (R2) are
 * written, into the local cache data/web/regions/<region>/ (served by `npm run dev` over production;
 * `npm run publish -- <region>` uploads and empties it):
 *   tiles/map/{z}/{x}/{y}.avif         painted tiles where available, 3D render elsewhere
 *   tiles/photo/{z}/{x}/{y}.avif       3D render only (toggle)
 *   data/world.json                    camera, bounds, tile origin, ENU→pixel map, attributions, and
 *                                      the names of the files below (the only mutable file)
 *   data/tiles-<layer>.<hash>.json     every tile of a layer per zoom with its content hash (URL ?v=)
 *   data/borders.<hash>.json           OSM city borders in art-pixel space, on real terrain
 *   data/roads.<hash>.json             drivable roads for traffic (columnar, delta-coded: encodeRoads)
 *   data/trams.<hash>.json             tram tracks, same format, plus stops (where the region has trams)
 *   preview/<city>-<land|port>.<hash>.avif  the city's opening view, shown until the tiles are in
 * Content-hashed names never change, so browsers keep them for a year; world.json says which are current.
 * The legacy data/tiles.json + .webp tiles stay on R2 untouched: the viewer's fallback without AVIF.
 * What is published (tile sources + hashes) is tracked in data/web-state/<region>.json; an export not
 * yet published keeps its state next to the cache (data/web/<region>.state.json) so exports stack.
 *
 * Tile (x, y) at zoom z covers global art pixels [x·512·2^(8-z), …); z = 8 is 1:1.
 */
import { isCarFree, isOneway, roadLanes, roadWidth } from "./roadspec.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { AREAS, groundH, areaPolygon, insideDistance, openArea } from "./areas.ts";
import { CAMERA, activeRegion, axes, camera, ecefToEnu, enuToPixel, llhToEcef, llhToPixel } from "./camera.ts";
import { HOSTING } from "./hosting.ts";
import { DERIVED, RAW, WEB_CACHE, WEB_STATE, readJson } from "./paths.ts";
import { CITIES, REGIONS } from "./places.ts";
import { readHeights } from "./heights.ts";

const TS = 512;                  // web tile size
const SPLIT = CAMERA.tile / TS;  // web tiles per art tile edge
const NATIVE_Z = 8;
const MIN_Z = 2;
/** AVIF q50 ≈ the old WebP q72 in PSNR at ~40% fewer bytes (measured on painted tiles). */
const FORMAT = "avif", QUALITY = 50;
const MARGIN = 16; // neighbour pixels used when building each zoomed-out tile
/** Soft map edge: tiles fade out toward the areas' true outline instead of ending in tile steps.
 *  Fully transparent within EDGE0 of the outline (half a render tile's diagonal: the staircase
 *  never shows), fully opaque from EDGE1 in. */
const EDGE0 = 760;
let EDGE1 = EDGE0 + 1800;
let outlines: Array<Array<[number, number]>> = [];
/** web/src/pages/index.astro #map background (#0e0f12): the edge fades into it */
const BG = [14, 15, 18];
const edgeDistance = (x: number, y: number) => Math.max(0, ...outlines.map((o) => insideDistance([x, y], o)));

/** Native web tile at global art px (x0, y0): fade alpha near the map edge (null = fully inside). */
function edgeAlpha(x0: number, y0: number): Buffer | null {
  const corners = [[x0, y0], [x0 + TS, y0], [x0, y0 + TS], [x0 + TS, y0 + TS]];
  if (Math.min(...corners.map(([x, y]) => edgeDistance(x, y))) >= EDGE1) return null;
  const a = Buffer.alloc(TS * TS), step = 8; // distance on an 8 px lattice, bilinear in between
  const n = TS / step + 1, grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grid[j * n + i] = edgeDistance(x0 + i * step, y0 + j * step);
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const gx = x / step, gy = y / step, i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
    const d = (grid[j * n + i] * (1 - fx) + grid[j * n + i + 1] * fx) * (1 - fy) + (grid[(j + 1) * n + i] * (1 - fx) + grid[(j + 1) * n + i + 1] * fx) * fy;
    const t = Math.min(1, Math.max(0, (d - EDGE0) / (EDGE1 - EDGE0)));
    a[y * TS + x] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  return a;
}

type Key = `${number}_${number}`;
const key = (x: number, y: number): Key => `${x}_${y}`;
const parse = (k: string) => k.split("_").map(Number) as [number, number];
/** Existing tiles per zoom with their content hash, written to tiles.json: the viewer never requests
 *  missing tiles, and ?v=<hash> makes every tile URL immutable (cached at the edge for a year). */
const index: Record<string, Record<number, Record<string, string>>> = {};

/** Published state of a region: per layer the source stamp of each native tile and the content hash
 *  of every tile ("z/x_y"), plus the hash of each data file. */
interface State { layers: Record<string, { sources: Record<string, string>; hashes: Record<string, string> }>; data: Record<string, string> }
let state: State = { layers: {}, data: {} };
const hash = (b: Buffer | string) => createHash("sha1").update(b).digest("hex").slice(0, 10);
const pendingFile = () => join(WEB_CACHE, `${activeRegion()}.state.json`);
const publishedFile = () => join(WEB_STATE, `${activeRegion()}.json`);

/** A content-addressed data file data/<name>.<hash>.json, written to the cache only when it differs
 *  from the published one (the old one stays on R2 for pages still pointing at it). */
function writeData(name: string, content: string) {
  const h = hash(content);
  if (state.data[name] === h) return;
  mkdirSync(join(OUT, "data"), { recursive: true });
  writeFileSync(join(OUT, "data", `${name}.${h}.json`), content);
  state.data[name] = h;
}
const dataFile = (name: string) => (state.data[name] ? `${name}.${state.data[name]}.json` : undefined);

/** A tile built earlier: from the cache if it is waiting to be published, else from production. */
const fetched = new Map<string, Buffer>();
async function readTile(layer: string, z: number, x: number, y: number): Promise<Buffer> {
  const rel = `tiles/${layer}/${z}/${x}/${y}.${FORMAT}`, local = join(OUT, rel);
  if (existsSync(local)) return readFileSync(local);
  if (fetched.has(rel)) return fetched.get(rel)!;
  const v = state.layers[layer]?.hashes[`${z}/${x}_${y}`];
  const r = await fetch(`${HOSTING.origin}/regions/${activeRegion()}/${rel}${v ? `?v=${v}` : ""}`);
  if (!r.ok) throw new Error(`${rel}: not in the cache and ${r.status} from ${HOSTING.origin} (delete ${publishedFile()} to rebuild everything)`);
  const b = Buffer.from(await r.arrayBuffer());
  fetched.set(rel, b);
  return b;
}

/**
 * Road bridges drawn over the paint. Codex sometimes paints rails or lanes running across a bridge
 * deck (the layering is ambiguous in a flat painting); the OSM decks (layer > 0, as projected for the
 * traffic) are laid on top in the painted road style, so a bridge always reads as on top.
 */
type Deck = { y: number; w: number; m: number; pts: Array<[number, number]>; box: number[] };
let decks: Deck[] = [];
const DECK_STYLE = "decks1"; // bump to re-export painted tiles after changing the deck drawing
function bridgeDecks(ways: Array<{ y: number; w: number; l: number; s: number[] }>) {
  decks = [];
  for (const w of ways) {
    if (w.y <= 0) continue;
    let run: Array<[number, number]> = [], scale = 0, n = 0;
    const flush = () => {
      if (run.length >= 2) {
        const xs = run.map((p) => p[0]), ys = run.map((p) => p[1]);
        decks.push({ y: w.y, w: (w.w * scale) / n, m: scale / n, pts: run, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
      }
      run = []; scale = 0; n = 0;
    };
    for (let k = 0; k < w.s.length; k += 4) {
      if (!w.s[k + 3]) { flush(); continue; } // hidden behind a building, under a higher bridge, in the margin
      const p = enuToPixel([w.s[k], w.s[k + 1], w.s[k + 2]]);
      run.push([p[0], p[1]]);
      const k2 = k + 4 < w.s.length ? k + 4 : k - 4;
      const dx = w.s[k2] - w.s[k], dy = w.s[k2 + 1] - w.s[k + 1], L = Math.hypot(dx, dy) || 1;
      const q = enuToPixel([w.s[k] - dy / L, w.s[k + 1] + dx / L, w.s[k + 2]]); // 1 m across the deck
      scale += Math.hypot(q[0] - p[0], q[1] - p[1]); n++;
    }
    flush();
  }
  decks.sort((a, b) => a.y - b.y);
}
/** SVG of the bridge decks crossing a web tile at global px (x0, y0), or null */
function deckSvg(x0: number, y0: number) {
  const hit = decks.filter((d) => d.box[0] < x0 + TS + d.w && d.box[2] > x0 - d.w && d.box[1] < y0 + TS + d.w && d.box[3] > y0 - d.w);
  if (!hit.length) return null;
  const line = (d: Deck, color: string, width: number, extra = "") =>
    `<polyline points="${d.pts.map(([x, y]) => `${(x - x0).toFixed(1)},${(y - y0).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="${width.toFixed(1)}" stroke-linejoin="round" ${extra}/>`;
  const body = hit.map((d) => {
    const m = d.m; // px per metre across the deck
    return line(d, "#55565c", d.w + 1.5 * m, 'stroke-linecap="butt"') + line(d, "#e2ddd2", d.w + 0.9 * m, 'stroke-linecap="butt"')
      + line(d, "#6e7078", d.w, 'stroke-linecap="butt"') + line(d, "#f4f1ea", 0.15 * m, `stroke-dasharray="${3 * m} ${3 * m}"`);
  }).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${TS}" height="${TS}">${body}</svg>`);
}

/** Run tile jobs a few at a time (AVIF encoding is the slow part; sharp works off the main thread). */
const PARALLEL = 8;
async function pool(jobs: Array<() => Promise<void>>) {
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => { while (next < jobs.length) await jobs[next++](); }));
}

async function exportLayer(layer: string, sources: Map<Key, string>) {
  index[layer] = {};
  const root = join(OUT, "tiles", layer);
  // which source (path + mtime) produced each native tile last time, and every tile's content hash
  const st = (state.layers[layer] ??= { sources: {}, hashes: {} });
  const prevSources = st.sources, nextSources: Record<string, string> = {}, hashes: Record<string, string> = {};
  const save = async (img: ReturnType<typeof sharp>, z: number, x: number, y: number) => {
    const buf = await img.avif({ quality: QUALITY, effort: 4 }).toBuffer();
    mkdirSync(join(root, `${z}`, `${x}`), { recursive: true });
    writeFileSync(join(root, `${z}`, `${x}`, `${y}.${FORMAT}`), buf);
    hashes[`${z}/${x}_${y}`] = hash(buf);
  };
  // native zoom: split each 1024 art tile into 512 web tiles (only when the source changed)
  let level = new Map<Key, number>(); // key -> source mtime
  let changed = new Set<Key>();
  const jobs: Array<() => Promise<void>> = [];
  for (const [k, file] of sources) {
    const [tx, ty] = parse(k);
    const painted = layer === "map" && file.includes("/paint/");
    const m = statSync(file).mtimeMs, stamp = `${file}@${m}@edge${EDGE0}-${EDGE1}d${painted ? `@${DECK_STYLE}` : ""}@${FORMAT}${QUALITY}`;
    for (let j = 0; j < SPLIT; j++)
      for (let i = 0; i < SPLIT; i++) {
        const x = tx * SPLIT + i, y = ty * SPLIT + j, h = st.hashes[`${NATIVE_Z}/${x}_${y}`];
        level.set(key(x, y), m);
        nextSources[key(x, y)] = stamp;
        if (h && prevSources[key(x, y)] === stamp) { hashes[`${NATIVE_Z}/${x}_${y}`] = h; continue; }
        changed.add(key(x, y));
        jobs.push(async () => {
          let img = sharp(file).extract({ left: i * TS, top: j * TS, width: TS, height: TS });
          const svg = painted ? deckSvg(x * TS, y * TS) : null;
          if (svg) img = sharp(await img.png().toBuffer()).composite([{ input: svg }]);
          const rgb = await img.removeAlpha().raw().toBuffer();
          const alpha = edgeAlpha(x * TS, y * TS);
          // fade baked toward the page background: opaque tiles, so no seams where tiles meet
          if (alpha) for (let p = 0; p < TS * TS; p++) for (let c = 0; c < 3; c++)
            rgb[p * 3 + c] = Math.round(BG[c] + (rgb[p * 3 + c] - BG[c]) * (alpha[p] / 255));
          await save(sharp(rgb, { raw: { width: TS, height: TS, channels: 3 } }), NATIVE_Z, x, y);
        });
      }
  }
  await pool(jobs);
  console.log(`  ${layer} z${NATIVE_Z}: ${level.size} (${changed.size} updated)`);
  const keep = (z: number) => Object.fromEntries([...level.keys()].map((k) => [k, hashes[`${z}/${k}`]]));
  index[layer][NATIVE_Z] = keep(NATIVE_Z);
  for (let z = NATIVE_Z - 1; z >= MIN_Z; z--) {
    const parents = new Map<Key, Array<[number, number]>>();
    for (const k of level.keys()) {
      const [x, y] = parse(k);
      const p = key(Math.floor(x / 2), Math.floor(y / 2));
      if (!parents.has(p)) parents.set(p, []);
      parents.get(p)!.push([x, y]);
    }
    const next = new Map<Key, number>(), nextChanged = new Set<Key>();
    jobs.length = 0;
    for (const [p, kids] of parents) {
      const [px, py] = parse(p);
      const h = st.hashes[`${z}/${p}`];
      next.set(p, Math.max(...kids.map(([x, y]) => level.get(key(x, y))!)));
      if (h && !kids.some(([x, y]) => changed.has(key(x, y)))) { hashes[`${z}/${p}`] = h; continue; }
      nextChanged.add(p);
      jobs.push(async () => {
        // the 2×2 children plus a MARGIN strip of their neighbours, so the downscale filter sees
        // across tile edges (otherwise faint lines appear along tile borders at low zoom)
        const composite = [];
        for (let y = py * 2 - 1; y <= py * 2 + 2; y++) for (let x = px * 2 - 1; x <= px * 2 + 2; x++) {
          if (!level.has(key(x, y))) continue;
          const left = (x - px * 2) * TS + MARGIN, top = (y - py * 2) * TS + MARGIN;
          const cut = { left: Math.max(0, -left), top: Math.max(0, -top) };
          const width = Math.min(TS - cut.left, TS * 2 + 2 * MARGIN - Math.max(0, left)), height = Math.min(TS - cut.top, TS * 2 + 2 * MARGIN - Math.max(0, top));
          if (width <= 0 || height <= 0) continue;
          const input = await sharp(await readTile(layer, z + 1, x, y)).extract({ ...cut, width, height }).toBuffer();
          composite.push({ input, left: Math.max(0, left), top: Math.max(0, top) });
        }
        const S = TS * 2 + 2 * MARGIN;
        const merged = await sharp({ create: { width: S, height: S, channels: 3, background: { r: BG[0], g: BG[1], b: BG[2] } } })
          .composite(composite).png().toBuffer();
        const half = await sharp(merged).resize(S / 2, S / 2, { kernel: "lanczos3" }).png().toBuffer();
        await save(sharp(half).extract({ left: MARGIN / 2, top: MARGIN / 2, width: TS, height: TS }), z, px, py);
      });
    }
    await pool(jobs);
    level = next;
    changed = nextChanged;
    index[layer][z] = keep(z);
  }
  console.log(`  ${layer} z${MIN_Z}–${NATIVE_Z - 1}: ${Object.keys(hashes).length - Object.keys(index[layer][NATIVE_Z]).length} tiles`);
  st.sources = nextSources;
  st.hashes = hashes; // tiles no longer produced drop out (they stay in R2, unreferenced)
}

/** Surface ellipsoid height sampler from the renderer's height pass (256² per 1024² tile). */
class Heights {
  private cache = new Map<string, Float32Array | null>();
  constructor(private dirs: string[]) {}
  async ensure(x: number, y: number, r = 32) {
    for (let ty = Math.floor((y - r) / CAMERA.tile); ty <= Math.floor((y + r) / CAMERA.tile); ty++)
      for (let tx = Math.floor((x - r) / CAMERA.tile); tx <= Math.floor((x + r) / CAMERA.tile); tx++) {
        const k = `${tx}_${ty}`;
        if (this.cache.has(k)) continue;
        const file = this.dirs.map((d) => join(d, `${k}.png`)).find(existsSync);
        this.cache.set(k, file ? await readHeights(file) : null);
      }
  }
  /** Surface height at an art pixel (call ensure() first). */
  at(x: number, y: number): number | null {
    const T = CAMERA.tile, k = T / 256;
    const tx = Math.floor(x / T), ty = Math.floor(y / T);
    const h = this.cache.get(`${tx}_${ty}`);
    if (!h) return null;
    const v = h[Math.floor((y - ty * T) / k) * 256 + Math.floor((x - tx * T) / k)];
    return Number.isNaN(v) ? null : v;
  }
  /** Lowest surface (≈ ground, not rooftops) within ~r art px of a pixel. */
  async ground(x: number, y: number, r = 24): Promise<number | null> {
    await this.ensure(x, y, r);
    let best: number | null = null;
    for (let dy = -r; dy <= r; dy += 4)
      for (let dx = -r; dx <= r; dx += 4) {
        const h = this.at(x + dx, y + dy);
        if (h !== null && (best === null || h < best)) best = h;
      }
    return best;
  }
}

/** lat/lon -> art pixel on the real terrain (iterate: project, read ground, re-project). */
async function onGround(heights: Heights, lat: number, lon: number) {
  let h = groundH();
  let [x, y] = llhToPixel(lat, lon, h);
  for (let it = 0; it < 3; it++) {
    const g = await heights.ground(x, y);
    if (g === null) break;
    h = g;
    [x, y] = llhToPixel(lat, lon, h);
  }
  return { x, y, h };
}

async function exportBorders(heights: Heights) {
  const raw = readJson(join(RAW, "boundaries", `${activeRegion()}.json`));
  const feats = [];
  for (const el of raw.elements) {
    const ways: Array<Array<[number, number]>> = el.members
      .filter((m: any) => m.type === "way" && m.role === "outer" && m.geometry)
      .map((m: any) => m.geometry.map((p: any) => [p.lat, p.lon]));
    const out = [];
    for (const ring of stitch(ways)) {
      const pts: Array<[number, number]> = [];
      for (const [lat, lon] of ring) {
        const { x, y } = await onGround(heights, lat, lon);
        pts.push([Math.round(y * 10) / 10, Math.round(x * 10) / 10]);
      }
      out.push(pts);
    }
    feats.push({ id: el.id, name: el.tags.name, name_en: el.tags["name:en"], rings: out, label: labelPoint(out) });
  }
  writeData("borders", JSON.stringify(feats));
  console.log(`  borders: ${feats.length} cities`);
}

type Sampled = { y: number; c: number; o: number; l: number; w: number; a: number; b: number; s: number[] };

/**
 * OSM ways as ENU polylines sampled every ~6 m, each sample flagged visible/occluded, split at every
 * node another of these ways shares (so junctions and switches are always way ends). `props` gives a
 * way's class, direction, lanes and width.
 */
async function sampleWays(els: any[], heights: Heights, props: (t: Record<string, string>) => { c: number; o: number; l: number; w: number }) {
  const ways: Sampled[] = [];
  let occluded = 0, total = 0;
  const use = new Map<number, number>();
  for (const el of els) el.nodes.forEach((n: number, i: number) => use.set(n, (use.get(n) ?? 0) + (i === 0 || i === el.nodes.length - 1 ? 2 : 1)));
  for (const el of els) {
    const t = el.tags ?? {};
    const pr = props(t);
    let start = 0;
    for (let end = 1; end < el.nodes.length; end++) {
      if (end < el.nodes.length - 1 && (use.get(el.nodes[end]) ?? 0) < 2) continue;
      const pts = el.geometry.slice(start, end + 1).map((p: any) => ({ lat: p.lat, lon: p.lon, e: ecefToEnu(llhToEcef(p.lat, p.lon, 0)) }));
      const samples: number[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a0 = pts[i], b0 = pts[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(b0.e[0] - a0.e[0], b0.e[1] - a0.e[1]) / 6));
        for (let k = 0; k < n + (i === pts.length - 2 ? 1 : 0); k++) {
          const f2 = k / n, lat = a0.lat + (b0.lat - a0.lat) * f2, lon = a0.lon + (b0.lon - a0.lon) * f2;
          const g = await onGround(heights, lat, lon);
          const surf = heights.at(g.x, g.y);
          const vis = surf === null || surf <= g.h + 2.5 ? 1 : 0; // bridges are drawn at ground level
          total++; occluded += 1 - vis;
          const e = ecefToEnu(llhToEcef(lat, lon, g.h));
          samples.push(Math.round(e[0] * 10) / 10, Math.round(e[1] * 10) / 10, Math.round(e[2] * 10) / 10, vis);
        }
      }
      ways.push({ y: Number(t.layer) || (t.bridge && t.bridge !== "no" ? 1 : 0), ...pr, a: el.nodes[start], b: el.nodes[end], s: samples });
      start = end;
    }
  }
  return { ways, occluded, total };
}

/** OSM ways of every area's raw `file` passing `keep`, per area, each OSM way once (areas overlap: the pilot lies inside tlv-core). */
function rawWays(areas: string[], file: string, keep: (el: any) => boolean) {
  const seen = new Set<number>(), out: any[][] = [];
  for (const a of areas) {
    const f = join(RAW, a, file);
    if (!existsSync(f)) continue;
    out.push(readJson(f).elements.filter((el: any) => {
      if (el.type !== "way" || seen.has(el.id) || !keep(el)) return false;
      seen.add(el.id);
      return true;
    }));
  }
  return out;
}

/** sampleWays per area (ways are split at the nodes they share within their area), merged */
async function sampleAreas(perArea: any[][], heights: Heights, props: Parameters<typeof sampleWays>[2]) {
  const all = { ways: [] as Sampled[], occluded: 0, total: 0 };
  for (const els of perArea) {
    const r = await sampleWays(els, heights, props);
    all.ways.push(...r.ways); all.occluded += r.occluded; all.total += r.total;
  }
  return all;
}

/** Hide samples in the faded margin outside the painted map: nothing drives or walks there. */
function hideMargin(ways: Sampled[]) {
  let hidden = 0;
  for (const w of ways) for (let k = 0; k < w.s.length; k += 4) {
    if (!w.s[k + 3]) continue;
    const [x, y] = enuToPixel([w.s[k], w.s[k + 1], w.s[k + 2]]);
    if (edgeDistance(x, y) < (EDGE0 + EDGE1) / 2) { w.s[k + 3] = 0; hidden++; }
  }
  return hidden;
}

/**
 * Drivable roads (roads.json) and tram tracks (railway=tram in ground.json, no tunnels, depots and
 * sidings) as ENU polylines, each sample flagged visible/occluded. Vehicles on either disappear under
 * a bridge of either.
 */
async function exportRoads(areas: string[], heights: Heights) {
  const CLS: Record<string, number> = { motorway: 0, trunk: 0, primary: 1, secondary: 2, tertiary: 3, unclassified: 4, residential: 4, living_street: 5, service: 5 };
  const underground = (t: any) => t.tunnel === "yes" || String(t.layer ?? "").startsWith("-");
  const roadEls = rawWays(areas, "roads.json", (el) => {
    const t = el.tags ?? {};
    return el.geometry?.length >= 2 && !underground(t) && roadWidth(t) > 0;
  });
  const roads = await sampleAreas(roadEls, heights, (t) => ({
    c: isCarFree(t) ? 6 : CLS[String(t.highway).replace("_link", "")] ?? 5, o: t.oneway === "-1" ? -1 : isOneway(t) ? 1 : 0, l: roadLanes(t), w: Math.round(roadWidth(t) * 10) / 10,
  }));
  const isTram = (t: any) => t.railway === "tram" && !underground(t) && t.tunnel !== "building_passage" && !["yard", "siding", "spur"].includes(t.service);
  const isPlatform = (t: any) => t.railway === "platform" || (t.public_transport === "platform" && t.tram === "yes");
  const groundEls = rawWays(areas, "ground.json", (el) => el.geometry?.length >= 2 && (isTram(el.tags ?? {}) || isPlatform(el.tags ?? {})));
  const tramEls = groundEls.map((els) => els.filter((el) => isTram(el.tags ?? {})));
  const platforms = groundEls.flat().filter((el) => isPlatform(el.tags ?? {}));
  // one track per way: oneway=yes (most of Kraków's) runs forward, otherwise both ways
  const trams = await sampleAreas(tramEls, heights, (t) => ({ c: 0, o: t.oneway === "-1" ? -1 : t.oneway === "yes" ? 1 : 0, l: 1, w: 2.6 }));
  const ways = roads.ways;
  let occluded = roads.occluded + hideUnderBridges([...ways, ...trams.ways]);
  occluded += hideMargin(ways);
  hideMargin(trams.ways);
  bridgeDecks(ways);
  writeData("roads", JSON.stringify(encodeRoads(ways)));
  console.log(`  roads: ${ways.length} ways, ${roads.total} samples, ${((occluded / Math.max(1, roads.total)) * 100).toFixed(1)}% occluded`);
  // ground.json reaches ~2 km past the area: keep only tracks with something on the map
  const tracks = trams.ways.filter((w) => w.s.some((v, k) => k % 4 === 3 && v));
  if (!tracks.length) return;
  const stops = tramStops(platforms, tracks);
  writeData("trams", JSON.stringify({ ...encodeRoads(tracks), stops }));
  console.log(`  trams: ${tracks.length} track sections, ${tracks.reduce((a, w) => a + w.s.length / 4, 0)} samples, ${stops.length / 2} stops`);
}

/**
 * Tram stops as [way index, sample index] pairs: every tram platform from ground.json
 * (public_transport=platform with tram=yes, or railway=platform) snapped to the nearest track within
 * 8 m, and to a second track as close (an island platform serves both directions).
 */
function tramStops(platforms: any[], tracks: Sampled[]) {
  const stops: number[] = [];
  for (const p of platforms) {
    const g = p.geometry, lat = g.reduce((a: number, q: any) => a + q.lat, 0) / g.length, lon = g.reduce((a: number, q: any) => a + q.lon, 0) / g.length;
    const [e, n] = ecefToEnu(llhToEcef(lat, lon, 0));
    const near = tracks.map((w, i) => {
      let best = Infinity, at = 0;
      for (let k = 0; k < w.s.length; k += 4) {
        const d = Math.hypot(w.s[k] - e, w.s[k + 1] - n);
        if (d < best) { best = d; at = k / 4; }
      }
      return { i, d: best, at };
    }).filter((x) => x.d < 8).sort((a, b) => a.d - b.d);
    for (const x of near) if (x.d < near[0].d + 1.5) stops.push(x.i, x.at);
  }
  return stops;
}

/**
 * Roads for the viewer, columnar and delta-coded (~2.6× smaller than one object per way after
 * compression; decoded by web/src/scripts/roads.ts back into { c, o, l, w, a, b, s } per way):
 *   c, o, l, w   per way: class, oneway, lanes, width (m)
 *   a, b         per way: junction ids (OSM node ids renumbered 0…, only their identity matters)
 *   n            per way: number of samples
 *   s            per sample e, n, u in 0.1 m: a way's first sample absolute, then differences
 *   v            per way: number of runs, then run lengths of visible / hidden samples, visible first
 */
function encodeRoads(ways: Array<{ c: number; o: number; l: number; w: number; a: number; b: number; s: number[] }>) {
  const ids = new Map<number, number>(), id = (n: number) => ids.get(n) ?? ids.set(n, ids.size).get(n)!;
  const out = { v: 2, c: [] as number[], o: [] as number[], l: [] as number[], w: [] as number[], a: [] as number[], b: [] as number[], n: [] as number[], s: [] as number[], vis: [] as number[] };
  for (const w of ways) {
    out.c.push(w.c); out.o.push(w.o); out.l.push(w.l); out.w.push(w.w); out.a.push(id(w.a)); out.b.push(id(w.b));
    out.n.push(w.s.length / 4);
    let pe = 0, pn = 0, pu = 0, cur = 1, run = 0;
    const runs: number[] = [];
    for (let k = 0; k < w.s.length; k += 4) {
      const e = Math.round(w.s[k] * 10), n = Math.round(w.s[k + 1] * 10), u = Math.round(w.s[k + 2] * 10);
      out.s.push(e - pe, n - pn, u - pu);
      pe = e; pn = n; pu = u;
      if (w.s[k + 3] === cur) run++; else { runs.push(run); cur = w.s[k + 3]; run = 1; }
    }
    runs.push(run);
    out.vis.push(runs.length, ...runs);
  }
  return out;
}

/**
 * Vehicles on a road passing under a bridge (a road on a higher layer) must disappear beneath its
 * deck: mark those samples hidden. Returns how many samples were hidden.
 */
function hideUnderBridges(ways: Array<{ y: number; w: number; a: number; b: number; s: number[] }>) {
  type Seg = [number, number, number, number, number, number, number, number]; // a, b, half width, layer, way ends
  const CELL = 20, grid = new Map<string, Seg[]>();
  for (const w of ways) {
    if (w.y <= 0) continue;
    for (let k = 0; k + 4 < w.s.length; k += 4) {
      const seg: Seg = [w.s[k], w.s[k + 1], w.s[k + 4], w.s[k + 5], w.w / 2 + 1.5, w.y, w.a, w.b];
      for (let gx = Math.floor(Math.min(seg[0], seg[2]) / CELL) - 1; gx <= Math.floor(Math.max(seg[0], seg[2]) / CELL) + 1; gx++)
        for (let gy = Math.floor(Math.min(seg[1], seg[3]) / CELL) - 1; gy <= Math.floor(Math.max(seg[1], seg[3]) / CELL) + 1; gy++)
          grid.set(`${gx},${gy}`, [...(grid.get(`${gx},${gy}`) ?? []), seg]);
    }
  }
  let hidden = 0;
  for (const w of ways)
    for (let k = 0; k < w.s.length; k += 4) {
      const x = w.s[k], y = w.s[k + 1];
      if (!w.s[k + 3]) continue;
      for (const [ax, ay, bx, by, r, layer, ea, eb] of grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? []) {
        if (layer <= w.y || [ea, eb].includes(w.a) || [ea, eb].includes(w.b)) continue; // not the bridge's own approach
        const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < r) { w.s[k + 3] = 0; hidden++; break; }
      }
    }
  return hidden;
}

/** Interior point farthest from the boundary (coarse pole of inaccessibility), as [y, x]. */
function labelPoint(rings: Array<Array<[number, number]>>): [number, number] {
  const ring = rings.reduce((a, b) => (b.length > a.length ? b : a));
  const ys = ring.map((p) => p[0]), xs = ring.map((p) => p[1]);
  const [y0, y1, x0, x1] = [Math.min(...ys), Math.max(...ys), Math.min(...xs), Math.max(...xs)];
  const inside = (x: number, y: number) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const distEdge = (x: number, y: number) => {
    let d = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ay, ax] = ring[j], [by, bx] = ring[i];
      const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2));
      d = Math.min(d, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
    }
    return d;
  };
  let best: [number, number] = [ys[0], xs[0]], bestD = -1;
  const N = 40;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = x0 + ((x1 - x0) * i) / N, y = y0 + ((y1 - y0) * j) / N;
    if (!inside(x, y)) continue;
    const d = distEdge(x, y);
    if (d > bestD) { bestD = d; best = [Math.round(y), Math.round(x)]; }
  }
  return best;
}

function stitch(ways: Array<Array<[number, number]>>) {
  const eq = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  const left = ways.map((w) => [...w]);
  const rings: Array<Array<[number, number]>> = [];
  while (left.length) {
    const ring = left.shift()!;
    let grown = true;
    while (!eq(ring[0], ring[ring.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const w = left[i], end = ring[ring.length - 1];
        if (eq(w[0], end)) ring.push(...w.slice(1));
        else if (eq(w[w.length - 1], end)) ring.push(...w.reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Each city's opening view as one small image (and a ~0.5 KB blurred version inlined in the page), so
 * the first frame shows the map at once and the tiles fade in over it. The viewer opens a city
 * centred on `center` with `widthM` across the screen; the image covers that width and a fixed
 * height: H = 0.8 W for landscape screens (aspect ≥ 5:4), 2.2 W for portrait. The page lays it out with CSS
 * only (full width, centred vertically), so it lines up with the map before any script runs.
 */
const PREVIEWS = { land: { aspect: 0.8, width: 768 }, port: { aspect: 2.2, width: 480 } };
async function exportPreviews() {
  const out: Record<string, Record<string, { file: string; lqip: string }>> = {};
  for (const [slug, city] of Object.entries(CITIES)) {
    if (city.region !== activeRegion()) continue;
    const [cx, cy] = llhToPixel(city.center[0], city.center[1], 25); // as the viewer's show()
    const W = city.widthM / CAMERA.mpp;
    out[slug] = {};
    for (const [kind, { aspect, width }] of Object.entries(PREVIEWS)) {
      const H = W * aspect, height = Math.round(width * aspect);
      // the finest zoom that still has at least `width` pixels across the view
      const z = Math.min(NATIVE_Z, NATIVE_Z - Math.floor(Math.log2(W / width)));
      const f = 2 ** (z - NATIVE_Z), span = TS / f;
      const x0 = cx - W / 2, y0 = cy - H / 2;
      const composite = [];
      for (let ty = Math.floor(y0 / span); ty <= Math.floor((y0 + H) / span); ty++)
        for (let tx = Math.floor(x0 / span); tx <= Math.floor((x0 + W) / span); tx++) {
          if (!index.map?.[z]?.[key(tx, ty)] && !state.layers.map?.hashes[`${z}/${tx}_${ty}`]) continue;
          composite.push({ input: await readTile("map", z, tx, ty), left: Math.round((tx * span - x0) * f), top: Math.round((ty * span - y0) * f) });
        }
      const cw = Math.round(W * f), ch = Math.round(H * f);
      const inside = composite.filter((c) => c.left < cw && c.top < ch && c.left > -TS && c.top > -TS);
      // sharp composites need inputs inside the canvas: pad by a tile on every side, then crop
      const canvas = await sharp({ create: { width: cw + 2 * TS, height: ch + 2 * TS, channels: 3, background: { r: BG[0], g: BG[1], b: BG[2] } } })
        .composite(inside.map((c) => ({ ...c, left: c.left + TS, top: c.top + TS }))).png().toBuffer();
      const view = await sharp(canvas).extract({ left: TS, top: TS, width: cw, height: ch }).resize(width, height, { kernel: "lanczos3" }).png().toBuffer();
      const img = await sharp(view).avif({ quality: 45, effort: 6 }).toBuffer();
      const name = `preview/${slug}-${kind}`, h = hash(img), file = `${name}.${h}.${FORMAT}`;
      if (state.data[name] !== h) {
        mkdirSync(join(OUT, "preview"), { recursive: true });
        writeFileSync(join(OUT, file), img);
        state.data[name] = h;
      }
      const tiny = await sharp(view).resize(24, Math.round(24 * aspect)).webp({ quality: 40 }).toBuffer();
      out[slug][kind] = { file, lqip: `data:image/webp;base64,${tiny.toString("base64")}` };
      console.log(`  preview ${slug} ${kind}: ${width}×${height} from z${z}, ${(img.length / 1024).toFixed(0)} KB`);
    }
  }
  return out;
}

let OUT = ""; // data/web/regions/<region>

async function main() {
  const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const areas = names.length ? names : ["tlv-core"];
  const regions = new Set(areas.map((a) => openArea(a).region));
  if (regions.size !== 1) throw new Error(`export one region at a time (got ${[...regions].join(", ")})`);
  OUT = join(WEB_CACHE, "regions", activeRegion());
  const from = [pendingFile(), publishedFile()].find(existsSync);
  if (from) state = readJson(from);
  console.log(`  ${activeRegion()}: ${from ? `changes since ${from === pendingFile() ? "the last (unpublished) export" : "the published state"}` : "no published state: building everything"}`);
  outlines = areas.map((a) => areaPolygon(AREAS[a].bbox));
  // a small area (a test patch) would be mostly fade: keep the transparent band (it hides the tile
  // staircase) and shorten the soft band after it to 15% of the way to the area's centre, 300 px at
  // least. City-sized areas keep the full fade.
  const inradius = Math.max(...outlines.map((o) => insideDistance([o.reduce((t, p) => t + p[0], 0) / o.length, o.reduce((t, p) => t + p[1], 0) / o.length], o)));
  EDGE1 = EDGE0 + Math.min(EDGE1 - EDGE0, Math.max(300, 0.15 * inradius));
  const photo = new Map<Key, string>(), art = new Map<Key, string>();
  const attributions = new Set<string>();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const a of areas) {
    const dir = join(DERIVED, a);
    const m = readJson(join(dir, "manifest.json"));
    (m.attributions as string[]).flatMap((s) => s.split(";")).map((s) => s.trim()).filter(Boolean).forEach((s) => attributions.add(s));
    for (const [layer, map] of [["render", photo], ["paint", art]] as const) {
      if (!existsSync(join(dir, layer))) continue;
      for (const f of readdirSync(join(dir, layer)).filter((f) => f.endsWith(".png"))) {
        const [tx, ty] = parse(f.replace(".png", ""));
        map.set(key(tx, ty), join(dir, layer, f));
        x0 = Math.min(x0, tx * CAMERA.tile); y0 = Math.min(y0, ty * CAMERA.tile);
        x1 = Math.max(x1, (tx + 1) * CAMERA.tile); y1 = Math.max(y1, (ty + 1) * CAMERA.tile);
      }
    }
  }
  const heights = new Heights(areas.map((a) => join(DERIVED, a, "height")));
  await exportRoads(areas, heights); // first: the bridge decks are drawn into the painted tiles
  if (!process.argv.includes("--data-only")) {
    await exportLayer("map", new Map([...photo, ...art])); // painted wins
    await exportLayer("photo", photo);
    for (const layer of Object.keys(index)) writeData(`tiles-${layer}`, JSON.stringify(index[layer]));
  }
  await exportBorders(heights);
  const previews = await exportPreviews();
  // OpenSeadragon wants non-negative tile indices at every level: origin aligned to a min-zoom tile
  const block = TS * 2 ** (NATIVE_Z - MIN_Z);
  const ox = Math.floor(x0 / block) * block, oy = Math.floor(y0 / block) * block;
  const { right: r, up: u } = axes();
  const m = CAMERA.mpp;
  const world = JSON.stringify({
    tile_size: TS, native_zoom: NATIVE_Z, min_zoom: MIN_Z, bounds: [[y0, x0], [y1, x1]],
    origin: [ox, oy], size: [Math.ceil((x1 - ox) / block) * block, Math.ceil((y1 - oy) / block) * block],
    // ENU meters -> art pixels (linear; ENU origin = pixel origin)
    enu2px: [[r[0] / m, r[1] / m, r[2] / m], [-u[0] / m, -u[1] / m, -u[2] / m]],
    camera: camera(), title: REGIONS[activeRegion()].title, credits: REGIONS[activeRegion()].credits,
    airport: REGIONS[activeRegion()].airport ?? null, areas: areas.map((a) => ({ id: a, title: AREAS[a]?.title })),
    layers: { photo: photo.size, art: art.size }, attributions: [...attributions],
    format: FORMAT,
    files: { "tiles-map": dataFile("tiles-map"), "tiles-photo": dataFile("tiles-photo"), borders: dataFile("borders"), roads: dataFile("roads"), trams: dataFile("trams") },
    previews,
  }, null, 2);
  if (state.data["world.json"] !== hash(world)) {
    mkdirSync(join(OUT, "data"), { recursive: true });
    writeFileSync(join(OUT, "data", "world.json"), world);
    state.data["world.json"] = hash(world);
  }
  console.log(`  world.json: ${photo.size} rendered, ${art.size} painted tiles`);
  mkdirSync(WEB_CACHE, { recursive: true });
  writeFileSync(pendingFile(), JSON.stringify(state));
  const files = existsSync(OUT) ? readdirSync(OUT, { recursive: true }).filter((f) => String(f).match(/\.(avif|webp|json)$/)).length : 0;
  console.log(files ? `  ${files} files ready in ${OUT}\n  preview: npm run dev · publish: npm run publish -- ${activeRegion()}` : "  nothing changed");
}

main();
