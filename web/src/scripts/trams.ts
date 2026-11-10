/**
 * Trams on the real OSM tram tracks (trams.<hash>.json from pipeline/src/export.ts): a few long
 * articulated sets in a navy MPK Kraków-style livery run along the tracks in their direction, take
 * switches that continue the way they are heading, stop for a while at the platforms, and keep their
 * distance to the tram ahead. Drawn as boxes in the cars' style (traffic.ts), one per car body, so a
 * tram bends round curves; each body is hidden where its track is behind a building or under a bridge.
 */
import type { Road } from "./traffic.ts";

type Vec3 = [number, number, number];
interface Track { r: Road; n: number; cum: Float32Array; len: number; stops: number[] }
interface Leg { w: number; dir: 1 | -1 }
interface Tram {
  path: Leg[];          // tracks driven, the current one last (enough of them to hold the whole tram)
  s: number;            // front, metres along the current track in the travel direction
  v: number; cruise: number;
  pause: number;        // seconds left at a stop
  served: string;       // the last stop stopped at
  stuck: number;        // seconds spent blocked (deadlock escape)
  next: Leg | null;
  bodies: number;       // car bodies (articulated sections)
}

const BODY = 6.2, JOINT = 0.5;        // one car body and the bellows between two (m)
const WIDTH = 2.4, HEIGHT = 3.2;
const ACCEL = 1.0, BRAKE = 1.2;       // m/s²
const CRUISE = 8.5;                   // m/s (~30 km/h in the city centre)
const SAFE = 8;                       // standstill gap to the tram ahead (m)
const NAVY: Vec3 = [30, 52, 116], ROOF: Vec3 = [226, 229, 234], GLASS = "#25303c";

const len = (t: Tram) => t.bodies * BODY + (t.bodies - 1) * JOINT;

export class Trams {
  private tracks: Track[] = [];
  private out = new Map<number, Leg[]>(); // node -> tracks leaving it (and in which direction)
  private trams: Tram[] = [];
  private rand = mulberry(17);
  /** tram bodies drawn in the last frame (debug / tests) */
  drawn = 0;
  /** points along every tram body after the last step (ENU), for the cars to keep clear of */
  points: Array<[number, number]> = [];
  /** cars and buses (ENU centres): a tram brakes for one standing on its track ahead */
  obstacles: Array<[number, number]> | null = null;

  constructor(tracks: Road[], stops: number[], private enu2px: number[][], private camFwd: [number, number]) {
    for (const r of tracks) {
      const n = r.s.length / 4;
      if (n < 2) continue;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(r.s[i * 4] - r.s[i * 4 - 4], r.s[i * 4 + 1] - r.s[i * 4 - 3]);
      const w = this.tracks.push({ r, n, cum, len: cum[n - 1], stops: [] }) - 1;
      if (r.o >= 0) this.link(r.a, { w, dir: 1 });
      if (r.o <= 0) this.link(r.b, { w, dir: -1 });
    }
    // stops: [track index in the file, sample index] -> distance along the track (forward)
    for (let k = 0; k + 1 < stops.length; k += 2) {
      const t = this.tracks.find((x) => x.r === tracks[stops[k]]);
      if (t) t.stops.push(t.cum[Math.min(t.n - 1, stops[k + 1])]);
    }
    // "a few": about one tram per 300 m of track on the map (tracks run on into the faded margin)
    let total = 0;
    for (const t of this.tracks) for (let i = 1; i < t.n; i++) if (t.r.s[i * 4 + 3] && t.r.s[i * 4 - 1]) total += t.cum[i] - t.cum[i - 1];
    const count = Math.round(Math.min(40, Math.max(2, total / 300)));
    for (let i = 0; i < count; i++) {
      const bodies = 4 + Math.floor(this.rand() * 3); // 27–40 m
      const tram: Tram = { path: [], s: 0, v: 0, cruise: CRUISE * (0.85 + this.rand() * 0.2), pause: 0, served: "", stuck: 0, next: null, bodies };
      if (this.place(tram)) this.trams.push(tram);
    }
  }

  get count() { return this.trams.length; }

  private link(node: number, leg: Leg) {
    if (!this.out.has(node)) this.out.set(node, []);
    this.out.get(node)!.push(leg);
  }

