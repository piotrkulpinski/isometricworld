/**
 * Which paint windows a region still needs, and which are worth painting: every window of the region's areas once
 * (areas overlap), whether it touches the region's outline, its share of building footprint (from the scene bins)
 * and whether it is painted already. paint.ts uses windowInfo() for --outline and --min-buildings.
 *
 *   REGION=krakow npm -w pipeline exec tsx src/windowplan.ts [--min-buildings 0.04] [--json <file>]
 *
 * Building share: the summed footprint of buildings of at least MIN_M2 (garden sheds and allotment arbours don't
 * count) inside the window (each footprint sampled every few metres), over the ground the window shows (1024 px at 0.25 m/px, tilted 45°).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AREAS, openArea } from "./areas.ts";
import { activeRegion, CAMERA, enuToPixel } from "./camera.ts";
import { REGIONS } from "./places.ts";
import { insideRing, outlineEdgeDistance, outlinePixels } from "./outline.ts";
import { DATA, DERIVED, readJson } from "./paths.ts";

const WIN = 1024, STRIDE = 896, T = CAMERA.tile;
/** Smaller buildings are sheds, garages and allotment arbours: they don't make a window worth painting. */
export const MIN_M2 = 40;
const GROUND_M2 = (WIN * CAMERA.mpp) ** 2 * Math.SQRT2;

export interface WindowInfo { inside: boolean; share: number; buildings: number; trees: number }
/** Bumped when what a WindowInfo holds changes (the disk cache is rebuilt). */
const VERSION = 2;

/** The windows over an area's render tiles (as paint.ts windows()). */
export function areaWindows(area: string): string[] {
  const out = new Set<string>();
  for (const t of readJson(join(DERIVED, area, "manifest.json")).tiles as Array<{ x: number; y: number }>)
    for (let j = Math.floor((t.y * T - WIN) / STRIDE) + 1; j * STRIDE < (t.y + 1) * T; j++)
      for (let i = Math.floor((t.x * T - WIN) / STRIDE) + 1; i * STRIDE < (t.x + 1) * T; i++) out.add(`${i}_${j}`);
  return [...out];
}

