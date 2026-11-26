/**
 * Vegetation colour transfer (Local.matchVegetation in paint.ts): the painter's grass and tree crowns drift duller
 * and yellower than the styled render around a painted patch. Per window, measure the render's and the painting's
 * grass and crowns on the SAME cells (paintaudit.ts classes: ground grass cells and above-ground cells where the
 * render is green), pool the statistics over the 3×3 windows around it (neighbours get nearly the same correction,
 * so seams stay quiet), and shift only green pixels of the painting by the hue difference and the saturation and
 * value ratios. Texture and shading stay; roofs, copper, water and paving are not green and stay untouched.
 *
 *   npm -w pipeline exec tsx src/vegetation.ts krakow-test --tag krakow-pilot-2 --measure
 *   npm -w pipeline exec tsx src/vegetation.ts krakow-test --tag krakow-pilot-2 --out-tag krakow-pilot-2c
 *     (corrected copies of every window; then `npm run paint -- krakow-test --tag krakow-pilot-2c --assemble`)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { auditContext, cells, crop, type Ctx, GRASS, hsv, windowClasses } from "./paintaudit.ts";
import { writeAtomic } from "./paths.ts";

const WIN = 1024, STRIDE = 896, CELL = 4, N = WIN / CELL;
type Sums = number[]; // n, painted h s v, render h s v
interface Stats { grass: Sums; crown: Sums; mtime: number }
const empty = (): Sums => [0, 0, 0, 0, 0, 0, 0];

/**
 * Weight of a painted pixel as vegetation: green hues only, some colour. Copper roofs are painted at hue 145–165
 * (peak 150–155, measured on the Cloth Hall and the Franciscan friary): the window ends below them.
 */
function vegWeight(h: number, s: number, v: number) {
  const hw = h < 40 || h > 138 ? 0 : h < 50 ? (h - 40) / 10 : h > 128 ? (138 - h) / 10 : 1;
  const sw = s < 0.1 ? 0 : s < 0.18 ? (s - 0.1) / 0.08 : 1;
  return v < 0.08 ? 0 : hw * sw;
}
const renderGreen = (r: number, g: number, b: number) => { const [h, s] = hsv(r, g, b); return h >= 50 && h <= 150 && s > 0.2; };

/** Grass and crown statistics of one window, render and painting on the same cells. */
export async function windowStats(ctx: Ctx, i: number, j: number, painting: string | Buffer): Promise<Stats> {
  const cls = await windowClasses(ctx, i, j, false);
  const R = cells((await crop(ctx, "render", i * STRIDE, j * STRIDE)) as Buffer);
  const P = await sharp(painting).removeAlpha().resize(WIN, WIN).raw().toBuffer();
  const out: Stats = { grass: empty(), crown: empty(), mtime: typeof painting === "string" ? statSync(painting).mtimeMs : 0 };
  for (let k = 0; k < N * N; k++) {
    const kind = cls[k] === GRASS ? "grass" : cls[k] === -1 ? "crown" : null;
    if (!kind || !renderGreen(R[k * 3], R[k * 3 + 1], R[k * 3 + 2])) continue;
    // the painting's green pixels in this cell
    let n = 0, ph = 0, ps = 0, pv = 0;
    const cx = (k % N) * CELL, cy = Math.floor(k / N) * CELL;
    for (let y = cy; y < cy + CELL; y++) for (let x = cx; x < cx + CELL; x++) {
      const o = (y * WIN + x) * 3, [h, s, v] = hsv(P[o], P[o + 1], P[o + 2]), w = vegWeight(h, s, v);
      if (w < 0.5) continue;
      n++; ph += h; ps += s; pv += v;
    }
    if (n < CELL * CELL / 2) continue; // the painter put something else here (a path, a shadowed gap)
    const [rh, rs, rv] = hsv(R[k * 3], R[k * 3 + 1], R[k * 3 + 2]), t = out[kind];
    t[0]++; t[1] += ph / n; t[2] += ps / n; t[3] += pv / n; t[4] += rh; t[5] += rs; t[6] += rv;
  }
  return out;
}

/** Hue shift and saturation/value ratios that bring the painting's means to the render's. */
export function transfer(t: Sums) {
  if (t[0] < 50) return null; // too few cells to say
  const clamp = (x: number) => Math.min(1.8, Math.max(0.6, x));
  return { dh: Math.max(-25, Math.min(25, (t[4] - t[1]) / t[0])), ks: clamp(t[5] / t[2]), kv: clamp(t[6] / t[3]) };
}
export type Transfer = ReturnType<typeof transfer>;

