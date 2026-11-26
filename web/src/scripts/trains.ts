/**
 * Trains on the real lines (OSM route relations, exported by pipeline/src/export.ts exportTrains): Stadtbahn,
 * S-Bahn, regional and long-distance trains; in regions with local stock (places.ts `rail`, Zagreb) street
 * trams and funicular cars too. Each line shuttles: out along one direction's relation, a
 * turnaround at the end, back along the other's (the Stadtbahn end to end; mainline trains come in over the
 * map edge to the Hbf terminus and leave the same way). Between stops a train accelerates, cruises and
 * brakes; it dwells at every stop of its relation. Trains of a line run its interval apart.
 *
 * Positions are a pure function of sim time (deterministic for film renders), no collision handling: lines
 * sharing a track are offset by their own phase. Cars are boxes bent along the track (each placed by its two
 * ends), hidden in tunnels and behind cover with a short fade, like the road traffic.
 */

import { ink } from "./ink.ts";

type Vec3 = [number, number, number];
type RGB = [number, number, number];

interface EncodedLine { k: number; r: string; c: string; i: number; b: number; w: number[]; st: number[] }
interface Encoded { v: 1; n: number[]; s: number[]; vis: number[]; l: EncodedLine[] }

/** One direction of a line: its run as samples [e, n, u, visible], arc lengths, stops. */
export interface Line { k: number; ref: string; interval: number; back: number; p: Float32Array; cum: Float32Array; len: number; stops: number[] }

export function decodeTrains(data: Encoded): Line[] {
  const tracks: Float32Array[] = [];
  let p = 0, q = 0;
  for (const n of data.n) {
    const s = new Float32Array(n * 4);
    let e = 0, no = 0, u = 0;
    for (let k = 0; k < n; k++, p += 3) {
      e += data.s[p]; no += data.s[p + 1]; u += data.s[p + 2];
      s[k * 4] = e / 10; s[k * 4 + 1] = no / 10; s[k * 4 + 2] = u / 10;
    }
    const runs = data.vis[q++];
    for (let r = 0, k = 0; r < runs; r++) {
      const len = data.vis[q++], vis = r % 2 === 0 ? 1 : 0;
      for (let j = 0; j < len; j++, k++) s[k * 4 + 3] = vis;
    }
    tracks.push(s);
  }
  return data.l.map((l) => {
    const pts: number[] = [];
    l.w.forEach((wi, j) => {
      const s = tracks[wi < 0 ? ~wi : wi], n = s.length / 4;
      for (let k = j ? 1 : 0; k < n; k++) { const i = wi < 0 ? n - 1 - k : k; pts.push(s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3]); }
    });
    const pa = new Float32Array(pts), n = pa.length / 4, cum = new Float32Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pa[i * 4] - pa[i * 4 - 4], pa[i * 4 + 1] - pa[i * 4 - 3]);
    return { k: l.k, ref: l.r, interval: l.i, back: l.b, p: pa, cum, len: cum[n - 1] ?? 0, stops: l.st };
  });
}

// ---- rolling stock ------------------------------------------------------------------------------
/** body colour, roof colour, bands on the sides and ends: [from, to] height (m) and colour */
interface Livery { body: RGB; roof: RGB; bands: Array<[number, number, RGB]> }
/** `tilt`: the body follows the track's grade (a funicular car on its incline); otherwise it stands level */
interface Car { len: number; wid: number; hei: number; liv: Livery; gap: number; tilt?: boolean }
/** whose rolling stock (places.ts Region `rail.stock`); default Stuttgart's SSB and DB */
export type Stock = "zet" | "mpk" | undefined;

