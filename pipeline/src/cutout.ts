/**
 * Painted landmarks on the procedural map: one window painted around a single building (paint.ts --tag),
 * and only that building, cut out along its exact LoD2 silhouette, goes onto the render. The ground around
 * it stays procedural, so there is no patch edge. Places (airport, stadium, squares) are painted as window
 * patches instead.
 *
 *   npm -w pipeline exec tsx src/cutout.ts stuttgart-core --plan rosenstein 48.8005,9.2057
 *       → which window to paint, and the paint command (it goes to windows-cutout-rosenstein/)
 *   npm -w pipeline exec tsx src/cutout.ts stuttgart-core --add rosenstein 48.8005,9.2057
 *       → records the cutout in <area>/cutouts.json and composes the tiles
 *   npm -w pipeline exec tsx src/cutout.ts stuttgart-north-east --plan rbk --lot 5385339
 *       → a property instead of one building: the OSM lot polygon on the terrain plus every LoD2 building
 *         standing in it, minus whatever outside the lot stands in front; clipped to one window (--window i,j)
 *   npm -w pipeline exec tsx src/cutout.ts stuttgart-core --plan hbf --lot r13217418,756337804 --windows auto
 *       → a lot bigger than one window: several OSM ways / relations (r<id>) as one lot, painted over a block of
 *         grid windows (paint.ts --window "i,j;i,j;…" continues each from its painted neighbours); the cut reads
 *         the assembled paint-cutout-<name>/ tiles. A lot that is itself a construction site keeps its sites.
 *   npm -w pipeline exec tsx src/cutout.ts stuttgart-core          # recompose every cutout (after a re-render)
 *   npm -w pipeline exec tsx src/cutout.ts krakow-test --tag krakow-pilot-2c
 *       → an experiment's cutouts (landmark.ts --tag): cutouts-<tag>.json over paint-<tag>/, into cutout-<tag>/
 *
 * Tiles go to <area>/cutout/<tx>_<ty>.png: the tile as the map shows it (the area's painted tile where there is one,
 * else the render) with the cutout on top; export layers them as render < paint < cutout.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { openArea } from "./areas.ts";
import { axes, CAMERA, ecefToEnu, enuHeight, enuToLlh, enuToPixel, llhToEcef } from "./camera.ts";
import { readHeights } from "./heights.ts";
import { lod2Files } from "./lgl.ts";
import { type Lod2Building, parseLod2 } from "./lod2.ts";
import { DERIVED, RAW, readJson, writeAtomic } from "./paths.ts";
import { REGIONS } from "./places.ts";

type P2 = [number, number];
/** a screen triangle: art px x, y and ellipsoid height per vertex */
type Tri = Array<[number, number, number]>;
/** lot: an OSM way id (ground.json): the whole property is painted, cut along its boundary, not along the walls */
// grow: art px the lot outline is widened by, for paintings that spill over it (the Wasen's beer tents onto the promenade)
// key: the mask comes from an AI cut-out instead of the lot: a white-on-black PNG (area-relative path) covering the
// global art-px box `frame` (the overview painting's frame, any resolution), widened by `grow` px and softened over
// `feather` px (Gaussian sigma) so the painting fades into the map
/** `art`: one painting covering exactly `frame` (an overview painted at native scale), used instead of windows */
interface Key { mask: string; frame: [number, number, number, number]; grow?: number; feather?: number; art?: string }
interface Cutout { name: string; at?: [number, number]; window?: [number, number]; windows?: Array<[number, number]>; lot?: number | string[]; grow?: number; key?: Key }
/** the art px rectangle a cutout's mask covers: one window, or the bounding box of a block of windows */
type Frame = { ox: number; oy: number; w: number; h: number };
const frameOf = (wins: Array<[number, number]>): Frame => {
  const is = wins.map((w) => w[0]), js = wins.map((w) => w[1]);
  const ox = Math.min(...is) * STRIDE, oy = Math.min(...js) * STRIDE;
  return { ox, oy, w: Math.max(...is) * STRIDE + WIN - ox, h: Math.max(...js) * STRIDE + WIN - oy };
};

