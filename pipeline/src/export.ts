/**
 * Export rendered/painted areas to the web viewer.
 *
 *   npm run export -- tlv-core [more areas…] [--data-only]
 *   npm run export -- rothschild tlv-core --parts   # only the tiles around the buildings `scene --parts` swapped
 *   npm run export -- zagreb                        # a region: the areas it is published with (world.json)
 *   npm run export -- zagreb --partial              # from the renders/paintings on this machine only (a patch
 *                                                   # pulled from the archive, archive.ts); every other tile stays
 *                                                   # as published
 *
 * All areas must belong to one region. Only files that differ from what is published (R2) are
 * written, into the local cache data/web/regions/<region>/ (served by `npm run dev` over production;
 * `npm run publish -- <region>` uploads and empties it):
 *   tiles/map/{z}/{x}/{y}.avif         painted tiles where available, 3D render elsewhere
 *   tiles/photo/{z}/{x}/{y}.avif       3D render only (toggle)
 *   tiles/fg/{z}/{x}/{y}.avif          what stands higher than a car, transparent elsewhere (life.foreground)
 *   tiles/mine-<level>/{z}/{x}/{y}.avif a salt mine's level (areas.ts `mine`, mine.ts), transparent outside the mine;
 *                                      data/mine.<hash>.json lists the levels, their facts, labels and tile indexes
 *   data/world.json                    camera, bounds, tile origin, ENU→pixel map, attributions, and
 *                                      the names of the files below (the only mutable file)
 *   data/tiles-<layer>.<hash>.json     every tile of a layer per zoom with its content hash (URL ?v=)
 *   data/borders.<hash>.json           OSM city borders in art-pixel space, on real terrain
 *   data/roads.<hash>.json             drivable roads for traffic (columnar, delta-coded: encodeRoads)
 *   data/trains.<hash>.json            rail lines and their tracks for the trains (exportTrains)
 *   data/airport.<hash>.json           the airport's taxi network and stands (airport.ts)
 *   preview/<city>-<land|port>.<hash>.avif  the city's opening view, shown until the tiles are in
 * Content-hashed names never change, so browsers keep them for a year; world.json says which are current.
 * Tel Aviv's legacy data/tiles.json + .webp tiles stay on R2 untouched: the viewer's fallback without AVIF.
 * Other regions have no WebP pyramid and need none.
 * What is published (tile sources + hashes) is tracked in data/web-state/<region>.json, and on R2 as
 * regions/<region>/state.json (webstate.ts: downloaded when this machine has none); an export not yet
 * published keeps its state next to the cache (data/web/<region>.state.json) so exports stack.
 *
 * Tile (x, y) at zoom z covers global art pixels [x·512·2^(8-z), …); z = 8 is 1:1.
 */
import { isCarFree, isOneway, isPedestrianised, roadLanes, roadWidth } from "./roadspec.ts";
import { styleOf } from "./styles.ts";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import sharp from "sharp";
import { AREAS, groundH, areaPolygon, insideDistance, openArea } from "./areas.ts";
import { outlineEdgeDistance, outlinePixels } from "./outline.ts";
import { CAMERA, activeRegion, axes, camera, ecefToEnu, enuHeight, enuToPixel, llhToEcef, llhToPixel } from "./camera.ts";
import { HOSTING } from "./hosting.ts";
import { DERIVED, RAW, WEB_CACHE, WEB_STATE, readJson } from "./paths.ts";
import { CITIES, REGIONS } from "./places.ts";
import { readHeights } from "./heights.ts";
import { FILTERS, localOsm } from "./osmlocal.ts";
import { airportNetwork } from "./airport.ts";
import { deckHeight, isBridge } from "./bridges.ts";
import { fetchPublishedState, stateHash } from "./webstate.ts";

const TS = 512;                  // web tile size
const SPLIT = CAMERA.tile / TS;  // web tiles per art tile edge
const NATIVE_Z = 8;
const MIN_Z = 2;
/** AVIF q50 ≈ the old WebP q72 in PSNR at ~40% fewer bytes (measured on painted tiles). */
const FORMAT = "avif", QUALITY = 50;
/** version of the zoomed-out tile build, part of its stamp ("raw": composited from raw pixels, no lossy pass in between) */
const PYRAMID = "raw";
const MARGIN = 16; // neighbour pixels used when building each zoomed-out tile
/** Soft map edge: tiles fade out toward the areas' true outline instead of ending in tile steps.
 *  Fully transparent within EDGE0 of the outline (half a render tile's diagonal: the staircase
 *  never shows), fully opaque from EDGE1 in. */
let EDGE0 = 760, EDGE1 = EDGE0 + 1800;
let outlines: Array<Array<[number, number]>> = [];
/** the region's own shape (outline.ts), if it has one: the edge follows it inside the areas */
let shape: Array<Array<[number, number]>> | null = null;
/** web/src/pages/index.astro #map background (#0e0f12): the edge fades into it */
const BG = [14, 15, 18];
/** the outer edge of the union of the areas: each area's sides minus the stretches inside another area (seams) */
let unionEdges: Array<[[number, number], [number, number]]> = [];
function buildUnionEdges() {
  unionEdges = [];
  const STEP = 512;
  outlines.forEach((poly, i) => {
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / STEP));
      const at = (t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      let start = -1;
      for (let j = 0; j <= n; j++) {
        const mid = at((j + 0.5) / n);
        const open = j < n && !outlines.some((o, m) => m !== i && insideDistance(mid, o) > 1);
        if (open && start < 0) start = j;
        if (!open && start >= 0) { unionEdges.push([at(start / n), at(j / n)]); start = -1; }
      }
    }
  });
}
const segDist = ([x, y]: [number, number], [ax, ay]: [number, number], [bx, by]: [number, number]) => {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};
const edgeDistance = (x: number, y: number) => {
  if (!outlines.some((o) => insideDistance([x, y], o) > 0)) return 0;
  let d = Infinity;
  for (const [a, b] of unionEdges) d = Math.min(d, segDist([x, y], a, b));
  // every caller clamps at EDGE1: the outline search can stop there
  return shape ? Math.min(d, outlineEdgeDistance([x, y], EDGE1)) : d;
};

/** Native web tile at global art px (x0, y0): edge distance on an 8 px lattice, clamped to the fade band
 *  (so its hash is the tile's whole fade), or null when the tile is fully inside. */