  /** point and visibility at distance d (travel direction) along a leg */
  private at(leg: Leg, d: number): { p: Vec3; vis: boolean } {
    const t = this.tracks[leg.w], S = t.r.s;
    const s = Math.max(0, Math.min(t.len, leg.dir === 1 ? d : t.len - d));
    let i = 1;
    while (i < t.n - 1 && t.cum[i] < s) i++;
    const k0 = (i - 1) * 4, k1 = i * 4, f = (s - t.cum[i - 1]) / Math.max(1e-3, t.cum[i] - t.cum[i - 1]);
    return { p: [S[k0] + (S[k1] - S[k0]) * f, S[k0 + 1] + (S[k1 + 1] - S[k0 + 1]) * f, S[k0 + 2] + (S[k1 + 2] - S[k0 + 2]) * f], vis: S[k0 + 3] > 0 && S[k1 + 3] > 0 };
  }

  /** a point `back` metres behind the tram's front, following the tracks it came along */
  private behind(tram: Tram, back: number) {
    let i = tram.path.length - 1, d = tram.s - back;
    while (d < 0 && i > 0) { i--; d += this.tracks[tram.path[i].w].len; }
    return this.at(tram.path[i], Math.max(0, d));
  }

  /** heading (unit, ENU) of a leg near its start (`end` false) or its end */
  private heading(leg: Leg, end: boolean) {
    const L = this.tracks[leg.w].len, a = end ? Math.max(0, L - 8) : 0, b = end ? L : Math.min(L, 8);
    const p = this.at(leg, a).p, q = this.at(leg, b).p, l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  }

  /** the track to take at the end of `leg`: any that continues within ~60° (no reversing at switches) */
  private choose(leg: Leg): Leg | null {
    const t = this.tracks[leg.w], node = leg.dir === 1 ? t.r.b : t.r.a, h = this.heading(leg, true);
    const options = (this.out.get(node) ?? []).filter((o) => {
      if (o.w === leg.w) return false;
      const g = this.heading(o, false);
      return h[0] * g[0] + h[1] * g[1] > 0.5;
    });
    return options.length ? options[Math.floor(this.rand() * options.length)] : null;
  }

  /** put a tram on a random free stretch of track long enough for it, on the map if possible (false if none was found) */
  private place(tram: Tram) {
    const L = len(tram);
    for (let tries = 0; tries < 40; tries++) {
      const w = Math.floor(this.rand() * this.tracks.length), t = this.tracks[w];
      if (t.len < L + 10) continue;
      const dir: 1 | -1 = t.r.o === -1 ? -1 : t.r.o === 1 ? 1 : this.rand() < 0.5 ? 1 : -1;
      const s = L + this.rand() * (t.len - L);
      const head = this.at({ w, dir }, s), front = head.p;
      if (tries < 30 && (!head.vis || !this.at({ w, dir }, s - L).vis)) continue;
      if (this.trams.some((o) => o !== tram && o.path.length && Math.hypot(this.behind(o, 0).p[0] - front[0], this.behind(o, 0).p[1] - front[1]) < L + 40)) continue;
      Object.assign(tram, { path: [{ w, dir }], s, v: 0, pause: 0, stuck: 0, next: null, served: "" });
      return true;
    }
    return false;
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.advance(dt);
    this.collect();
  }