const RED: RGB = [206, 32, 38], LIGHT: RGB = [208, 210, 214], GLASS: RGB = [34, 40, 52];
// SSB DT 8 (yellow, navy window band, grey roof), DB ET 430 S-Bahn, DB double-deck regional coaches and
// their locomotive, ICE / Flixtrain
const DT8: Livery = { body: [244, 200, 16], roof: LIGHT, bands: [[1.2, 2.55, [30, 38, 74]]] };
const ET430: Livery = { body: RED, roof: LIGHT, bands: [[0.35, 0.95, LIGHT], [1.35, 2.35, GLASS]] };
const DOSTO: Livery = { body: RED, roof: LIGHT, bands: [[0.3, 0.75, [176, 178, 184]], [1.05, 1.85, GLASS], [2.75, 3.55, GLASS]] };
const LOCO: Livery = { body: RED, roof: [150, 152, 158], bands: [[0.3, 0.8, [60, 62, 68]], [2.7, 3.3, GLASS]] };
const ICE: Livery = { body: [242, 242, 242], roof: [214, 216, 220], bands: [[0.9, 1.15, RED], [1.55, 2.4, GLASS]] };
const FLX: Livery = { body: [110, 196, 32], roof: LIGHT, bands: [[1.55, 2.4, GLASS]] };
// Zagreb. ZET blue: the low-floor TMK 2200 (blue, white waist stripe, grey skirt and roof equipment), the older
// ČKD T4 + B4 sets (blue with cream window surrounds and roofs), the Uspinjača cars (blue, cream window band);
// HŽPP: white EMUs with a blue skirt, blue locomotives, white coaches with a blue band
const ZET: RGB = [22, 82, 164], CREAM: RGB = [232, 222, 192], HZ: RGB = [26, 64, 140], WHITE: RGB = [236, 237, 236];
const TMK2200: Livery = { body: ZET, roof: [204, 208, 214], bands: [[0.22, 0.6, [74, 78, 86]], [0.78, 0.92, WHITE], [1.0, 2.4, GLASS]] };
const T4: Livery = { body: ZET, roof: [206, 200, 182], bands: [[0.95, 1.1, CREAM], [1.1, 2.15, GLASS], [2.15, 2.9, CREAM]] };
const USPINJACA: Livery = { body: ZET, roof: [190, 194, 200], bands: [[1.0, 1.2, CREAM], [1.2, 2.2, GLASS]] };
const HZ_EMU: Livery = { body: WHITE, roof: LIGHT, bands: [[0.3, 1.05, HZ], [1.4, 2.35, GLASS]] };
const HZ_LOCO: Livery = { body: HZ, roof: [150, 152, 158], bands: [[0.3, 0.8, [60, 62, 68]], [1.0, 1.15, WHITE], [2.7, 3.3, GLASS]] };
const HZ_COACH: Livery = { body: WHITE, roof: [196, 198, 202], bands: [[0.5, 0.95, HZ], [1.55, 2.4, GLASS]] };

/** Zagreb's stock: kind 4 street trams, 5 funicular cars, mainline trains in HŽPP colours */
function zetConsist(line: Line, rand: () => number, add: (n: number, c: Omit<Car, "gap">, gap: number) => void) {
  if (line.k === 4) {
    if (rand() < 0.7) { // TMK 2200: 32 m in 5 sections (3 on bogies, 2 suspended between them), articulated
      for (const len of [7.4, 5.4, 6.4, 5.4, 7.4]) add(1, { len, wid: 2.3, hei: 3.4, liv: TMK2200 }, 0.02);
    } else add(2, { len: 14.6, wid: 2.5, hei: 3.1, liv: T4 }, 0.9); // ČKD T4YU motor car + B4YU trailer
  } else if (line.k === 5) add(1, { len: 6.5, wid: 2.2, hei: 3, liv: USPINJACA, tilt: true }, 0);
  else if (line.k === 3) {
    add(1, { len: 19.5, wid: 2.95, hei: 4.2, liv: HZ_LOCO }, 1);
    add(5 + Math.floor(rand() * 3), { len: 26.4, wid: 2.85, hei: 3.9, liv: HZ_COACH }, 0.8);
  } else { // Končar EMU, one or two units
    const units = rand() < 0.35 ? 2 : 1;
    for (let u = 0; u < units; u++) { add(3, { len: 18.5, wid: 2.85, hei: 4, liv: HZ_EMU }, 0.5); }
  }
}