function edgeGrid(x0: number, y0: number): Float32Array | null {
  const corners = [[x0, y0], [x0 + TS, y0], [x0, y0 + TS], [x0 + TS, y0 + TS]];
  if (Math.min(...corners.map(([x, y]) => edgeDistance(x, y))) >= EDGE1) return null;
  const n = TS / GRID + 1, grid = new Float32Array(n * n);
  let inside = true;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const d = Math.min(EDGE1, Math.max(EDGE0, edgeDistance(x0 + i * GRID, y0 + j * GRID)));
    grid[j * n + i] = Math.round(d * 10) / 10;
    if (d < EDGE1) inside = false;
  }
  return inside ? null : grid;
}
const GRID = 8;
/** fade alpha from an edge grid, bilinear between lattice points */
function edgeAlpha(grid: Float32Array): Buffer {
  const a = Buffer.alloc(TS * TS), n = TS / GRID + 1;
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const gx = x / GRID, gy = y / GRID, i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
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
interface State {
  /** per layer: the stamp ("z/x_y") and content hash of every tile */
  layers: Record<string, { sources: Record<string, string>; hashes: Record<string, string> }>;
  data: Record<string, string>;
  /** source PNG path -> "mtime:size@content hash" */
  src?: Record<string, string>;
  /** stateHash of the published state this export started from (none: from scratch); publish refuses
   *  when R2's state has moved on since (someone else published) */
  base?: string;
}
let state: State = { layers: {}, data: {} };
/** what is on R2 now: a tile encoded to the same bytes stays out of the cache, so publish uploads only real changes */
let published: State | null = null;
/** --parts: art-pixel boxes (data/derived/<area>/osm-parts.json); native tiles outside them keep what is published */
let SCOPE: number[][] | null = null;
/** a repainted window reaches this far past a box (paint --parts repaints every window touching it) */
const SCOPE_MARGIN = 1024 + 16;
/** --partial: tiles whose source is not on this machine keep their published pixels (sources map to REMOTE) */
const PARTIAL = process.argv.includes("--partial");
const REMOTE = "<published>";
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

/**
 * One layer's pyramid, idempotent and resumable: every tile has a stamp of everything its pixels depend on
 * (native: the source PNG's content hash, its edge fade, deck style, format; zoomed out: the hashes of the
 * child tiles it is built from) and is encoded only when the stamp changed. Finished tiles go into the
 * state as they are written, and the state is checkpointed, so a stopped export picks up where it was.
 */
async function exportLayer(layer: string, sources: Map<Key, string>) {
  index[layer] = {};
  const root = join(OUT, "tiles", layer);
  const st = (state.layers[layer] ??= { sources: {}, hashes: {} });
  const produced = new Set<string>(); // "z/x_y" of every tile of this export
  const save = async (img: ReturnType<typeof sharp>, z: number, x: number, y: number, stamp: string) => {
    const buf = await img.avif({ quality: QUALITY, effort: 4 }).toBuffer();
    const id = `${z}/${x}_${y}`, file = join(root, `${z}`, `${x}`, `${y}.${FORMAT}`);
    st.hashes[id] = hash(buf);
    st.sources[id] = stamp;
    if (published?.layers[layer]?.hashes[id] === st.hashes[id]) { // same pixels as on R2: nothing to upload
      rmSync(file, { force: true });
      checkpoint();
      return;
    }
    mkdirSync(join(root, `${z}`, `${x}`), { recursive: true });
    writeFileSync(file, buf);
    changed.add(id);
    checkpoint();
  };
  const fresh = (id: string, stamp: string) => !!st.hashes[id] && st.sources[id] === stamp;
  // State from before content-hash stamps (Tel Aviv, published with mtime stamps keyed "x_y" and no stamps on
  // zoomed-out tiles): a tile whose old stamp still matches keeps its published pixels and only gets the new
  // stamp, so the first export after the change re-encodes and re-uploads only what really changed.
  const legacy = Object.keys(st.sources).some((k) => !k.includes("/"));
  const changed = new Set<string>(); // ids encoded or cloned in this export
  const legacyNative = (id: string, k: Key, file: string, painted: boolean) => {
    const old = st.sources[k];
    if (!legacy || !old || !st.hashes[id] || !existsSync(file)) return false;
    // the old stamp: <absolute source path>@<mtime>@edge…d[@deck style]@<format><quality>; the path is
    // compared below data/derived/, so a moved checkout still matches
    const rest = `@${statSync(file).mtimeMs}@edge${EDGE0}-${EDGE1}d${painted ? `@${DECK_STYLE}` : ""}@${FORMAT}${QUALITY}`;
    return old.endsWith(`/data/derived/${relative(DERIVED, file)}${rest}`);
  };
  const legacyParent = (id: string, near: Array<[number, number]>, z: number) =>
    legacy && !!st.hashes[id] && !st.sources[id] && !near.some(([x, y]) => changed.has(`${z + 1}/${x}_${y}`));
  // decoded tiles (raw RGB) for building the next level up: each child feeds up to 9 parents, kept LRU
  const cache = new Map<string, Promise<Buffer>>();
  const decoded = (z: number, x: number, y: number) => {
    const k = `${z}/${x}_${y}`;
    let b = cache.get(k);
    if (b) cache.delete(k);
    else b = readTile(layer, z, x, y).then((f) => sharp(f).removeAlpha().raw().toBuffer());
    cache.set(k, b);
    if (cache.size > 600) cache.delete(cache.keys().next().value!); // ~470 MB
    return b;
  };
  // a tile the map layer already encoded from the same inputs (unpainted tiles: photo = map) is cloned, not
  // re-encoded (APFS clone: no extra space, and a later rewrite of either file leaves the other alone)
  const twin = layer === "map" ? null : state.layers.map;
  const reuse = (id: string, z: number, x: number, y: number, stamp: string) => {
    if (!twin || twin.sources[id] !== stamp || !twin.hashes[id]) return false;
    if (published?.layers[layer]?.hashes[id] === twin.hashes[id]) { // already on R2
      st.hashes[id] = twin.hashes[id];
      st.sources[id] = stamp;
      checkpoint();
      return true;
    }
    const from = join(OUT, "tiles", "map", `${z}`, `${x}`, `${y}.${FORMAT}`);
    if (!existsSync(from)) return false;
    mkdirSync(join(root, `${z}`, `${x}`), { recursive: true });
    copyFileSync(from, join(root, `${z}`, `${x}`, `${y}.${FORMAT}`), constants.COPYFILE_FICLONE);
    st.hashes[id] = twin.hashes[id];
    st.sources[id] = stamp;
    changed.add(id);
    checkpoint();
    return true;
  };
  // native zoom: split each 1024 art tile into 512 web tiles
  let level = new Set<Key>();
  let jobs: Array<() => Promise<void>> = [];
  for (const [k, file] of sources) {
    const [tx, ty] = parse(k);
    if (file === REMOTE) { // --partial: not on this machine, stays as published
      for (let j = 0; j < SPLIT; j++)
        for (let i = 0; i < SPLIT; i++) {
          const x = tx * SPLIT + i, y = ty * SPLIT + j, id = `${NATIVE_Z}/${x}_${y}`;
          if (!st.hashes[id]) throw new Error(`--partial: ${layer} ${id} is in no published state`);
          level.add(key(x, y));
          produced.add(id);
        }
      continue;
    }
    // a cutout tile laid on a painted tile (cutout.ts) is painted too: it gets the bridge decks
    const painted = layer === "map" && (file.includes("/paint/") || (file.includes("/cutout/") && existsSync(file.replace("/cutout/", "/paint/"))));
    const src = sourceHash(file);
    for (let j = 0; j < SPLIT; j++)
      for (let i = 0; i < SPLIT; i++) {
        const x = tx * SPLIT + i, y = ty * SPLIT + j, id = `${NATIVE_Z}/${x}_${y}`;
        const grid = edgeGrid(x * TS, y * TS);
        const stamp = `${src}@${grid ? `e${hash(Buffer.from(grid.buffer))}` : "in"}@edge${EDGE0}-${EDGE1}${painted ? `@${DECK_STYLE}` : ""}@${FORMAT}${QUALITY}`;
        level.add(key(x, y));
        produced.add(id);
        if (SCOPE && st.hashes[id] && !SCOPE.some(([a, b, c, d]) => x * TS < c + SCOPE_MARGIN && (x + 1) * TS > a - SCOPE_MARGIN && y * TS < d + SCOPE_MARGIN && (y + 1) * TS > b - SCOPE_MARGIN)) continue;
        if (fresh(id, stamp)) continue;
        if (legacyNative(id, key(x, y), file, painted)) { st.sources[id] = stamp; continue; }
        if (reuse(id, NATIVE_Z, x, y, stamp)) continue;
        jobs.push(async () => {
          let img = sharp(file).extract({ left: i * TS, top: j * TS, width: TS, height: TS });
          const svg = painted ? deckSvg(x * TS, y * TS) : null;
          if (svg) img = sharp(await img.png().toBuffer()).composite([{ input: svg }]);
          const rgb = await img.removeAlpha().raw().toBuffer();
          // fade baked toward the page background: opaque tiles, so no seams where tiles meet
          if (grid) {
            const alpha = edgeAlpha(grid);
            for (let p = 0; p < TS * TS; p++) for (let c = 0; c < 3; c++)
              rgb[p * 3 + c] = Math.round(BG[c] + (rgb[p * 3 + c] - BG[c]) * (alpha[p] / 255));
          }
          await save(sharp(rgb, { raw: { width: TS, height: TS, channels: 3 } }), NATIVE_Z, x, y, stamp);
        });
      }
  }
  console.log(`  ${layer} z${NATIVE_Z}: ${level.size} tiles, ${jobs.length} to encode${legacy ? " (old stamps converted)" : ""}`);
  await pool(jobs);
  const keep = (z: number, keys: Iterable<Key>) => Object.fromEntries([...keys].map((k) => [k, st.hashes[`${z}/${k}`]]));
  index[layer][NATIVE_Z] = keep(NATIVE_Z, level);
  let built = 0;
  for (let z = NATIVE_Z - 1; z >= MIN_Z; z--) {
    const parents = new Set<Key>();
    for (const k of level) { const [x, y] = parse(k); parents.add(key(Math.floor(x / 2), Math.floor(y / 2))); }
    const rows = [...parents].map(parse).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    jobs = [];
    for (const [px, py] of rows) {
      const p = key(px, py), id = `${z}/${p}`;
      // the 2×2 children plus their neighbours (the MARGIN strip): their hashes are this tile's stamp
      const near: Array<[number, number]> = [];
      for (let y = py * 2 - 1; y <= py * 2 + 2; y++) for (let x = px * 2 - 1; x <= px * 2 + 2; x++) if (level.has(key(x, y))) near.push([x, y]);
      const stamp = hash(`${PYRAMID}:` + near.map(([x, y]) => `${x}_${y}:${st.hashes[`${z + 1}/${x}_${y}`]}`).join(","));
      produced.add(id);
      if (fresh(id, stamp)) continue;
      if (legacyParent(id, near, z)) { st.sources[id] = stamp; continue; }
      if (reuse(id, z, px, py, stamp)) continue;
      jobs.push(async () => {
        // the downscale filter sees across tile edges (otherwise faint lines appear along tile borders at low zoom):
        // the 2×2 children plus a MARGIN strip of their neighbours, copied as raw pixels (no intermediate encode)
        const S = TS * 2 + 2 * MARGIN, merged = Buffer.alloc(S * S * 3, Buffer.from(BG));
        for (const [x, y] of near) {
          const left = (x - px * 2) * TS + MARGIN, top = (y - py * 2) * TS + MARGIN;
          const cl = Math.max(0, -left), ct = Math.max(0, -top);
          const width = Math.min(TS - cl, S - Math.max(0, left)), height = Math.min(TS - ct, S - Math.max(0, top));
          if (width <= 0 || height <= 0) continue;
          const child = await decoded(z + 1, x, y);
          for (let r = 0; r < height; r++)
            child.copy(merged, ((Math.max(0, top) + r) * S + Math.max(0, left)) * 3, ((ct + r) * TS + cl) * 3, ((ct + r) * TS + cl + width) * 3);
        }
        const half = await sharp(merged, { raw: { width: S, height: S, channels: 3 } }).resize(S / 2, S / 2, { kernel: "lanczos3" }).raw().toBuffer();
        await save(sharp(half, { raw: { width: S / 2, height: S / 2, channels: 3 } }).extract({ left: MARGIN / 2, top: MARGIN / 2, width: TS, height: TS }), z, px, py, stamp);
      });
    }
    built += jobs.length;
    await pool(jobs);
    level = parents;
    index[layer][z] = keep(z, level);
  }
  console.log(`  ${layer} z${MIN_Z}–${NATIVE_Z - 1}: ${built} encoded`);
  // tiles no longer produced drop out (they stay in R2, unreferenced)
  for (const id of Object.keys(st.hashes)) if (!produced.has(id)) delete st.hashes[id];
  for (const id of Object.keys(st.sources)) if (!produced.has(id)) delete st.sources[id];
  checkpoint(true);
}

/**
 * The foreground layer (places.ts life.foreground; web foreground.ts): the render's pixels where its fg mask says
 * the surface stands higher than a car, transparent elsewhere (faded at the map's edge like the map), at the native
 * zoom and down to FG_MIN_Z (vehicles show from ~1/7 scale). Tiles with nothing tall are left out of the index.
 * Stamps as in exportLayer: native and the next level from the render, its mask and its edge fade; further out from
 * the stamps of the render tiles they cover. Every level is built from the render tiles directly.
 */
const FG_MIN_Z = 5;
async function exportForeground(renders: Map<Key, string>, layer = "fg", minZ = FG_MIN_Z) {
  const root = join(OUT, "tiles", layer), st = (state.layers[layer] ??= { sources: {}, hashes: {} }), produced = new Set<string>();
  index[layer] = {};
  const maskOf = (file: string) => file.replace(/\/render\/([^/]+)$/, "/fg/$1");
  const srcs = [...renders].filter(([, f]) => f !== REMOTE && existsSync(maskOf(f)));
  // --partial: render tiles not on this machine keep their published fg tiles; a level out that mixes them with
  // local ones is rebuilt from their published z(NATIVE_Z - 1) tile
  const remote = new Set([...renders].filter(([, f]) => f === REMOTE).map(([k]) => k));
  const A = CAMERA.tile, stampOf = new Map<Key, string>();
  for (const [k, f] of srcs) {
    const [tx, ty] = parse(k), grids: string[] = [];
    for (let j = 0; j < SPLIT; j++) for (let i = 0; i < SPLIT; i++) {
      const g = edgeGrid((tx * SPLIT + i) * TS, (ty * SPLIT + j) * TS);
      grids.push(g ? hash(Buffer.from(g.buffer)) : "in");
    }
    stampOf.set(k, hash(`fg1:${sourceHash(f)}:${sourceHash(maskOf(f))}:${grids.join(",")}@${FORMAT}${QUALITY}`));
  }
  const pubHash = (z: number, x: number, y: number) => st.hashes[`${z}/${x}_${y}`];
  // a render tile as RGBA, its alpha the mask faded at the map's edge (a few kept: the levels out reuse them)
  const cache = new Map<Key, Promise<Buffer>>();
  const source = (k: Key) => {
    let b = cache.get(k);
    if (b) { cache.delete(k); cache.set(k, b); return b; }
    b = (async () => {
      const f = renders.get(k)!, [tx, ty] = parse(k);
      if (f === REMOTE) { // its published tile one level out, back at the render's size (only shrunk further from here)
        if (!pubHash(NATIVE_Z - 1, tx, ty)) return Buffer.alloc(A * A * 4); // nothing tall there
        return sharp(await readTile(layer, NATIVE_Z - 1, tx, ty)).ensureAlpha().resize(A, A, { kernel: "lanczos3" }).raw().toBuffer();
      }
      const rgb = await sharp(f).removeAlpha().raw().toBuffer(), mask = await sharp(maskOf(f)).extractChannel(0).raw().toBuffer();
      const out = Buffer.alloc(A * A * 4);
      for (let p = 0; p < A * A; p++) { out[p * 4] = rgb[p * 3]; out[p * 4 + 1] = rgb[p * 3 + 1]; out[p * 4 + 2] = rgb[p * 3 + 2]; out[p * 4 + 3] = mask[p]; }
      for (let j = 0; j < SPLIT; j++) for (let i = 0; i < SPLIT; i++) {
        const g = edgeGrid((tx * SPLIT + i) * TS, (ty * SPLIT + j) * TS);
        if (!g) continue;
        const a = edgeAlpha(g);
        for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) { const q = ((j * TS + y) * A + i * TS + x) * 4 + 3; out[q] = Math.round((out[q] * a[y * TS + x]) / 255); }
      }
      return out;
    })();
    cache.set(k, b);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
    return b;
  };
  const empty = (b: Buffer) => { for (let p = 3; p < b.length; p += 4) if (b[p] > 4) return false; return true; };
  let encoded = 0;
  const put = async (z: number, x: number, y: number, stamp: string, make: () => Promise<Buffer>) => {
    const id = `${z}/${x}_${y}`, at = () => ((index[layer][z] ??= {})[key(x, y)] = st.hashes[id]);
    produced.add(id);
    if (st.sources[id] === stamp) { if (st.hashes[id]) at(); return; } // fresh (an empty tile has no hash)
    const rgba = await make();
    st.sources[id] = stamp;
    if (empty(rgba)) { delete st.hashes[id]; checkpoint(); return; }
    const buf = await sharp(rgba, { raw: { width: TS, height: TS, channels: 4 } }).avif({ quality: QUALITY, effort: 4 }).toBuffer();
    mkdirSync(join(root, `${z}`, `${x}`), { recursive: true });
    writeFileSync(join(root, `${z}`, `${x}`, `${y}.${FORMAT}`), buf);
    st.hashes[id] = hash(buf);
    at();
    encoded++;
    checkpoint();
  };
  const raw = (b: Buffer, size: number) => sharp(b, { raw: { width: size, height: size, channels: 4 } });
  const jobs: Array<() => Promise<void>> = [];
  /** a published tile kept as it is (--partial) */
  const keepPublished = (z: number, x: number, y: number) => {
    const id = `${z}/${x}_${y}`;
    if (!(id in st.sources)) return;
    produced.add(id);
    if (st.hashes[id]) (index[layer][z] ??= {})[key(x, y)] = st.hashes[id];
  };
  for (const k of remote) {
    const [tx, ty] = parse(k);
    for (let j = 0; j < SPLIT; j++) for (let i = 0; i < SPLIT; i++) keepPublished(NATIVE_Z, tx * SPLIT + i, ty * SPLIT + j);
    keepPublished(NATIVE_Z - 1, tx, ty);
  }
  // native zoom: each render tile split in four; one level out: the render tile halved
  for (const [k] of srcs) {
    const [tx, ty] = parse(k), stamp = stampOf.get(k)!;
    for (let j = 0; j < SPLIT; j++) for (let i = 0; i < SPLIT; i++)
      jobs.push(() => put(NATIVE_Z, tx * SPLIT + i, ty * SPLIT + j, `${stamp}:${i}${j}`,
        async () => raw(await source(k), A).extract({ left: i * TS, top: j * TS, width: TS, height: TS }).raw().toBuffer()));
    jobs.push(() => put(NATIVE_Z - 1, tx, ty, stamp, async () => raw(await source(k), A).resize(TS, TS, { kernel: "lanczos3" }).raw().toBuffer()));
  }
  // further out: n × n render tiles shrunk into one
  for (let z = NATIVE_Z - 2; z >= minZ; z--) {
    const n = 2 ** (NATIVE_Z - 1 - z), parents = new Map<Key, Key[]>();
    const remoteKids = [...remote].filter((k) => { const [tx, ty] = parse(k); return `${NATIVE_Z - 1}/${tx}_${ty}` in st.sources; });
    for (const k of [...srcs.map(([k]) => k), ...remoteKids]) { const [tx, ty] = parse(k), p = key(Math.floor(tx / n), Math.floor(ty / n)); (parents.get(p) ?? parents.set(p, []).get(p)!).push(k); }
    for (const [p, kids] of parents) {
      const [px, py] = parse(p);
      if (kids.every((k) => remote.has(k))) { keepPublished(z, px, py); continue; }
      const stamp = hash(kids.map((k) => { const [tx, ty] = parse(k); return `${k}:${remote.has(k) ? `pub:${pubHash(NATIVE_Z - 1, tx, ty) ?? "-"}` : stampOf.get(k)}`; }).sort().join(","));
      jobs.push(() => put(z, px, py, stamp, async () => {
        // far out (a mine's levels go to z3): each render tile shrunk first, the n × n canvas would be too big
        const C = n > 4 ? TS / n : A, S = C * n, big = Buffer.alloc(S * S * 4);
        for (const k of kids) {
          const [tx, ty] = parse(k), ox = (tx - px * n) * C, oy = (ty - py * n) * C;
          const b = C === A ? await source(k) : await raw(await source(k), A).resize(C, C, { kernel: "lanczos3" }).raw().toBuffer();
          for (let y = 0; y < C; y++) b.copy(big, ((oy + y) * S + ox) * 4, y * C * 4, (y + 1) * C * 4);
        }
        return S === TS ? big : raw(big, S).resize(TS, TS, { kernel: "lanczos3" }).raw().toBuffer();
      }));
    }
  }
  await pool(jobs);
  for (const id of Object.keys(st.sources)) if (!produced.has(id)) { delete st.sources[id]; delete st.hashes[id]; }
  const count = Object.values(index[layer]).reduce((a, m) => a + Object.keys(m).length, 0);
  console.log(`  ${layer} z${minZ}–${NATIVE_Z}: ${count} tiles${layer === "fg" ? " with something tall" : ""}, ${encoded} encoded`);
  checkpoint(true);
}

