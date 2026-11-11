/**
 * Traffic sanity check in the live viewer: runs the simulation for N simulated minutes, then
 * reports vehicles overlapping each other (any two box centres closer than their half-sizes),
 * speed spread, and vehicles stuck at junctions.
 *
 *   npx tsx src/traffictest.ts [url] [minutes]
 */
import { chromium } from "playwright-core";
import { CHROME, siteUrl } from "./paths.ts";

const url = siteUrl(process.argv[2]);
const minutes = Number(process.argv[3] ?? 5);
const b = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await b.newPage();
await page.addInitScript("window.__name = (f) => f;");
await page.goto(url);
await page.waitForFunction(() => (window as any).__traffic, null, { timeout: 30_000 });
const r = await page.evaluate((steps) => {
  const T = (window as any).__traffic;
  for (let i = 0; i < steps; i++) T.step(0.1);
  // vehicle centre + heading in ENU (same math as draw, without occlusion)
  const pos = T.vehicles.map((v: any) => {
    const way = T.ways[v.w], S = way.r.s;
    const s = v.dir === 1 ? v.s : way.len - v.s;
    let i = 1;
    while (i < way.n - 1 && way.cum[i] < s) i++;
    const k0 = (i - 1) * 4, k1 = i * 4, f = (s - way.cum[i - 1]) / Math.max(1e-3, way.cum[i] - way.cum[i - 1]);
    let dx = S[k1] - S[k0], dy = S[k1 + 1] - S[k0 + 1];
    const L = Math.hypot(dx, dy) || 1; dx = dx / L * v.dir; dy = dy / L * v.dir;
    const off = T.offset(way, v, i, f);
    return { x: S[k0] + (S[k1] - S[k0]) * f + dy * off, y: S[k0 + 1] + (S[k1 + 1] - S[k0 + 1]) * f - dx * off, dx, dy, v };
  });
  // oriented-box overlap test (separating axis) between nearby vehicles
  const grid = new Map<string, number[]>();
  pos.forEach((p: any, i: number) => { const k = `${Math.floor(p.x / 20)}_${Math.floor(p.y / 20)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
  const corners = (p: any) => { const hl = p.v.len / 2, hw = p.v.wid / 2, rx = p.dy, ry = -p.dx;
    return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([a, c]) => [p.x + p.dx * a + rx * c, p.y + p.dy * a + ry * c]); };
  const overlap = (a: any, b2: any) => {
    const ca = corners(a), cb = corners(b2);
    for (const ax of [[a.dx, a.dy], [a.dy, -a.dx], [b2.dx, b2.dy], [b2.dy, -b2.dx]]) {
      const pa = ca.map(([x, y]) => x * ax[0] + y * ax[1]), pb = cb.map(([x, y]) => x * ax[0] + y * ax[1]);
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
    return true;
  };
  let overlaps = 0, sameWay = 0;
  const kinds: Record<string, number> = {};
  pos.forEach((p: any, i: number) => {
    const gx = Math.floor(p.x / 20), gy = Math.floor(p.y / 20);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++)
      for (const j of grid.get(`${gx + ox}_${gy + oy}`) ?? []) if (j > i && overlap(p, pos[j])) {
        overlaps++;
        const a = p.v, c = pos[j].v, wa = T.ways[a.w];
        const k = a.w !== c.w ? "other-way" : a.dir !== c.dir ? `opposite w=${wa.w}` : a.lane !== c.lane ? "other-lane" : `same-lane ds=${Math.abs(a.s - c.s).toFixed(0)}`;
        kinds[k] = (kinds[k] ?? 0) + 1;
        if (pos[j].v.w === p.v.w) sameWay++;
      }
  });
  const speeds = T.vehicles.map((v: any) => v.v * 3.6).sort((a: number, b2: number) => a - b2);
  const q = (f: number) => speeds[Math.floor(f * (speeds.length - 1))].toFixed(0);
  return { kinds: Object.entries(kinds).sort((x, y) => y[1] - x[1]).slice(0, 12), n: T.vehicles.length, overlaps, sameWay, stopped: speeds.filter((s: number) => s < 1).length,
    stuck: T.vehicles.filter((v: any) => v.stuck > 20).length, kmh: `p10 ${q(0.1)} · p50 ${q(0.5)} · p90 ${q(0.9)}` };
}, minutes * 600);
console.log(r);
await b.close();