const WIN = 1024, STRIDE = 896, T = CAMERA.tile;
/** silhouette grown by GROW px (the painted outline), anti-aliased over ~1 px */
const GROW = 1.5;
/** the height pass is this much above the building's own surface: something stands in front of it. Small:
 *  a tree a metre in front of a wall is only ~1 m above the wall point behind it on the same line of sight;
 *  both heights are sampled at the same pixel centre, so the building itself matches to centimetres. */
const IN_FRONT = 0.4;
const CELL = 4; // height pass resolution (art px)
/** room a silhouette needs to the window edge (the painter is least reliable at the border) */
const MARGIN = 48;

const argv = process.argv.slice(2), tagAt = argv.indexOf("--tag"), TAG = tagAt >= 0 ? argv.splice(tagAt, 2)[1] : "";
const SUFFIX = TAG ? `-${TAG}` : "";
const [name, ...rest] = argv;
if (!name) throw new Error("usage: cutout.ts <area> [--plan|--add <name> <lat,lon>] [--tag <tag>]");
const area = openArea(name);
const base = join(DERIVED, name);
const listFile = join(base, `cutouts${SUFFIX}.json`);
const list: Cutout[] = existsSync(listFile) ? readJson(listFile) : [];

/** the LoD2 building at (lat, lon) and every building part touching it (wings, towers) */
function buildingsAt(lat: number, lon: number): Lod2Building[] {
  const m = 0.003, box = [lat - m, lon - m, lat + m, lon + m];
  const all = [...lod2Files(box)].flatMap((f) => parseLod2(f.xml, box, REGIONS[area.region].geoidM));
  const e = ecefToEnu(llhToEcef(lat, lon, 0)), p: P2 = [e[0], e[1]];
  const seed = all.find((b) => inside(p, b.footprint));
  if (!seed) throw new Error(`no LoD2 building at ${lat},${lon}`);
  const picked = [seed];
  for (let grew = true; grew;) {
    grew = false;
    for (const b of all) if (!picked.includes(b) && picked.some((q) => gap(b.footprint, q.footprint) < 1.5)) { picked.push(b); grew = true; }
  }
  return picked;
}

/** ENU ground height (ground.ts grid, bilinear) */
const gmeta = readJson(join(base, "ground", "meta.json"));
const gbuf = readFileSync(join(base, "ground", "height.bin")), gh = new Float32Array(gbuf.buffer, gbuf.byteOffset, gbuf.length / 4);
function groundAt(e: number, n: number) {
  const fx = Math.max(0, Math.min(gmeta.nx - 1.001, (e - gmeta.x0) / gmeta.step)), fy = Math.max(0, Math.min(gmeta.ny - 1.001, (n - gmeta.y0) / gmeta.step));
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, v = (a: number, b: number) => gh[b * gmeta.nx + a];
  return (v(ix, iy) * (1 - ax) + v(ix + 1, iy) * ax) * (1 - ay) + (v(ix, iy + 1) * (1 - ax) + v(ix + 1, iy + 1) * ax) * ay;
}

/**
 * the lot ring (ENU) of an OSM way, every LoD2 building whose footprint centre lies in it, and its holes:
 * construction sites in the lot (the aerial shows what is being built, our data doesn't: the painter would
 * invent buildings there), which stay procedural
 */