/** What a place is, in a word or two, for the search's list (OSM tags). */
function placeKind(t: Record<string, string>) {
  const words: Record<string, string> = {
    suburb: "district", neighbourhood: "neighbourhood", quarter: "quarter", isolated_dwelling: "hamlet", place_of_worship: "church",
    townhall: "town hall", arts_centre: "arts centre", community_centre: "community centre", fire_station: "fire station",
    post_office: "post office", bus_station: "bus station", swimming_pool: "swimming pool", attraction: "sight", sports_centre: "sports centre",
    water_park: "water park", nature_reserve: "nature reserve", mineshaft: "mine shaft", water_tower: "water tower", water: "pond",
  };
  const v = t.place ?? t.amenity ?? t.tourism ?? t.historic ?? t.leisure ?? (t.railway ? "station" : undefined) ?? t.man_made ?? t.natural ?? (t.landuse === "cemetery" ? "cemetery" : undefined) ?? t.building ?? "place";
  return words[v] ?? v.replace(/_/g, " ");
}

/**
 * The viewer's search index (places.ts effects.search; web search.ts): every named street (from the areas' roads,
 * at the point of its line nearest the middle of all its parts) and the named places of the region's OSM extract
 * (FILTERS.search: settlements, sights, public buildings, parks, stations…), on the real ground, inside the map.
 * data/search: [name, kind (0 street, 1 settlement or district, 2 place), x, y (global art px), what it is].
 */
