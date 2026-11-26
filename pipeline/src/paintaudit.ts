/**
 * Audit painted windows against the render and the ground map: what the painter got wrong that the geometry check
 * (register.ts) can't see. Every window pixel is traced back to the ground (height pass + the area's terrain grid)
 * and to its OSM ground class (ground/features.json), then the painting is measured where it must not change:
 *
 *   pedAsphalt   pedestrian ground (plaza, paving, market) painted as grey asphalt
 *   pedObjects   pedestrian ground painted with saturated or dark objects (cars, shopfronts, umbrellas)
 *   redWalls     buildings painted brick/tile red where the render's colour is not red (plaster turned brick)
 *   streetTrees  road surface painted as tree or grass green where the render shows no green
 *   glassWalls   walls painted as a blue-grey glass grid (curtain wall, office or prison look) where the render's wall
 *                is plaster, brick or stone (Wawel castle in the Kraków pilot)
 *   inventedTrees tree crowns (dark vegetation green) painted on roofs, stands, decks or squares: where the render
 *                has a building or pedestrian paving and no tree
 *   greens       painted grass and tree crowns minus the render's on the same cells: hue, saturation, value
 *                (the painted patch must read as one with the styled map around it)
 *   seam         mean colour difference with the right and bottom neighbour in their shared overlap
 *
 *   npm -w pipeline exec tsx src/paintaudit.ts krakow-test --tag krakow-pilot [--out <dir>] [--crops 12]
 *
 * Writes <out>/audit.json (per window), <out>/flaws.md (worst windows) and crops (render | painting | flagged).
 * Also importable: windowFlaws(i, j, painting) for paint.ts's per-window check.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { AREAS, openArea } from "./areas.ts";
import { axes, CAMERA, enuToLlh } from "./camera.ts";
import { DERIVED, readJson } from "./paths.ts";
import { readHeights } from "./heights.ts";

const WIN = 1024, STRIDE = 896, CELL = 4, N = WIN / CELL, T = CAMERA.tile;
/** Ground classes of the top-down raster. */
export const PED = 1, ROAD = 2, GRASS = 3, PATH = 4, RAIL = 5;
const CLASS_OF: Record<string, number> = {
  plaza: PED, paving: PED, stalls: PED,
  street: ROAD, lane: ROAD, highway: ROAD, parking: ROAD, dirtroad: ROAD,
  park: GRASS, lawn: GRASS, meadow: GRASS,
  rail: RAIL, // tram and rail tracks across squares: brown rails are not objects
  path: PATH, sidewalk: PATH, cycle: PATH, flowerbed: PATH, playground: PATH, pitch: PATH,
};
/** Drawing order: later classes cover earlier ones (roads cross plazas, paths cross lawns). */
const ORDER = [GRASS, PATH, PED, ROAD, RAIL];
/**
 * OSM draws a pedestrian street as a line with a default width (5 m) while the render paves it from wall to wall:
 * widen pedestrian lines to this before anything else is drawn (buildings are cut out by height, roads and lawns
 * drawn later win).
 */
const PED_STREET_W = 12;
/** Roads drawn this much wider than OSM's width (kerbs, the render's pavements, misregistration): never pedestrian. */
const ROAD_MARGIN = 3;
const RES = 0.5; // m per raster cell

export interface Flaws {
  /** shares of the pedestrian cells, and their counts (a cell is ~1 m²) */
  window: string; ped: number; pedAsphalt: number; pedObjects: number; pedAsphaltCells?: number; pedObjectCells?: number; walls: number; redWalls: number;
  road: number; streetTrees: number;
  /** m² of painted crowns where the render has a structure (roof, stand, deck) or paving and no tree */
  inventedTrees: number;
  /** share of wall cells painted as a blue-grey glass grid where the render's wall is not glass */
  glassWalls: number;
  /** painted minus render, mean over the cells where both are green: grass (ground) and crowns (above it) */
  grassCells: number; grassDH: number; grassDS: number; grassDV: number; crownCells: number; crownDH: number; crownDS: number; crownDV: number;
  seamRight?: number; seamBottom?: number; match?: number;
}