type LL = { lat: number; lon: number };
type El = { id: number; type: string; tags?: Record<string, string>; geometry?: LL[]; members?: Array<{ role: string; geometry?: LL[] }> };
/** outer rings of a multipolygon relation: its member ways joined end to end */
function joinRings(parts: LL[][]): LL[][] {
  const key = (p: LL) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`, open = parts.map((p) => [...p]), rings: LL[][] = [];
  while (open.length) {
    const r = open.shift()!;
    for (let grew = true; grew && key(r[0]) !== key(r.at(-1)!);) {
      grew = false;
      for (let k = 0; k < open.length; k++) {
        const p = open[k], end = key(r.at(-1)!);
        if (key(p[0]) === end) r.push(...p.slice(1));
        else if (key(p.at(-1)!) === end) r.push(...p.reverse().slice(1));
        else continue;
        open.splice(k, 1); grew = true; break;
      }
    }
    if (r.length > 3) rings.push(r);
  }
  return rings;
}
/**
 * the lot rings (ENU) of OSM ways (id) / relations (r<id>), every LoD2 building whose footprint centre lies in
 * them, and the holes: construction sites in the lot (the aerial shows what is being built, our data doesn't: the
 * painter would invent buildings there), which stay procedural. A lot that is itself a construction site keeps them.
 */
function lotAt(ids: Array<number | string>): { rings: P2[][]; bs: Lod2Building[]; holes: P2[][] } {
  const els: El[] = ["ground.json", "osm.json"].flatMap((f) => existsSync(join(RAW, name, f)) ? readJson(join(RAW, name, f)).elements : []);
  const enu = (g: LL): P2 => { const e = ecefToEnu(llhToEcef(g.lat, g.lon, 0)); return [e[0], e[1]]; };
  const lots: El[] = [], ll: LL[][] = [];
  for (const id of ids) {
    const rel = String(id).startsWith("r"), n = Number(String(id).replace(/^r/, ""));
    const el = els.find((e) => e.id === n && e.type === (rel ? "relation" : "way") && (e.geometry || e.members));
    if (!el) throw new Error(`no OSM ${rel ? "relation" : "way"} ${n} in ${name}'s ground.json / osm.json`);
    lots.push(el);
    ll.push(...(rel ? joinRings(el.members!.filter((m) => m.role === "outer" && m.geometry).map((m) => m.geometry!)) : [el.geometry!]));
  }
  const rings = ll.map((r) => r.map(enu));
  const lats = ll.flat().map((g) => g.lat), lons = ll.flat().map((g) => g.lon);
  const box = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  const all = [...lod2Files(box)].flatMap((f) => parseLod2(f.xml, box, REGIONS[area.region].geoidM));
  const centre = (r: P2[]): P2 => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
  const inLot = (p: P2) => rings.some((r) => inside(p, r));
  const site = lots.some((e) => e.tags?.landuse === "construction");
  const holes = site ? [] : els.filter((e) => e.type === "way" && !lots.includes(e) && e.geometry && e.tags?.landuse === "construction")
    .map((e) => e.geometry!.map(enu)).filter((h) => inLot(centre(h)));
  return { rings, bs: all.filter((b) => inLot(centre(b.footprint))), holes };
}

/** the lot's boundary on the terrain, in global art px (1 m steps) */
function lotScreen(ring: P2[]): P2[] {
  const out: P2[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = 0; s < L; s += 1) {
      const e = a[0] + ((b[0] - a[0]) * s) / L, n = a[1] + ((b[1] - a[1]) * s) / L;
      out.push(enuToPixel([e, n, groundAt(e, n)]));
    }
  }
  return out;
}

/** what a cutout covers: its buildings (and lot) */
function shapeOf(c: { at?: [number, number]; lot?: number | string[] }) {
  if (c.lot) { const { rings, bs, holes } = lotAt(Array.isArray(c.lot) ? c.lot : [c.lot]); return { bs, tris: silhouette(bs), rings, holes }; }
  const bs = buildingsAt(...c.at!);
  return { bs, tris: silhouette(bs), rings: undefined as P2[][] | undefined, holes: [] as P2[][] };
}

