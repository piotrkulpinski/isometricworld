/**
 * Simulated traffic on real OSM roads: cars and buses wander the road graph (random walk,
 * one-way aware, right-hand lanes), drawn as small 3D boxes through the map camera.
 * Not real trips, but they behave: each vehicle keeps a safe gap to the one ahead in its lane,
 * takes turns at junctions (approaches alternate like lights), slows for turns, and its cruising
 * speed drifts so traffic flows unevenly. Lanes come from the same widths the ground was drawn
 * with, so vehicles stay on the asphalt. Hidden where the road is behind buildings or trees.
 */

export interface Road {
  c: number;        // class 0 motorway … 5 service, 6 closed to cars (kept for ground heights)
  o: number;        // 1 oneway forward, -1 oneway backward, 0 both
  l: number;        // lanes per direction (total if one-way)
  w?: number;       // carriageway width (m), as drawn on the map
  a: number; b: number; // OSM start / end node ids
  s: number[];      // [e, n, u, visible] × samples (≈ 6 m apart)
}

type Vec3 = [number, number, number];

/** lanes: per-sample lane centre (m right of travel) where tram tracks share the road, indexed
 *  lane (forward) or l + lane (backward); absent on roads without tracks */
interface Way { r: Road; n: number; cum: Float32Array; len: number; w: number; lanes?: Float32Array[] }
interface Vehicle {
  id: number;
  w: number; dir: 1 | -1; s: number; lane: number;
  v: number;          // current speed (m/s)
  cruise: number;     // personal cruising factor
  phase: number;      // speed drift phase
  stuck: number;      // seconds spent waiting at a stop line (gridlock escape)
  through: boolean;   // granted the junction ahead: may cross the stop line
  holding: number;    // junction node this vehicle is inside (-1 none)
  next: { w: number; dir: 1 | -1 } | null; // way chosen for after this one
  len: number; wid: number; hei: number; color: [number, number, number]; bus: boolean;
}

const CLASS_WEIGHT = [3, 2.6, 2, 1.4, 0.35, 0.05];
const CLASS_SPEED = [22, 13, 12, 11, 8, 5]; // m/s (≈ 80, 47, 43, 40, 29, 18 km/h)
const ACCEL = 2.2, BRAKE = 5.5;              // m/s²
const GAP = 2.2, HEADWAY = 1.1;              // standstill gap (m), time gap (s)
const CAR_COLORS: Array<[number, number, number]> = [
  [236, 236, 236], [236, 236, 236], [190, 194, 200], [60, 62, 68], [36, 38, 44], [170, 40, 38],
  [40, 80, 150], [235, 190, 40], [120, 130, 140], [210, 210, 214],
];
const BUS_COLORS: Array<[number, number, number]> = [[40, 110, 190], [30, 150, 90], [220, 220, 222]];

export class Traffic {
  private ways: Way[] = [];
  private out = new Map<number, Array<{ w: number; dir: 1 | -1 }>>();
  private vehicles: Vehicle[] = [];
  /** junction node -> approach (way) that has green, vehicles inside, when the green started */
  private nodeHold = new Map<number, { way: number; inside: number; start: number; last: number }>();
  /** ways meeting at a node: 2 = plain split of one road (no junction) */
  private degree = new Map<number, number>();
  private lanes = new Map<string, Vehicle[]>(); // `${way}:${dir}:${lane}` -> sorted by s
  /** junction box radius per node: half the widest road meeting there + margin */
  private nodeR = new Map<number, number>();
  private t = 0;
  private rand = mulberry(7);
  /** vehicles drawn in the last frame (debug / tests) */
  drawn = 0;
  /** other movers on the streets (tram bodies, ENU points): vehicles brake for one ahead of them */
  obstacles: Array<[number, number]> | null = null;