// Kraków. MPK's navy and silver: the low-floor Pesa Krakowiak (42 m, 4 sections) and Stadler Lajkonik and Bombardier
// NGT6 (26–33 m), the older pairs of Konstal 105Na; regional EMUs white with a navy skirt, long-distance coaches
// grey with a navy band (approximations of the liveries, not exact)
const MPK: RGB = [28, 44, 96], SILVER: RGB = [196, 200, 206], KM: RGB = [236, 236, 234];
const KRAKOWIAK: Livery = { body: MPK, roof: SILVER, bands: [[0.25, 0.65, [62, 66, 74]], [0.9, 2.45, GLASS], [2.45, 2.75, SILVER]] };
const NGT6: Livery = { body: MPK, roof: SILVER, bands: [[0.8, 0.95, SILVER], [1.0, 2.4, GLASS]] };
const N105: Livery = { body: MPK, roof: [184, 186, 190], bands: [[0.9, 1.05, SILVER], [1.1, 2.2, GLASS]] };
const PL_EMU: Livery = { body: KM, roof: LIGHT, bands: [[0.3, 1.0, MPK], [1.4, 2.35, GLASS]] };
const PL_LOCO: Livery = { body: [176, 180, 186], roof: [150, 152, 158], bands: [[0.3, 0.8, [60, 62, 68]], [1.0, 1.2, MPK], [2.7, 3.3, GLASS]] };
const PL_COACH: Livery = { body: [196, 200, 206], roof: [170, 174, 180], bands: [[0.5, 0.95, MPK], [1.55, 2.4, GLASS]] };

/** Kraków's stock: kind 4 MPK street trams, mainline trains as Polish regional EMUs and long-distance coaches */
function mpkConsist(line: Line, rand: () => number, add: (n: number, c: Omit<Car, "gap">, gap: number) => void) {
  if (line.k === 4) {
    const r = rand();
    if (r < 0.4) for (const len of [11.6, 9.4, 9.4, 11.6]) add(1, { len, wid: 2.4, hei: 3.4, liv: KRAKOWIAK }, 0.02); // Krakowiak
    else if (r < 0.8) for (const len of [9.6, 7.0, 9.6]) add(1, { len, wid: 2.4, hei: 3.3, liv: NGT6 }, 0.02); // NGT6 / Lajkonik
    else add(2, { len: 13.5, wid: 2.4, hei: 3.1, liv: N105 }, 0.9); // two Konstal 105Na
  } else if (line.k === 3) {
    add(1, { len: 19.5, wid: 2.95, hei: 4.2, liv: PL_LOCO }, 1);
    add(5 + Math.floor(rand() * 3), { len: 26.4, wid: 2.85, hei: 3.9, liv: PL_COACH }, 0.8);
  } else { // regional EMU, one or two units
    const units = rand() < 0.35 ? 2 : 1;
    for (let u = 0; u < units; u++) add(3, { len: 18.5, wid: 2.85, hei: 4, liv: PL_EMU }, 0.5);
  }
}

function consist(line: Line, rand: () => number, stock: Stock): Car[] {
  const cars: Car[] = [];
  const add = (n: number, c: Omit<Car, "gap">, gap: number) => { for (let i = 0; i < n; i++) cars.push({ ...c, gap }); };
  if (stock === "zet") zetConsist(line, rand, add);
  else if (stock === "mpk") mpkConsist(line, rand, add);
  else if (line.k === 0) { // DT 8: 2 cars per unit, single or double traction
    const units = rand() < 0.5 ? 2 : 1;
    for (let u = 0; u < units; u++) { add(2, { len: 19.2, wid: 2.65, hei: 3.4, liv: DT8 }, 0.5); cars.at(-1)!.gap = 1.2; }
  } else if (line.k === 1) { // ET 430: 4 cars per unit, one to two units
    const units = rand() < 0.6 ? 2 : 1;
    for (let u = 0; u < units; u++) { add(4, { len: 16.8, wid: 2.95, hei: 3.85, liv: ET430 }, 0.6); cars.at(-1)!.gap = 1.2; }
  } else if (line.k === 2) { // locomotive + double-deck coaches (push-pull)
    add(1, { len: 19, wid: 2.95, hei: 4.2, liv: LOCO }, 1);
    add(3 + Math.floor(rand() * 3), { len: 26.8, wid: 2.8, hei: 4.6, liv: DOSTO }, 0.8);
  } else {
    const liv = /^FLX/i.test(line.ref) ? FLX : ICE;
    add(8, { len: 25.5, wid: 2.95, hei: 3.85, liv }, 0.8);
  }
  return cars;
}