async function exportSearch(areas: string[], heights: Heights, [bx0, by0, bx1, by1]: number[]) {
  const items: Array<[string, number, number, number, string]> = [];
  const inside = (x: number, y: number) => x > bx0 && x < bx1 && y > by0 && y < by1;
  const streets = new Map<string, Array<[number, number]>>();
  for (const a of areas) {
    const f = join(RAW, a, "roads.json");
    if (!existsSync(f)) continue;
    for (const el of readJson(f).elements ?? []) {
      const n = el.tags?.name;
      if (!n || !el.geometry?.length) continue;
      const pts = streets.get(n) ?? streets.set(n, []).get(n)!;
      for (const g of el.geometry) pts.push([g.lat, g.lon]);
    }
  }
  for (const [name, pts] of streets) {
    const c = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const p = pts.reduce((b, q) => (Math.hypot(q[0] - c[0], q[1] - c[1]) < Math.hypot(b[0] - c[0], b[1] - c[1]) ? q : b));
    const { x, y } = await onGround(heights, p[0], p[1]);
    if (inside(x, y)) items.push([name, 0, Math.round(x), Math.round(y), "street"]);
  }
  const extract = REGIONS[activeRegion()].osmExtract;
  if (extract) {
    const boxes = areas.map((a) => AREAS[a].bbox);
    const bbox = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
    // cached for the areas' joint bbox: an export over more areas reads the extract again
    const cache = join(RAW, `search-${activeRegion()}.json`), key = bbox.join(",");
    let places = existsSync(cache) ? readJson(cache) : null;
    if (places?.bbox !== key) writeFileSync(cache, JSON.stringify(places = { bbox: key, ...(await localOsm(extract, bbox, FILTERS.search)) }));
    const seen = new Set<string>();
    for (const el of places.elements as Array<{ type: string; lat?: number; lon?: number; tags: Record<string, string>; geometry?: Array<{ lat: number; lon: number }>; members?: Array<{ geometry?: Array<{ lat: number; lon: number }> }> }>) {
      const g = el.type === "node" ? [{ lat: el.lat!, lon: el.lon! }] : el.geometry ?? (el.members ?? []).flatMap((m) => m.geometry ?? []);
      if (!g.length) continue;
      const lat = g.reduce((s, q) => s + q.lat, 0) / g.length, lon = g.reduce((s, q) => s + q.lon, 0) / g.length;
      const { x, y } = await onGround(heights, lat, lon), name = el.tags.name, kind = el.tags.place ? 1 : 2;
      const k = `${name}@${Math.round(x / 400)},${Math.round(y / 400)}`; // a node and the area it lies in: once
      if (!inside(x, y) || seen.has(k)) continue;
      seen.add(k);
      items.push([name, kind, Math.round(x), Math.round(y), placeKind(el.tags)]);
    }
  }
  items.sort((a, b) => a[0].localeCompare(b[0], "pl") || a[1] - b[1]);
  writeData("search", JSON.stringify(items));
  console.log(`  search: ${items.filter((i) => i[1] === 0).length} streets, ${items.filter((i) => i[1] > 0).length} places`);
}

/**
 * The renderer's height pass for the web, in regions with a biplane (places.ts effects.fly): fly.ts lays the plane's
 * shadow over roofs, walls and crowns with it. Per render tile its surface heights as rendered (256² px, 4 art px
 * each; R·256 + G centimetres over the region's height base, alpha 0 where there is no surface), as lossless WebP
 * under tiles/height/<tx>/<ty>.webp, and data/tiles-height: each tile's content hash.
 */
async function exportHeights(renders: Map<Key, string>) {
  const layer = "height", st = (state.layers[layer] ??= { sources: {}, hashes: {} }), produced = new Set<string>();
  let encoded = 0;
  await pool([...renders].map(([k, f]) => async () => {
    if (f === REMOTE) { if (st.hashes[k]) produced.add(k); return; } // --partial: stays as published
    const file = f.replace(/\/render\/([^/]+)$/, "/height/$1");
    if (!existsSync(file)) return;
    const stamp = `h1:${sourceHash(file)}`;
    produced.add(k);
    if (st.sources[k] === stamp && st.hashes[k]) return;
    const buf = await sharp(file).webp({ lossless: true, exact: true, effort: 6 }).toBuffer(), [tx, ty] = parse(k);
    mkdirSync(join(OUT, "tiles", layer, `${tx}`), { recursive: true });
    writeFileSync(join(OUT, "tiles", layer, `${tx}`, `${ty}.webp`), buf);
    st.sources[k] = stamp; st.hashes[k] = hash(buf);
    encoded++;
    checkpoint();
  }));
  for (const id of Object.keys(st.sources)) if (!produced.has(id)) { delete st.sources[id]; delete st.hashes[id]; }
  writeData("tiles-height", JSON.stringify(Object.fromEntries([...produced].sort().map((k) => [k, st.hashes[k]]))));
  console.log(`  height: ${produced.size} tiles, ${encoded} encoded`);
  checkpoint(true);
}

/**
 * A salt mine's levels (areas.ts `mine`, src/mine.ts): each its own layer like the foreground (the render, its alpha
 * the mask render.ts drew from the level's extent), and data/mine.json with the levels' facts and labels (web mine.ts).
 */
const MINE_MIN_Z = 3;
async function exportMine(levels: string[]) {
  const out: Array<{ depth: number }> = [];
  for (const a of levels) {
    const dir = join(DERIVED, a), info = readJson(join(dir, "mine.json")), layer = `mine-${AREAS[a].mine}`;
    const renders = new Map<Key, string>();
    for (const f of readdirSync(join(dir, "render")).filter((f) => f.endsWith(".png"))) renders.set(key(...parse(f.replace(".png", ""))), join(dir, "render", f));
    await exportForeground(renders, layer, MINE_MIN_Z);
    writeData(`tiles-${layer}`, JSON.stringify(index[layer]));
    const { extent: _e, ...facts } = info;
    out.push({ ...facts, tiles: dataFile(`tiles-${layer}`), layer });
  }
  const { SOURCES } = await import("./minedata.ts");
  writeData("mine", JSON.stringify({ levels: out.sort((a, b) => a.depth - b.depth), sources: SOURCES, min_zoom: MINE_MIN_Z }));
}

