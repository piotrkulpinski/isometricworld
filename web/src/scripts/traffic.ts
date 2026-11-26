/**
 * Simulated traffic on real OSM roads: cars and buses wander the road graph (random walk,
 * one-way aware, right-hand lanes), drawn as small 3D boxes through the map camera.
 * Not real trips, but they behave: each vehicle keeps a safe gap to the one ahead in its lane,
 * takes turns at junctions (approaches alternate like lights), slows for turns, and its cruising
 * speed drifts so traffic flows unevenly. Lanes come from the same widths the ground was drawn
 * with, so vehicles stay on the asphalt. Hidden where the road is behind buildings or trees.
 *
 * Only the roads in and around the view are populated (a whole region has far too many roads for one
 * fixed fleet): twice a second (sim time, so film renders stay deterministic) vehicles that left that zone
 * are dropped and the zone is topped up to a fixed density, new ones preferably just off screen.
 *
 * Where trams share the street (Zagreb), vehicles yield to them (`yieldTo`): a car whose lane runs into a tram
 * ahead waits behind it, and one doesn't cross the tracks where a tram is about to pass (trams run on a
 * timetable, so where they will be in a few seconds is known). Trams never wait for cars.
 *
 * Regions with `life` (places.ts) can have detailed vehicles (body and cabin, windows, lights, shadows cast like
 * the render's) and coach parks: rows of parked coaches, and coaches that drive to a park (at each junction the
 * way that brings them nearer, by distances found once over the road graph) and from it out to a main road.
 */
import { ecefToEnu, llhToEcef } from "../../../pipeline/src/camera.ts";

export interface Road {
  c: number;        // class 0 motorway … 5 service, 6 closed to cars (kept for ground heights)
  o: number;        // 1 oneway forward, -1 oneway backward, 0 both
  l: number;        // lanes per direction (total if one-way)
  w?: number;       // carriageway width (m), as drawn on the map
  a: number; b: number; // OSM start / end node ids
  s: number[];      // [e, n, u, visible] × samples (≈ 6 m apart)
}

import { ink } from "./ink.ts";

type Vec3 = [number, number, number];
/** a tram car's footprint in ENU: centre, unit heading, length, width; `soon`: where it will be in a few seconds */
export interface Footprint { x: number; y: number; dx: number; dy: number; len: number; wid: number; soon?: boolean }
interface Trams { footprints(e: number, n: number, r: number, later?: number): Footprint[] }

interface Way { r: Road; n: number; cum: Float32Array; len: number; w: number }
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
  kind: Kind; accent?: [number, number, number];
  /** coaches: the park they drive to (or from, `leaving`), the sim time they reached it, when they appeared */
  goal?: number; leaving?: boolean; parkedAt?: number; born?: number;
  lat: number;        // lateral offset drawn (m): eases to the lane centre when the road width changes
  /** drawn pose, smoothed: position error (m) that decays, heading, sim time last drawn (-1: not drawn) */
  ex: number; ey: number; hx: number; hy: number; cx: number; cy: number; seen: number;
  alpha: number;      // fades in/out (~0.25 s) where the road passes behind trees / buildings instead of popping
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
type Kind = "car" | "hatch" | "sedan" | "suv" | "van" | "bus" | "coach" | "minibus";
/** detailed vehicles: [length, width, height, body top] (m); length varies a little per car */
const DIMS: Record<Kind, [number, number, number, number]> = {
  car: [4.6, 1.8, 1.5, 1.5], hatch: [4.1, 1.76, 1.48, 0.95], sedan: [4.7, 1.8, 1.45, 0.9], suv: [4.6, 1.9, 1.7, 1.05],
  van: [5.3, 2.0, 2.25, 2.25], bus: [12, 2.55, 3.1, 3.1], coach: [12.5, 2.55, 3.6, 3.6], minibus: [7.2, 2.15, 2.7, 2.7],
};
const VAN_COLORS: Array<[number, number, number]> = [[240, 240, 240], [240, 240, 240], [240, 240, 240], [196, 199, 204], [60, 62, 68], [38, 74, 140]];
const COACH_COLORS: Array<[number, number, number]> = [[244, 244, 244], [244, 244, 244], [244, 244, 244], [200, 204, 210], [40, 52, 96], [178, 34, 40], [236, 190, 52]];
const ACCENTS: Array<[number, number, number]> = [[200, 40, 40], [30, 90, 170], [240, 160, 30], [40, 140, 80], [120, 60, 150], [60, 62, 68]];
const GLASS = "#27313b";
export interface CoachPark { name: string; at: [number, number]; heading: number; row: number; count: number; step: number }
export interface TrafficOptions { detailed?: boolean; coaches?: CoachPark[] }
interface Park { node: number; ways: number[]; dist: Map<number, number>; parked: Array<{ c: Vec3; d: [number, number]; v: Vehicle }>; nextIn: number; nextOut: number }

export class Traffic {
  private ways: Way[] = [];
  private out = new Map<number, Array<{ w: number; dir: 1 | -1 }>>();
  /** ways arriving at a node */
  private into = new Map<number, number[]>();
  private vehicles: Vehicle[] = [];
  /** junction node -> approach (way) that has green, vehicles inside, when the green started */
  private nodeHold = new Map<number, { way: number; inside: number; start: number; last: number }>();
  /** ways meeting at a node: 2 = plain split of one road (no junction) */
  private degree = new Map<number, number>();
  /** nodes where a way other than a one-way motorway/trunk (or its ramp) meets: the rest are merges/splits */
  private street = new Set<number>();
  private lanes = new Map<string, Vehicle[]>(); // `${way}:${dir}:${lane}` -> sorted by s
  /** merges: lane entered -> the last vehicle cleared into it that hasn't reached the node yet (zipper) */
  private claims = new Map<string, Vehicle>();
  /** junction box radius per node: half the widest road meeting there + margin */
  private nodeR = new Map<number, number>();
  private t = 0;
  private rand = mulberry(7);
  private weight: number[] = [];
  /** each way's bounding box in art px */
  private box2: Float32Array;
  private zone: number[] = [];           // ways in or near the view
  private inZone = new Uint8Array(0);    // 1 near the view, 2 on screen
  private boxE: Float32Array;            // per way: ENU box [e0, n0, e1, n1]
  private zoneE: number[] | null = null; // ENU box of the zone's ways: only trams near it are looked up
  private nextManage = 0;
  private nextId = 0;
  private lastView: number[] | null = null;
  /** vehicles drawn in the last frame (debug / tests) */
  drawn = 0;
  /** trams to yield to, and their footprints this step in a 16 m grid */
  private trams: Trams | null = null;
  private tramGrid = new Map<string, Footprint[]>();
  /** canvas boxes of the vehicles drawn last ([x0, y0, x1, y1], shadows included): where the foreground goes over them */
  boxes: number[][] = [];
  /**
   * Over painted map tiles (export.ts data file "painted"): draw vehicles like the painted cities' (an ink outline,
   * a soft contact shadow instead of the render's long cast shadow, which the painting doesn't have).
   */
  painted: ((p: Vec3) => boolean) | null = null;
  /** coach parks (life.coaches); the sun's shadow per metre of height, like the styled render's */
  private parks: Park[] = [];
  private shadow: [number, number];