  private advance(dt: number) {
    // every tram as a few points along its body, for keeping distance
    const bodies = this.trams.map((t) => {
      const pts: Array<[number, number]> = [];
      for (let b = 0; b <= len(t); b += 4) { const p = this.behind(t, b).p; pts.push([p[0], p[1]]); }
      return pts;
    });
    this.trams.forEach((tram, ti) => {
      if (tram.pause > 0) { tram.pause -= dt; tram.v = 0; return; }
      const leg = tram.path[tram.path.length - 1], track = this.tracks[leg.w];
      if (tram.next === null) tram.next = this.choose(leg);
      let target = tram.cruise;
      // the tram ahead: the nearest body point in front of us, roughly on our line
      const f = this.behind(tram, 0).p, b = this.behind(tram, 3).p, hl = Math.hypot(f[0] - b[0], f[1] - b[1]) || 1;
      const h = [(f[0] - b[0]) / hl, (f[1] - b[1]) / hl];
      let gap = Infinity;
      bodies.forEach((pts, oi) => {
        if (oi === ti) return;
        for (const [x, y] of pts) {
          const ahead = (x - f[0]) * h[0] + (y - f[1]) * h[1], side = Math.abs((x - f[0]) * h[1] - (y - f[1]) * h[0]);
          if (ahead > 0 && ahead < 80 && side < 2.2) gap = Math.min(gap, ahead);
        }
      });
      for (const [x, y] of this.obstacles ?? []) { // a car on the track: it is ~2.5 m from centre to its back
        const ahead = (x - f[0]) * h[0] + (y - f[1]) * h[1], side = Math.abs((x - f[0]) * h[1] - (y - f[1]) * h[0]);
        if (ahead > 0 && ahead < 40 && side < 2) gap = Math.min(gap, ahead - 2.5 + SAFE - 4);
      }
      target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, gap - SAFE)));
      // the next stop ahead on this track or the next one: brake for it, then wait
      const left = track.len - tram.s;
      let stop = Infinity, key = "";
      const look = (lg: Leg, offset: number) => {
        const t = this.tracks[lg.w];
        for (const d0 of t.stops) {
          const d = (lg.dir === 1 ? d0 : t.len - d0) + offset - (lg === leg ? tram.s : 0), k = `${lg.w}:${d0}`;
          if (d > -0.5 && d < stop && k !== tram.served) { stop = d; key = k; }
        }
      };
      look(leg, 0);
      if (tram.next) look(tram.next, left);
      if (stop < Infinity) {
        target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, stop - 0.3)));
        if (stop < 1 && tram.v < 0.8) { tram.served = key; tram.pause = 8 + this.rand() * 10; tram.v = 0; return; }
      }
      // end of the line in the data (or the edge of the map): stop there, and reappear elsewhere
      if (!tram.next) target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, left - 1)));
      tram.v = target > tram.v ? Math.min(target, tram.v + ACCEL * dt) : Math.max(target, tram.v - BRAKE * 3 * dt);
      tram.stuck = tram.v < 0.1 ? tram.stuck + dt : 0;
      if (tram.stuck > (tram.next ? 40 : 6)) { this.place(tram); return; } // deadlock or dead end
      tram.s += tram.v * dt;
      // onto the next track
      while (tram.next && tram.s > this.tracks[tram.path[tram.path.length - 1].w].len) {
        tram.s -= this.tracks[tram.path[tram.path.length - 1].w].len;
        tram.path.push(tram.next);
        tram.next = this.choose(tram.next);
      }
      // forget tracks the whole tram has left
      while (tram.path.length > 1) {
        let covered = tram.s;
        for (let i = tram.path.length - 2; i >= 1; i--) covered += this.tracks[tram.path[i].w].len;
        if (covered < len(tram)) break;
        tram.path.shift();
      }
    });
  }

  private collect() {
    this.points = [];
    for (const t of this.trams) for (let b = 0; b <= len(t); b += 3) { const p = this.behind(t, b).p; this.points.push([p[0], p[1]]); }
  }

  /** `px` = canvas px per art px. */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: [number, number, number, number]) {
    if (px < 0.14) return;
    const M = this.enu2px;
    const proj = (p: Vec3): [number, number] => toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    const items: Array<{ a: Vec3; b: Vec3; first: boolean; last: boolean; depth: number; pan: boolean }> = [];
    for (const tram of this.trams) {
      for (let k = 0; k < tram.bodies; k++) {
        const s0 = k * (BODY + JOINT), front = this.behind(tram, s0), back = this.behind(tram, s0 + BODY);
        if (!front.vis || !back.vis) continue; // behind a building or under a bridge
        const [sx, sy] = proj(front.p);
        if (sx < view[0] - 80 || sy < view[1] - 80 || sx > view[2] + 80 || sy > view[3] + 80) continue;
        const c = [(front.p[0] + back.p[0]) / 2, (front.p[1] + back.p[1]) / 2];
        items.push({ a: front.p, b: back.p, first: k === 0, last: k === tram.bodies - 1, pan: k % 2 === 1, depth: c[0] * this.camFwd[0] + c[1] * this.camFwd[1] });
      }
    }
    items.sort((p, q) => q.depth - p.depth); // back to front
    this.drawn = items.length;
    for (const it of items) this.body(ctx, proj, it);
  }

  /** one car body from its front point `a` to its back point `b` */
  private body(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], it: { a: Vec3; b: Vec3; first: boolean; last: boolean; pan: boolean }) {
    const { a, b } = it, l = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    const d = [(a[0] - b[0]) / l, (a[1] - b[1]) / l], r = [d[1], -d[0]];
    const c: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const hl = l / 2, hw = WIDTH / 2;
    const corner = (x: number, y: number, z: number): Vec3 => [c[0] + d[0] * x + r[0] * y, c[1] + d[1] * x + r[1] * y, c[2] + z];
    const shape = (pts: Vec3[], color: string) => {
      ctx.fillStyle = color; ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath(); ctx.fill();
    };
    const rgb = ([R, G, B]: Vec3, k: number) => `rgb(${Math.min(255, R * k) | 0},${Math.min(255, G * k) | 0},${Math.min(255, B * k) | 0})`;
    // rounded-off cab ends: the first and last bodies taper a little
    const half = (end: boolean) => (end ? hw - 0.35 : hw);
    const base = [corner(hl, half(it.first), 0.3), corner(hl, -half(it.first), 0.3), corner(-hl, -half(it.last), 0.3), corner(-hl, half(it.last), 0.3)];
    const top = base.map((p) => [p[0], p[1], p[2] + HEIGHT] as Vec3);
    // soft contact shadow, like the cars
    ctx.globalAlpha = 0.25;
    shape(base.map((p) => [p[0] + 0.4, p[1] - 0.4, p[2] - 0.3] as Vec3), "#000");
    ctx.globalAlpha = 1;
    for (let i = 0; i < 4; i++) {
      const p = base[i], q = base[(i + 1) % 4];
      if ((q[1] - p[1]) * this.camFwd[0] - (q[0] - p[0]) * this.camFwd[1] >= 0) continue; // faces away
      const shade = 0.72 + 0.1 * (i % 2);
      shape([p, q, top[(i + 1) % 4], top[i]], rgb(NAVY, shade));
      // window band along the side (and the windscreen at the cab ends)
      const lo = 1.45, hi = 2.55, inset = 0.08;
      const lerp = (u: Vec3, w: Vec3, t: number): Vec3 => [u[0] + (w[0] - u[0]) * t, u[1] + (w[1] - u[1]) * t, u[2] + (w[2] - u[2]) * t];
      const u0 = lerp(p, q, inset), u1 = lerp(p, q, 1 - inset);
      ctx.globalAlpha = 0.85;
      shape([[u0[0], u0[1], u0[2] + lo], [u1[0], u1[1], u1[2] + lo], [u1[0], u1[1], u1[2] + hi], [u0[0], u0[1], u0[2] + hi]], GLASS);
      ctx.globalAlpha = 1;
      // white skirt line under the windows
      shape([[p[0], p[1], p[2] + 1.1], [q[0], q[1], q[2] + 1.1], [q[0], q[1], q[2] + 1.3], [p[0], p[1], p[2] + 1.3]], "#eef0f3");
    }
    // roof: navy edges, light grey middle (the blue-and-white look from above)
    shape(top, rgb(NAVY, 1.05));
    const ri = hw - 0.45;
    shape([corner(hl - 0.15, ri, HEIGHT + 0.31), corner(hl - 0.15, -ri, HEIGHT + 0.31), corner(-hl + 0.15, -ri, HEIGHT + 0.31), corner(-hl + 0.15, ri, HEIGHT + 0.31)], rgb(ROOF, 1));
    // roof equipment: a pantograph on every other body
    if (it.pan) shape([corner(1.1, 0.5, HEIGHT + 0.5), corner(1.1, -0.5, HEIGHT + 0.5), corner(-0.6, -0.5, HEIGHT + 0.5), corner(-0.6, 0.5, HEIGHT + 0.5)], "#4a515c");
  }
}

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