/** Content hash of a source PNG, cached in the state by path, size and mtime (a re-render with the same pixels changes nothing). */
function sourceHash(file: string) {
  const { mtimeMs, size } = statSync(file), id = `${mtimeMs}:${size}`, rel = relative(DERIVED, file);
  const c = (state.src ??= {})[rel];
  if (c?.startsWith(`${id}@`)) return c.slice(id.length + 1);
  const h = hash(readFileSync(file));
  state.src[rel] = `${id}@${h}`;
  return h;
}

/** Write the pending state now and then (atomically), so a stopped export resumes instead of starting over. */
let lastCheckpoint = Date.now();
function checkpoint(force = false) {
  if (!force && Date.now() - lastCheckpoint < 30_000) return;
  lastCheckpoint = Date.now();
  mkdirSync(WEB_CACHE, { recursive: true });
  writeFileSync(`${pendingFile()}.tmp`, JSON.stringify(state));
  renameSync(`${pendingFile()}.tmp`, pendingFile());
}

/** Surface ellipsoid height sampler from the renderer's height pass (256² per 1024² tile). */
class Heights {
  private cache = new Map<string, Float32Array | null>();
  private lx = NaN; private ly = NaN; private lh: Float32Array | null | undefined;
  constructor(private dirs: string[]) {}
  async ensure(x: number, y: number, r = 32) {
    for (let ty = Math.floor((y - r) / CAMERA.tile); ty <= Math.floor((y + r) / CAMERA.tile); ty++)
      for (let tx = Math.floor((x - r) / CAMERA.tile); tx <= Math.floor((x + r) / CAMERA.tile); tx++) {
        const k = `${tx}_${ty}`;
        if (this.cache.has(k)) continue;
        const file = this.dirs.map((d) => join(d, `${k}.png`)).find(existsSync);
        this.cache.set(k, file ? await readHeights(file) : null);
        this.lx = NaN; // at() may have remembered this tile as not loaded
      }
  }
  /** Surface height at an art pixel (call ensure() first). */
  at(x: number, y: number): number | null {
    const T = CAMERA.tile, k = T / 256;
    const tx = Math.floor(x / T), ty = Math.floor(y / T);
    // ground() reads ~170 neighbouring pixels per call, nearly always from the same tile
    if (tx !== this.lx || ty !== this.ly) { this.lx = tx; this.ly = ty; this.lh = this.cache.get(`${tx}_${ty}`); }
    const h = this.lh;
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

/** The airport's taxi network (airport.ts) on the rendered ground. */
async function exportAirport(heights: Heights) {
  const net = await airportNetwork(REGIONS[activeRegion()], async (lat, lon) => (await placePoint(heights, lat, lon, null)).e);
  if (!net) return;
  writeData("airport", JSON.stringify(net));
  console.log(`  airport: ${net.n.length / 3} nodes, ${net.w.length} ways, ${net.s.length} stands`);
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

/**
 * The terrain grids the render drapes roads and tracks on (ground.ts): ENU height at (e, n), or null off
 * the grids. A road's height is the ground under it, not the lowest surface nearby (that is the track bed
 * next to a cutting or below an embankment).
 */
/**
 * Bridge deck end heights (OSM way id -> [start, end]) that ground.ts computed per area (bridges.ts bridgeEnds).
 * Areas overlap and each solves only the roads it fetched, so near its border an area gets a bridge wrong
 * (cut-off joints, terrain off its grid): take each way from the area it lies deepest inside, which is also
 * the area whose render the map shows there (export picks tiles the same way).
 */
function bridgeEndsOf(areas: string[]) {
  const per = areas.map((a) => {
    const f = join(DERIVED, a, "ground", "bridge-ends.json");
    return { bbox: AREAS[a].bbox, ends: existsSync(f) ? (readJson(f) as Record<string, number[]>) : {} };
  });
  const depth = ([s, w, n, e]: number[], g: Array<{ lat: number; lon: number }>) =>
    Math.min(...g.map((p) => Math.min((p.lat - s) * 111e3, (n - p.lat) * 111e3, (p.lon - w) * 73e3, (e - p.lon) * 73e3)));
  return (id: number, g: Array<{ lat: number; lon: number }>) => {
    let best: number[] | undefined, bd = -Infinity;
    for (const a of per) {
      const v = a.ends[id];
      if (!v) continue;
      const d = depth(a.bbox, g);
      if (d > bd) { bd = d; best = v; }
    }
    return best;
  };
}

function terrainSampler(areas: string[]) {
  const grids = areas.map((a) => join(DERIVED, a, "ground")).filter((d) => existsSync(join(d, "meta.json"))).map((d) => {
    const m = readJson(join(d, "meta.json")), b = readFileSync(join(d, "height.bin"));
    return { ...m, h: new Float32Array(b.buffer, b.byteOffset, b.length / 4) } as { x0: number; y0: number; nx: number; ny: number; step: number; h: Float32Array };
  });
  const terrainU = (e: number, n: number) => {
    for (const g of grids) {
      const fx = (e - g.x0) / g.step, fy = (n - g.y0) / g.step;
      if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) continue;
      const ix = Math.min(g.nx - 2, Math.floor(fx)), iy = Math.min(g.ny - 2, Math.floor(fy)), tx = fx - ix, ty = fy - iy, k = iy * g.nx + ix;
      const v = (g.h[k] * (1 - tx) + g.h[k + 1] * tx) * (1 - ty) + (g.h[k + g.nx] * (1 - tx) + g.h[k + g.nx + 1] * tx) * ty;
      if (Number.isFinite(v)) return v;
    }
    return null;
  };
  return terrainU;
}

/**
 * A point at ENU height `u` (null: on the rendered ground) in art px, with its ENU position and whether it
 * is visible (not behind a building or tree in the height pass).
 */
async function placePoint(heights: Heights, lat: number, lon: number, u: number | null) {
  let g: { x: number; y: number; h: number };
  if (u === null) g = await onGround(heights, lat, lon);
  else {
    const h = enuHeight([...latLonEnu(lat, lon), u] as [number, number, number]), [x, y] = llhToPixel(lat, lon, h);
    await heights.ensure(x, y, 4);
    g = { x, y, h };
  }
  const surf = heights.at(g.x, g.y);
  const vis = surf === null || surf <= g.h + 2.5 ? 1 : 0; // bridges are drawn at ground level
  return { x: g.x, y: g.y, e: ecefToEnu(llhToEcef(lat, lon, g.h)), vis };
}
const latLonEnu = (lat: number, lon: number): [number, number] => { const e = ecefToEnu(llhToEcef(lat, lon, 0)); return [e[0], e[1]]; };

/**
 * Painted-over ground (cutout.ts `key` masks, e.g. the Wasen fairground): the OSM service roads under it are gone in
 * the painting, so traffic must not drive there. Returns a test: is this map pixel inside any key mask?
 */
async function keyMasks(areas: string[]) {
  const masks: Array<{ x: number; y: number; sx: number; sy: number; mw: number; mh: number; a: Buffer }> = [];
  for (const area of areas) {
    const f = join(DERIVED, area, "cutouts.json");
    if (!existsSync(f)) continue;
    for (const c of readJson(f)) {
      if (!c.key) continue;
      const [x, y, w, h] = c.key.frame, { data, info } = await sharp(join(DERIVED, area, c.key.mask)).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
      masks.push({ x, y, sx: info.width / w, sy: info.height / h, mw: info.width, mh: info.height, a: data });
    }
  }
  return (px: number, py: number) => masks.some((m) => {
    const mx = Math.floor((px - m.x) * m.sx), my = Math.floor((py - m.y) * m.sy);
    return mx >= 0 && my >= 0 && mx < m.mw && my < m.mh && m.a[my * m.mw + mx] > 127;
  });
}

/** Drivable roads as ENU polylines sampled every 4 m, each sample flagged visible/occluded. */
async function exportRoads(areas: string[], heights: Heights) {
  const CLS: Record<string, number> = { motorway: 0, trunk: 0, primary: 1, secondary: 2, tertiary: 3, unclassified: 4, residential: 4, living_street: 5, service: 5 };
  const ways = [];
  const seen = new Set<number>(); // areas overlap (the pilot lies inside tlv-core): each OSM way once
  let occluded = 0, total = 0, fallback = 0;
  const terrainU = terrainSampler(areas), ends = bridgeEndsOf(areas);
  // preset carFreePaving: the streets the ground draws as pedestrian paving carry no simulated cars either
  const region = REGIONS[activeRegion()], carFree = region.look === "styled" && styleOf(region.style).carFreePaving ? isPedestrianised : isCarFree;
  for (const a of areas) {
    const f = join(RAW, a, "roads.json");
    if (!existsSync(f)) continue;
    const els = readJson(f).elements.filter((el: any) => {
      const t = el.tags ?? {};
      if (seen.has(el.id)) return false;
      seen.add(el.id);
      return el.geometry?.length >= 2 && t.tunnel !== "yes" && !String(t.layer ?? "").startsWith("-") && roadWidth(t) > 0;
    });
    // split ways at every node another road shares, so junctions are always way ends
    const use = new Map<number, number>();
    for (const el of els) el.nodes.forEach((n: number, i: number) => use.set(n, (use.get(n) ?? 0) + (i === 0 || i === el.nodes.length - 1 ? 2 : 1)));
    for (const el of els) {
      const t = el.tags ?? {};
      const cls = carFree(t) ? 6 : CLS[String(t.highway).replace("_link", "")] ?? 5;
      const width = roadWidth(t);
      // bridges: on the deck the render builds (bridges.ts), from the whole way's ends, by arc length
      const line: Array<[number, number]> = el.geometry.map((p: any) => { const e = ecefToEnu(llhToEcef(p.lat, p.lon, 0)); return [e[0], e[1]]; });
      const deck = isBridge(t) ? deckHeight(line, terrainU, ends(el.id, el.geometry)) : null;
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
            const e0 = ecefToEnu(llhToEcef(lat, lon, 0));
            const j = start + i, ud = deck ? deck.at(deck.cum[j] + (deck.cum[j + 1] - deck.cum[j]) * f2, e0[0], e0[1]) : terrainU(e0[0], e0[1]);
            const u = ud !== null && Number.isFinite(ud) ? ud : null;
            if (u === null) fallback++;
            const { e, vis: cover } = await placePoint(heights, lat, lon, u);
            // the foreground layer covers them under trees and behind houses (only bridges still hide them, below)
            const vis = REGIONS[activeRegion()].life?.foreground ? 1 : cover;
            total++; occluded += 1 - vis;
            samples.push(Math.round(e[0] * 10) / 10, Math.round(e[1] * 10) / 10, Math.round(e[2] * 10) / 10, vis);
          }
        }
        ways.push({
          y: Number(t.layer) || (t.bridge && t.bridge !== "no" ? 1 : 0),
          c: cls, o: t.oneway === "-1" ? -1 : isOneway(t) ? 1 : 0,
          l: roadLanes(t), w: Math.round(width * 10) / 10, a: el.nodes[start], b: el.nodes[end], s: samples,
        });
        start = end;
      }
    }
  }
  // rail bridges cover the roads under them too (a street through an underpass below the tracks)
  const covers: Array<{ y: number; w: number; a: number; b: number; s: number[] }> = [];
  for (const a of areas) {
    const f = join(RAW, a, "rails.json");
    if (!existsSync(f)) continue;
    for (const el of readJson(f).elements) {
      const t = el.tags ?? {};
      if (!isBridge(t) || !t.railway || !(el.geometry?.length >= 2)) continue;
      covers.push({ y: Number(t.layer) || 1, w: 5, a: -1, b: -1, s: el.geometry.flatMap((q: any) => [...latLonEnu(q.lat, q.lon), 0, 1]) });
    }
  }
  occluded += hideUnderBridges(ways, covers);
  // nothing drives or walks in the faded margin outside the painted map
  for (const w of ways) for (let k = 0; k < w.s.length; k += 4) {
    if (!w.s[k + 3]) continue;
    const [x, y] = enuToPixel([w.s[k], w.s[k + 1], w.s[k + 2]]);
    if (edgeDistance(x, y) < (EDGE0 + EDGE1) / 2) { w.s[k + 3] = 0; occluded++; }
  }
  // painted-over ground (key cutouts): a way mostly under the painting goes; one that only clips it hides its cars there
  const painted = await keyMasks(areas);
  let dropped = 0;
  for (let i = ways.length - 1; i >= 0; i--) {
    const w = ways[i], inside: number[] = [];
    for (let k = 0; k < w.s.length; k += 4) { const [x, y] = enuToPixel([w.s[k], w.s[k + 1], w.s[k + 2]]); if (painted(x, y)) inside.push(k); }
    if (inside.length * 4 * 2 >= w.s.length) { ways.splice(i, 1); dropped++; continue; }
    for (const k of inside) if (w.s[k + 3]) { w.s[k + 3] = 0; occluded++; }
  }
  if (dropped) console.log(`  roads: ${dropped} ways dropped under painted cutouts`);
  bridgeDecks(ways);
  writeData("roads", JSON.stringify(encodeRoads(ways)));
  console.log(`  roads: ${ways.length} ways, ${total} samples, ${((occluded / Math.max(1, total)) * 100).toFixed(1)}% occluded, ${fallback} off the terrain grids`);
}