// ---- timetable ----------------------------------------------------------------------------------
/**
 * per kind: top speed (m/s), acceleration = braking (m/s²), dwell at a stop, turnaround at the end (s); `leg`:
 * a fixed time per direction (the turnaround fills it), so counterweighted funicular cars stay in step
 */
const RUN: Array<{ v: number; a: number; dwell: number; turn: number; leg?: number }> = [
  { v: 15, a: 1.0, dwell: 25, turn: 240 },
  { v: 24, a: 0.9, dwell: 35, turn: 300 },
  { v: 28, a: 0.6, dwell: 50, turn: 480 },
  { v: 30, a: 0.5, dwell: 70, turn: 720 },
  // street tram (ZET): ~40 km/h between stops, ~20 km/h with stops, round the loop at the terminus
  { v: 11, a: 1.0, dwell: 20, turn: 90 },
  // Uspinjača: 66 m in ~55 s at 1.2 m/s, half a minute at the station, every 3 minutes (really every 10: the
  // map shows it more often)
  { v: 1.2, a: 0.2, dwell: 0, turn: 0, leg: 90 },
];

/** a stretch of one leg: from s0 to s1 (front of the train), starting at t0, running for `run` s, then waiting `wait` s */
interface Hop { t0: number; s0: number; s1: number; run: number; wait: number }
interface Leg { line: Line; rev: boolean; hops: Hop[]; t0: number; dur: number }
/** `headway` (s): trains of the service run exactly this far apart (cycle = trains × headway, Zagreb); 0: about the interval */
interface Service { legs: Leg[]; cycle: number; cars: Car[][]; phase: number[]; k: number; headway: number }

const runTime = (d: number, v: number, a: number) => (d >= (v * v) / a ? d / v + v / a : 2 * Math.sqrt(d / a));
/** distance covered after time t of a run of length d (accelerate, cruise, brake) */
function runPos(d: number, t: number, v: number, a: number) {
  const T = runTime(d, v, a);
  if (t >= T) return d;
  const vp = Math.min(v, Math.sqrt(a * d)), ta = vp / a;
  if (t < ta) return 0.5 * a * t * t;
  if (t > T - ta) { const r = T - t; return d - 0.5 * a * r * r; }
  return 0.5 * a * ta * ta + vp * (t - ta);
}

export class Trains {
  private services: Service[] = [];
  private t = 0;
  private alpha = new Map<string, { a: number; seen: number }>();
  drawn = 0;

