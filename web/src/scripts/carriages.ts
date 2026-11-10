/**
 * Horse-drawn carriages (Kraków's dorożki): a few white or black carriages, each behind a horse,
 * walking slowly round a closed loop (places.ts `fauna`, the living street round Rynek Główny).
 * Now and then one stops for a while at the stand, and the ones behind keep their distance.
 * Drawn as small 3D boxes like the cars (traffic.ts), on the road's height and hidden where the
 * road is behind buildings.
 */
import type { Road } from "./traffic.ts";
import { groundLookup } from "./roads.ts";
import { ecefToEnu, llhToEcef } from "../../../pipeline/src/camera.ts";

type Vec3 = [number, number, number];
type RGB = [number, number, number];
interface Carriage { s: number; v: number; cruise: number; pause: number; body: RGB; horse: RGB }

const STEP = 1;         // loop resampled every metre
const LEN = 6.4;        // horse + shafts + carriage (m)
const GAP = 3;          // standstill gap to the carriage ahead (m)
const SIDE = 1.4;       // right of the street's centre line (m)
const BODIES: RGB[] = [[236, 234, 228], [32, 32, 36], [236, 234, 228], [120, 28, 34]];
const HORSES: RGB[] = [[238, 236, 232], [222, 220, 214], [96, 64, 44], [60, 44, 34]];

export class Carriages {
  private pts: number[] = []; // [e, n, u, visible] per sample, closed loop
  private len = 0;
  private stand = 0; // where carriages may stop and wait (m along the loop)
  private carriages: Carriage[] = [];
  private seed = 5;