/**
 * Trains on the real lines, for web/src/scripts/trains.ts: OSM route relations (S-Bahn, regional and long-
 * distance trains, Stadtbahn) on their tracks. Each route's track members are chained into one run (the
 * longest connected one inside the region), and a line's two directions are paired, so trains shuttle: out
 * on one relation and back on the other (the Stadtbahn end to end; mainline trains in to the Hbf terminus
 * and back out over the map edge). Columnar like the roads:
 *   n, s, vis  tracks (each OSM way once): samples [e, n, u] in 0.1 m, delta-coded per track; visible runs.
 *              Tunnels are hidden, bridges run on the deck (bridges.ts).
 *   l          lines: k kind (0 Stadtbahn, 1 S-Bahn, 2 regional, 3 long distance, 4 street tram, 5 funicular car;
 *              4 and 5 only in regions with local stock, places.ts `rail`), r ref, c colour,
 *              i interval (min), w tracks in running order (~index: run backwards), st stops (m along the
 *              run), b the line back (-1: back along the same run)
 */
async function exportTrains(areas: string[], heights: Heights) {
  const ways = new Map<number, any>(), rels = new Map<number, any>(), nodes = new Map<number, [number, number]>();
  for (const a of areas) {
    const f = join(RAW, a, "rails.json");
    if (!existsSync(f)) continue;
    for (const el of readJson(f).elements) {
      if (el.type === "way") {
        if (el.geometry?.length >= 2 && el.nodes?.length === el.geometry.length && !(ways.get(el.id)?.nodes.length >= el.nodes.length)) ways.set(el.id, el);
      } else if (el.type === "relation") {
        rels.set(el.id, el);
        for (const m of el.members ?? []) if (m.type === "node" && m.lat !== undefined) nodes.set(m.ref, [m.lat, m.lon]);
      } else if (el.type === "node") nodes.set(el.id, [el.lat, el.lon]);
    }
  }
  if (!rels.size) return;
  const RAIL = REGIONS[activeRegion()].rail;
  const enu = new Map<number, Array<[number, number]>>();
  const lineOf = (w: any) => enu.get(w.id) ?? enu.set(w.id, w.geometry.map((p: any) => latLonEnu(p.lat, p.lon))).get(w.id)!;
  const lenOf = (w: any) => { const l = lineOf(w); let d = 0; for (let i = 1; i < l.length; i++) d += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]); return d; };

  // each relation's track members in running order; a member outside the region breaks the run
  type Run = { ids: number[]; fwd: boolean[]; len: number };
  const runOf = (r: any): Run | null => {
    const runs: Run[] = [];
    let cur: Run | null = null, head = -1, tail = -1;
    for (const m of r.members ?? []) {
      if (m.type !== "way" || /platform/.test(m.role ?? "")) continue;
      const w = ways.get(m.ref);
      if (!w) { cur = null; continue; }
      const a = w.nodes[0], b = w.nodes.at(-1);
      // the first way's direction is only known from the second
      if (cur && cur.ids.length === 1 && (a === head || b === head) && a !== tail && b !== tail) { cur.fwd[0] = !cur.fwd[0]; [head, tail] = [tail, head]; }
      if (cur && a === tail) { cur.ids.push(w.id); cur.fwd.push(true); tail = b; }
      else if (cur && b === tail) { cur.ids.push(w.id); cur.fwd.push(false); tail = a; }
      else { cur = { ids: [w.id], fwd: [true], len: 0 }; runs.push(cur); head = a; tail = b; }
      cur.len += lenOf(w);
    }
    return runs.sort((x, y) => y.len - x.len)[0] ?? null;
  };
  const endsOf = (run: Run) => {
    const f = lineOf(ways.get(run.ids[0])), l = lineOf(ways.get(run.ids.at(-1)!));
    return [run.fwd[0] ? f[0] : f.at(-1)!, run.fwd.at(-1) ? l.at(-1)! : l[0]];
  };
  const kindOf = (t: Record<string, string>) => {
    if (RAIL && t.route === "tram") return 4;
    if (/^(light_rail|subway|tram)$/.test(t.route)) return 0;
    const refs = (t.ref ?? "").toUpperCase().split(";").map((x) => x.trim());
    if (refs.some((x) => /^S\s*\d/.test(x))) return 1;
    if (refs.some((x) => /^(ICE|IC|EC|ECE|EN|NJ|TGV|RJX?|FLX)\b/.test(x)) || /long_distance|high_speed/.test(t.service ?? "")) return 3;
    return 2;
  };
  const DEFAULT_INTERVAL = [10, 15, 30, 60, RAIL?.tramInterval ?? 10, 60];
  const refOf = (t: Record<string, string>) => String(t.ref ?? "").split(";").at(-1)!.trim();
  const intervalOf = (t: Record<string, string>, k: number) => {
    const m = /^(?:(\d+):)?(\d+)/.exec(t.interval ?? "");
    const v = m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : 0;
    if (v >= 3 && v <= 240) return v;
    if (k === 4) return RAIL?.interval?.[refOf(t)] ?? DEFAULT_INTERVAL[k];
    if (k < 4 && RAIL?.mainline) return new RegExp(RAIL.mainline.line).test(refOf(t)) ? RAIL.mainline.every : RAIL.mainline.single;
    return DEFAULT_INTERVAL[k];
  };

  // one line per ref and its way back: the longest run, and the other direction ending where it starts
  const groups = new Map<string, Array<{ r: any; run: Run; k: number }>>();
  for (const r of rels.values()) {
    const run = runOf(r);
    if (!run || run.len < 300) continue;
    const k = kindOf(r.tags ?? {});
    if (k === 4 && RAIL?.night?.includes(refOf(r.tags))) continue; // night line: the map shows the day
    const key = `${r.tags.route}:${(r.tags.ref ?? r.tags.name ?? r.id).toString().split(";").at(-1)!.trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ r, run, k });
  }
  const chosen: Array<{ r: any; run: Run; k: number; back: number }> = [];
  for (const g of groups.values()) {
    g.sort((a, b) => b.run.len - a.run.len);
    const A = g[0], [as, ae] = endsOf(A.run);
    let best = -1, bd = Infinity;
    g.forEach((B, i) => {
      if (!i) return;
      const [bs, be] = endsOf(B.run), d = Math.hypot(ae[0] - bs[0], ae[1] - bs[1]) + Math.hypot(as[0] - be[0], as[1] - be[1]);
      if (d < bd) { bd = d; best = i; }
    });
    const ia = chosen.push({ ...A, back: -1 }) - 1;
    if (best > 0 && bd < 3000) { chosen[ia].back = chosen.length; chosen.push({ ...g[best], back: ia }); }
  }

  const terrainU = terrainSampler(areas), ends = bridgeEndsOf(areas);
  // funiculars have no route relation: each track is a line of its own, run bottom to top, the cars
  // counterweighted (the next track's car starts at the top: its run is reversed)
  if (RAIL) [...ways.values()].filter((w) => w.tags?.railway === "funicular" && lenOf(w) > 20).forEach((w, i) => {
    const l = lineOf(w), up = (terrainU(...l.at(-1)!) ?? 0) >= (terrainU(...l[0]) ?? 0);
    chosen.push({ r: { tags: { route: "funicular", ref: w.tags.name ?? "" }, members: [] }, run: { ids: [w.id], fwd: [up === (i % 2 === 0)], len: lenOf(w) }, k: 5, back: -1 });
  });

  // sample every track a chosen line runs on, once
  const index = new Map<number, number>(), tracks: number[][] = [];
  let hidden = 0, total = 0;
  for (const c of chosen) for (const id of c.run.ids) {
    if (index.has(id)) continue;
    const w = ways.get(id), t = w.tags ?? {}, line = lineOf(w);
    const tunnel = /^(yes|building_passage|covered)$/.test(t.tunnel ?? "") || t.covered === "yes";
    const deck = isBridge(t) ? deckHeight(line, terrainU, ends(id, w.geometry)) : null;
    const g = w.geometry, samples: number[] = [];
    let cum = 0;
    for (let i = 0; i < g.length - 1; i++) {
      const d = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]), n = Math.max(1, Math.ceil(d / 8));
      for (let k = 0; k < n + (i === g.length - 2 ? 1 : 0); k++) {
        const f = k / n, lat = g[i].lat + (g[i + 1].lat - g[i].lat) * f, lon = g[i].lon + (g[i + 1].lon - g[i].lon) * f;
        const [e0, n0] = latLonEnu(lat, lon), ground = terrainU(e0, n0);
        const ud = deck ? deck.at(cum + d * f, e0, n0) : ground;
        const p = await placePoint(heights, lat, lon, ud !== null && Number.isFinite(ud) ? ud : null);
        const vis = tunnel || edgeDistance(p.x, p.y) < (EDGE0 + EDGE1) / 2 ? 0 : p.vis;
        total++; hidden += 1 - vis;
        samples.push(Math.round(p.e[0] * 10) / 10, Math.round(p.e[1] * 10) / 10, Math.round(p.e[2] * 10) / 10, vis);
      }
      cum += d;
    }
    index.set(id, tracks.push(samples) - 1);
  }

  // stops: the relation's stop nodes, as distance along the run
  const lines = chosen.map((c) => {
    const pts: Array<[number, number]> = [];
    c.run.ids.forEach((id, j) => {
      const s = tracks[index.get(id)!], n = s.length / 4;
      for (let q = 0; q < n; q++) {
        const i = c.run.fwd[j] ? q : n - 1 - q;
        if (j && !q) continue; // the joint is the previous track's last sample
        pts.push([s[i * 4], s[i * 4 + 1]]);
      }
    });
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const st: number[] = [];
    for (const m of c.r.members ?? []) {
      if (m.type !== "node" || !/^stop/.test(m.role ?? "") || !nodes.has(m.ref)) continue;
      const [x, y] = latLonEnu(...nodes.get(m.ref)!);
      let bd = 40, bs = -1;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], dx = pts[i][0] - ax, dy = pts[i][1] - ay, L2 = dx * dx + dy * dy || 1;
        const f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), d = Math.hypot(ax + dx * f - x, ay + dy * f - y);
        if (d < bd) { bd = d; bs = cum[i - 1] + Math.sqrt(L2) * f; }
      }
      if (bs >= 0) st.push(Math.round(bs));
    }
    st.sort((a, b) => a - b);
    const t = c.r.tags ?? {};
    return {
      k: c.k, r: refOf(t), c: t.colour ?? "", i: intervalOf(t, c.k), b: c.back,
      w: c.run.ids.map((id, j) => (c.run.fwd[j] ? index.get(id)! : ~index.get(id)!)),
      st: st.filter((v, i) => !i || v - st[i - 1] > 30),
    };
  });

  const out = { v: 1, n: [] as number[], s: [] as number[], vis: [] as number[], l: lines };
  for (const s of tracks) {
    out.n.push(s.length / 4);
    let pe = 0, pn = 0, pu = 0, cur = 1, run = 0;
    const runs: number[] = [];
    for (let k = 0; k < s.length; k += 4) {
      const e = Math.round(s[k] * 10), n = Math.round(s[k + 1] * 10), u = Math.round(s[k + 2] * 10);
      out.s.push(e - pe, n - pn, u - pu);
      pe = e; pn = n; pu = u;
      if (s[k + 3] === cur) run++; else { runs.push(run); cur = s[k + 3]; run = 1; }
    }
    runs.push(run);
    out.vis.push(runs.length, ...runs);
  }
  writeData("trains", JSON.stringify(out));
  const kinds = [0, 1, 2, 3, 4, 5].map((k) => lines.filter((l) => l.k === k).length);
  const local = RAIL ? `, ${kinds[4]} tram, ${kinds[5]} funicular` : "";
  console.log(`  trains: ${lines.length} lines (${kinds[0]} Stadtbahn, ${kinds[1]} S-Bahn, ${kinds[2]} regional, ${kinds[3]} long distance${local}) on ${tracks.length} tracks, ${total} samples, ${((hidden / Math.max(1, total)) * 100).toFixed(1)}% hidden`);
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
 * Vehicles on a road passing under a bridge (a road or, in `covers`, a railway on a higher layer) must disappear beneath its
 * deck: mark those samples hidden. Returns how many samples were hidden.
 */
function hideUnderBridges(ways: Array<{ y: number; w: number; a: number; b: number; s: number[] }>, covers: typeof ways = []) {
  type Seg = [number, number, number, number, number, number, number, number]; // a, b, half width, layer, way ends
  const CELL = 20, grid = new Map<string, Seg[]>();
  for (const w of [...ways, ...covers]) {
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
  // region names expand to the areas its live map was built from, else all of its areas
  const asked: string[] = [];
  for (const n of names.length ? names : ["tlv-core"]) {
    if (AREAS[n] || !REGIONS[n]) { asked.push(n); continue; }
    const r = await fetch(`${HOSTING.origin}/regions/${n}/data/world.json?t=${Date.now()}`);
    asked.push(...(r.ok ? ((await r.json()) as { areas: Array<{ id: string }> }).areas.map((a) => a.id)
      : Object.keys(AREAS).filter((a) => AREAS[a].region === n)));
  }
  const regions = new Set(asked.map((a) => openArea(a).region));
  // a mine's levels are layers of their own, never part of the map; exported whenever they are rendered
  // (--partial without them keeps the published mine: its levels and mine.json stay in the state)
  const areas = asked.filter((a) => !AREAS[a]?.mine);
  const mineLevels = Object.keys(AREAS).filter((a) => AREAS[a].mine && AREAS[a].region === [...regions][0] && existsSync(join(DERIVED, a, "render")) && existsSync(join(DERIVED, a, "mine.json")));
  if (regions.size !== 1) throw new Error(`export one region at a time (got ${[...regions].join(", ")})`);
  OUT = join(WEB_CACHE, "regions", activeRegion());
  if (await fetchPublishedState(activeRegion())) console.log(`  published state downloaded from R2 → ${publishedFile()}`);
  const from = [pendingFile(), publishedFile()].find(existsSync);
  if (from) state = readJson(from);
  if (from === publishedFile()) state.base = stateHash(readFileSync(from)); // stacked exports keep theirs
  if (existsSync(publishedFile())) published = readJson(publishedFile());
  if (process.argv.includes("--parts")) {
    SCOPE = areas.flatMap((a) => { const f = join(DERIVED, a, "osm-parts.json"); return existsSync(f) ? readJson(f).map((p: { px: number[] }) => p.px) : []; });
    if (!SCOPE!.length) throw new Error("--parts: no osm-parts.json with buildings in these areas (run scene first)");
    console.log(`  --parts: only tiles around ${SCOPE!.length} swapped building(s)`);
  }
  console.log(`  ${activeRegion()}: ${from ? `changes since ${from === pendingFile() ? "the last (unpublished) export" : "the published state"}` : "no published state: building everything"}`);
  outlines = areas.map((a) => areaPolygon(AREAS[a].bbox));
  buildUnionEdges();
  // a small area (a test patch) would never reach full opacity: shrink the fade so EDGE1 is at most
  // 60% of the way from the edge to the area's centre. City-sized areas keep the full fade.
  const inradius = Math.max(...outlines.map((o) => insideDistance([o.reduce((t, p) => t + p[0], 0) / o.length, o.reduce((t, p) => t + p[1], 0) / o.length], o)));
  const fade = Math.min(1, (0.6 * inradius) / EDGE1);
  EDGE0 *= fade; EDGE1 *= fade;
  shape = outlinePixels();
  // areas overlap: each tile from the area it lies deepest inside (its scene has the most context around it)
  const depth = new Map<string, number>();
  const photo = new Map<Key, string>(), art = new Map<Key, string>(), cut = new Map<Key, string>(); // cut: cutout.ts landmarks
  const attributions = new Set<string>();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const a of areas) {
    const dir = join(DERIVED, a);
    const m = readJson(join(dir, "manifest.json"));
    (m.attributions as string[]).flatMap((s) => s.split(";")).map((s) => s.trim()).filter(Boolean).forEach((s) => attributions.add(s));
    for (const [layer, map] of [["render", photo], ["cutout", cut], ["paint", art]] as const) {
      if (!existsSync(join(dir, layer))) continue;
      for (const f of readdirSync(join(dir, layer)).filter((f) => f.endsWith(".png"))) {
        const [tx, ty] = parse(f.replace(".png", ""));
        const d = insideDistance([(tx + 0.5) * CAMERA.tile, (ty + 0.5) * CAMERA.tile], outlines[areas.indexOf(a)]);
        if (d < (depth.get(`${layer}:${tx}_${ty}`) ?? -1)) continue;
        depth.set(`${layer}:${tx}_${ty}`, d);
        map.set(key(tx, ty), join(dir, layer, f));
        x0 = Math.min(x0, tx * CAMERA.tile); y0 = Math.min(y0, ty * CAMERA.tile);
        x1 = Math.max(x1, (tx + 1) * CAMERA.tile); y1 = Math.max(y1, (ty + 1) * CAMERA.tile);
      }
    }
  }
  const mapOnly = new Map<Key, string>(); // --partial: published map tiles with neither a render nor a painting
  if (PARTIAL) {
    const pub = published;
    if (!pub) throw new Error("--partial: nothing published for this region yet (run a full export first)");
    // roads, trains and bridge decks (drawn into painted tiles) are built for the whole region: their inputs must be here
    const missing = areas.filter((a) => !existsSync(join(RAW, a, "roads.json")) || !existsSync(join(DERIVED, a, "ground", "meta.json")) || !existsSync(join(DERIVED, a, "height")));
    if (missing.length) throw new Error(`--partial: ${missing.join(", ")} lack raw/<area>/roads.json, ground/ or height/ (npm run pull -- ${activeRegion()}, or fetch + ground + render)`);
    const native = (layer: string) => new Set(Object.keys(pub.layers[layer]?.hashes ?? {}).filter((id) => id.startsWith(`${NATIVE_Z}/`))
      .map((id) => { const [x, y] = parse(id.slice(`${NATIVE_Z}/`.length)); return key(Math.floor(x / SPLIT), Math.floor(y / SPLIT)); }));
    // painted on the live map: its stamp has the deck style, or (tiles from before stamps) a painting was its source
    const painted = new Set(Object.entries(pub.layers.map?.sources ?? {}).filter(([id, s]) => id.startsWith(`${NATIVE_Z}/`) && s.includes("@decks"))
      .map(([id]) => { const [x, y] = parse(id.slice(`${NATIVE_Z}/`.length)); return key(Math.floor(x / SPLIT), Math.floor(y / SPLIT)); }));
    for (const rel of Object.keys(pub.src ?? {})) {
      const m = rel.match(/^([^/]+)\/paint\/(-?\d+_-?\d+)\.png$/);
      if (m && areas.includes(m[1])) painted.add(m[2] as Key);
    }
    const mapNative = native("map"), photoNative = native("photo"), here = { photo: photo.size, art: art.size };
    for (const k of photoNative) if (!photo.has(k)) photo.set(k, REMOTE);
    for (const k of painted) if (mapNative.has(k) && !art.has(k)) art.set(k, REMOTE); // a local render never replaces a painting
    for (const k of mapNative) if (!photo.has(k) && !art.has(k) && !cut.has(k)) mapOnly.set(k, REMOTE);
    for (const k of [...mapNative, ...photoNative]) {
      const [tx, ty] = parse(k);
      x0 = Math.min(x0, tx * CAMERA.tile); y0 = Math.min(y0, ty * CAMERA.tile);
      x1 = Math.max(x1, (tx + 1) * CAMERA.tile); y1 = Math.max(y1, (ty + 1) * CAMERA.tile);
    }
    console.log(`  --partial: ${here.photo} renders and ${here.art} paintings here, the rest (${photo.size - here.photo} rendered, ${art.size - here.art} painted tiles) as published`);
  }
  const heights = new Heights(areas.map((a) => join(DERIVED, a, "height")));
  await exportRoads(areas, heights); // first: the bridge decks are drawn into the painted tiles
  await exportTrains(areas, heights);
  if (!process.argv.includes("--data-only")) {
    await exportLayer("map", new Map([...mapOnly, ...photo, ...art, ...cut])); // painted wins; cutouts win over both: cutout.ts lays them on the painted tile where there is one
    await exportLayer("photo", photo);
    if (REGIONS[activeRegion()].life?.foreground) await exportForeground(photo);
    if (mineLevels.length) await exportMine(mineLevels);
    if (REGIONS[activeRegion()].effects?.fly) await exportHeights(photo);
    for (const layer of Object.keys(index)) writeData(`tiles-${layer}`, JSON.stringify(index[layer]));
  }
  await exportBorders(heights);
  const effects = REGIONS[activeRegion()].effects ?? {};
  if (effects.search) await exportSearch(areas, heights, [x0, y0, x1, y1]);
  await exportAirport(heights);
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
    files: { "tiles-map": dataFile("tiles-map"), "tiles-photo": dataFile("tiles-photo"), "tiles-fg": dataFile("tiles-fg"), borders: dataFile("borders"), roads: dataFile("roads"), trains: dataFile("trains"), airport: dataFile("airport"), ...(mineLevels.length || (PARTIAL && dataFile("mine")) ? { mine: dataFile("mine") } : {}), ...(REGIONS[activeRegion()].effects?.fly ? { "tiles-height": dataFile("tiles-height") } : {}), ...(effects.search ? { search: dataFile("search") } : {}) },
    previews,
  }, null, 2);
  if (state.data["world.json"] !== hash(world)) {
    mkdirSync(join(OUT, "data"), { recursive: true });
    writeFileSync(join(OUT, "data", "world.json"), world);
    state.data["world.json"] = hash(world);
  }
  console.log(`  world.json: ${photo.size} rendered, ${art.size} painted tiles`);
  checkpoint(true);
  const files = existsSync(OUT) ? readdirSync(OUT, { recursive: true }).filter((f) => String(f).match(/\.(avif|webp|json)$/)).length : 0;
  console.log(files ? `  ${files} files ready in ${OUT}\n  preview: npm run dev · publish: npm run publish -- ${activeRegion()}` : "  nothing changed");
}

main();