/** Ground classes and terrain of one area, built once. */
export async function auditContext(areaName: string, opts: { ground?: string; render?: string } = {}) {
  const area = openArea(areaName), base = join(DERIVED, areaName), groundDir = opts.ground ?? join(base, "ground");
  // terrain: ENU up per grid node
  const meta = readJson(join(groundDir, "meta.json")), gb = readFileSync(join(groundDir, "height.bin"));
  const gh = new Float32Array(gb.buffer, gb.byteOffset, gb.length / 4);
  const terrain = (e: number, n: number) => {
    const fx = (e - meta.x0) / meta.step, fy = (n - meta.y0) / meta.step;
    const ix = Math.max(0, Math.min(meta.nx - 2, Math.floor(fx))), iy = Math.max(0, Math.min(meta.ny - 2, Math.floor(fy)));
    const ax = Math.min(1, Math.max(0, fx - ix)), ay = Math.min(1, Math.max(0, fy - iy)), k = iy * meta.nx + ix;
    return (gh[k] * (1 - ax) + gh[k + 1] * ax) * (1 - ay) + (gh[k + meta.nx] * (1 - ax) + gh[k + meta.nx + 1] * ax) * ay;
  };
  // top-down class raster over the ground grid
  const W = Math.ceil(((meta.nx - 1) * meta.step) / RES), H = Math.ceil(((meta.ny - 1) * meta.step) / RES);
  const cls = new Uint8Array(W * H);
  const features: any[] = readJson(join(groundDir, "features.json"));
  const toCell = (p: number[]) => [(p[0] - meta.x0) / RES, (p[1] - meta.y0) / RES];
  for (const f of features) if (CLASS_OF[f.k] === PED && f.l && !f.b) strokeLine(cls, W, H, f.l.map(toCell), Math.max(f.w ?? 0, PED_STREET_W) / RES / 2, PED);
  for (const c of ORDER)
    for (const f of features) {
      if (CLASS_OF[f.k] !== c || f.b) continue; // skip bridge decks (drawn above the ground)
      if (f.r) fillRings(cls, W, H, f.r.map((r: number[][]) => r.map(toCell)), c);
      else if (f.l) strokeLine(cls, W, H, f.l.map(toCell), ((f.w ?? 2) + (c === ROAD || c === RAIL ? ROAD_MARGIN : 0)) / RES / 2, c);
    }
  const classAt = (e: number, n: number) => {
    const x = Math.floor((e - meta.x0) / RES), y = Math.floor((n - meta.y0) / RES);
    return x < 0 || y < 0 || x >= W || y >= H ? 0 : cls[y * W + x];
  };
  // a render or height tile of this area, else of a sibling area of the region
  const siblings = Object.entries(AREAS).filter(([n, a]) => a.region === area.region && n !== areaName).map(([n]) => join(DERIVED, n));
  const regionFile = (kind: string, tx: number, ty: number) => {
    const own = kind === "render" && opts.render ? join(opts.render, `${tx}_${ty}.png`) : join(base, kind, `${tx}_${ty}.png`);
    return existsSync(own) ? own : siblings.map((d) => join(d, kind, `${tx}_${ty}.png`)).find((f) => existsSync(f)) ?? own;
  };
  return { area, base, terrain, classAt, regionFile };
}
export type Ctx = Awaited<ReturnType<typeof auditContext>>;

function fillRings(cls: Uint8Array, W: number, H: number, rings: number[][][], c: number) {
  let y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  for (let y = Math.max(0, Math.ceil(y0)); y <= Math.min(H - 1, Math.floor(y1)); y++) {
    const xs: number[] = [];
    for (const r of rings)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(W - 1, Math.floor(xs[k + 1])); x++) cls[y * W + x] = c;
  }
}

function strokeLine(cls: Uint8Array, W: number, H: number, pts: number[][], r: number, c: number) {
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, ay] = pts[s], [bx, by] = pts[s + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    for (let y = Math.max(0, Math.floor(Math.min(ay, by) - r)); y <= Math.min(H - 1, Math.ceil(Math.max(ay, by) + r)); y++)
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - r)); x <= Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r)); x++) {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r) cls[y * W + x] = c;
      }
  }
}

/** Global art pixel + ENU up -> ENU east, north (inverse of enuToPixel for a known height). */
function pixelToEn(px: number, py: number, u: number): [number, number] {
  const { right: r, up: v } = axes(), m = CAMERA.mpp;
  // e·r0 + n·r1 = px·m ; e·v0 + n·v1 = −py·m − u·v2
  const a = r[0], b = r[1], c = v[0], d = v[1], p = px * m, q = -py * m - u * v[2], det = a * d - b * c;
  return [(p * d - b * q) / det, (a * q - p * c) / det];
}