  constructor(roads: Road[], private enu2px: number[][], private camFwd: [number, number], density = 1) {
    for (const r of roads) {
      const n = r.s.length / 4;
      if (n < 2 || r.c > 5) continue;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++)
        cum[i] = cum[i - 1] + Math.hypot(r.s[i * 4] - r.s[i * 4 - 4], r.s[i * 4 + 1] - r.s[i * 4 - 3]);
      const w = this.ways.push({ r, n, cum, len: cum[n - 1], w: r.w ?? Math.max(4, r.l * (r.o ? 3.2 : 6.4)) }) - 1;
      const R = Math.min(16, (r.w ?? 6) / 2 + 1.5);
      for (const n of [r.a, r.b]) {
        this.nodeR.set(n, Math.max(this.nodeR.get(n) ?? 0, R));
        this.degree.set(n, (this.degree.get(n) ?? 0) + 1);
      }
      if (r.o >= 0) this.link(r.a, { w, dir: 1 });
      if (r.o <= 0) this.link(r.b, { w, dir: -1 });
    }
    for (const [n, d] of this.degree) if (d <= 2) this.nodeR.set(n, 0); // not a junction: no box, no stop line
    // "not too many": ~1 vehicle per 55 weighted metres (only on-screen ones are drawn)
    const weights = this.ways.map((w) => w.len * CLASS_WEIGHT[w.r.c]);
    const total = weights.reduce((a, b) => a + b, 0);
    const count = Math.round(Math.min(5000, Math.max(80, (total / 55) * density)));
    this.regroup();
    for (let i = 0, tries = 0; this.vehicles.length < count && tries < count * 4; tries++) {
      let pick = this.rand() * total, w = 0;
      while (pick > weights[w] && w < weights.length - 1) pick -= weights[w++];
      const way = this.ways[w];
      const dir: 1 | -1 = way.r.o === 1 ? 1 : way.r.o === -1 ? -1 : this.rand() < 0.5 ? 1 : -1;
      const bus = way.r.c <= 2 && this.rand() < 0.08;
      const len = bus ? 12 : 4.4 + this.rand() * 0.6;
      if (way.len < len + 4) continue;
      const s = len / 2 + this.rand() * (way.len - len);
      const lane = bus ? 0 : Math.floor(this.rand() * way.r.l);
      // never spawn on top of another vehicle
      const group = this.lanes.get(`${w}:${dir}:${lane}`) ?? [];
      if (group.some((o) => Math.abs(o.s - s) < (o.len + len) / 2 + GAP)) continue;
      const v: Vehicle = {
        id: i++, w, dir, s, lane, bus, len, stuck: 0, through: false, holding: -1, next: null,
        cruise: 0.8 + this.rand() * 0.35, phase: this.rand() * Math.PI * 2, v: 0,
        wid: bus ? 2.55 : 1.8, hei: bus ? 3.1 : 1.5,
        color: bus ? BUS_COLORS[Math.floor(this.rand() * BUS_COLORS.length)] : CAR_COLORS[Math.floor(this.rand() * CAR_COLORS.length)],
      };
      v.v = this.limit(v) * 0.8;
      this.vehicles.push(v);
      group.push(v);
      this.lanes.set(`${w}:${dir}:${lane}`, group);
    }
  }

  get count() { return this.vehicles.length; }

  private link(node: number, e: { w: number; dir: 1 | -1 }) {
    if (!this.out.has(node)) this.out.set(node, []);
    this.out.get(node)!.push(e);
  }

  private regroup() {
    this.lanes.clear();
    for (const v of this.vehicles) {
      const k = `${v.w}:${v.dir}:${v.lane}`;
      const g = this.lanes.get(k);
      if (g) g.push(v); else this.lanes.set(k, [v]);
    }
    for (const g of this.lanes.values()) g.sort((a, b) => a.s - b.s);
  }

  /** Cruising speed right now: class limit × personality × slow drift (traffic waves). */
  private limit(v: Vehicle) {
    const base = CLASS_SPEED[this.ways[v.w].r.c] * v.cruise * (v.bus ? 0.8 : 1);
    return base * (0.72 + 0.28 * (0.5 + 0.5 * Math.sin(this.t * 0.11 + v.phase)));
  }

  private endNode(v: Vehicle) { const r = this.ways[v.w].r; return v.dir === 1 ? r.b : r.a; }

  private chooseNext(v: Vehicle) {
    const options = (this.out.get(this.endNode(v)) ?? []).filter((o) => o.w !== v.w);
    const pool = v.bus ? options.filter((o) => this.ways[o.w].r.c <= 3) : options;
    const from = pool.length ? pool : options;
    if (!from.length) return null;
    const weights = from.map((o) => CLASS_WEIGHT[this.ways[o.w].r.c] + 0.05);
    let pick = this.rand() * weights.reduce((a, b) => a + b, 0), k = 0;
    while (pick > weights[k] && k < weights.length - 1) pick -= weights[k++];
    return from[k];
  }

  /** Free space beyond the junction box at the start of `next`, in the lane we would enter. */
  private entryClear(v: Vehicle, next: { w: number; dir: 1 | -1 }) {
    const lane = v.bus ? 0 : Math.min(v.lane, this.ways[next.w].r.l - 1);
    const g = this.lanes.get(`${next.w}:${next.dir}:${lane}`);
    return !g?.length || g[0].s - g[0].len / 2 > (this.nodeR.get(this.endNode(v)) ?? 4) + v.len + GAP;
  }

  /** Distance from the vehicle's front to the stop line before the junction box ahead. */
  private toStop(v: Vehicle) {
    return this.ways[v.w].len - v.s - v.len / 2 - (this.nodeR.get(this.endNode(v)) ?? 4);
  }

  private isJunction(node: number) { return (this.degree.get(node) ?? 0) > 2; }

  /**
   * May the vehicle enter the junction ahead now? Vehicles from the same approach go together
   * (a green phase, at most 12 s while others wait); other approaches wait until the box is empty.
   */
  private grant(v: Vehicle) {
    if (!v.next || !this.entryClear(v, v.next)) return false;
    const node = this.endNode(v);
    if (!this.isJunction(node)) { v.through = true; return true; }
    let hold = this.nodeHold.get(node);
    if (hold && hold.inside <= 0 && this.t - hold.last > 0.8) { this.nodeHold.delete(node); hold = undefined; }
    if (hold && this.t - hold.last > 10) { this.nodeHold.delete(node); hold = undefined; } // lost vehicle: reset
    if (hold && (hold.way !== v.w || this.t - hold.start > 12)) return false;
    if (!hold) { hold = { way: v.w, inside: 0, start: this.t, last: this.t }; this.nodeHold.set(node, hold); }
    hold.inside++; hold.last = this.t;
    v.through = true; v.holding = node;
    return true;
  }

  private release(v: Vehicle) {
    if (v.holding < 0) return;
    const h = this.nodeHold.get(v.holding);
    if (h) { h.inside--; h.last = this.t; }
    v.holding = -1;
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    this.regroup();
    for (const g of this.lanes.values()) {
      for (let k = 0; k < g.length; k++) {
        const v = g[k], way = this.ways[v.w];
        if (v.next === null) v.next = this.chooseNext(v);
        let target = this.limit(v);
        if (v.stuck > 25) { this.respawn(v); continue; } // gridlock escape
        // car following: stay a safe gap behind the vehicle ahead in this lane
        const lead = g[k + 1];
        if (lead) {
          const gap = lead.s - lead.len / 2 - (v.s + v.len / 2) - GAP;
          target = Math.min(target, Math.max(0, gap / HEADWAY), lead.v + Math.max(0, gap) * 0.5);
        }
        if (this.obstacles?.length) { // a tram on our lane or crossing ahead
          const [c, d] = this.pose(v);
          let free = Infinity;
          for (const [x, y] of this.obstacles) {
            const ahead = (x - c[0]) * d[0] + (y - c[1]) * d[1] - v.len / 2, side = Math.abs((x - c[0]) * d[1] - (y - c[1]) * d[0]);
            if (ahead > -1 && ahead < 40 && side < v.wid / 2 + 1.5) free = Math.min(free, ahead);
          }
          if (free < Infinity) target = Math.min(target, Math.max(0, free - GAP - 1.2) / HEADWAY);
        }
        // approaching the junction: slow for the turn; at the stop line wait until it's granted
        const toStop = this.toStop(v);
        if (!v.through && v.next && toStop < 30) {
          const go = (toStop < 2 || !this.isJunction(this.endNode(v))) && this.grant(v);
          if (!go) target = Math.min(target, Math.max(0, toStop - 0.3) / HEADWAY);
          if (!go && toStop < 2 && v.v < 0.5) v.stuck += dt; else if (go) v.stuck = 0;
          if (way.r.c >= 2 && this.isJunction(this.endNode(v))) target = Math.min(target, 5 + Math.max(0, toStop) * 0.3);
        } else if (v.through && way.r.c >= 2 && this.isJunction(this.endNode(v))) target = Math.min(target, 7);
        // left the junction box behind: release it
        if (v.holding >= 0 && v.holding !== this.endNode(v) && v.s - v.len / 2 > (this.nodeR.get(v.holding) ?? 0)) this.release(v);
        // accelerate gently, brake firmly; never overrun the stop point
        v.v = target > v.v ? Math.min(target, v.v + ACCEL * dt) : Math.max(target, v.v - BRAKE * dt);
        if (lead) v.v = Math.min(v.v, Math.max(0, (lead.s - lead.len / 2 - (v.s + v.len / 2) - 0.5) / dt));
        v.s += v.v * dt;
      }
    }
    // move vehicles that have driven past the end of their way onto the next one
    for (const v of this.vehicles) {
      let way = this.ways[v.w];
      if (v.s + v.len / 2 < way.len) continue;
      if (!v.next) { // dead end
        if (way.r.o === 0) { v.dir = v.dir === 1 ? -1 : 1; v.s = v.len / 2; v.through = false; }
        else this.respawn(v);
        continue;
      }
      if (!v.through) { v.s = way.len - v.len / 2; v.v = 0; continue; } // not granted: hold at the end
      const over = v.s + v.len / 2 - way.len;
      v.w = v.next.w; v.dir = v.next.dir; v.next = null; v.through = false;
      way = this.ways[v.w];
      v.lane = v.bus ? 0 : Math.min(v.lane, way.r.l - 1);
      v.s = Math.min(way.len - v.len / 2, v.len / 2 + over);
      v.phase += 0.7;
    }
  }

  /** Move a vehicle stranded at a one-way dead end (data gap) to a random free road start. */
  private respawn(v: Vehicle) {
    this.release(v);
    for (let tries = 0; tries < 20; tries++) {
      const w = Math.floor(this.rand() * this.ways.length), way = this.ways[w];
      const dir: 1 | -1 = way.r.o === -1 ? -1 : way.r.o === 1 ? 1 : this.rand() < 0.5 ? 1 : -1;
      const start = (this.nodeR.get(dir === 1 ? way.r.a : way.r.b) ?? 4) + v.len / 2;
      if (way.r.c > 3 || way.len < start + v.len + 30 || (v.bus && way.r.c > 2)) continue;
      const g = this.lanes.get(`${w}:${dir}:0`);
      if (g?.some((o) => Math.abs(o.s - start) < v.len + 2 * GAP + o.len)) continue;
      Object.assign(v, { w, dir, lane: 0, s: start, v: 0, next: null, stuck: 0, through: false });
      return;
    }
  }

  /** Centre (ENU, in its lane) and travel direction of a vehicle. */
  private pose(v: Vehicle): [Vec3, [number, number]] {
    const way = this.ways[v.w], S = way.r.s;
    const s = Math.max(0, Math.min(way.len, v.dir === 1 ? v.s : way.len - v.s));
    let i = 1;
    while (i < way.n - 1 && way.cum[i] < s) i++;
    const k0 = (i - 1) * 4, k1 = i * 4, f = (s - way.cum[i - 1]) / Math.max(1e-3, way.cum[i] - way.cum[i - 1]);
    let dx = S[k1] - S[k0], dy = S[k1 + 1] - S[k0 + 1];
    const L = Math.hypot(dx, dy) || 1;
    dx = (dx / L) * v.dir; dy = (dy / L) * v.dir;
    const off = this.offset(way, v, i, f);
    return [[S[k0] + (S[k1] - S[k0]) * f + dy * off, S[k0 + 1] + (S[k1 + 1] - S[k0 + 1]) * f - dx * off, S[k0 + 2] + (S[k1 + 2] - S[k0 + 2]) * f], [dx, dy]];
  }

  /**
   * Tram tracks inside the carriageways (most of Kraków's trams share the street with cars). A lane
   * that half overlaps a track moves onto it, or clear of it where the road is wide enough, so a car
   * either queues behind a tram or passes it side by side, never through its flank.
   */
  useTracks(tracks: Road[]) {
    const CELL = 8, TRAM = 1.3, CAR = 0.9, CLEAR = TRAM + CAR + 0.3;
    const grid = new Map<string, number[]>(); // [e, n, unit direction e, n] per track sample
    for (const t of tracks) for (let i = 0; i < t.s.length; i += 4) {
      const j = i + 4 < t.s.length ? i + 4 : i - 4;
      const dx = t.s[j] - t.s[i], dy = t.s[j + 1] - t.s[i + 1], L = Math.hypot(dx, dy) || 1;
      const key = `${Math.floor(t.s[i] / CELL)},${Math.floor(t.s[i + 1] / CELL)}`;
      let g = grid.get(key);
      if (!g) grid.set(key, (g = []));
      g.push(t.s[i], t.s[i + 1], dx / L, dy / L);
    }
    const smooth = (a: Float32Array) => {
      for (let pass = 0; pass < 2; pass++) {
        const b = a.slice();
        for (let i = 1; i < a.length - 1; i++) a[i] = (b[i - 1] + b[i] + b[i + 1]) / 3;
      }
      return a;
    };
    for (const way of this.ways) {
      const r = way.r, S = r.s, half = way.w / 2;
      // per sample: tracks running along the road, as offsets right of the forward direction
      const along: number[][] = [];
      let any = false;
      for (let i = 0; i < way.n; i++) {
        const j = i + 1 < way.n ? i + 1 : i - 1, sign = j > i ? 1 : -1;
        const L = Math.hypot(S[j * 4] - S[i * 4], S[j * 4 + 1] - S[i * 4 + 1]) || 1;
        const tx = (sign * (S[j * 4] - S[i * 4])) / L, ty = (sign * (S[j * 4 + 1] - S[i * 4 + 1])) / L;
        const found: number[] = [];
        const cx = Math.floor(S[i * 4] / CELL), cy = Math.floor(S[i * 4 + 1] / CELL);
        for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const g = grid.get(`${gx},${gy}`);
          if (g) for (let k = 0; k < g.length; k += 4) {
            const ex = g[k] - S[i * 4], ey = g[k + 1] - S[i * 4 + 1];
            if (Math.abs(ex * tx + ey * ty) > 3.5 || Math.abs(g[k + 2] * tx + g[k + 3] * ty) < 0.9) continue;
            const side = ex * ty - ey * tx;
            if (Math.abs(side) < half + 1 && !found.some((o) => Math.abs(o - side) < 1)) found.push(side);
          }
        }
        if (found.length) any = true;
        along.push(found);
      }
      if (!any) continue;
      const lanes = Math.max(1, r.l), lw = r.o === 0 ? half / lanes : way.w / lanes;
      way.lanes = [];
      for (const dir of [1, -1]) for (let lane = 0; lane < lanes; lane++) {
        const base = Math.max(-half + CAR + 0.2, Math.min(half - CAR - 0.2, half - (lane + 0.5) * lw));
        way.lanes.push(smooth(Float32Array.from(along, (found) => {
          let o = base;
          for (let pass = 0; pass < 2; pass++) for (const t0 of found) {
            const t = t0 * dir, d = o - t;
            if (Math.abs(d) >= CLEAR) continue;
            if (Math.abs(d) < 1) { o = t; continue; }
            const away = t + Math.sign(d) * CLEAR;
            o = Math.abs(away) <= half - CAR - 0.2 ? away : t;
          }
          return o;
        })));
      }
    }
  }

  /** Move vehicles that start inside another mover (a tram body, ENU points) to a free road start. */
  clearOf(points: Array<[number, number]>) {
    for (const v of this.vehicles) {
      const [c] = this.pose(v);
      if (points.some(([x, y]) => Math.hypot(x - c[0], y - c[1]) < v.len / 2 + 1.5)) this.respawn(v);
    }
  }

  /** Centres of all vehicles (ENU), for other movers that keep clear of them. */
  centres(): Array<[number, number]> {
    return this.vehicles.map((v) => { const [c] = this.pose(v); return [c[0], c[1]]; });
  }

  /** Lateral offset (m, + = right of travel) of the lane centre, kept inside the drawn asphalt. */
  private offset(way: Way, v: Vehicle, i: number, f: number) {
    const r = way.r, half = way.w / 2;
    const lanes = Math.max(1, r.l);
    const lw = r.o === 0 ? half / lanes : way.w / lanes;
    const shared = way.lanes?.[v.dir === 1 ? v.lane : lanes + v.lane];
    const o = shared ? shared[i - 1] + (shared[i] - shared[i - 1]) * f : half - (v.lane + 0.5) * lw;
    return Math.max(-half + v.wid / 2 + 0.2, Math.min(half - v.wid / 2 - 0.2, o));
  }

  /** Draw vehicles. `toScreen` maps global art px -> canvas px; `px` = canvas px per art px. */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: [number, number, number, number]) {
    if (px < 0.14) return; // cars < ~2.5 px: skip
    const [vx0, vy0, vx1, vy1] = view;
    const M = this.enu2px;
    const proj = (p: Vec3): [number, number] =>
      toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    const items: Array<{ v: Vehicle; c: Vec3; d: [number, number]; depth: number }> = [];
    for (const v of this.vehicles) {
      const way = this.ways[v.w], S = way.r.s;
      const at = (dist: number) => { // sample index at distance along the travel direction
        const s = Math.max(0, Math.min(way.len, v.dir === 1 ? dist : way.len - dist));
        let i = 1;
        while (i < way.n - 1 && way.cum[i] < s) i++;
        return { i, s };
      };
      // hidden if any part of the vehicle is behind a building / tree
      const front = at(v.s + v.len / 2), back = at(v.s - v.len / 2), mid = at(v.s);
      if (!S[front.i * 4 + 3] || !S[(front.i - 1) * 4 + 3] || !S[back.i * 4 + 3] || !S[(back.i - 1) * 4 + 3]) continue;
      const { i, s } = mid, k0 = (i - 1) * 4, k1 = i * 4;
      const f = (s - way.cum[i - 1]) / Math.max(1e-3, way.cum[i] - way.cum[i - 1]);
      let dx = S[k1] - S[k0], dy = S[k1 + 1] - S[k0 + 1];
      const L = Math.hypot(dx, dy) || 1;
      dx = (dx / L) * v.dir; dy = (dy / L) * v.dir;
      const off = this.offset(way, v, i, f);
      const c: Vec3 = [S[k0] + (S[k1] - S[k0]) * f + dy * off, S[k0 + 1] + (S[k1 + 1] - S[k0 + 1]) * f - dx * off, S[k0 + 2] + (S[k1 + 2] - S[k0 + 2]) * f];
      const [sx, sy] = proj(c);
      if (sx < vx0 - 40 || sy < vy0 - 40 || sx > vx1 + 40 || sy > vy1 + 40) continue;
      items.push({ v, c, d: [dx, dy], depth: c[0] * this.camFwd[0] + c[1] * this.camFwd[1] });
    }
    items.sort((a, b) => b.depth - a.depth); // back to front
    this.drawn = items.length;
    for (const { v, c, d } of items) this.box(ctx, proj, c, d, v);
  }

  private box(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], v: Vehicle) {
    const r: [number, number] = [d[1], -d[0]];
    const hl = v.len / 2, hw = v.wid / 2;
    const corner = (a: number, b: number, z: number): Vec3 => [c[0] + d[0] * a + r[0] * b, c[1] + d[1] * a + r[1] * b, c[2] + z];
    const base = [corner(hl, hw, 0.25), corner(hl, -hw, 0.25), corner(-hl, -hw, 0.25), corner(-hl, hw, 0.25)];
    const top = base.map((p) => [p[0], p[1], p[2] + v.hei] as Vec3);
    const [R, G, B] = v.color;
    const fill = (pts: Vec3[], k: number) => {
      ctx.fillStyle = `rgb(${R * k | 0},${G * k | 0},${B * k | 0})`;
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fill();
    };
    // soft contact shadow
    ctx.globalAlpha = 0.25;
    fill(base.map((p) => [p[0] + 0.4, p[1] - 0.4, p[2] - 0.25] as Vec3), 0);
    ctx.globalAlpha = 1;
    // sides facing the camera (outward normal · camera forward < 0), then roof
    for (let i = 0; i < 4; i++) {
      const a = base[i], b = base[(i + 1) % 4];
      const nx = (b[1] - a[1]), ny = -(b[0] - a[0]);
      const facing = nx * this.camFwd[0] + ny * this.camFwd[1];
      if (facing >= 0) continue;
      fill([a, b, top[(i + 1) % 4], top[i]], 0.72 + 0.1 * (i % 2));
    }
    fill(top, 1.05);
    // windscreen / bus window band on the roof
    const wb = v.bus ? [corner(hl - 0.3, hw - 0.15, v.hei + 0.26), corner(hl - 0.3, -hw + 0.15, v.hei + 0.26), corner(-hl + 0.3, -hw + 0.15, v.hei + 0.26), corner(-hl + 0.3, hw - 0.15, v.hei + 0.26)]
      : [corner(hl * 0.45, hw - 0.2, v.hei + 0.26), corner(hl * 0.45, -hw + 0.2, v.hei + 0.26), corner(-hl * 0.35, -hw + 0.2, v.hei + 0.26), corner(-hl * 0.35, hw - 0.2, v.hei + 0.26)];
    ctx.globalAlpha = v.bus ? 0.25 : 0.55;
    ctx.fillStyle = "#26303a";
    ctx.beginPath();
    wb.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
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