  constructor(private M: number[][], loop: Array<[number, number]>, count: number, roads: Road[], private camFwd: [number, number]) {
    const ground = groundLookup(roads, 30);
    const enu = loop.map(([lat, lon]) => ecefToEnu(llhToEcef(lat, lon, 0)));
    for (let i = 0; i < enu.length; i++) {
      const a = enu[i], b = enu[(i + 1) % enu.length], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let t = 0; t < d; t += STEP) {
        const e = a[0] + ((b[0] - a[0]) * t) / d, n = a[1] + ((b[1] - a[1]) * t) / d, g = ground(e, n);
        this.pts.push(e, n, g?.u ?? NaN, g?.vis === false ? 0 : 1);
      }
    }
    // samples with no road nearby take the last known height
    const N = this.pts.length / 4;
    let last = this.pts.find((v, k) => k % 4 === 2 && Number.isFinite(v)) ?? 0;
    for (let i = 0; i < N; i++) if (Number.isFinite(this.pts[i * 4 + 2])) last = this.pts[i * 4 + 2]; else this.pts[i * 4 + 2] = last;
    this.len = N * STEP;
    this.stand = this.len * 0.42; // north-east side of the square, towards St Mary's
    for (let k = 0; k < count; k++)
      this.carriages.push({
        s: (this.len * k) / count + this.rnd() * 10, v: 0, cruise: 1.7 + this.rnd() * 0.6, pause: 0,
        body: BODIES[k % BODIES.length], horse: HORSES[Math.floor(this.rnd() * HORSES.length)],
      });
  }

  get count() { return this.carriages.length; }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    if (!this.len) return;
    const C = this.carriages, L = this.len;
    for (const c of C) {
      if (c.pause > 0) { c.pause -= dt; c.v = 0; continue; }
      // gap to the nearest carriage ahead round the loop
      let gap = Infinity;
      for (const o of C) if (o !== c) gap = Math.min(gap, (((o.s - c.s) % L) + L) % L - LEN - GAP);
      const target = Math.max(0, Math.min(c.cruise, gap / 1.5));
      c.v = target > c.v ? Math.min(target, c.v + 0.8 * dt) : Math.max(target, c.v - 2 * dt);
      const before = c.s;
      c.s = (c.s + c.v * dt) % L;
      const passed = before <= this.stand ? c.s > this.stand || c.s < before : c.s > this.stand && c.s < before;
      if (passed && this.rnd() < 0.5) c.pause = 8 + this.rnd() * 20; // wait at the stand
    }
  }

  /** position (kept right of the centre line), forward direction and visibility at s metres along the loop */
  private at(s: number) {
    const N = this.pts.length / 4, x = ((s % this.len) + this.len) % this.len / STEP;
    const i = Math.floor(x) % N, j = (i + 1) % N, f = x - Math.floor(x), P = this.pts;
    let dx = P[j * 4] - P[i * 4], dy = P[j * 4 + 1] - P[i * 4 + 1];
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const p: Vec3 = [P[i * 4] + (P[j * 4] - P[i * 4]) * f + dy * SIDE, P[i * 4 + 1] + (P[j * 4 + 1] - P[i * 4 + 1]) * f - dx * SIDE, P[i * 4 + 2] + (P[j * 4 + 2] - P[i * 4 + 2]) * f];
    return { p, d: [dx, dy] as [number, number], vis: P[i * 4 + 3] > 0 && P[j * 4 + 3] > 0 };
  }

  /** `px` = canvas px per art px. */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: [number, number, number, number]) {
    if (px < 0.2 || !this.len) return;
    const M = this.M;
    const proj = (p: Vec3): [number, number] => toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    const items: Array<{ c: Carriage; p: Vec3; d: [number, number]; depth: number }> = [];
    for (const c of this.carriages) {
      const front = this.at(c.s + LEN / 2), back = this.at(c.s - LEN / 2), mid = this.at(c.s);
      if (!front.vis || !back.vis || !mid.vis) continue;
      const [sx, sy] = proj(mid.p);
      if (sx < view[0] - 40 || sy < view[1] - 40 || sx > view[2] + 40 || sy > view[3] + 40) continue;
      items.push({ c, p: mid.p, d: mid.d, depth: mid.p[0] * this.camFwd[0] + mid.p[1] * this.camFwd[1] });
    }
    items.sort((a, b) => b.depth - a.depth); // back to front
    for (const { c, p, d } of items) this.carriage(ctx, proj, p, d, c);
  }

  /** one carriage: centre `c` on the ground, travelling along `d`; the horse in front */
  private carriage(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], car: Carriage) {
    const r: [number, number] = [d[1], -d[0]];
    const pt = (a: number, b: number, z: number): Vec3 => [c[0] + d[0] * a + r[0] * b, c[1] + d[1] * a + r[1] * b, c[2] + z];
    const poly = (pts: Vec3[], color: string) => {
      ctx.fillStyle = color; ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath(); ctx.fill();
    };
    const rgb = ([R, G, B]: RGB, k: number) => `rgb(${Math.min(255, R * k) | 0},${Math.min(255, G * k) | 0},${Math.min(255, B * k) | 0})`;
    /** box from a0 to a1 along the travel direction, half-width hw, from z0 to z1, sides lit like the cars */
    const box = (a0: number, a1: number, hw: number, z0: number, z1: number, color: RGB) => {
      const base = [pt(a1, hw, z0), pt(a1, -hw, z0), pt(a0, -hw, z0), pt(a0, hw, z0)];
      const top = base.map((p) => [p[0], p[1], p[2] + z1 - z0] as Vec3);
      for (let i = 0; i < 4; i++) {
        const a = base[i], b = base[(i + 1) % 4];
        if ((b[1] - a[1]) * this.camFwd[0] - (b[0] - a[0]) * this.camFwd[1] >= 0) continue; // faces away
        poly([a, b, top[(i + 1) % 4], top[i]], rgb(color, 0.72 + 0.1 * (i % 2)));
      }
      poly(top, rgb(color, 1.05));
    };
    // soft contact shadow under carriage and horse
    ctx.globalAlpha = 0.22;
    poly([pt(3.3, 0.55, 0), pt(3.3, -0.55, 0), pt(-3.2, -0.85, 0), pt(-3.2, 0.85, 0)].map((p) => [p[0] + 0.4, p[1] - 0.4, p[2]] as Vec3), "#000");
    ctx.globalAlpha = 1;
    const dark: RGB = [40, 34, 30], seat: RGB = [150, 36, 40], hood: RGB = [30, 30, 34];
    const parts: Array<[number, () => void]> = [ // [distance along d, draw]: drawn back to front
      [-1.9, () => { box(-3.0, -1.2, 0.85, 0.15, 0.75, dark); box(-3.1, -0.8, 0.75, 0.75, 1.35, car.body); }], // wheels + body
      [-2.6, () => box(-3.15, -2.4, 0.74, 1.35, 1.85, hood)],          // folded hood behind the seat
      [-1.4, () => box(-2.3, -1.2, 0.6, 1.35, 1.45, seat)],            // red upholstered seat
      [-0.5, () => box(-0.8, -0.2, 0.5, 0.9, 1.65, car.body)],         // coachman's box
      [0.5, () => box(-0.2, 1.4, 0.36, 0.95, 1.0, dark)],              // shafts
      [2.1, () => { box(1.3, 2.9, 0.22, 0, 0.85, rgb2(car.horse, 0.8)); box(1.2, 3.0, 0.3, 0.85, 1.5, car.horse); }], // legs + barrel
      [3.2, () => box(2.9, 3.5, 0.15, 1.35, 2.05, car.horse)],         // neck and head
    ];
    const fwd = d[0] * this.camFwd[0] + d[1] * this.camFwd[1]; // > 0: the carriage drives away from the camera
    parts.sort((a, b) => (b[0] - a[0]) * fwd);
    for (const [, draw] of parts) draw();
  }
}

const rgb2 = ([R, G, B]: RGB, k: number): RGB => [R * k, G * k, B * k];