/** Building footprint share per window over an area's scene bins (each building once, by its centre). */
function areaShares(area: string, into: Map<string, { m2: number; n: number; trees: number }>, seen: Set<string>) {
  const add = (px: number, py: number, f: (v: { m2: number; n: number; trees: number }, k: string) => void) => {
    for (let j = Math.floor((py - WIN) / STRIDE) + 1; j * STRIDE <= py; j++)
      for (let i = Math.floor((px - WIN) / STRIDE) + 1; i * STRIDE <= px; i++) {
        const k = `${i}_${j}`, v = into.get(k) ?? { m2: 0, n: 0, trees: 0 };
        f(v, k);
        into.set(k, v);
      }
  };
  const dir = join(DERIVED, area, "scene");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const bin = JSON.parse(readFileSync(join(dir, f), "utf8")), bases: number[] = [];
    for (const m of (bin.m ?? []) as any[]) {
      const fp: number[][] = m[4], roof: number[] = m[2], h: number = m[5];
      if (!fp?.length || !roof?.length) continue;
      const key = `${fp[0][0]},${fp[0][1]},${h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let a = 0, cx = 0, cy = 0;
      for (let k = 0; k < fp.length; k++) { const p = fp[k], q = fp[(k + 1) % fp.length]; a += p[0] * q[1] - q[0] * p[1]; cx += p[0]; cy += p[1]; }
      const m2 = Math.abs(a) / 2;
      if (m2 < MIN_M2) continue;
      let z = Infinity;
      for (let k = 2; k < roof.length; k += 3) z = Math.min(z, roof[k]);
      bases.push(z - h);
      // spread the footprint over points every `step` m inside it (a hall at a window's corner counts only there)
      const xs = fp.map((p) => p[0]), ys = fp.map((p) => p[1]), step = Math.max(3, Math.sqrt(m2) / 8);
      const pts: Array<[number, number]> = [];
      for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step)
        for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) if (insideRing([x, y], fp as Array<[number, number]>)) pts.push([x, y]);
      if (!pts.length) pts.push([cx / fp.length, cy / fp.length]);
      const counted = new Set<string>();
      for (const [x, y] of pts) {
        const [px, py] = enuToPixel([x, y, z - h]);
        add(px, py, (v, k) => { v.m2 += m2 / pts.length; if (!counted.has(k)) { v.n++; counted.add(k); } });
      }
    }
    // tree crowns (π r² each, overlaps counted twice), at the ground of the bin's buildings or the region's
    bases.sort((a, b) => a - b);
    const ground = bases.length ? bases[Math.floor(bases.length / 2)] : REGIONS[activeRegion()].groundH;
    for (const t of (bin.t ?? []) as number[][]) {
      const key = `t${t[0]},${t[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [px, py] = enuToPixel([t[0], t[1], ground]);
      add(px, py, (v) => { v.trees += Math.PI * t[2] * t[2]; });
    }
  }
}

/** Does any of a 9×9 grid of points over the window lie inside the region's outline? (no outline: always) */
function touchesOutline(i: number, j: number) {
  if (!outlinePixels()) return true;
  for (let y = 0; y <= 8; y++) for (let x = 0; x <= 8; x++)
    if (outlineEdgeDistance([i * STRIDE + (x * WIN) / 8, j * STRIDE + (y * WIN) / 8], 1) > 0) return true;
  return false;
}

const cache = new Map<string, Map<string, WindowInfo>>();
/**
 * Every window of the region of `area` (all its areas), with outline and building share. Cached per region, and on
 * disk in data/windowplan/<region>.json until a scene or manifest of its areas changes (reading every scene bin
 * takes ~20 min from a hard disk).
 */
export function regionWindows(area: string): Map<string, WindowInfo> {
  const region = openArea(area).region;
  if (!cache.has(region)) {
    const names = Object.keys(AREAS).filter((a) => AREAS[a].region === region && !AREAS[a].mine && existsSync(join(DERIVED, a, "manifest.json")));
    const stamp = names.map((a) => [join(DERIVED, a, "scene"), join(DERIVED, a, "manifest.json")].map((f) => existsSync(f) ? statSync(f).mtimeMs : 0).join("/")).join(" ");
    const file = join(DATA, "windowplan", `${region}.json`);
    if (existsSync(file)) {
      const saved = readJson(file);
      if (saved.stamp === stamp && saved.minM2 === MIN_M2 && saved.version === VERSION) { cache.set(region, new Map(Object.entries(saved.windows))); openArea(area); return cache.get(region)!; }
    }
    const shares = new Map<string, { m2: number; n: number; trees: number }>(), seen = new Set<string>();
    for (const a of names) areaShares(a, shares, seen);
    const out = new Map<string, WindowInfo>();
    for (const a of names) for (const k of areaWindows(a)) {
      if (out.has(k)) continue;
      const [i, j] = k.split("_").map(Number), s = shares.get(k);
      out.set(k, { inside: touchesOutline(i, j), share: s ? s.m2 / GROUND_M2 : 0, buildings: s?.n ?? 0, trees: s ? s.trees / GROUND_M2 : 0 });
    }
    cache.set(region, out);
    mkdirSync(join(DATA, "windowplan"), { recursive: true });
    writeFileSync(file, JSON.stringify({ stamp, minM2: MIN_M2, version: VERSION, windows: Object.fromEntries(out) }));
  }
  openArea(area);
  return cache.get(region)!;
}

if (process.argv[1]?.endsWith("windowplan.ts")) {
  const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { "min-buildings": { type: "string" }, json: { type: "string" } } });
  const region = positionals[0] ?? process.env.REGION;
  const first = Object.keys(AREAS).find((a) => AREAS[a].region === region && !AREAS[a].mine);
  if (!first) throw new Error(`no areas in region ${region} (a grid region needs REGION=${region})`);
  const wins = regionWindows(first), names = Object.keys(AREAS).filter((a) => AREAS[a].region === region);
  const painted = (k: string) => names.some((a) => existsSync(join(DERIVED, a, "windows", `${k}.png`)));
  const min = Number(args["min-buildings"] ?? 0);
  let all = 0, inside = 0, worth = 0, done = 0, left = 0, leftAll = 0;
  const rows: Record<string, WindowInfo & { painted: boolean }> = {};
  for (const [k, w] of wins) {
    const p = painted(k);
    rows[k] = { ...w, painted: p };
    all++;
    if (!p) leftAll++;
    if (!w.inside) continue;
    inside++;
    if (w.share < min && !p) continue;
    worth++;
    if (p) done++; else left++;
  }
  console.log(`${region}: ${all} windows, ${leftAll} unpainted; inside the outline ${inside}; with ≥ ${(min * 100).toFixed(1)} % buildings (or painted) ${worth}: ${done} painted, ${left} left`);
  const hist = [0, 0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1, 0.15, 0.2, 1];
  for (let h = 0; h < hist.length - 1; h++)
    console.log(`  share ${(hist[h] * 100).toFixed(1)}–${(hist[h + 1] * 100).toFixed(1)} %: ${[...wins.values()].filter((w) => w.inside && w.share >= hist[h] && w.share < hist[h + 1]).length}`);
  if (args.json) writeFileSync(args.json, JSON.stringify(rows));
}