export const hsv = (r: number, g: number, b: number) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, mx ? d / mx : 0, mx / 255];
};
/** brick or tile red-brown */
const isRed = (r: number, g: number, b: number) => { const [h, s, v] = hsv(r, g, b); return (h <= 28 || h >= 340) && s > 0.45 && v > 0.3 && v < 0.92; }; // not brown ballast or dark wood
const isGreen = (r: number, g: number, b: number) => { const [h, s] = hsv(r, g, b); return h >= 55 && h <= 170 && s > 0.2; };
/** asphalt: mid grey, nearly unsaturated */
const isAsphalt = (r: number, g: number, b: number) => { const [, s, v] = hsv(r, g, b); return s < 0.16 && v > 0.2 && v < 0.62 && b >= r - 2; }; // cool grey: warm paving-pattern lines are not asphalt
/** a car, shopfront, umbrella: saturated and not green, or very dark */
const isObject = (r: number, g: number, b: number) => { const [h, s, v] = hsv(r, g, b); return (s > 0.42 && v > 0.25 && !(h >= 55 && h <= 170)) || v < 0.2; };

/** Mean colour per 4×4 cell of a 1024² RGB buffer. */
export function cells(px: Buffer) {
  const out = new Float32Array(N * N * 3);
  for (let y = 0; y < WIN; y++) for (let x = 0; x < WIN; x++) {
    const s = (y * WIN + x) * 3, d = (Math.floor(y / CELL) * N + Math.floor(x / CELL)) * 3;
    out[d] += px[s]; out[d + 1] += px[s + 1]; out[d + 2] += px[s + 2];
  }
  for (let k = 0; k < out.length; k++) out[k] /= CELL * CELL;
  return out;
}

export async function crop(ctx: Ctx, kind: "render" | "height", X: number, Y: number) {
  const parts: any[] = [];
  for (let ty = Math.floor(Y / T); ty <= Math.floor((Y + WIN - 1) / T); ty++)
    for (let tx = Math.floor(X / T); tx <= Math.floor((X + WIN - 1) / T); tx++) {
      const f = ctx.regionFile(kind, tx, ty);
      if (!existsSync(f)) continue;
      if (kind === "height") { parts.push({ f, tx, ty }); continue; }
      const l = Math.max(0, X - tx * T), t = Math.max(0, Y - ty * T), r = Math.min(T, X + WIN - tx * T), b = Math.min(T, Y + WIN - ty * T);
      parts.push({ input: await sharp(f).removeAlpha().extract({ left: l, top: t, width: r - l, height: b - t }).toBuffer(), left: tx * T + l - X, top: ty * T + t - Y });
    }
  if (kind === "height") return parts as Array<{ f: string; tx: number; ty: number }>;
  return sharp({ create: { width: WIN, height: WIN, channels: 3, background: "#000" } }).composite(parts).removeAlpha().raw().toBuffer();
}

/** Per-cell classes of a window: ground class where the ground is visible, -1 = building or tree, 0 = unknown. */
export async function windowClasses(ctx: Ctx, i: number, j: number, erode = true) {
  const X = i * STRIDE, Y = j * STRIDE, hc = new Float32Array(N * N).fill(NaN);
  for (const { f, tx, ty } of (await crop(ctx, "height", X, Y)) as Array<{ f: string; tx: number; ty: number }>) {
    const h = await readHeights(f);
    for (let cy = 0; cy < N; cy++) for (let cx = 0; cx < N; cx++) {
      const gx = X + cx * CELL, gy = Y + cy * CELL;
      if (Math.floor(gx / T) !== tx || Math.floor(gy / T) !== ty) continue;
      hc[cy * N + cx] = h[Math.floor((gy - ty * T) / 4) * 256 + Math.floor((gx - tx * T) / 4)];
    }
  }
  const cls = new Int8Array(N * N);
  for (let k = 0; k < N * N; k++) {
    const h = hc[k];
    if (Number.isNaN(h)) continue;
    const px = X + (k % N) * CELL + CELL / 2, py = Y + Math.floor(k / N) * CELL + CELL / 2;
    let [e, n] = pixelToEn(px, py, h);
    const u = h - (e * e + n * n) / (2 * 6371000); // ellipsoid height -> ENU up
    [e, n] = pixelToEn(px, py, u);
    cls[k] = u - ctx.terrain(e, n) > 1.2 ? -1 : ctx.classAt(e, n);
  }
  if (!erode) return cls;
  // keep pedestrian and road cells away from their edges (kerbs, misregistration): 1 cell in (Old Town streets show
  // only ~6 cells between facades)
  const out = Int8Array.from(cls);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = cls[y * N + x];
    if (c !== PED && c !== ROAD) continue;
    for (let dy = -1; dy <= 1 && out[y * N + x] === c; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= N || xx >= N || cls[yy * N + xx] !== c) { out[y * N + x] = 0; break; }
    }
  }
  return out;
}

