/**
 * Life above the roofs: now and then an airliner on final approach to the region's airport
 * (~3° glide slope) flies in along the extended runway centreline and fades out before the threshold
 * (Ben Gurion runway 12 in Israel Center: in from the sea; Kraków runway 25: in from the east, over
 * the north of the city). Birds per region (places.ts `fauna`): small flocks of green rose-ringed
 * parakeets (Tel Aviv's famous feral parrots) dart about over the streets; grey city pigeons sit on
 * the squares and now and then fly over to another one.
 * Drawn on the overlay canvas in a local frame projected like the cars (x forward, y side, z up).
 */
type Vec3 = [number, number, number];
type ToScreen = (x: number, y: number) => [number, number];

import { ecefToEnu, llhToEcef } from "../../../pipeline/src/camera.ts";

/** The region's airport: runway threshold, landing heading and threshold ellipsoid height (places.ts). */
export interface Airport { lat: number; lon: number; runwayHeadingDeg: number; h?: number }
// metres before the threshold, measured back along the approach (against the landing heading):
// Tel Aviv over the sea → over Ramat Gan, Kraków over Mistrzejowice → over Bronowice
const START = 22000, END = 7000;
const FADE = 2500, SPEED = 75, EVERY = 110, GLIDE = Math.tan((3 * Math.PI) / 180);

/** projector + local frame (forward d, z up), scaled, as a canvas transform setter */
function frame(ctx: CanvasRenderingContext2D, M: number[][], toScreen: ToScreen, p: Vec3, d: [number, number], scale: number) {
  const proj = (q: Vec3) => toScreen(M[0][0] * q[0] + M[0][1] * q[1] + M[0][2] * q[2], M[1][0] * q[0] + M[1][1] * q[1] + M[1][2] * q[2]);
  const o = proj(p), f = proj([p[0] + d[0], p[1] + d[1], p[2]]), s = proj([p[0] + d[1], p[1] - d[0], p[2]]);
  const ex = [(f[0] - o[0]) * scale, (f[1] - o[1]) * scale], ey = [(s[0] - o[0]) * scale, (s[1] - o[1]) * scale];
  return { o, set: () => ctx.setTransform(ex[0], ex[1], ey[0], ey[1], o[0], o[1]) };
}

const inView = (o: [number, number], view: number[], m: number) => o[0] > view[0] - m && o[1] > view[1] - m && o[0] < view[2] + m && o[1] < view[3] + m;