const inside = (p: P2, ring: P2[]) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    if (ring[i][1] > p[1] !== ring[j][1] > p[1] && p[0] < ((ring[j][0] - ring[i][0]) * (p[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) c = !c;
  return c;
};
const segDist = (p: P2, a: P2, b: P2) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const gap = (r: P2[], s: P2[]) => Math.min(
  ...r.flatMap((p) => s.map((_, i) => segDist(p, s[i], s[(i + 1) % s.length]))),
  ...s.flatMap((p) => r.map((_, i) => segDist(p, r[i], r[(i + 1) % r.length]))),
);

/** screen triangles (global art px + height) of the buildings' roofs and walls */
function silhouette(bs: Lod2Building[]): Tri[] {
  const tris: Tri[] = [];
  const at = (e: number, n: number, u: number): [number, number, number] => [...enuToPixel([e, n, u]), enuHeight([e, n, u])];
  for (const b of bs) {
    for (let k = 0; k + 9 <= b.roof.length; k += 9) tris.push([0, 1, 2].map((v) => at(b.roof[k + v * 3], b.roof[k + v * 3 + 1], b.roof[k + v * 3 + 2])));
    for (let k = 0; k + 15 <= b.wall.length; k += 15) tris.push([0, 1, 2].map((v) => at(b.wall[k + v * 5], b.wall[k + v * 5 + 1], b.wall[k + v * 5 + 2])));
  }
  return tris;
}

/** ENU ground position of the surface seen at global art pixel (x, y) with ellipsoid height h */
function pixelToEnu(x: number, y: number, h: number): P2 {
  const { right: r, up: v } = axes();
  let e = 0, n = 0;
  for (let it = 0; it < 3; it++) { // enuHeight adds the earth's curvature: solve for u, then e, n again
    const u = h - (e * e + n * n) / (2 * 6371000), a = x * CAMERA.mpp, b = -y * CAMERA.mpp - u * v[2], det = r[0] * v[1] - r[1] * v[0];
    e = (a * v[1] - b * r[1]) / det; n = (r[0] * b - v[0] * a) / det;
  }
  return [e, n];
}

/**
 * Cells (CELL px, window grid) where something stands in front of the building: along a pixel's line of sight
 * everything nearer the camera is higher, so a height pass well above the building's own surface there
 * (the highest of its triangles at that pixel) is a tree, mast or other building in front. Grown by a cell.
 */
async function inFront(tris: Tri[], { ox, oy, w, h }: Frame, bs: Lod2Building[], rings?: P2[][], left: Lod2Building[] = [], holes: P2[][] = []) {
  // the renderer's own roof furniture (plant rooms, solar, AC units, eaves) stands on the footprint: not in front
  const on = (list: Lod2Building[]) => (p: P2) => list.some((b) => inside(p, b.footprint) || b.footprint.some((q, k) => segDist(p, q, b.footprint[(k + 1) % b.footprint.length]) < 1));
  const onBuilding = on(bs), onLeft = on(left);
  const n = w / CELL, nh = h / CELL;
  const own = new Float32Array(n * nh).fill(-Infinity);
  for (const t of tris) {
    const [a, b, c] = t.map(([x, y, h]) => [(x - ox) / CELL - 0.5, (y - oy) / CELL - 0.5, h]);
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-9) continue;
    for (let cy = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))); cy <= Math.min(nh - 1, Math.ceil(Math.max(a[1], b[1], c[1]))); cy++)
      for (let cx = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))); cx <= Math.min(n - 1, Math.ceil(Math.max(a[0], b[0], c[0]))); cx++) {
        const w0 = ((b[1] - c[1]) * (cx - c[0]) + (c[0] - b[0]) * (cy - c[1])) / d, w1 = ((c[1] - a[1]) * (cx - c[0]) + (a[0] - c[0]) * (cy - c[1])) / d, w2 = 1 - w0 - w1;
        if (w0 < -0.05 || w1 < -0.05 || w2 < -0.05) continue;
        const k = cy * n + cx;
        own[k] = Math.max(own[k], w0 * a[2] + w1 * b[2] + w2 * c[2]);
      }
  }
  const front = new Uint8Array(n * nh);
  for (let tx = Math.floor(ox / T); tx <= Math.floor((ox + w - 1) / T); tx++)
    for (let ty = Math.floor(oy / T); ty <= Math.floor((oy + h - 1) / T); ty++) {
      const f = join(base, "height", `${tx}_${ty}.png`);
      if (!existsSync(f)) continue;
      const hp = await readHeights(f), m = T / CELL;
      for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
        const cx = (tx * T - ox) / CELL + x, cy = (ty * T - oy) / CELL + y;
        if (cx < 0 || cy < 0 || cx >= n || cy >= nh) continue;
        const k = cy * n + cx, v = hp[y * m + x];
        const p = pixelToEnu(ox + (cx + 0.5) * CELL, oy + (cy + 0.5) * CELL, v);
        if (rings) { // lot: anything raised (tree, building, mast) seen here that stands outside the lot, or on a building left out, is cut
          if (!onBuilding(p) && (!rings.some((r) => inside(p, r)) || onLeft(p) || holes.some((h) => inside(p, h))) && v > enuHeight([p[0], p[1], groundAt(p[0], p[1])]) + 1.5) front[k] = 1;
        } else if (own[k] > -Infinity && v > own[k] + IN_FRONT && !onBuilding(p)) front[k] = 1;
      }
    }
  const grown = new Uint8Array(n * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < n; x++) if (front[y * n + x])
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < n && y + dy < nh) grown[(y + dy) * n + x + dx] = 255;
  return grown;
}