/** Flaws of one painted window (1024² image file or buffer) against its render; flags = per-cell flaw bits. */
export async function windowFlaws(ctx: Ctx, i: number, j: number, painting: string | Buffer, classes?: Int8Array) {
  const cls = classes ?? (await windowClasses(ctx, i, j));
  const R = cells((await crop(ctx, "render", i * STRIDE, j * STRIDE)) as Buffer);
  const full = await sharp(painting).removeAlpha().resize(WIN, WIN).raw().toBuffer(), P = cells(full);
  // per cell: luminance contrast (std dev over its 4×4 px), high on a grid of panes and frames
  const contrast = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) {
    const cx = (k % N) * CELL, cy = Math.floor(k / N) * CELL;
    let s1 = 0, s2 = 0;
    for (let y = cy; y < cy + CELL; y++) for (let x = cx; x < cx + CELL; x++) { const o = (y * WIN + x) * 3, l = 0.3 * full[o] + 0.59 * full[o + 1] + 0.11 * full[o + 2]; s1 += l; s2 += l * l; }
    contrast[k] = Math.sqrt(Math.max(0, s2 / (CELL * CELL) - (s1 / (CELL * CELL)) ** 2));
  }
  /** blue-grey glass: cool hue, a little colour, mid brightness */
  const glassy = (c: readonly [number, number, number]) => { const [h, sat, v] = hsv(...c); return h >= 195 && h <= 235 && sat >= 0.1 && sat <= 0.4 && v >= 0.4 && v <= 0.85; };
  const f: Flaws = { window: `${i}_${j}`, ped: 0, pedAsphalt: 0, pedObjects: 0, walls: 0, redWalls: 0, road: 0, streetTrees: 0, inventedTrees: 0, glassWalls: 0, grassCells: 0, grassDH: 0, grassDS: 0, grassDV: 0, crownCells: 0, crownDH: 0, crownDS: 0, crownDV: 0 };
  const flags = new Uint8Array(N * N); // 1 asphalt, 2 object, 4 red wall, 8 street tree, 16 invented tree
  const crown = (c: readonly [number, number, number]) => isGreen(...c) && hsv(...c)[2] < 0.55;
  // invented trees: only crowns more than ~6 m (6 cells) from any tree crown in the render (painted crowns sit a
  // few metres off the render's, which is fine)
  const near = new Uint8Array(N * N), RAD = 6;
  for (let k = 0; k < N * N; k++) {
    if (cls[k] !== -1 || !isGreen(R[k * 3], R[k * 3 + 1], R[k * 3 + 2])) continue; // render crowns (above ground), not lawns
    const x0 = k % N, y0 = Math.floor(k / N);
    for (let y = Math.max(0, y0 - RAD); y <= Math.min(N - 1, y0 + RAD); y++) for (let x = Math.max(0, x0 - RAD); x <= Math.min(N - 1, x0 + RAD); x++) near[y * N + x] = 1;
  }
  for (let k = 0; k < N * N; k++) {
    const r = [R[k * 3], R[k * 3 + 1], R[k * 3 + 2]] as const, p = [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]] as const;
    if ((cls[k] === PED || cls[k] === -1) && crown(p) && !near[k]) { f.inventedTrees++; flags[k] |= 16; }
    if (cls[k] === PED) {
      f.ped++;
      // no render test for asphalt: the render's cast shadows make its paving look grey
      if (isAsphalt(...p)) { f.pedAsphalt++; flags[k] |= 1; }
      else if (isObject(...p) && !isObject(...r)) { f.pedObjects++; flags[k] |= 2; }
    } else if (cls[k] === -1) {
      if (isGreen(...r)) { // trees
        if (isGreen(...p)) { const [ph, ps, pv] = hsv(...p), [rh, rs, rv] = hsv(...r); f.crownCells++; f.crownDH += ph - rh; f.crownDS += ps - rs; f.crownDV += pv - rv; }
        continue;
      }
      f.walls++;
      if (isRed(...p) && !isRed(...r)) { f.redWalls++; flags[k] |= 4; }
      if (glassy(p) && contrast[k] > 14 && !glassy(r)) flags[k] |= 32;
    } else if (cls[k] === ROAD) {
      f.road++;
      if (isGreen(...p) && !isGreen(...r)) { f.streetTrees++; flags[k] |= 8; }
    } else if (cls[k] === GRASS && isGreen(...r) && isGreen(...p)) {
      const [ph, ps, pv] = hsv(...p), [rh, rs, rv] = hsv(...r);
      f.grassCells++; f.grassDH += ph - rh; f.grassDS += ps - rs; f.grassDV += pv - rv;
    }
  }
  // invented trees: crown-sized blobs only (a cell with at least 4 of its 8 neighbours flagged), not green shutters,
  // balcony plants or a painted green facade
  f.inventedTrees = 0;
  const raw = Uint8Array.from(flags);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x;
    if (!(raw[k] & 16)) continue;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && y + dy >= 0 && x + dx >= 0 && y + dy < N && x + dx < N && raw[(y + dy) * N + x + dx] & 16) nb++;
    }
    if (nb >= 4) f.inventedTrees++; else flags[k] &= ~16;
  }
  // glass walls: facade-sized blobs only (a cell with at least 5 of its 8 neighbours flagged)
  const g0 = Uint8Array.from(flags);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x;
    if (!(g0[k] & 32)) continue;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && y + dy >= 0 && x + dx >= 0 && y + dy < N && x + dx < N && g0[(y + dy) * N + x + dx] & 32) nb++;
    if (nb >= 5) f.glassWalls++; else flags[k] &= ~32;
  }
  f.pedAsphaltCells = f.pedAsphalt; f.pedObjectCells = f.pedObjects;
  if (f.ped) { f.pedAsphalt /= f.ped; f.pedObjects /= f.ped; }
  if (f.walls) { f.redWalls /= f.walls; f.glassWalls /= f.walls; }
  if (f.road) f.streetTrees /= f.road;
  if (f.grassCells) { f.grassDH /= f.grassCells; f.grassDS /= f.grassCells; f.grassDV /= f.grassCells; }
  if (f.crownCells) { f.crownDH /= f.crownCells; f.crownDS /= f.crownCells; f.crownDV /= f.crownCells; }
  return { flaws: f, flags };
}