export class Planes {
  private t = EVERY - 6; // first one shortly after load
  private flights: number[] = []; // distance flown (m) per plane in the air
  private threshold: [number, number]; // runway threshold in the region's ENU metres
  private dir: [number, number]; // landing direction (unit, ENU): planes fly along it towards the threshold
  private ground = 0; // threshold height in the region's ENU frame (0 when the airport has no `h`)
  constructor(private M: number[][], airport: Airport) {
    const p = ecefToEnu(llhToEcef(airport.lat, airport.lon, airport.h ?? 0)), a = (airport.runwayHeadingDeg * Math.PI) / 180;
    this.threshold = [p[0], p[1]];
    if (airport.h !== undefined) this.ground = p[2];
    this.dir = [Math.sin(a), Math.cos(a)];
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    if (this.t >= EVERY) { this.t = 0; this.flights.push(0); }
    this.flights = this.flights.map((s) => s + SPEED * dt).filter((s) => s < START - END);
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen, px: number, view: number[]) {
    for (const s of this.flights) {
      const left = START - s; // metres to the threshold
      const B = this.threshold, DIR = this.dir;
      const p: Vec3 = [B[0] - DIR[0] * left, B[1] - DIR[1] * left, this.ground + 30 + left * GLIDE];
      const alpha = Math.min(1, s / FADE, (START - END - s) / FADE);
      const scale = Math.max(1, 0.12 / px); // never smaller than ~20 screen px across
      // shadow on the ground (sun high in the south-west), then the plane itself
      const agl = p[2] - this.ground;
      const sh = frame(ctx, this.M, toScreen, [p[0] + agl * 0.25, p[1] + agl * 0.35, this.ground], DIR, scale);
      const pl = frame(ctx, this.M, toScreen, p, DIR, scale);
      if (!inView(pl.o, view, 400) && !inView(sh.o, view, 400)) continue;
      ctx.globalAlpha = alpha * 0.18; sh.set(); this.shape(ctx, "#000", "#000", "#000");
      ctx.globalAlpha = alpha; pl.set(); this.shape(ctx, "#f4f5f7", "#c9ced6", "#8a93a0");
      // nav lights: red port, green starboard, white strobe on the tail
      const blink = (performance.now() % 1200) < 120;
      ctx.fillStyle = "#ff3b30"; ctx.fillRect(-2, -17.6, 1.2, 1.2);
      ctx.fillStyle = "#34c759"; ctx.fillRect(-2, 16.4, 1.2, 1.2);
      if (blink) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(-19, 0, 1.6, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  /** narrow-body airliner from above, ~38 m long and 36 m across, nose at +x */
  private shape(ctx: CanvasRenderingContext2D, body: string, wing: string, edge: string) {
    const poly = (pts: number[], color: string) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath(); ctx.fill();
    };
    for (const s of [-1, 1]) {
      poly([3, s * 1.8, -3, s * 18, -6, s * 18, -5, s * 1.8], wing);           // swept wing
      poly([-14, s * 1, -18.5, s * 6.5, -20, s * 6.5, -19, s * 1], wing);      // tailplane
      poly([0.5, s * 7, -3, s * 7, -3, s * 8.6, 0.5, s * 8.6], edge);           // engine
    }
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, 0, 19, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = edge; ctx.beginPath(); ctx.ellipse(-17.5, 0, 2.5, 0.5, 0, 0, Math.PI * 2); ctx.fill(); // fin
  }
}

interface Flock { p: Vec3; h: number; turn: number; timer: number; birds: Array<[number, number, number, number]> }

export class Parrots {
  private flocks: Flock[] = [];
  private seed = 7;
  private box: number[];

  /** `area` = [e0, n0, e1, n1]: the flocks wander over this, turning back at the edges */
  constructor(private M: number[][], area: number[], count = 6) {
    const pad = 300;
    this.box = [area[0] + pad, area[1] + pad, area[2] - pad, area[3] - pad];
    const b = this.box;
    for (let k = 0; k < count; k++) {
      const n = 3 + Math.floor(this.rnd() * 5), birds: Flock["birds"] = [];
      for (let i = 0; i < n; i++) birds.push([(this.rnd() - 0.5) * 14, (this.rnd() - 0.5) * 14, (this.rnd() - 0.5) * 3, this.rnd() * 6]);
      this.flocks.push({
        p: [b[0] + this.rnd() * (b[2] - b[0]), b[1] + this.rnd() * (b[3] - b[1]), 25 + this.rnd() * 20],
        h: this.rnd() * Math.PI * 2, turn: 0, timer: 0, birds,
      });
    }
  }

  get count() { return this.flocks.reduce((a, f) => a + f.birds.length, 0); }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    const b = this.box;
    for (const f of this.flocks) {
      f.timer -= dt;
      if (f.timer <= 0) { f.timer = 1 + this.rnd() * 3; f.turn = (this.rnd() - 0.5) * 1.6; } // swooping, chattering turns
      const out = f.p[0] < b[0] || f.p[0] > b[2] || f.p[1] < b[1] || f.p[1] > b[3];
      if (out) { // steer back towards the middle
        const want = Math.atan2((b[0] + b[2]) / 2 - f.p[0], (b[1] + b[3]) / 2 - f.p[1]);
        f.turn = Math.sign(Math.sin(want - f.h)) * 0.9;
      }
      f.h += f.turn * dt;
      f.p[0] += Math.sin(f.h) * 14 * dt; f.p[1] += Math.cos(f.h) * 14 * dt;
      f.p[2] = 30 + 10 * Math.sin(performance.now() / 4000 + f.birds.length);
    }
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen, px: number, view: number[]) {
    if (px < 0.5) return;
    const now = performance.now() / 1000;
    for (const f of this.flocks) {
      const d: [number, number] = [Math.sin(f.h), Math.cos(f.h)];
      for (const [bx, by, bz, ph] of f.birds) {
        const wob = Math.sin(now * 1.3 + ph) * 1.5;
        const p: Vec3 = [f.p[0] + d[0] * bx + d[1] * (by + wob), f.p[1] + d[1] * bx - d[0] * (by + wob), f.p[2] + bz];
        const bird = frame(ctx, this.M, toScreen, p, d, 8 / Math.min(1, px)); // ≥ 8× life size, or a parakeet is a speck
        if (!inView(bird.o, view, 30)) continue;
        bird.set();
        const flap = Math.sin(now * 22 + ph * 5); // fast parakeet wingbeats
        ctx.fillStyle = "#3fae3a";
        for (const s of [-1, 1]) {
          ctx.beginPath(); ctx.moveTo(0.05, s * 0.03); ctx.lineTo(-0.08, s * (0.12 + 0.2 * Math.abs(flap))); ctx.lineTo(-0.14, s * 0.03); ctx.closePath(); ctx.fill();
        }
        ctx.beginPath(); ctx.moveTo(-0.08, 0); ctx.lineTo(-0.36, 0.02); ctx.lineTo(-0.36, -0.02); ctx.closePath(); ctx.fill(); // long tail
        ctx.fillStyle = "#57c94d"; ctx.beginPath(); ctx.ellipse(0, 0, 0.11, 0.04, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#d8333a"; ctx.beginPath(); ctx.arc(0.12, 0, 0.018, 0, Math.PI * 2); ctx.fill(); // red beak
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}

/** A square pigeons sit on, in the region's ENU metres: centre, ground height, radius. */
export interface Plaza { e: number; n: number; u: number; r: number }
interface Pigeon { x: number; y: number; h: number; ph: number; walk: number; timer: number; coat: string[] }
interface PigeonFlock {
  air: boolean; timer: number; plaza: number; target: number; flown: number;
  p: Vec3; h: number; turn: number; birds: Pigeon[]; form: Array<[number, number, number]>;
}

/** feathers: [body, wing, head, neck sheen]: blue-grey rock pigeons, a darker one, a pale one */
const PIGEON_COATS = [
  ["#a3aab4", "#8a929d", "#6f7682", "#6f9a86"], ["#a3aab4", "#8a929d", "#6f7682", "#8b6f9a"],
  ["#7d838c", "#666c75", "#555a63", "#6f9a86"], ["#d9d6d0", "#bdb9b2", "#a3a7ad", "#8fa79a"],
];
const FLY = 9; // m/s

/**
 * City pigeons: small flocks that sit on the squares (walking and pecking about), then all take off
 * together, circle over the roofs for a while and land on the same square or another one.
 * Same flock mechanics as the parakeets, but grounded most of the time.
 */
export class Pigeons {
  private flocks: PigeonFlock[] = [];
  private seed = 23;

  constructor(private M: number[][], private plazas: Plaza[], perPlaza = 1) {
    plazas.forEach((pl, k) => {
      for (let j = 0; j < perPlaza; j++) {
        const n = Math.max(3, Math.round(pl.r / 2.5 + this.rnd() * 5)), birds: Pigeon[] = [], form: PigeonFlock["form"] = [];
        for (let i = 0; i < n; i++) {
          const [x, y] = this.inside(pl, 0.85);
          birds.push({ x, y, h: this.rnd() * Math.PI * 2, ph: this.rnd() * 6, walk: 0, timer: this.rnd() * 6, coat: PIGEON_COATS[Math.floor(this.rnd() * PIGEON_COATS.length)] });
          form.push([(this.rnd() - 0.5) * 8, (this.rnd() - 0.5) * 8, (this.rnd() - 0.5) * 2]);
        }
        this.flocks.push({ air: false, timer: 20 + this.rnd() * 60, plaza: k, target: k, flown: 0, p: [pl.e, pl.n, pl.u], h: 0, turn: 0, birds, form });
      }
    });
  }

  get count() { return this.flocks.reduce((a, f) => a + f.birds.length, 0); }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  /** a random point in the plaza's disc (fraction `k` of its radius) */
  private inside(pl: Plaza, k: number): [number, number] {
    const a = this.rnd() * Math.PI * 2, d = Math.sqrt(this.rnd()) * pl.r * k;
    return [pl.e + Math.sin(a) * d, pl.n + Math.cos(a) * d];
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    for (const f of this.flocks) (f.air ? this.fly(f, dt) : this.sit(f, dt));
  }

  /** on the ground: each bird pecks, then walks a few steps, staying on its square */
  private sit(f: PigeonFlock, dt: number) {
    const pl = this.plazas[f.plaza];
    for (const b of f.birds) {
      b.timer -= dt;
      if (b.timer <= 0) {
        b.walk = b.walk ? 0 : 1;
        b.timer = b.walk ? 0.8 + this.rnd() * 2 : 1 + this.rnd() * 5;
        if (b.walk) b.h += (this.rnd() - 0.5) * 2.4;
      }
      if (!b.walk) continue;
      if (Math.hypot(b.x - pl.e, b.y - pl.n) > pl.r) b.h = Math.atan2(pl.e - b.x, pl.n - b.y); // back onto the square
      b.x += Math.sin(b.h) * 0.45 * dt; b.y += Math.cos(b.h) * 0.45 * dt;
    }
    f.timer -= dt;
    if (f.timer > 0) return;
    // take off together: the flock rises from where the birds sit
    f.air = true; f.flown = 0; f.turn = 0;
    f.p = [f.birds.reduce((a, b) => a + b.x, 0) / f.birds.length, f.birds.reduce((a, b) => a + b.y, 0) / f.birds.length, pl.u];
    f.h = this.rnd() * Math.PI * 2;
    f.target = this.rnd() < 0.5 ? f.plaza : Math.floor(this.rnd() * this.plazas.length);
    f.timer = 0;
  }

  /** in the air: a few swooping turns over the roofs, then home in on the target square and land */
  private fly(f: PigeonFlock, dt: number) {
    const to = this.plazas[f.target];
    f.flown += dt; f.timer -= dt;
    const dist = Math.hypot(to.e - f.p[0], to.n - f.p[1]);
    if (f.flown < 10) { // roam
      if (f.timer <= 0) { f.timer = 1.5 + this.rnd() * 2.5; f.turn = (this.rnd() - 0.5) * 1.4; }
    } else { // head for the target square, turning harder the closer it is
      const want = Math.atan2(to.e - f.p[0], to.n - f.p[1]);
      const diff = Math.atan2(Math.sin(want - f.h), Math.cos(want - f.h));
      f.turn = Math.max(-2.2, Math.min(2.2, diff * 2));
    }
    f.h += f.turn * dt;
    const speed = f.flown > 10 && dist < 20 ? Math.max(3, FLY * dist / 20) : FLY; // brake for landing
    f.p[0] += Math.sin(f.h) * speed * dt; f.p[1] += Math.cos(f.h) * speed * dt;
    // climb to ~18 m over the square, glide down on the final approach
    const cruise = to.u + 18 + 4 * Math.sin(f.flown * 0.7);
    const want = f.flown > 10 ? Math.min(cruise, to.u + dist * 0.6) : cruise;
    f.p[2] += Math.max(-4 * dt, Math.min(4 * dt, want - f.p[2]));
    if (f.flown > 10 && dist < Math.max(2, to.r * 0.4) && f.p[2] < to.u + 2.5) { // land, each bird where it touches down
      const d: [number, number] = [Math.sin(f.h), Math.cos(f.h)];
      f.birds.forEach((b, i) => {
        const [bx, by] = f.form[i];
        let x = f.p[0] + d[0] * bx + d[1] * by, y = f.p[1] + d[1] * bx - d[0] * by;
        const off = Math.hypot(x - to.e, y - to.n);
        if (off > to.r * 0.9) { x = to.e + ((x - to.e) * to.r * 0.9) / off; y = to.n + ((y - to.n) * to.r * 0.9) / off; }
        Object.assign(b, { x, y, h: f.h + (this.rnd() - 0.5), walk: 0, timer: this.rnd() * 3 });
      });
      f.air = false; f.plaza = f.target; f.timer = 25 + this.rnd() * 60;
    }
    if (f.flown > 90) { f.flown = 10; f.target = Math.floor(this.rnd() * this.plazas.length); } // lost: pick a square again
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen, px: number, view: number[]) {
    if (px < 0.5) return;
    const now = performance.now() / 1000, scale = 4 / Math.min(1, px); // ≥ 4× life size, or a pigeon is a speck
    const ell = (x: number, y: number, rx: number, ry: number, color: string) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    };
    for (const f of this.flocks) {
      if (!f.air) {
        if (px < 0.6) continue; // sitting birds only when zoomed in close, like the cats
        for (const b of f.birds) {
          const pl = this.plazas[f.plaza], d: [number, number] = [Math.sin(b.h), Math.cos(b.h)];
          const bird = frame(ctx, this.M, toScreen, [b.x, b.y, pl.u], d, scale);
          if (!inView(bird.o, view, 20)) continue;
          bird.set();
          const [body, wing, head, sheen] = b.coat;
          const peck = b.walk ? Math.sin(now * 9 + b.ph) * 0.02 : Math.max(0, Math.sin(now * 3 + b.ph * 3)) * 0.05; // nodding head
          ctx.globalAlpha = 0.25; ell(-0.01, 0.03, 0.17, 0.08, "#000"); ctx.globalAlpha = 1;
          ell(-0.15, 0, 0.06, 0.035, head);    // tail
          ell(0, 0, 0.14, 0.07, body);
          ell(-0.04, 0, 0.09, 0.055, wing);    // folded wings on the back
          ctx.fillStyle = "#3d4048"; ctx.fillRect(-0.06, -0.05, 0.02, 0.1); ctx.fillRect(-0.1, -0.045, 0.02, 0.09); // wing bars
          ell(0.09 + peck, 0, 0.045, 0.045, sheen); // iridescent neck
          ell(0.14 + peck, 0, 0.038, 0.035, head);
        }
      } else {
        const d: [number, number] = [Math.sin(f.h), Math.cos(f.h)];
        f.birds.forEach((b, i) => {
          const [bx, by, bz] = f.form[i], wob = Math.sin(now * 1.1 + b.ph) * 1.2;
          const p: Vec3 = [f.p[0] + d[0] * bx + d[1] * (by + wob), f.p[1] + d[1] * bx - d[0] * (by + wob), f.p[2] + bz];
          const bird = frame(ctx, this.M, toScreen, p, d, scale * 1.4);
          if (!inView(bird.o, view, 30)) return;
          bird.set();
          const [body, wing, head] = b.coat;
          const flap = Math.sin(now * 13 + b.ph * 5);
          ctx.fillStyle = wing;
          for (const s of [-1, 1]) {
            ctx.beginPath(); ctx.moveTo(0.06, s * 0.04); ctx.lineTo(-0.04, s * (0.14 + 0.2 * Math.abs(flap))); ctx.lineTo(-0.12, s * (0.1 + 0.16 * Math.abs(flap))); ctx.lineTo(-0.08, s * 0.04); ctx.closePath(); ctx.fill();
          }
          ctx.fillStyle = head; ctx.beginPath(); ctx.moveTo(-0.1, 0); ctx.lineTo(-0.2, 0.05); ctx.lineTo(-0.2, -0.05); ctx.closePath(); ctx.fill(); // fanned tail
          ell(0, 0, 0.12, 0.05, body);
          ell(0.12, 0, 0.035, 0.032, head);
        });
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}