/** Shift the green pixels of a raw 1024² RGB window: crowns above ground, grass on it. */
export function applyTransfer(px: Buffer, cls: Int8Array, grass: Transfer, crown: Transfer) {
  for (let y = 0; y < WIN; y++) for (let x = 0; x < WIN; x++) {
    const c = cls[Math.floor(y / CELL) * N + Math.floor(x / CELL)], t = c === -1 ? crown : grass;
    if (!t) continue;
    const o = (y * WIN + x) * 3, [h, s, v] = hsv(px[o], px[o + 1], px[o + 2]), w = vegWeight(h, s, v);
    if (!w) continue;
    const h2 = (h + t.dh * w + 360) % 360, s2 = Math.min(1, s * (1 + (t.ks - 1) * w)), v2 = Math.min(1, v * (1 + (t.kv - 1) * w));
    // HSV -> RGB
    const C = v2 * s2, X = C * (1 - Math.abs(((h2 / 60) % 2) - 1)), m = v2 - C, sec = Math.floor(h2 / 60) % 6;
    const [r, g, b] = [[C, X, 0], [X, C, 0], [0, C, X], [0, X, C], [X, 0, C], [C, 0, X]][sec];
    px[o] = Math.round((r + m) * 255); px[o + 1] = Math.round((g + m) * 255); px[o + 2] = Math.round((b + m) * 255);
  }
  return px;
}

/** Per-window statistics of one tag's windows, cached (vegetation.json next to the windows) by file time. */
export class VegetationCache {
  private data: Record<string, Stats>;
  constructor(private ctx: Ctx, private dir: string) {
    const f = join(dir, "..", `${dir.split("/").pop()}-vegetation.json`);
    this.file = f;
    this.data = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  }
  private file: string;
  async get(i: number, j: number): Promise<Stats | null> {
    const f = join(this.dir, `${i}_${j}.png`);
    if (!existsSync(f)) return null;
    const k = `${i}_${j}`, m = statSync(f).mtimeMs;
    if (this.data[k]?.mtime !== m) this.data[k] = await windowStats(this.ctx, i, j, f);
    return this.data[k];
  }
  save() { writeFileSync(this.file, JSON.stringify(this.data)); }
  /** Transfers for window (i, j) from its own and its 8 neighbours' statistics. */
  async transfers(i: number, j: number) {
    const g = empty(), c = empty();
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const s = await this.get(i + di, j + dj);
      if (!s) continue;
      for (let q = 0; q < 7; q++) { g[q] += s.grass[q]; c[q] += s.crown[q]; }
    }
    return { grass: transfer(g), crown: transfer(c), pooled: { grass: g, crown: c } };
  }
}

/** A window's pixels (raw RGB) with its vegetation matched to the render. */
export async function matchedWindow(ctx: Ctx, cache: VegetationCache, i: number, j: number, px: Buffer) {
  const { grass, crown } = await cache.transfers(i, j);
  if (!grass && !crown) return px;
  return applyTransfer(px, await windowClasses(ctx, i, j, false), grass, crown);
}

const fmt = (t: Sums) => t[0] ? `cells ${t[0]}  painted h ${(t[1] / t[0]).toFixed(1)} s ${(t[2] / t[0]).toFixed(3)} v ${(t[3] / t[0]).toFixed(3)}  render h ${(t[4] / t[0]).toFixed(1)} s ${(t[5] / t[0]).toFixed(3)} v ${(t[6] / t[0]).toFixed(3)}` : "no cells";

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { tag: { type: "string" }, measure: { type: "boolean", default: false }, "out-tag": { type: "string" } } });
  const area = positionals[0] ?? "krakow-test", ctx = await auditContext(area);
  const dir = join(ctx.base, `windows${args.tag ? `-${args.tag}` : ""}`);
  const wins = readdirSync(dir).filter((f) => /^-?\d+_-?\d+\.png$/.test(f)).map((f) => f.slice(0, -4).split("_").map(Number));
  const cache = new VegetationCache(ctx, dir);
  const total = { grass: empty(), crown: empty() };
  for (const [i, j] of wins) { const s = (await cache.get(i, j))!; for (let q = 0; q < 7; q++) { total.grass[q] += s.grass[q]; total.crown[q] += s.crown[q]; } }
  cache.save();
  console.log(`${args.tag ?? "untagged"}: ${wins.length} windows\n  grass  ${fmt(total.grass)}\n  crowns ${fmt(total.crown)}`);
  if (args["out-tag"]) {
    const out = join(ctx.base, `windows-${args["out-tag"]}`);
    mkdirSync(out, { recursive: true });
    for (const [i, j] of wins) {
      const px = await sharp(join(dir, `${i}_${j}.png`)).removeAlpha().resize(WIN, WIN).raw().toBuffer();
      await writeAtomic(sharp(await matchedWindow(ctx, cache, i, j, px), { raw: { width: WIN, height: WIN, channels: 3 } }).png(), join(out, `${i}_${j}.png`));
    }
    console.log(`  corrected windows in ${out}`);
  }
}