/** Mean |difference| of two windows' shared overlap (the strip both painted). */
async function seam(a: string, b: string, side: "right" | "bottom") {
  const box = side === "right" ? [{ left: STRIDE, top: 0, width: 128, height: WIN }, { left: 0, top: 0, width: 128, height: WIN }]
    : [{ left: 0, top: STRIDE, width: WIN, height: 128 }, { left: 0, top: 0, width: WIN, height: 128 }];
  const [x, y] = await Promise.all([sharp(a).removeAlpha().resize(WIN, WIN).extract(box[0]).raw().toBuffer(), sharp(b).removeAlpha().resize(WIN, WIN).extract(box[1]).raw().toBuffer()]);
  let s = 0;
  for (let k = 0; k < x.length; k++) s += Math.abs(x[k] - y[k]);
  return s / x.length;
}

/** Grass of any painted image (green, saturated pixels): mean hue, saturation, value. */
export async function grassStats(files: string[]) {
  let n = 0, h = 0, s = 0, v = 0;
  for (const f of files) {
    const px = await sharp(f).removeAlpha().resize(512, 512, { fit: "inside" }).raw().toBuffer();
    for (let k = 0; k < px.length; k += 3) {
      const [hh, ss, vv] = hsv(px[k], px[k + 1], px[k + 2]);
      if (hh >= 70 && hh <= 140 && ss > 0.25 && vv > 0.35) { n++; h += hh; s += ss; v += vv; }
    }
  }
  return { pixels: n, hue: h / n, sat: s / n, val: v / n };
}