  constructor(lines: Line[], private enu2px: number[][], private camFwd: [number, number], stock?: Stock) {
    let seed = 11;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    lines.forEach((A, ia) => {
      if (A.back >= 0 && A.back < ia) return; // the pair was built from its first line
      const R = RUN[A.k];
      const B = A.back >= 0 ? lines[A.back] : A;
      const sample: Car[] = consist(A, rand, stock), L = sample.reduce((s, c) => s + c.len + c.gap, 0);
      const legs: Leg[] = [];
      let t = 0;
      for (const [line, rev] of [[A, false], [B, A.back < 0]] as Array<[Line, boolean]>) {
        if (line.len < L + (R.leg ? 5 : 60)) return; // a funicular is barely longer than its car
        // the front runs from L (whole train on the track) to the end; stops as front positions
        const stops = (rev ? line.stops.map((s) => line.len - s).reverse() : line.stops)
          .map((s) => Math.min(line.len, s + L / 2)).filter((s) => s > L + 40 && s < line.len - 40);
        const pts = [L, ...stops, line.len], hops: Hop[] = [], t0 = t;
        for (let i = 1; i < pts.length; i++) {
          const run = runTime(pts[i] - pts[i - 1], R.v, R.a);
          const wait = i < pts.length - 1 ? R.dwell : R.leg ? Math.max(0, R.leg - (t + run - t0)) : R.turn;
          hops.push({ t0: t, s0: pts[i - 1], s1: pts[i], run, wait });
          t += run + wait;
        }
        legs.push({ line, rev, hops, t0, dur: t - t0 });
      }
      let cycle = t, n = Math.max(1, Math.round(cycle / (A.interval * 60))), headway = 0;
      if (A.k === 4) { // street trams: a timetable with an exact headway (see stagger), the slack spread over the stops
        headway = Math.round(A.interval * 60);
        n = Math.max(1, Math.ceil(cycle / headway));
        const extra = (n * headway - cycle) / legs.reduce((k, l) => k + l.hops.length, 0);
        let tt = 0;
        for (const leg of legs) {
          leg.t0 = tt;
          for (const h of leg.hops) { h.t0 = tt; h.wait += extra; tt += h.run + h.wait; }
          leg.dur = tt - leg.t0;
        }
        cycle = n * headway;
      } else if (stock && A.k < 4) {
        // HŽPP, PKP: an exact headway too (see stagger), the slack spent at a turnaround off the map (over the faded
        // edge); a single train (a few a day) so waits out its interval there and passes rarely
        const hw = Math.round(A.interval * 60), off = legs.findIndex((leg) => this.hidden(leg, leg.hops.at(-1)!.s1, L));
        if (off >= 0) {
          n = Math.max(1, Math.ceil(cycle / hw));
          const pad = n * hw - cycle;
          legs[off].hops.at(-1)!.wait += pad; legs[off].dur += pad;
          if (off === 0) { legs[1].t0 += pad; legs[1].hops.forEach((h) => { h.t0 += pad; }); }
          cycle = n * hw; headway = hw;
        }
      }
      const cars = [sample], phase = [R.leg ? 0 : rand() * cycle]; // funicular cars: all in step (each track's run is set by export)
      for (let i = 1; i < n; i++) { cars.push(consist(A, rand, stock)); phase.push(phase[0] + (i * cycle) / n); }
      this.services.push({ legs, cycle, cars, phase, k: A.k, headway });
    });
    this.stagger();
  }