const bounds = (tris: Tri[]) => {
  const xs = tris.flat().map((p) => p[0]), ys = tris.flat().map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** the grid window that holds the silhouette with the most room to its edges */
function pickWindow(tris: Tri[]): { win: [number, number]; room: number } {
  const [x0, y0, x1, y1] = bounds(tris);
  let best = { win: [0, 0] as [number, number], room: -Infinity };
  // half steps too: a cutout window is painted alone (its own --tag folder, no neighbours), so it needn't sit
  // on the patch grid, and a building that straddles two grid rows still gets a window with room round it
  for (let i = Math.floor(x1 / STRIDE) - 1; i <= x0 / STRIDE; i += 0.5)
    for (let j = Math.floor(y1 / STRIDE) - 1; j <= y0 / STRIDE; j += 0.5) {
      const room = Math.min(x0 - i * STRIDE, y0 - j * STRIDE, i * STRIDE + WIN - x1, j * STRIDE + WIN - y1);
      if (room > best.room) best = { win: [i, j], room };
    }
  return best;
}

/** alpha mask in window pixels: the silhouette (anti-aliased edge) minus whatever stands in front of it */
async function mask(tris: Tri[], fr: Frame, bs: Lod2Building[], rings?: P2[][], holes: P2[][] = [], grow = 0) {
  const { ox, oy, w: W, h: H } = fr, pt = (p: number[]) => `${(p[0] - ox).toFixed(1)},${(p[1] - oy).toFixed(1)}`;
  // a lot: only buildings wholly inside the window's inner part are painted; one the window edge would slice
  // through stays procedural as a whole (the cut then runs through ground only)
  let left: Lod2Building[] = [];
  if (rings) {
    const fits = (b: Lod2Building) => { const [x0, y0, x1, y1] = bounds(silhouette([b])); return x0 >= ox + MARGIN && y0 >= oy + MARGIN && x1 < ox + W - MARGIN && y1 < oy + H - MARGIN; };
    left = bs.filter((b) => !fits(b)); bs = bs.filter(fits); tris = silhouette(bs);
  }
  const g = (ts: Tri[], fill: string) => `<g fill="${fill}" stroke="${fill}" stroke-width="${GROW * 2}" stroke-linejoin="round">${ts.map((t) => `<polygon points="${t.map(pt).join(" ")}"/>`).join("")}</g>`;
  const lot = rings ? `${rings.map((r) => `<polygon fill="white" stroke="white" stroke-width="${2 * grow}" stroke-linejoin="round" points="${lotScreen(r).map(pt).join(" ")}"/>`).join("")}${holes.map((h) => `<polygon fill="black" points="${lotScreen(h).map(pt).join(" ")}"/>`).join("")}${g(silhouette(left), "black")}` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="black"/>${lot}${g(tris, "white")}</svg>`;
  const sil = await sharp(Buffer.from(svg), { limitInputPixels: false }).extractChannel(0).raw().toBuffer();
  const front = await sharp(await inFront(tris, fr, bs, rings, left, holes), { raw: { width: W / CELL, height: H / CELL, channels: 1 } })
    .resize(W, H, { kernel: "nearest" }).extractChannel(0).raw().toBuffer();
  if (sil.length !== W * H || front.length !== W * H) throw new Error("cutout mask: expected one channel");
  // hard edges for now (no feathering): every pixel is painting or render, nothing in between
  const m = rings ? MARGIN : 0; // a lot is clipped to the frame's inner part (the painter is least reliable at the border)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x, edge = x < m || y < m || x >= W - m || y >= H - m;
    sil[k] = !edge && sil[k] >= 128 && front[k] < 128 ? 255 : 0;
  }
  return sil;
}

/** alpha mask in frame pixels from a key mask (see Key): scaled to art px, grown, feathered, clipped to the inner frame */
async function keyMask(k: Key, fr: Frame) {
  const [kx, ky, kw, kh] = k.frame, grow = k.grow ?? 5, feather = k.feather ?? 4;
  const scaled = await sharp(join(base, k.mask)).extractChannel(0).resize(kw, kh, { kernel: "cubic", fit: "fill" }).threshold(128).png().toBuffer();
  // onto the frame (black outside the key's box), extract clips what lies outside the frame
  const pad = Math.max(kw, kh, fr.w, fr.h);
  let m = await sharp({ create: { width: fr.w + 2 * pad, height: fr.h + 2 * pad, channels: 3, background: "#000" }, limitInputPixels: false })
    .composite([{ input: scaled, left: kx - fr.ox + pad, top: ky - fr.oy + pad }]).png().toBuffer();
  m = await sharp(m, { limitInputPixels: false }).extract({ left: pad, top: pad, width: fr.w, height: fr.h }).extractChannel(0).png().toBuffer();
  if (grow > 0) m = await sharp(m).blur(grow / 1.5).threshold(25).extractChannel(0).png().toBuffer(); // ≈ dilate by grow px
  if (feather > 0) m = await sharp(m).blur(feather).extractChannel(0).png().toBuffer();
  const a = await sharp(m).extractChannel(0).raw().toBuffer();
  if (a.length !== fr.w * fr.h) throw new Error("key mask: expected one channel");
  // window paintings are unreliable at their border; a whole-frame `art` image was checked as a whole
  if (!k.art) for (let y = 0; y < fr.h; y++) for (let x = 0; x < fr.w; x++)
    if (x < MARGIN || y < MARGIN || x >= fr.w - MARGIN || y >= fr.h - MARGIN) a[y * fr.w + x] = 0;
  return a;
}

/** the painting under a cutout's frame (RGB): its one window, or a block's assembled paint-cutout-<name>/ tiles */
async function paintedFrame(c: Cutout, fr: Frame): Promise<Buffer | null> {
  if (c.key?.art) return sharp(join(base, c.key.art)).removeAlpha().resize(fr.w, fr.h, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
  if (!c.windows) {
    const win = join(base, `windows-cutout-${c.name}`, `${c.window![0]}_${c.window![1]}.png`);
    if (!existsSync(win)) { console.warn(`  ${c.name}: not painted yet (${win})`); return null; }
    return sharp(win).removeAlpha().resize(WIN, WIN).raw().toBuffer();
  }
  const missing = c.windows.filter(([i, j]) => !existsSync(join(base, `windows-cutout-${c.name}`, `${i}_${j}.png`)));
  if (missing.length) { console.warn(`  ${c.name}: ${missing.length} of ${c.windows.length} windows not painted yet`); return null; }
  const parts = [];
  for (let tx = Math.floor(fr.ox / T); tx <= Math.floor((fr.ox + fr.w - 1) / T); tx++)
    for (let ty = Math.floor(fr.oy / T); ty <= Math.floor((fr.oy + fr.h - 1) / T); ty++) {
      const f = join(base, `paint-cutout-${c.name}`, `${tx}_${ty}.png`);
      if (existsSync(f)) parts.push({ input: await sharp(f).removeAlpha().resize(T, T).toBuffer(), left: tx * T - fr.ox + T, top: ty * T - fr.oy + T });
    }
  const big = await sharp({ create: { width: fr.w + 2 * T, height: fr.h + 2 * T, channels: 3, background: "#000" }, limitInputPixels: false }).composite(parts).png().toBuffer();
  return sharp(big, { limitInputPixels: false }).extract({ left: T, top: T, width: fr.w, height: fr.h }).removeAlpha().raw().toBuffer();
}

/** rebuild every cutout tile of the area: the map's tile (painted, else rendered) + the cutouts over it */
async function compose() {
  const out = join(base, `cutout${SUFFIX}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const tiles = new Map<string, Array<{ fr: Frame; img: Buffer; a: Buffer }>>();
  for (const c of [...list].sort((a, b) => (b.lot || b.key ? 1 : 0) - (a.lot || a.key ? 1 : 0))) { // lots first: buildings go on top
    const fr = c.key?.art ? { ox: c.key.frame[0], oy: c.key.frame[1], w: c.key.frame[2], h: c.key.frame[3] } : frameOf(c.windows ?? [c.window!]);
    const img = await paintedFrame(c, fr);
    if (!img) continue;
    let a: Buffer;
    if (c.key) a = await keyMask(c.key, fr);
    else { const { bs, tris, rings, holes } = shapeOf(c); a = await mask(tris, fr, bs, rings, holes, c.grow ?? 0); }
    for (let tx = Math.floor(fr.ox / T); tx <= Math.floor((fr.ox + fr.w - 1) / T); tx++)
      for (let ty = Math.floor(fr.oy / T); ty <= Math.floor((fr.oy + fr.h - 1) / T); ty++)
        tiles.set(`${tx}_${ty}`, [...(tiles.get(`${tx}_${ty}`) ?? []), { fr, img, a }]);
  }
  for (const [k, cuts] of tiles) {
    const [tx, ty] = k.split("_").map(Number), painted = join(base, `paint${SUFFIX}`, `${k}.png`), render = join(base, "render", `${k}.png`);
    if (!existsSync(render)) continue;
    const px = await sharp(existsSync(painted) ? painted : render).removeAlpha().resize(T, T).raw().toBuffer();
    let used = 0;
    for (const { fr, img, a } of cuts) {
      const dx = tx * T - fr.ox, dy = ty * T - fr.oy; // tile origin in frame px
      for (let y = 0; y < T; y++) {
        const wy = y + dy;
        if (wy < 0 || wy >= fr.h) continue;
        for (let x = 0; x < T; x++) {
          const wx = x + dx;
          if (wx < 0 || wx >= fr.w) continue;
          const al = a[wy * fr.w + wx] / 255;
          if (!al) continue;
          used++;
          for (let ch = 0; ch < 3; ch++) px[(y * T + x) * 3 + ch] = Math.round(px[(y * T + x) * 3 + ch] * (1 - al) + img[(wy * fr.w + wx) * 3 + ch] * al);
        }
      }
    }
    if (used) await writeAtomic(sharp(px, { raw: { width: T, height: T, channels: 3 } }).png(), join(out, `${k}.png`));
  }
  console.log(`  ${list.length} cutouts -> ${out}`);
}

const flag = rest[0];
if (flag === "--plan" || flag === "--add") {
  const cname = rest[1], opt = (k: string) => { const i = rest.indexOf(k); return i > 0 ? rest[i + 1] : undefined; };
  const lotIds = opt("--lot")?.split(","), ll = lotIds ? undefined : rest[2];
  if (!cname || (!lotIds && !ll)) throw new Error(`usage: cutout.ts <area> ${flag} <name> <lat,lon> | --lot <way>[,r<relation>,…] [--window i,j | --windows auto|"i,j;i,j"] [--grow px]`);
  const lot: number | string[] | undefined = !lotIds ? undefined : lotIds.length === 1 && /^\d+$/.test(lotIds[0]) ? Number(lotIds[0]) : lotIds;
  let at = ll?.split(",").map(Number) as [number, number];
  const { bs, tris, rings, holes } = shapeOf({ at, lot });
  if (rings) { const all = rings.flat(), c = all.reduce((a, p) => [a[0] + p[0] / all.length, a[1] + p[1] / all.length], [0, 0]); const g = enuToLlh([c[0], c[1], 0]); at = [+g[0].toFixed(5), +g[1].toFixed(5)]; }
  const outline: Tri[] = rings ? [...tris, ...rings.flatMap((r) => lotScreen(r).map((p) => [[p[0], p[1], 0]] as Tri))] : tris;
  const [x0, y0, x1, y1] = bounds(outline);
  // a block of grid windows round the whole lot (plus MARGIN), or the one window with most room
  let wins: Array<[number, number]>;
  const wopt = opt("--windows");
  if (wopt === "auto") {
    const i0 = Math.floor((x0 - MARGIN) / STRIDE), j0 = Math.floor((y0 - MARGIN) / STRIDE);
    const i1 = Math.max(i0, Math.ceil((x1 + MARGIN - WIN) / STRIDE)), j1 = Math.max(j0, Math.ceil((y1 + MARGIN - WIN) / STRIDE));
    wins = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) wins.push([i, j]);
  } else if (wopt) wins = wopt.split(";").map((w) => w.split(",").map(Number) as [number, number]);
  else wins = [(opt("--window")?.split(",").map(Number) as [number, number]) ?? pickWindow(tris).win];
  const fr = frameOf(wins), room = Math.min(x0 - fr.ox, y0 - fr.oy, fr.ox + fr.w - x1, fr.oy + fr.h - y1);
  console.log(`  ${cname}: ${bs.length} LoD2 part(s)${rings ? ` on lot ${lotIds!.join(",")}${holes.length ? `, ${holes.length} construction hole(s)` : ""}` : ""}, ${Math.round(x1 - x0)}×${Math.round(y1 - y0)} px, ${wins.length} window(s) ${wins.map((w) => w.join(",")).join(" ")}, ${Math.round(room)} px to the edge`);
  if (room < MARGIN && !rings) throw new Error(`no grid window holds ${cname} with ${MARGIN} px room`);
  const winArg = wins.map((w) => w.join(",")).join(";");
  if (flag === "--plan") {
    // preview: the render under the frame, lot / silhouette tinted (check it sits on the ground and buildings)
    const parts = [];
    for (let tx = Math.floor(fr.ox / T); tx <= Math.floor((fr.ox + fr.w - 1) / T); tx++)
      for (let ty = Math.floor(fr.oy / T); ty <= Math.floor((fr.oy + fr.h - 1) / T); ty++) {
        const f = join(base, "render", `${tx}_${ty}.png`);
        if (existsSync(f)) parts.push({ input: await sharp(f).resize(T, T).toBuffer(), left: tx * T - fr.ox + T, top: ty * T - fr.oy + T });
      }
    const a = await mask(tris, fr, bs, rings, holes, Number(opt("--grow") ?? 0));
    const tint = await sharp({ create: { width: fr.w, height: fr.h, channels: 3, background: { r: 255, g: 0, b: 160 } } })
      .joinChannel(Buffer.from(a.map((v) => v * 0.45)), { raw: { width: fr.w, height: fr.h, channels: 1 } }).png().toBuffer();
    const under = await sharp({ create: { width: fr.w + 2 * T, height: fr.h + 2 * T, channels: 3, background: "#000" }, limitInputPixels: false }).composite(parts).png().toBuffer();
    const preview = join(base, `cutout-${cname}-plan.png`);
    await writeAtomic(sharp(Buffer.from(a), { raw: { width: fr.w, height: fr.h, channels: 1 } }).png(), join(base, `cutout-${cname}-mask.png`)); // the mask alone (frame below)
    await writeAtomic(sharp(await sharp(under, { limitInputPixels: false }).extract({ left: T, top: T, width: fr.w, height: fr.h }).toBuffer()).composite([{ input: tint }]), preview);
    console.log(`  preview: ${preview} (frame ${fr.ox},${fr.oy} ${fr.w}×${fr.h})`);
    console.log(`  aerial: npm -w pipeline exec tsx src/aerial.ts ${name} --near ${at.join(",")} --radius ${Math.max(1, Math.ceil(Math.max(fr.w, fr.h) / T / 2))} --source lgl`);
    console.log(`  paint: npm run paint -- ${name} --window "${winArg}" --tag cutout-${cname} --aerial lgl --aerial-input --look simple`);
  } else {
    const next = list.filter((c) => c.name !== cname);
    next.push({ name: cname, at, window: wins[0], ...(wins.length > 1 ? { windows: wins } : {}), ...(lot ? { lot } : {}), ...(opt("--grow") ? { grow: Number(opt("--grow")) } : {}) });
    list.splice(0, list.length, ...next);
    writeFileSync(listFile, JSON.stringify(list, null, 2));
    await compose();
  }
} else await compose();