const TYPES = { pedAsphalt: 1, pedObjects: 2, redWalls: 4, streetTrees: 8, inventedTrees: 16, glassWalls: 32 } as const;
/** Severity thresholds per flaw: [high, medium, low] (below: smaller is worse). Tuned on the Kraków pilot. */
const SEVERITY: Record<string, { value: (r: Flaws) => number | undefined; levels: number[]; below?: boolean; show: (v: number) => string }> = {
  pedAsphalt: { value: (r) => r.pedAsphaltCells, levels: [300, 120, 40], show: (v) => `${v} m² asphalt on pedestrian ground` },
  pedObjects: { value: (r) => r.pedObjectCells, levels: [100, 40, 15], show: (v) => `${v} m² cars/stalls on pedestrian ground` },
  redWalls: { value: (r) => r.redWalls, levels: [0.06, 0.035, 0.02], show: (v) => `${(v * 100).toFixed(1)} % of buildings turned red` },
  glassWalls: { value: (r) => r.glassWalls, levels: [0.03, 0.015, 0.006], show: (v) => `${(v * 100).toFixed(1)} % of walls painted as a blue-grey glass grid` },
  inventedTrees: { value: (r) => r.inventedTrees, levels: [150, 60, 25], show: (v) => `${v} m² of tree crowns on roofs, stands or paving` },
  streetTrees: { value: (r) => r.streetTrees, levels: [0.2, 0.1, 0.05], show: (v) => `${(v * 100).toFixed(1)} % of road painted green` },
  seam: { value: (r) => Math.max(r.seamRight ?? 0, r.seamBottom ?? 0) || undefined, levels: [50, 42, 36], show: (v) => `overlap differs by ${v.toFixed(0)}/255` },
  // distance of the painted greens from the render's, in units of (8° hue, 0.08 saturation, 0.08 value)
  greens: { value: (r) => (r.grassCells + r.crownCells < 200 ? undefined : Math.max(...[[r.grassDH, r.grassDS, r.grassDV, r.grassCells], [r.crownDH, r.crownDS, r.crownDV, r.crownCells]]
    .filter((g) => g[3] >= 100).map(([h, s, v]) => Math.max(Math.abs(h) / 8, Math.abs(s) / 0.08, Math.abs(v) / 0.08)), 0)),
    levels: [3, 2, 1.25], show: (v) => `greens ${v.toFixed(1)}× off the render's (1 = 8° hue or 0.08 saturation/value)` },
  geometry: { value: (r) => r.match, levels: [0.45, 0.5, 0.55], below: true, show: (v) => `edge match ${v.toFixed(2)}` },
};
/** Nearest named part of Kraków to a window centre (labels for the report). */
const PLACES: Array<[string, number, number]> = [
  ["Rynek Główny", 50.0617, 19.9373], ["Old Town (Grodzka)", 50.058, 19.9375], ["Planty (west)", 50.0605, 19.933], ["Wawel", 50.0541, 19.9354], ["Kazimierz (Szeroka)", 50.053, 19.948], ["Kazimierz (Plac Nowy)", 50.0515, 19.9447],
  ["Stradom", 50.056, 19.941], ["Planty / Barbakan", 50.0655, 19.9415], ["Kleparz", 50.068, 19.939], ["Piasek", 50.0625, 19.929],
  ["Nowy Świat", 50.058, 19.926], ["Dębniki", 50.049, 19.923], ["Ludwinów", 50.045, 19.933], ["Podgórze", 50.044, 19.95],
  ["Kraków Główny", 50.0675, 19.947], ["Grzegórzki", 50.059, 19.956], ["Salwator", 50.054, 19.91], ["Błonia", 50.06, 19.915],
];
function placeOf(ctx: Ctx, i: number, j: number) {
  const px = i * STRIDE + WIN / 2, py = j * STRIDE + WIN / 2;
  let [e, n] = pixelToEn(px, py, 0);
  const u = ctx.terrain(e, n);
  [e, n] = pixelToEn(px, py, u);
  const [lat, lon] = enuToLlh([e, n, u]);
  let best = PLACES[0], d = Infinity;
  for (const p of PLACES) { const dd = Math.hypot(p[1] - lat, (p[2] - lon) * 0.64); if (dd < d) { d = dd; best = p; } }
  return best[0];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    // --ground / --render: audit against the ground and render a painting was made from (default: the area's own)
    options: { tag: { type: "string" }, out: { type: "string" }, crops: { type: "string", default: "12" }, ground: { type: "string" }, render: { type: "string" } },
  });
  const areaName = positionals[0] ?? "krakow-test", ctx = await auditContext(areaName, { ground: args.ground, render: args.render });
  const dir = join(ctx.base, `windows${args.tag ? `-${args.tag}` : ""}`), work = join(ctx.base, `work${args.tag ? `-${args.tag}` : ""}`);
  const out = resolve(args.out ?? join(ctx.base, `audit${args.tag ? `-${args.tag}` : ""}`));
  mkdirSync(join(out, "crops"), { recursive: true });
  const wins = readdirSync(dir).filter((f) => /^-?\d+_-?\d+\.png$/.test(f)).map((f) => f.slice(0, -4).split("_").map(Number));
  const have = new Set(wins.map(([i, j]) => `${i}_${j}`));
  const results: Flaws[] = [], flagMaps = new Map<string, Uint8Array>();
  for (const [i, j] of wins) {
    const file = join(dir, `${i}_${j}.png`), { flaws, flags } = await windowFlaws(ctx, i, j, file);
    if (have.has(`${i + 1}_${j}`)) flaws.seamRight = await seam(file, join(dir, `${i + 1}_${j}.png`), "right");
    if (have.has(`${i}_${j + 1}`)) flaws.seamBottom = await seam(file, join(dir, `${i}_${j + 1}.png`), "bottom");
    const qa = join(work, `${i}_${j}`, "qa.json");
    if (existsSync(qa)) flaws.match = readJson(qa).score;
    results.push(flaws); flagMaps.set(flaws.window, flags);
  }
  writeFileSync(join(out, "audit.json"), JSON.stringify(results, null, 1));
  // summary
  const pct = (v: number) => `${(v * 100).toFixed(1)} %`;
  const mean = (k: keyof Flaws) => results.reduce((s, r) => s + ((r[k] as number) || 0), 0) / results.length;
  const pooled = (n: "grassCells" | "crownCells", k: keyof Flaws) => results.reduce((s, r) => s + (r[k] as number) * (r[n] as number), 0) / Math.max(1, results.reduce((s, r) => s + (r[n] as number), 0));
  const greens = (n: "grassCells" | "crownCells", p: "grass" | "crown") =>
    `hue ${pooled(n, `${p}DH` as keyof Flaws).toFixed(1)}°, saturation ${pooled(n, `${p}DS` as keyof Flaws).toFixed(3)}, value ${pooled(n, `${p}DV` as keyof Flaws).toFixed(3)}`;
  console.log(`${results.length} windows. mean pedAsphalt ${pct(mean("pedAsphalt"))}, pedObjects ${pct(mean("pedObjects"))}, redWalls ${pct(mean("redWalls"))}, streetTrees ${pct(mean("streetTrees"))}; painted minus render: grass ${greens("grassCells", "grass")}, crowns ${greens("crownCells", "crown")}`);
  // every flaw with a severity, worst first
  const found: Array<{ type: string; r: Flaws; v: number; sev: number }> = [];
  for (const r of results) for (const [type, f] of Object.entries(SEVERITY)) {
    const v = f.value(r), sev = v === undefined ? 0 : f.levels.findIndex((t) => (f.below ? v < t : v >= t)) === -1 ? 0 : 3 - f.levels.findIndex((t) => (f.below ? v < t : v >= t));
    if (sev > 0) found.push({ type, r, v: v!, sev });
  }
  found.sort((a, b) => b.sev - a.sev || b.v / SEVERITY[b.type].levels[2] - a.v / SEVERITY[a.type].levels[2]);
  rmSync(join(out, "crops"), { recursive: true, force: true });
  mkdirSync(join(out, "crops"), { recursive: true });
  const rows: string[] = [], sheet: string[] = [];
  for (const w of found) {
    const [i, j] = w.r.window.split("_").map(Number), bit = TYPES[w.type as keyof typeof TYPES];
    let file = "";
    if (bit && sheet.length < Number(args.crops) * 3) { // crops for the cell-level flaw types
      const flags = flagMaps.get(w.r.window)!;
      // the 384 px box holding the most flagged cells (summed-area table over the cell flags)
      const B = 384 / CELL, sat = new Int32Array((N + 1) * (N + 1));
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
        sat[(y + 1) * (N + 1) + x + 1] = (flags[y * N + x] & bit ? 1 : 0) + sat[y * (N + 1) + x + 1] + sat[(y + 1) * (N + 1) + x] - sat[y * (N + 1) + x];
      let n = 0, bx = 0, by = 0;
      for (let y = 0; y + B <= N; y += 4) for (let x = 0; x + B <= N; x += 4) {
        const c = sat[(y + B) * (N + 1) + x + B] - sat[y * (N + 1) + x + B] - sat[(y + B) * (N + 1) + x] + sat[y * (N + 1) + x];
        if (c > n) { n = c; bx = x; by = y; }
      }
      if (n) {
        const S = 384, left = bx * CELL, top = by * CELL;
        const render = await sharp((await crop(ctx, "render", i * STRIDE, j * STRIDE)) as Buffer, { raw: { width: WIN, height: WIN, channels: 3 } }).extract({ left, top, width: S, height: S }).png().toBuffer();
        const paint = await sharp(join(dir, `${w.r.window}.png`)).removeAlpha().resize(WIN, WIN).extract({ left, top, width: S, height: S }).png().toBuffer();
        const mark = Buffer.alloc(N * N * 4);
        for (let k = 0; k < N * N; k++) if (flags[k] & bit) mark.set([255, 0, 255, 150], k * 4);
        const overlay = await sharp(mark, { raw: { width: N, height: N, channels: 4 } }).resize(WIN, WIN, { kernel: "nearest" }).extract({ left, top, width: S, height: S }).png().toBuffer();
        file = join(out, "crops", `${w.type}_${w.r.window}.jpg`);
        await sharp({ create: { width: S * 3 + 16, height: S, channels: 3, background: "#fff" } })
          .composite([{ input: render, left: 0, top: 0 }, { input: paint, left: S + 8, top: 0 }, { input: await sharp(paint).composite([{ input: overlay }]).png().toBuffer(), left: 2 * S + 16, top: 0 }])
          .jpeg({ quality: 88 }).toFile(file);
        sheet.push(file);
      }
    }
    rows.push(`| ${w.r.window} | ${placeOf(ctx, i, j)} | ${w.type} | ${["", "low", "medium", "high"][w.sev]} | ${SEVERITY[w.type].show(w.v)} | ${file} |`);
  }
  const counts = Object.keys(SEVERITY).map((t) => `${t} ${found.filter((f) => f.type === t).length} (high ${found.filter((f) => f.type === t && f.sev === 3).length})`);
  writeFileSync(join(out, "flaws.md"), `# Paint audit: ${areaName}${args.tag ? ` --tag ${args.tag}` : ""}\n\n${results.length} windows. Flaws per type (windows): ${counts.join(", ")}.\n`
    + `Painted minus render on the same cells: grass ${greens("grassCells", "grass")}; crowns ${greens("crownCells", "crown")}.\n\n`
    + `Crops: render | painting | painting with the flagged cells in magenta.\n\n| Window | Place | Flaw | Severity | Value | Crop |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`);
  // contact sheet of the worst crops (one per window and type, at most --crops)
  const pick = sheet.slice(0, Number(args.crops));
  if (pick.length) {
    const cw = 1168, ch = 384, cols = 2, scale = 0.5, W = Math.round(cw * scale), H = Math.round(ch * scale);
    const tiles = await Promise.all(pick.map((f) => sharp(f).resize(W, H).toBuffer()));
    await sharp({ create: { width: cols * W + (cols - 1) * 8, height: Math.ceil(pick.length / cols) * (H + 8), channels: 3, background: "#fff" } })
      .composite(tiles.map((t, k) => ({ input: t, left: (k % cols) * (W + 8), top: Math.floor(k / cols) * (H + 8) }))).jpeg({ quality: 88 }).toFile(join(out, "flaws.jpg"));
  }
  console.log(`flaws: ${counts.join(", ")}; ${join(out, "flaws.md")}`);
}