  /**
   * Street trams of many lines share the trunk tracks and stops (eight lines through Jelačić), and the HŽPP
   * trains the platforms of Glavni kolodvor. With random phases two would often stand at one platform together,
   * drawn on top of each other. So the lines are timed against each other: each line repeats exactly every
   * headway, and in turn takes the phase (5 s steps, coarser for trains hours apart) whose stops and turnarounds
   * least overlap in time with the lines already placed at the same platform. Like a real timetable, it can't
   * always avoid bunching where many lines meet; what is left drives as is (in zagreb-core it removes ~85% of
   * the tram overlaps).
   *
   * Two windows repeating every h1 and h2 s meet in a pattern that repeats every lcm(h1, h2) and depends only
   * on their offset modulo g = gcd(h1, h2): their overlap per lcm is that of the two windows on a circle of
   * length g.
   */
  private stagger() {
    const timed = this.services.filter((sv) => sv.headway > 0).sort((a, b) => a.headway - b.headway);
    if (timed.length < 2) return;
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    /** share of time windows [a0, a0 + la) every h1 and [b0, b0 + lb) every h2 overlap */
    const overlap = (a0: number, la: number, h1: number, b0: number, lb: number, h2: number) => {
      const g = gcd(h1, h2), A = Math.min(la, g), B = Math.min(lb, g), d = (((b0 - a0) % g) + g) % g;
      return (Math.max(0, Math.min(A, d + B) - d) + Math.max(0, Math.min(A, d - g + B))) * g / (h1 * h2);
    };
    // a train's stands: platform front position, heading, window in its cycle (8 s margins: the last 30 m of
    // the approach, the tail clearing the platform); the trains of a service are one headway apart, so one
    // window per headway
    type Stand = { x: number; y: number; dx: number; dy: number; t0: number; len: number; hw: number; L: number };
    const standsOf = (sv: Service): Stand[] => {
      const L = sv.cars[0].reduce((a, c) => a + c.len + c.gap, 0);
      // (out of sight, e.g. waiting off the map, they may stack)
      return sv.legs.flatMap((leg) => leg.hops.filter((h) => !this.hidden(leg, h.s1, L)).map((h) => {
        const p = this.at(leg, h.s1), q = this.at(leg, h.s1 - 8), d = Math.hypot(p.e - q.e, p.n - q.n) || 1;
        return { x: p.e, y: p.n, dx: (p.e - q.e) / d, dy: (p.n - q.n) / d, t0: h.t0 + h.run - 8, len: h.wait + 16, hw: sv.headway, L };
      }));
    };
    /** would trains standing at a and b overlap: on one track (< 2.5 m apart sideways), fronts < 30 m apart
     * facing the same way, or their bodies meeting facing each other */
    const clash = (a: Stand, b: Stand) => {
      const rx = b.x - a.x, ry = b.y - a.y, u = rx * a.dx + ry * a.dy, dot = a.dx * b.dx + a.dy * b.dy;
      if (Math.abs(rx * a.dy - ry * a.dx) > 2.5) return false;
      // a fills [-a.L, 0] along its heading; b, facing back, [u, u + b.L]
      return dot > 0.7 ? Math.abs(u) < 30 : dot < -0.7 && u <= 0 && u + b.L >= -a.L;
    };
    const placed = new Map<string, Stand[]>(); // 50 m cells, windows in sim time
    const cell = (x: number, y: number) => `${Math.floor(x / 50)}_${Math.floor(y / 50)}`, reach = 5; // cells: trains up to 250 m
    for (const sv of timed) {
      const stands = standsOf(sv);
      const near = stands.map((st) => {
        const out: Stand[] = [];
        for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++)
          for (const o of placed.get(cell(st.x + i * 50, st.y + j * 50)) ?? [])
            if (clash(st, o)) out.push(o);
        return out;
      });
      // with phase ph a train stands there from sim time t0 - ph on (tau = t + phase)
      let best = sv.phase[0], cost = Infinity;
      const start = Math.floor(sv.phase[0] / 5) * 5;
      const step = Math.max(5, sv.headway / 720); // ≤ 720 tries (a train every 4 hours: 20 s steps)
      for (let k = 0; k < sv.headway / step && cost > 0; k++) {
        const ph = (start + k * step) % sv.headway;
        let c = 0;
        stands.forEach((st, i) => { for (const o of near[i]) c += overlap(st.t0 - ph, st.len, st.hw, o.t0, o.len, o.hw); });
        if (c < cost) { cost = c; best = ph; }
      }
      sv.phase = sv.phase.map((_, i) => best + (i * sv.cycle) / sv.phase.length);
      for (const st of stands) {
        const key = cell(st.x, st.y);
        (placed.get(key) ?? placed.set(key, []).get(key)!).push({ ...st, t0: st.t0 - best });
      }
    }
  }

  get count() { return this.services.reduce((n, s) => n + s.phase.length, 0); }

  step(dt: number) { this.t += Math.min(dt, 0.1); }

  /** front position of train `i` of a service now: leg and distance along the leg's line */
  private where(sv: Service, i: number, t = this.t) {
    const tau = (((t + sv.phase[i]) % sv.cycle) + sv.cycle) % sv.cycle;
    const leg = sv.legs[tau < sv.legs[0].dur || sv.legs.length < 2 ? 0 : 1];
    const R = RUN[sv.k];
    for (const h of leg.hops) {
      const dt = tau - h.t0;
      if (dt < 0 || dt >= h.run + h.wait) continue;
      return { leg, s: h.s0 + runPos(h.s1 - h.s0, dt, R.v, R.a) };
    }
    return { leg, s: leg.hops.at(-1)!.s1 };
  }

  /** a train of length L with its front at `s` is wholly out of sight (off the map, in a tunnel; a station roof hides only a bit of it) */
  private hidden(leg: Leg, s: number, L: number) {
    for (let d = 0; d <= L + 30; d += 8) if (this.at(leg, s - d).vis) return false;
    return true;
  }

  /** point at distance `s` along a leg (reversed legs run the line backwards) */
  private at(leg: Leg, s: number) {
    const l = leg.line, P = l.p, C = l.cum;
    const d = Math.max(0, Math.min(l.len, leg.rev ? l.len - s : s));
    let lo = 0, hi = C.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] < d) lo = m; else hi = m; }
    const f = (d - C[lo]) / Math.max(1e-3, C[hi] - C[lo]), a = lo * 4, b = hi * 4;
    const near = f < 0.5 ? a : b;
    return { e: P[a] + (P[b] - P[a]) * f, n: P[a + 1] + (P[b + 1] - P[a + 1]) * f, u: P[a + 2] + (P[b + 2] - P[a + 2]) * f, vis: P[near + 3] };
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: [number, number, number, number]) {
    if (px < 0.08) return;
    const [vx0, vy0, vx1, vy1] = view, M = this.enu2px;
    const proj = (p: Vec3): [number, number] =>
      toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    const items: Array<{ c: Vec3; d: [number, number]; g: number; car: Car; a: number; depth: number }> = [];
    const m = 400 * px;
    this.each((head) => { const [hx, hy] = proj(head); return hx >= vx0 - m && hy >= vy0 - m && hx <= vx1 + m && hy <= vy1 + m; }, (key, c, d, g, car, vis) => {
      // fade in / out (~0.3 s) at tunnel mouths and behind cover
      const st = this.alpha.get(key);
      const dtf = st ? this.t - st.seen : 0;
      const a = !st || dtf > 1 ? (vis ? 1 : 0) : Math.max(0, Math.min(1, st.a + (vis ? 1 : -1) * Math.max(0, dtf) / 0.3));
      this.alpha.set(key, { a, seen: this.t });
      if (a <= 0) return;
      items.push({ c, d, g, car, a, depth: c[0] * this.camFwd[0] + c[1] * this.camFwd[1] });
    });
    items.sort((a, b) => b.depth - a.depth);
    this.drawn = items.length;
    this.boxes = [];
    for (const it of items) {
      // its canvas box, for the foreground drawn over it (foreground.ts): trams pass behind houses, not over them
      const R = Math.max(it.car.len, it.car.wid) / 2 + 4.5, c = it.c;
      const pts = [proj([c[0] - R, c[1] - R, c[2]]), proj([c[0] + R, c[1] - R, c[2]]), proj([c[0] - R, c[1] + R, c[2]]), proj([c[0] + R, c[1] + R, c[2]]), proj([c[0], c[1], c[2] + 4.5])];
      this.boxes.push([Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))]);
      this.box(ctx, proj, it.c, it.d, it.g, it.car, it.a);
    }
  }

  /** canvas boxes of the cars drawn last ([x0, y0, x1, y1]): where the foreground goes over them */
  boxes: number[][] = [];

  /**
   * Every car now: `near(head)` picks the trains (by their front, ENU), then `car(key, centre, heading,
   * grade, car, visible)` per car of each.
   */
  private each(near: (head: Vec3) => boolean, car: (key: string, c: Vec3, d: [number, number], g: number, car: Car, vis: boolean) => void, t = this.t) {
    this.services.forEach((sv, si) => sv.phase.forEach((_, ti) => {
      const { leg, s } = this.where(sv, ti, t);
      const head = this.at(leg, s);
      if (!near([head.e, head.n, head.u])) return;
      let front = s;
      sv.cars[ti].forEach((c, ci) => {
        const p = this.at(leg, front), q = this.at(leg, front - c.len);
        front -= c.len + c.gap;
        let dx = p.e - q.e, dy = p.n - q.n;
        const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        const vis = !!((p.vis || q.vis) && this.at(leg, front + c.gap + c.len / 2).vis);
        car(`${si}:${ti}:${ci}`, [(p.e + q.e) / 2, (p.n + q.n) / 2, (p.u + q.u) / 2], [dx, dy], c.tilt ? (p.u - q.u) / L : 0, c, vis);
      });
    }));
  }

  /**
   * footprints of the cars within `r` m of ENU (e, n), `later` s from now (positions are a function of time):
   * centre, heading, length, width, train ("service:train"), visible; road traffic yields to them, tests look
   * for overlaps
   */
  footprints(e: number, n: number, r: number, later = 0) {
    const out: Array<{ x: number; y: number; dx: number; dy: number; len: number; wid: number; train: string; vis: boolean }> = [];
    this.each((h) => Math.abs(h[0] - e) < r + 200 && Math.abs(h[1] - n) < r + 200, (key, c, d, _, car, vis) => {
      if (Math.abs(c[0] - e) < r && Math.abs(c[1] - n) < r)
        out.push({ x: c[0], y: c[1], dx: d[0], dy: d[1], len: car.len, wid: car.wid, train: key.slice(0, key.lastIndexOf(":")), vis });
    }, this.t + later);
    return out;
  }

  /** one car: centre c, heading d, grade g (rise per metre along d, 0: level) */
  private box(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], g: number, car: Car, alpha: number) {
    const r: [number, number] = [d[1], -d[0]], hl = car.len / 2, hw = car.wid / 2;
    const corner = (a: number, b: number, z: number): Vec3 => [c[0] + d[0] * a + r[0] * b, c[1] + d[1] * a + r[1] * b, c[2] + z + g * a];
    const Z0 = 0.35; // on the rails
    const base = [corner(hl, hw, Z0), corner(hl, -hw, Z0), corner(-hl, -hw, Z0), corner(-hl, hw, Z0)];
    const p0 = proj(c), pe = proj([c[0] + 1, c[1], c[2]]), pn = proj([c[0], c[1] + 1, c[2]]);
    const pxPerM = (Math.hypot(pe[0] - p0[0], pe[1] - p0[1]) + Math.hypot(pn[0] - p0[0], pn[1] - p0[1])) / 2;
    const poly = (pts: Vec3[], [R, G, B]: RGB, k: number, outline = false) => {
      ctx.fillStyle = `rgb(${Math.min(255, R * k) | 0},${Math.min(255, G * k) | 0},${Math.min(255, B * k) | 0})`;
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fill();
      if (outline) ink(ctx, pxPerM);
    };
    const up = (p: Vec3, z: number): Vec3 => [p[0], p[1], p[2] + z];
    const outlinePath = (pts: Vec3[]) => {
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ink(ctx, pxPerM);
    };
    ctx.globalAlpha = 0.25 * alpha; // contact shadow
    poly(base.map((p) => [p[0] + 0.5, p[1] - 0.5, p[2] - Z0] as Vec3), [0, 0, 0], 0);
    ctx.globalAlpha = alpha;
    for (let i = 0; i < 4; i++) {
      const a = base[i], b = base[(i + 1) % 4];
      const facing = (b[1] - a[1]) * this.camFwd[0] - (b[0] - a[0]) * this.camFwd[1];
      if (facing >= 0) continue;
      const k = 0.72 + 0.1 * (i % 2);
      poly([a, b, up(b, car.hei - 0.2), up(a, car.hei - 0.2)], car.liv.body, k);
      // bands: inset at the car ends on the long sides (i odd), full width on the ends (windscreens)
      const ins = i % 2 ? 0.5 / car.len : 0.18;
      const a2: Vec3 = [a[0] + (b[0] - a[0]) * ins, a[1] + (b[1] - a[1]) * ins, a[2]], b2: Vec3 = [b[0] + (a[0] - b[0]) * ins, b[1] + (a[1] - b[1]) * ins, b[2]];
      for (const [z0, z1, col] of car.liv.bands) poly([up(a2, z0), up(b2, z0), up(b2, z1), up(a2, z1)], col, k);
      outlinePath([a, b, up(b, car.hei - 0.2), up(a, car.hei - 0.2)]); // after the bands: one clean edge per side
    }
    // rounded roof: the body colour runs over the roof edges (that is what reads from above), the roof
    // itself is a narrower raised strip
    const top = [corner(hl, hw, Z0 + car.hei - 0.2), corner(hl, -hw, Z0 + car.hei - 0.2), corner(-hl, -hw, Z0 + car.hei - 0.2), corner(-hl, hw, Z0 + car.hei - 0.2)];
    poly(top, car.liv.body, 0.95, true);
    const rh = hw * 0.55, rl = hl - 0.4;
    poly([corner(rl, rh, Z0 + car.hei), corner(rl, -rh, Z0 + car.hei), corner(-rl, -rh, Z0 + car.hei), corner(-rl, rh, Z0 + car.hei)], car.liv.roof, 1.06);
    ctx.globalAlpha = 1;
  }
}