  constructor(roads: Road[], private enu2px: number[][], private camFwd: [number, number], private density = 1, private opts: TrafficOptions = {}) {
    // the renderer's styled sun: from the viewer's back-left (page/renderer.ts SUN), so shadows fall forward-right
    const f = camFwd, r: [number, number] = [f[1], -f[0]];
    this.shadow = [(0.45 * f[0] + 0.55 * r[0]) / 0.8, (0.45 * f[1] + 0.55 * r[1]) / 0.8];
    for (const r of roads) {
      const n = r.s.length / 4;
      if (n < 2 || r.c > 5) continue; // class 6: closed to cars (export.ts isCarFree)
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++)
        cum[i] = cum[i - 1] + Math.hypot(r.s[i * 4] - r.s[i * 4 - 4], r.s[i * 4 + 1] - r.s[i * 4 - 3]);
      const w = this.ways.push({ r, n, cum, len: cum[n - 1], w: r.w ?? Math.max(4, r.l * (r.o ? 3.2 : 6.4)) }) - 1;
      const R = Math.min(16, (r.w ?? 6) / 2 + 1.5);
      for (const n of [r.a, r.b]) {
        this.nodeR.set(n, Math.max(this.nodeR.get(n) ?? 0, R));
        this.degree.set(n, (this.degree.get(n) ?? 0) + 1);
        if (r.c > 0 || r.o === 0) this.street.add(n);
      }
      if (r.o >= 0) { this.link(r.a, { w, dir: 1 }); this.arrive(r.b, w); }
      if (r.o <= 0) { this.link(r.b, { w, dir: -1 }); this.arrive(r.a, w); }
    }
    for (const n of this.degree.keys()) if (!this.isJunction(n)) this.nodeR.set(n, 0); // no box, no stop line
    this.weight = this.ways.map((w) => w.len * CLASS_WEIGHT[w.r.c]);
    const M = this.enu2px;
    this.box2 = new Float32Array(this.ways.length * 4);
    this.boxE = new Float32Array(this.ways.length * 4);
    this.ways.forEach((way, w) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
      for (let i = 0; i < way.n; i++) {
        const e = way.r.s[i * 4], n = way.r.s[i * 4 + 1], u = way.r.s[i * 4 + 2];
        const x = M[0][0] * e + M[0][1] * n + M[0][2] * u, y = M[1][0] * e + M[1][1] * n + M[1][2] * u;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        e0 = Math.min(e0, e); e1 = Math.max(e1, e); n0 = Math.min(n0, n); n1 = Math.max(n1, n);
      }
      this.box2.set([x0, y0, x1, y1], w * 4);
      this.boxE.set([e0, n0, e1, n1], w * 4);
    });
    this.inZone = new Uint8Array(this.ways.length);
    for (const p of opts.coaches ?? []) this.addPark(p);
  }

  /** A coach park: its nearest road node, the distance to it from every node, its row of parked coaches. */
  private addPark(p: CoachPark) {
    const [x, y] = ecefToEnu(llhToEcef(p.at[0], p.at[1], 0));
    let node = -1, best = 150, z = 0;
    for (const way of this.ways) {
      const S = way.r.s, n = way.n;
      for (const [id, i] of [[way.r.a, 0], [way.r.b, n - 1]]) {
        const dd = Math.hypot(S[i * 4] - x, S[i * 4 + 1] - y);
        if (dd < best) { best = dd; node = id; z = S[i * 4 + 2]; }
      }
    }
    if (node < 0) return;
    // distances to the park over the road graph (Dijkstra over the ways, against their direction)
    const into = new Map<number, Array<[number, number]>>(); // node -> [from node, length]
    for (const way of this.ways) {
      const r = way.r, add = (to: number, from: number) => { if (!into.has(to)) into.set(to, []); into.get(to)!.push([from, way.len]); };
      if (r.o >= 0) add(r.b, r.a);
      if (r.o <= 0) add(r.a, r.b);
    }
    const dist = new Map<number, number>([[node, 0]]), heap: Array<[number, number]> = [[0, node]];
    const push = (e: [number, number]) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (heap[j][0] <= heap[i][0]) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; } };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } }
      return top;
    };
    while (heap.length) {
      const [d, n] = pop();
      if (d > (dist.get(n) ?? Infinity) || d > 6000) continue;
      for (const [from, len] of into.get(n) ?? []) if (d + len < (dist.get(from) ?? Infinity)) { dist.set(from, d + len); push([d + len, from]); }
    }
    // the parked row: coaches (every fourth a minibus) side by side as on the orthophoto
    const h = (p.heading * Math.PI) / 180, w = (p.row * Math.PI) / 180, d: [number, number] = [Math.sin(h), Math.cos(h)];
    const parked: Park["parked"] = [];
    for (let i = 0; i < p.count; i++) {
      const o = (i - (p.count - 1) / 2) * p.step, kind: Kind = (i * 7 + p.count) % 4 === 1 ? "minibus" : "coach";
      const v = this.vehicle(kind, -1, 1, 0, 0);
      v.alpha = 1;
      parked.push({ c: [x + Math.sin(w) * o, y + Math.cos(w) * o, z], d, v });
    }
    this.parks.push({ node, ways: this.ways.flatMap((way, i) => (way.r.a === node || way.r.b === node ? [i] : [])), dist, parked, nextIn: 8, nextOut: 20 });
  }

  /** A vehicle of a kind (detailed look), not yet on a lane. */
  private vehicle(kind: Kind, w: number, dir: 1 | -1, s: number, lane: number): Vehicle {
    const [L, W, H] = DIMS[kind], pick = <T>(a: T[]) => a[Math.floor(this.rand() * a.length)];
    const len = kind === "bus" || kind === "coach" || kind === "minibus" ? L : L + (this.rand() - 0.5) * 0.4;
    const color = kind === "coach" || kind === "minibus" ? pick(COACH_COLORS) : kind === "van" ? pick(VAN_COLORS) : kind === "bus" ? pick(BUS_COLORS) : pick(CAR_COLORS);
    return {
      id: this.nextId++, w, dir, s, lane, bus: kind === "bus" || kind === "coach" || kind === "minibus", kind, len, stuck: 0, through: false, holding: -1, next: null,
      cruise: 0.8 + this.rand() * 0.35, phase: this.rand() * Math.PI * 2, v: 0, wid: W, hei: H, color, accent: pick(ACCENTS),
      lat: 0, ex: 0, ey: 0, hx: 1, hy: 0, cx: 0, cy: 0, seen: -1, alpha: 0,
    };
  }

  /** Coaches on their way to a park (from a main road near the view) and from it, now and then while it is near. */
  private coachTick() {
    for (const [p, park] of this.parks.entries()) {
      if (!park.ways.some((w) => this.inZone[w])) continue;
      if (this.t >= park.nextIn && this.spawnCoach(p, false)) park.nextIn = this.t + 30 + this.rand() * 40;
      if (this.t >= park.nextOut && this.spawnCoach(p, true)) park.nextOut = this.t + 30 + this.rand() * 40;
    }
  }

  private spawnCoach(p: number, leaving: boolean) {
    const park = this.parks[p], endOf = (w: number, dir: 1 | -1) => (dir === 1 ? this.ways[w].r.b : this.ways[w].r.a);
    let w = -1, dir: 1 | -1 = 1, s = 0;
    if (leaving) {
      const out = (this.out.get(park.node) ?? []).filter((o) => (park.dist.get(endOf(o.w, o.dir)) ?? 0) > 0);
      if (!out.length) return false;
      ({ w, dir } = out[Math.floor(this.rand() * out.length)]);
      s = (this.nodeR.get(park.node) ?? 4) + 7;
    } else {
      // a through road off screen, 150 m – 2.5 km away by road, heading towards the park
      const pool: Array<{ w: number; dir: 1 | -1 }> = [];
      for (const z of this.zone) {
        if (this.inZone[z] !== 1 || this.ways[z].r.c > 3 || this.ways[z].len < 40) continue;
        for (const d of [1, -1] as const) {
          const o = this.ways[z].r.o;
          if ((o === 1 && d === -1) || (o === -1 && d === 1)) continue;
          const de = park.dist.get(endOf(z, d)), ds = park.dist.get(endOf(z, d === 1 ? -1 : 1));
          if (de !== undefined && de > 150 && de < 2500 && (ds === undefined || de < ds)) pool.push({ w: z, dir: d });
        }
      }
      if (!pool.length) return false;
      ({ w, dir } = pool[Math.floor(this.rand() * pool.length)]);
      s = 8 + this.rand() * Math.max(0, this.ways[w].len - 16);
    }
    const way = this.ways[w], g = this.lanes.get(`${w}:${dir}:0`) ?? [];
    if (way.len < 14 || g.some((o) => Math.abs(o.s - s) < (o.len + 12.5) / 2 + GAP)) return false;
    const v = this.vehicle(this.rand() < 0.2 ? "minibus" : "coach", w, dir, s, 0);
    v.goal = p; v.leaving = leaving; v.born = this.t;
    v.lat = this.offset(way, v);
    v.v = this.limit(v) * 0.6;
    this.vehicles.push(v);
    g.push(v); g.sort((a, b) => a.s - b.s);
    this.lanes.set(`${w}:${dir}:0`, g);
    return true;
  }

  /**
   * Keep the fleet on the roads around the view `art` (art px box): drop vehicles outside, top up to
   * ~1 vehicle per 55 weighted metres (class weights: busy roads get more), thinned evenly when that exceeds
   * the cap. Only on the first fill and after a jump (the view moved or zoomed by more than half) is the
   * screen itself filled; otherwise new vehicles start off screen and drive in, so nothing pops up in view.
   */
  private manage([ax0, ay0, ax1, ay1]: number[]) {
    const mx = (ax1 - ax0) * 0.5, my = (ay1 - ay0) * 0.5, B = this.box2;
    this.zone = [];
    let total = 0, e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    for (let w = 0; w < this.ways.length; w++) {
      const x0 = B[w * 4], y0 = B[w * 4 + 1], x1 = B[w * 4 + 2], y1 = B[w * 4 + 3];
      if (x1 < ax0 - mx || x0 > ax1 + mx || y1 < ay0 - my || y0 > ay1 + my) { this.inZone[w] = 0; continue; }
      const vis = x1 >= ax0 && x0 <= ax1 && y1 >= ay0 && y0 <= ay1;
      this.inZone[w] = vis ? 2 : 1;
      this.zone.push(w); total += this.weight[w];
      const E = this.boxE;
      e0 = Math.min(e0, E[w * 4]); n0 = Math.min(n0, E[w * 4 + 1]); e1 = Math.max(e1, E[w * 4 + 2]); n1 = Math.max(n1, E[w * 4 + 3]);
    }
    this.zoneE = this.zone.length ? [e0, n0, e1, n1] : null;
    const before = this.vehicles.length;
    this.vehicles = this.vehicles.filter((v) => { if (this.inZone[v.w]) return true; this.release(v); v.next = null; return false; });
    if (this.vehicles.length !== before) this.regroup();
    const count = Math.round(Math.min(2500, (total / 55) * this.density));
    if (this.vehicles.length >= count) { if (this.parks.length) this.coachTick(); return; }
    const L = this.lastView, size = Math.max(ax1 - ax0, ay1 - ay0);
    const jump = !L || Math.hypot((ax0 + ax1 - L[0] - L[2]) / 2, (ay0 + ay1 - L[1] - L[3]) / 2) > size / 2
      || Math.abs(Math.log(size / Math.max(L[2] - L[0], L[3] - L[1]))) > Math.log(1.5);
    this.lastView = [ax0, ay0, ax1, ay1];
    const fillScreen = jump;
    const pool = fillScreen ? this.zone : this.zone.filter((w) => this.inZone[w] === 1);
    if (this.parks.length) this.coachTick();
    if (!pool.length) return;
    const weights = pool.map((w) => this.weight[w]), sum = weights.reduce((a, b) => a + b, 0);
    for (let tries = 0, need = count - this.vehicles.length; need > 0 && tries < need * 4; tries++) {
      let pick = this.rand() * sum, k = 0;
      while (pick > weights[k] && k < weights.length - 1) pick -= weights[k++];
      if (this.spawn(pool[k])) need--;
    }
  }

  /** a new vehicle somewhere on way w (false if it doesn't fit) */
  private spawn(w: number) {
    const way = this.ways[w];
    const dir: 1 | -1 = way.r.o === 1 ? 1 : way.r.o === -1 ? -1 : this.rand() < 0.5 ? 1 : -1;
    const bus = way.r.c <= 2 && this.rand() < 0.08;
    const len = bus ? 12 : 4.4 + this.rand() * 0.6;
    if (way.len < len + 4) return false;
    const s = len / 2 + this.rand() * (way.len - len);
    const lane = bus ? 0 : Math.floor(this.rand() * way.r.l);
    // never spawn on top of another vehicle
    const key = `${w}:${dir}:${lane}`, group = this.lanes.get(key) ?? [];
    if (group.some((o) => Math.abs(o.s - s) < (o.len + len) / 2 + GAP)) return false;
    let v: Vehicle;
    if (this.opts.detailed) { // hatchbacks, saloons, SUVs, white vans
      const k = this.rand();
      v = this.vehicle(bus ? "bus" : k < 0.4 ? "hatch" : k < 0.65 ? "sedan" : k < 0.87 ? "suv" : "van", w, dir, s, lane);
      if (way.len < v.len + 4 || group.some((o) => Math.abs(o.s - s) < (o.len + v.len) / 2 + GAP)) return false;
    } else v = {
      id: this.nextId++, w, dir, s, lane, bus, kind: bus ? "bus" : "car", len, stuck: 0, through: false, holding: -1, next: null,
      cruise: 0.8 + this.rand() * 0.35, phase: this.rand() * Math.PI * 2, v: 0,
      wid: bus ? 2.55 : 1.8, hei: bus ? 3.1 : 1.5,
      color: bus ? BUS_COLORS[Math.floor(this.rand() * BUS_COLORS.length)] : CAR_COLORS[Math.floor(this.rand() * CAR_COLORS.length)], lat: 0, ex: 0, ey: 0, hx: 1, hy: 0, cx: 0, cy: 0, seen: -1, alpha: 0,
    };
    v.lat = this.offset(way, v);
    v.v = this.limit(v) * 0.8;
    this.vehicles.push(v);
    group.push(v);
    group.sort((a, b) => a.s - b.s);
    this.lanes.set(key, group);
    return true;
  }

  get count() { return this.vehicles.length; }

  /** yield to these trams (web/src/scripts/trains.ts) from now on */
  yieldTo(trams: Trams) { this.trams = trams; }

  /** ENU point `ahead` m in front of the vehicle's centre, in its lane, and the heading there */
  private ahead(v: Vehicle, ahead: number): [number, number, number, number] {
    const way = this.ways[v.w], S = way.r.s, C = way.cum;
    const s = Math.max(0, Math.min(way.len, v.dir === 1 ? v.s + ahead : way.len - v.s - ahead));
    let lo = 0, hi = way.n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] < s) lo = m; else hi = m; }
    const f = (s - C[lo]) / Math.max(1e-3, C[hi] - C[lo]), a = lo * 4, b = hi * 4;
    let dx = S[b] - S[a], dy = S[b + 1] - S[a + 1];
    const L = Math.hypot(dx, dy) || 1; dx = (dx / L) * v.dir; dy = (dy / L) * v.dir;
    return [S[a] + (S[b] - S[a]) * f + dy * v.lat, S[a + 1] + (S[b + 1] - S[a + 1]) * f - dx * v.lat, dx, dy];
  }

  /**
   * a tram car covers ENU point p (with `pad` m to spare sideways)? Where trams will `soon` be counts only across
   * the car's way (a tram coming up behind in the same street would stop it in front of the tram).
   */
  private tramAt(p: [number, number, number, number], pad: number, soon: boolean) {
    for (const f of this.tramGrid.get(`${Math.floor(p[0] / 16)}_${Math.floor(p[1] / 16)}`) ?? []) {
      if (f.soon && (!soon || Math.abs(f.dx * p[2] + f.dy * p[3]) > 0.7)) continue;
      const rx = p[0] - f.x, ry = p[1] - f.y;
      if (Math.abs(rx * f.dx + ry * f.dy) < f.len / 2 + 0.5 && Math.abs(rx * f.dy - ry * f.dx) < f.wid / 2 + pad) return true;
    }
    return false;
  }

  /**
   * Room (m) ahead of the vehicle's front before a tram, looking `range` m ahead (Infinity: clear). Inside a
   * junction box a car only minds trams already there: it clears the crossing rather than stopping on it.
   */
  private tramGap(v: Vehicle, range: number) {
    if (!this.tramGrid.size || this.tramAt(this.ahead(v, 0), 0, false)) return Infinity; // already alongside one: drive on out
    const soon = v.holding < 0;
    for (let d = 1; d <= range; d += 2.5) if (this.tramAt(this.ahead(v, v.len / 2 + d), v.wid / 2, soon)) return Math.max(0, d - 2.5);
    return Infinity;
  }

  private link(node: number, e: { w: number; dir: 1 | -1 }) {
    if (!this.out.has(node)) this.out.set(node, []);
    this.out.get(node)!.push(e);
  }

  private arrive(node: number, w: number) {
    if (!this.into.has(node)) this.into.set(node, []);
    this.into.get(node)!.push(w);
  }

  /**
   * Lane on `next` (0 = rightmost). Through a street junction the lane number carries over. Elsewhere (motorway
   * merges and splits, lane changes along one road) lanes line up from the left: a lane added on the right
   * (acceleration or exit lane) shifts the through lanes over and a dropped one ends on the right; at a merge the
   * approach with fewer lanes (the ramp) keeps the rightmost lanes.
   */
  private enterLane(v: Vehicle, next: { w: number; dir: 1 | -1 }) {
    const to = this.ways[next.w].r.l;
    if (v.bus || to <= 1) return 0;
    const node = this.endNode(v), from = this.ways[v.w];
    if (this.isJunction(node)) return Math.min(v.lane, to - 1);
    const minor = (this.into.get(node) ?? []).some((u) => {
      const o = this.ways[u];
      return u !== v.w && (o.r.l > from.r.l || (o.r.l === from.r.l && o.w > from.w));
    });
    return Math.max(0, Math.min(to - 1, minor ? v.lane : v.lane + to - from.r.l));
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
    if (v.goal !== undefined) { // coaches: towards their park, or away from it out to a main road
      const park = this.parks[v.goal], end = (o: { w: number; dir: 1 | -1 }) => (o.dir === 1 ? this.ways[o.w].r.b : this.ways[o.w].r.a);
      if (!v.leaving && this.endNode(v) === park.node) return null; // there: drives up and parks
      if (v.leaving && this.ways[v.w].r.c <= 2) { v.goal = undefined; v.leaving = false; } // out: traffic like a bus
      else {
        const known = options.filter((o) => park.dist.has(end(o)));
        if (known.length) {
          const cost = (o: { w: number; dir: 1 | -1 }) => (v.leaving ? -park.dist.get(end(o))! : this.ways[o.w].len + park.dist.get(end(o))!);
          return known.reduce((a, b) => (cost(b) < cost(a) ? b : a));
        }
      }
    }
    const pool = v.bus ? options.filter((o) => this.ways[o.w].r.c <= 3) : options;
    const from = pool.length ? pool : options;
    if (!from.length) return null;
    const weights = from.map((o) => CLASS_WEIGHT[this.ways[o.w].r.c] + 0.05);
    let pick = this.rand() * weights.reduce((a, b) => a + b, 0), k = 0;
    while (pick > weights[k] && k < weights.length - 1) pick -= weights[k++];
    return from[k];
  }

  private laneKey(v: Vehicle, next: { w: number; dir: 1 | -1 }) {
    return `${next.w}:${next.dir}:${this.enterLane(v, next)}`;
  }
  /** The lane group the vehicle enters on `next`. */
  private nextLane(v: Vehicle, next: { w: number; dir: 1 | -1 }) { return this.lanes.get(this.laneKey(v, next)); }
  /** Centre to the node at the end of its way (m). */
  private toNode(v: Vehicle) { return this.ways[v.w].len - v.s; }

  /** A vehicle from another approach cleared into the lane `v` would enter at a merge and still before the node. */
  private rival(v: Vehicle) {
    if (!v.next || (this.degree.get(this.endNode(v)) ?? 0) <= 2) return undefined;
    const c = this.claims.get(this.laneKey(v, v.next));
    if (!c || c === v || c.w === v.w || !c.through || !c.next || this.laneKey(c, c.next) !== this.laneKey(v, v.next)) return undefined;
    return c;
  }

  /**
   * Free space beyond the junction box at the start of `next`, in the lane we would enter. A plain split of one
   * road (two ways meet) needs none: there is no other stream, and car following sees across it.
   */
  private entryClear(v: Vehicle, next: { w: number; dir: 1 | -1 }) {
    const node = this.endNode(v);
    if ((this.degree.get(node) ?? 0) <= 2) return true;
    const g = this.nextLane(v, next);
    return !g?.length || g[0].s - g[0].len / 2 > (this.nodeR.get(node) ?? 4) + v.len + GAP;
  }

  /** Distance from the vehicle's front to the stop line before the junction box ahead. */
  private toStop(v: Vehicle) {
    return this.ways[v.w].len - v.s - v.len / 2 - (this.nodeR.get(this.endNode(v)) ?? 4);
  }

  /**
   * A crossing with a box and green phases. Motorway merges and splits are not: cars flow through them
   * at speed and only wait (gap acceptance) when the lane they enter is full.
   */
  private isJunction(node: number) { return (this.degree.get(node) ?? 0) > 2 && this.street.has(node); }

  /**
   * May the vehicle enter the junction ahead now? Vehicles from the same approach go together
   * (a green phase, at most 12 s while others wait); other approaches wait until the box is empty.
   */
  private grant(v: Vehicle) {
    if (!v.next || !this.entryClear(v, v.next)) return false;
    const node = this.endNode(v);
    if (!this.isJunction(node)) {
      if ((this.degree.get(node) ?? 0) > 2) { // merge: zip in behind the other approach's last car, or claim the lane first
        const c = this.rival(v);
        if (c && Math.abs(this.toNode(v) - this.toNode(c)) < (c.len + v.len) / 2 + GAP) return false;
        this.claims.set(this.laneKey(v, v.next), v);
      }
      v.through = true; return true;
    }
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
    this.tramGrid.clear();
    // the trams near the zone (vehicles only drive there; 80 m: a car's look-ahead) now and in 2 and 4 s;
    // each car in every 16 m cell its box touches
    const Z = this.zoneE, ze = Z ? (Z[0] + Z[2]) / 2 : 0, zn = Z ? (Z[1] + Z[3]) / 2 : 0, zr = Z ? Math.max(Z[2] - Z[0], Z[3] - Z[1]) / 2 + 80 : 0;
    if (this.trams && Z) for (const f of [0, 2, 4].flatMap((later) => this.trams!.footprints(ze, zn, zr, later).map((f) => (later ? { ...f, soon: true } : f)))) {
      const r = f.len / 2 + f.wid;
      for (let x = Math.floor((f.x - r) / 16); x <= Math.floor((f.x + r) / 16); x++)
        for (let y = Math.floor((f.y - r) / 16); y <= Math.floor((f.y + r) / 16); y++) {
          const k = `${x}_${y}`, g = this.tramGrid.get(k);
          if (g) g.push(f); else this.tramGrid.set(k, [f]);
        }
    }
    for (const g of this.lanes.values()) {
      for (let k = 0; k < g.length; k++) {
        const v = g[k], way = this.ways[v.w];
        if (v.next === null) v.next = this.chooseNext(v);
        let target = this.limit(v);
        if (v.stuck > 25) { this.respawn(v); continue; } // gridlock escape
        if (v.goal !== undefined && !v.leaving && !v.next) target = Math.min(target, Math.max(0, way.len - v.s - v.len / 2 - 1) * 0.6); // easing into the park
        // car following: stay a safe gap behind the vehicle ahead in this lane, or (none left on this way) the
        // last one that entered our lane of the next way, so traffic flows across way ends without stopping
        const lead = g[k + 1];
        let ahead: Vehicle | undefined = lead, gap = Infinity;
        if (lead) gap = lead.s - lead.len / 2 - (v.s + v.len / 2) - GAP;
        else if (v.next && (v.through || !this.isJunction(this.endNode(v)))) {
          ahead = this.nextLane(v, v.next)?.[0];
          if (ahead) gap = way.len - v.s - v.len / 2 + ahead.s - ahead.len / 2 - GAP;
          const c = this.rival(v); // at a merge, the other approach's car that goes before us
          if (c && this.toNode(c) < this.toNode(v)) {
            const g2 = this.toNode(v) - this.toNode(c) - (c.len + v.len) / 2 - GAP;
            if (g2 < gap) { ahead = c; gap = g2; }
          }
        }
        if (ahead) target = Math.min(target, Math.max(0, gap / HEADWAY), ahead.v + Math.max(0, gap) * 0.5);
        // a tram in the lane ahead (sharing the street, or crossing): stay behind it
        if (this.trams) {
          const room = this.tramGap(v, GAP + v.v * HEADWAY + (v.v * v.v) / (2 * BRAKE) + 3);
          if (room < Infinity) target = Math.min(target, Math.max(0, room - GAP) / HEADWAY);
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
    for (const v of this.vehicles) { const o = this.offset(this.ways[v.w], v); v.lat += Math.max(-1.5 * dt, Math.min(1.5 * dt, o - v.lat)); }
    // move vehicles that have driven past the end of their way onto the next one
    for (const v of this.vehicles) {
      let way = this.ways[v.w];
      if (!v.next || !v.through) {
        if (v.s + v.len / 2 < way.len) continue;
        if (v.next) { v.s = way.len - v.len / 2; v.v = 0; continue; } // not granted: hold at the end
        if (v.goal !== undefined && !v.leaving) { v.parkedAt ??= this.t; v.s = way.len - v.len / 2; v.v = 0; continue; } // a coach in its park
        // dead end
        if (way.r.o === 0) { v.dir = v.dir === 1 ? -1 : 1; v.s = v.len / 2; v.through = false; }
        else this.respawn(v);
        continue;
      }
      // hand over when the centre (the drawn position) crosses the node: the car moves on continuously
      if (v.s < way.len) continue;
      const over = v.s - way.len, key = this.laneKey(v, v.next);
      if (this.claims.get(key) === v) this.claims.delete(key);
      v.lane = this.enterLane(v, v.next);
      v.w = v.next.w; v.dir = v.next.dir; v.next = null; v.through = false;
      way = this.ways[v.w];
      v.s = Math.min(way.len, over);
      v.phase += 0.7;
    }
    // coaches that reached their park fade out in a second
    if (this.vehicles.some((v) => v.parkedAt !== undefined && this.t - v.parkedAt > 1)) {
      this.vehicles = this.vehicles.filter((v) => { if (v.parkedAt === undefined || this.t - v.parkedAt <= 1) return true; this.release(v); return false; });
    }
  }

  /** Move a vehicle stranded at a one-way dead end (data gap) to a random free road start. */
  private respawn(v: Vehicle) {
    this.release(v);
    if (v.goal !== undefined) { v.parkedAt = this.t - 1; return; } // a coach that cannot get on: gone
    for (let tries = 0; tries < 20; tries++) {
      const w = this.zone[Math.floor(this.rand() * this.zone.length)], way = this.ways[w];
      if (w === undefined || this.inZone[w] !== 1) continue; // never reappear in view
      const dir: 1 | -1 = way.r.o === -1 ? -1 : way.r.o === 1 ? 1 : this.rand() < 0.5 ? 1 : -1;
      const start = (this.nodeR.get(dir === 1 ? way.r.a : way.r.b) ?? 4) + v.len / 2;
      if (way.r.c > 3 || way.len < start + v.len + 30 || (v.bus && way.r.c > 2)) continue;
      const g = this.lanes.get(`${w}:${dir}:0`);
      if (g?.some((o) => Math.abs(o.s - start) < v.len + 2 * GAP + o.len)) continue;
      Object.assign(v, { w, dir, lane: 0, s: start, v: 0, next: null, stuck: 0, through: false, seen: -1 });
      v.lat = this.offset(way, v);
      return;
    }
  }

  /** Lateral offset (m, + = right of travel) of the lane centre, kept inside the drawn asphalt. */
  private offset(way: Way, v: Vehicle) {
    const r = way.r, half = way.w / 2;
    const lanes = Math.max(1, r.l);
    const lw = r.o === 0 ? half / lanes : way.w / lanes;
    const o = half - (v.lane + 0.5) * lw;
    return Math.max(-half + v.wid / 2 + 0.2, Math.min(half - v.wid / 2 - 0.2, o));
  }

  /** Draw vehicles. `toScreen` maps global art px -> canvas px; `px` = canvas px per art px. */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: [number, number, number, number]) {
    if (px < 0.14) return; // cars < ~2.5 px: skip
    const [vx0, vy0, vx1, vy1] = view;
    if (this.t >= this.nextManage) {
      // the view in art px (toScreen is scale + offset)
      const [ox, oy] = toScreen(0, 0), [sx1, sy1] = toScreen(1, 1), kx = sx1 - ox, ky = sy1 - oy;
      this.manage([(vx0 - ox) / kx, (vy0 - oy) / ky, (vx1 - ox) / kx, (vy1 - oy) / ky]);
      this.nextManage = this.t + 0.5;
    }
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
      const mid = at(v.s);
      // hidden when the road under the car's centre is (the nearest sample), so it fades only once it is
      // well into the cover; a lone hidden sample between visible ones (a crown's edge) doesn't count
      const j = mid.s - way.cum[mid.i - 1] < way.cum[mid.i] - mid.s ? mid.i - 1 : mid.i;
      const vis = !!S[j * 4 + 3] || (j > 0 && j < way.n - 1 && !!S[(j - 1) * 4 + 3] && !!S[(j + 1) * 4 + 3]);
      const { i, s } = mid, k0 = (i - 1) * 4, k1 = i * 4;
      const f = (s - way.cum[i - 1]) / Math.max(1e-3, way.cum[i] - way.cum[i - 1]);
      let dx = S[k1] - S[k0], dy = S[k1 + 1] - S[k0 + 1];
      const L = Math.hypot(dx, dy) || 1;
      dx = (dx / L) * v.dir; dy = (dy / L) * v.dir;
      const off = v.lat;
      const c: Vec3 = [S[k0] + (S[k1] - S[k0]) * f + dy * off, S[k0 + 1] + (S[k1 + 1] - S[k0 + 1]) * f - dx * off, S[k0 + 2] + (S[k1 + 2] - S[k0 + 2]) * f];
      // The lane offset swings sideways where the road bends (polyline vertices, way handovers, U-turns).
      // Keep motion continuous: the gap between where the car would be had it simply driven on and the
      // new pose becomes an error that fades out in ~0.15 s; the heading turns the same way.
      const dtf = this.t - v.seen;
      if (v.seen >= 0 && dtf > 0 && dtf < 0.5) {
        const k = Math.exp(-dtf / 0.15), step = v.v * dtf;
        const px = v.cx + v.hx * step, py = v.cy + v.hy * step;
        let gx = px - c[0], gy = py - c[1];
        if (gx * gx + gy * gy > 100) gx = gy = 0; // > 10 m: a real teleport (respawn), don't slide
        v.ex = gx * k; v.ey = gy * k;
        let hx = v.hx + (dx - v.hx) * (1 - k), hy = v.hy + (dy - v.hy) * (1 - k);
        const hl = Math.hypot(hx, hy);
        if (hl < 0.3 || v.hx * dx + v.hy * dy < -0.5) { hx = dx; hy = dy; } else { hx /= hl; hy /= hl; }
        v.hx = hx; v.hy = hy;
      } else if (dtf !== 0) { v.ex = v.ey = 0; v.hx = dx; v.hy = dy; }
      c[0] += v.ex; c[1] += v.ey;
      v.alpha = v.seen < 0 ? (vis ? 1 : 0) : Math.max(0, Math.min(1, v.alpha + (vis ? 1 : -1) * Math.max(0, dtf) / 0.25));
      v.cx = c[0]; v.cy = c[1]; v.seen = this.t;
      if (v.alpha <= 0) continue;
      dx = v.hx; dy = v.hy;
      const [sx, sy] = proj(c);
      if (sx < vx0 - 40 || sy < vy0 - 40 || sx > vx1 + 40 || sy > vy1 + 40) continue;
      items.push({ v, c, d: [dx, dy], depth: c[0] * this.camFwd[0] + c[1] * this.camFwd[1] });
    }
    for (const park of this.parks) for (const { c, d, v } of park.parked) {
      const [sx, sy] = proj(c);
      if (sx < vx0 - 60 || sy < vy0 - 60 || sx > vx1 + 60 || sy > vy1 + 60) continue;
      items.push({ v, c, d, depth: c[0] * this.camFwd[0] + c[1] * this.camFwd[1] });
    }
    items.sort((a, b) => b.depth - a.depth); // back to front
    this.drawn = items.length;
    this.boxes = [];
    for (const { v, c, d } of items) {
      // its canvas box with the shadow, for the foreground drawn over it (foreground.ts)
      const [L, W, H] = DIMS[v.kind], R = Math.max(L, W) / 2 + H + 0.8;
      const pts = [proj([c[0] - R, c[1] - R, c[2]]), proj([c[0] + R, c[1] - R, c[2]]), proj([c[0] - R, c[1] + R, c[2]]), proj([c[0] + R, c[1] + R, c[2]]), proj([c[0], c[1], c[2] + H + 0.5])];
      this.boxes.push([Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))]);
      const fade = v.parkedAt !== undefined ? Math.max(0, 1 - (this.t - v.parkedAt)) : v.born !== undefined && v.leaving ? Math.min(1, (this.t - v.born) / 0.8) : 1;
      if (fade < 1) { const a = v.alpha; v.alpha *= fade; this.opts.detailed ? this.detailed(ctx, proj, c, d, v) : this.box(ctx, proj, c, d, v); v.alpha = a; }
      else if (this.opts.detailed) this.detailed(ctx, proj, c, d, v);
      else this.box(ctx, proj, c, d, v);
    }
  }

  /**
   * A detailed vehicle (life.vehicles): a shadow cast like the render's, the body, a cabin of glass with a
   * roof (cars), a window band (buses, coaches with a coloured stripe), windscreens, head and tail lights.
   * Only faces turned to the camera are drawn, back to front within the vehicle.
   */
  private detailed(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], v: Vehicle) {
    const r: [number, number] = [d[1], -d[0]], hl = v.len / 2, hw = v.wid / 2, a = v.alpha, F = this.camFwd;
    const P = (x: number, y: number, z: number): Vec3 => [c[0] + d[0] * x + r[0] * y, c[1] + d[1] * x + r[1] * y, c[2] + z];
    const painted = this.painted?.(c) ?? false;
    const p0 = proj(c), pe = proj([c[0] + 1, c[1], c[2]]), pn = proj([c[0], c[1] + 1, c[2]]);
    const pxPerM = (Math.hypot(pe[0] - p0[0], pe[1] - p0[1]) + Math.hypot(pn[0] - p0[0], pn[1] - p0[1])) / 2;
    let inked = false; // painted: body and cabin faces get the ink outline
    const poly = (pts: Vec3[], color: string, alpha = 1) => {
      ctx.globalAlpha = alpha * a; ctx.fillStyle = color; ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath(); ctx.fill();
      if (inked) ink(ctx, pxPerM);
    };
    const rgb = (k: number, col = v.color) => `rgb(${Math.min(255, col[0] * k) | 0},${Math.min(255, col[1] * k) | 0},${Math.min(255, col[2] * k) | 0})`;
    // faces: +x front, -x rear, +y right, -y left; seen when the outward normal points against the view
    const seen = (nx: number, ny: number) => (d[0] * nx + r[0] * ny) * F[0] + (d[1] * nx + r[1] * ny) * F[1] < 0;
    // shadow: the footprint swept along the sun's shadow by the height, as a hull in screen space
    const sh = this.shadow, H = v.hei;
    const foot = [P(hl, hw, 0.02), P(hl, -hw, 0.02), P(-hl, -hw, 0.02), P(-hl, hw, 0.02)];
    if (painted) poly(foot.map((p) => [p[0] + 0.4, p[1] - 0.4, p[2]] as Vec3), "#000", 0.25); // soft contact shadow, as painted
    else {
      const pts = [...foot, ...foot.map((p) => [p[0] + sh[0] * H * 0.9, p[1] + sh[1] * H * 0.9, p[2]] as Vec3)].map(proj);
      ctx.globalAlpha = 0.22 * a; ctx.fillStyle = "#000"; ctx.beginPath();
      hull(pts).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill();
    }
    inked = painted;
    // a box from z0 to z1 over [x0, x1] × [-w, w]: its seen sides, then the top
    const box = (x0: number, x1: number, w: number, z0: number, z1: number, side: (face: number) => string, top: string | null) => {
      if (seen(0, -1)) poly([P(x0, -w, z0), P(x1, -w, z0), P(x1, -w, z1), P(x0, -w, z1)], side(0));
      if (seen(0, 1)) poly([P(x1, w, z0), P(x0, w, z0), P(x0, w, z1), P(x1, w, z1)], side(1));
      if (seen(1, 0)) poly([P(x1, -w, z0), P(x1, w, z0), P(x1, w, z1), P(x1, -w, z1)], side(2));
      if (seen(-1, 0)) poly([P(x0, w, z0), P(x0, -w, z0), P(x0, -w, z1), P(x0, w, z1)], side(3));
      if (top) poly([P(x0, -w, z1), P(x1, -w, z1), P(x1, w, z1), P(x0, w, z1)], top);
    };
    const shade = (f: number) => rgb(f === 2 || f === 3 ? 0.8 : 0.7);
    const K = v.kind, zb = DIMS[K][3];
    const big = K === "bus" || K === "coach" || K === "minibus";
    box(-hl, hl, hw, 0.3, zb, shade, big || K === "van" ? null : rgb(1.02));
    if (K === "hatch" || K === "sedan" || K === "suv" || K === "car") {
      // the cabin: glass sides, a sloping windscreen and rear window, a roof in the body colour
      const [x0, x1] = K === "hatch" ? [-hl + 0.25, hl * 0.25] : K === "sedan" ? [-hl * 0.5, hl * 0.22] : [-hl + 0.2, hl * 0.3];
      const [t0, t1] = K === "hatch" ? [x0 + 0.12, x1 - 0.6] : K === "sedan" ? [x0 + 0.45, x1 - 0.55] : [x0 + 0.08, x1 - 0.45];
      const w = hw - 0.12, z0 = zb, z1 = H;
      if (seen(0, -1)) poly([P(x0, -w, z0), P(x1, -w, z0), P(t1, -w, z1), P(t0, -w, z1)], GLASS);
      if (seen(0, 1)) poly([P(x1, w, z0), P(x0, w, z0), P(t0, w, z1), P(t1, w, z1)], GLASS);
      if (seen(1, 0)) poly([P(x1, -w, z0), P(x1, w, z0), P(t1, w, z1), P(t1, -w, z1)], "#3a4652");
      if (seen(-1, 0)) poly([P(x0, w, z0), P(x0, -w, z0), P(t0, -w, z1), P(t0, w, z1)], "#3a4652");
      poly([P(t0, -w, z1), P(t1, -w, z1), P(t1, w, z1), P(t0, w, z1)], rgb(1.08));
    } else {
      // vans, buses, coaches: one tall box with a window band
      const roof = big ? "#e9ebed" : rgb(1.04), z1 = H;
      poly([P(-hl, -hw, z1), P(hl, -hw, z1), P(hl, hw, z1), P(-hl, hw, z1)], roof);
      const [w0, w1] = K === "van" ? [1.15, H - 0.2] : K === "minibus" ? [1.25, H - 0.3] : [1.3, H - 0.35];
      const xs: [number, number] = K === "van" ? [hl - 1.2, hl - 0.25] : [-hl + 0.4, hl - 0.4];
      for (const sgn of [-1, 1] as const) {
        if (!seen(0, sgn)) continue;
        const y = sgn * (hw + 0.01);
        poly([P(xs[0], y, w0), P(xs[1], y, w0), P(xs[1], y, w1), P(xs[0], y, w1)], GLASS);
        if (K === "coach" || K === "minibus") poly([P(-hl + 0.3, y, 0.55), P(hl - 0.3, y, 0.55), P(hl - 0.3, y, 0.9), P(-hl + 0.3, y, 0.9)], rgb(1, v.accent));
      }
      if (seen(1, 0)) poly([P(hl + 0.01, -hw + 0.15, w0 - 0.1), P(hl + 0.01, hw - 0.15, w0 - 0.1), P(hl + 0.01, hw - 0.15, w1), P(hl + 0.01, -hw + 0.15, w1)], GLASS);
      if (big && K !== "minibus") poly([P(-hl * 0.3, -0.6, H), P(hl * 0.1, -0.6, H), P(hl * 0.1, 0.6, H + 0.25), P(-hl * 0.3, 0.6, H + 0.25)], "#c9cdd2"); // roof unit
    }
    inked = false;
    // lights: head lights at the front, tail lights at the rear, where those ends are seen
    const lamp = (x: number, col: string) => {
      for (const y of [-hw + 0.3, hw - 0.3]) poly([P(x, y - 0.17, 0.55), P(x, y + 0.17, 0.55), P(x, y + 0.17, 0.75), P(x, y - 0.17, 0.75)], col);
    };
    if (seen(1, 0)) lamp(hl + 0.02, "#fff6d8");
    if (seen(-1, 0)) lamp(-hl - 0.02, "#d0261f");
    ctx.globalAlpha = 1;
  }

  private box(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], v: Vehicle) {
    const r: [number, number] = [d[1], -d[0]];
    const hl = v.len / 2, hw = v.wid / 2;
    const corner = (a: number, b: number, z: number): Vec3 => [c[0] + d[0] * a + r[0] * b, c[1] + d[1] * a + r[1] * b, c[2] + z];
    const base = [corner(hl, hw, 0.25), corner(hl, -hw, 0.25), corner(-hl, -hw, 0.25), corner(-hl, hw, 0.25)];
    const top = base.map((p) => [p[0], p[1], p[2] + v.hei] as Vec3);
    const [R, G, B] = v.color;
    const p0 = proj(c), pe = proj([c[0] + 1, c[1], c[2]]), pn = proj([c[0], c[1] + 1, c[2]]);
    const pxPerM = (Math.hypot(pe[0] - p0[0], pe[1] - p0[1]) + Math.hypot(pn[0] - p0[0], pn[1] - p0[1])) / 2;
    const fill = (pts: Vec3[], k: number, outline = true) => {
      ctx.fillStyle = `rgb(${R * k | 0},${G * k | 0},${B * k | 0})`;
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fill();
      if (outline) ink(ctx, pxPerM);
    };
    // soft contact shadow
    const a = v.alpha;
    ctx.globalAlpha = 0.25 * a;
    fill(base.map((p) => [p[0] + 0.4, p[1] - 0.4, p[2] - 0.25] as Vec3), 0, false);
    ctx.globalAlpha = a;
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
    ctx.globalAlpha = (v.bus ? 0.25 : 0.55) * a;
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

/** convex hull of screen points (monotone chain) */
function hull(p: Array<[number, number]>): Array<[number, number]> {
  const q = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Array<[number, number]> = [], hi: Array<[number, number]> = [];
  for (const x of q) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], x) <= 0) lo.pop(); lo.push(x); }
  for (const x of q.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], x) <= 0) hi.pop(); hi.push(x); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}
