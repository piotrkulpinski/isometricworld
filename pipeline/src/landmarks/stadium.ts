/**
 * Football stadiums (landmarks.ts STADIUMS, by OSM name): LoD2 models the stands as solid blocks, which the styled
 * look gives window grids and rooftop clutter (an office ring) and the surface model reads the canopy edge as tree
 * crowns. scene.ts drops the LoD2 blocks between the pitch and the outline and builds this instead: an outer wall
 * of concrete and glass, seat rows rising from the pitch, and a level canopy over the upper part of the stands.
 *
 * The stands are sampled along rays from the pitch centre (rings convex enough: a stadium's), so the outline and
 * the pitch may be any polygons.
 */
import type { P2, Piece } from "./shapes.ts";
import { CLAD, face, roofFace } from "./shapes.ts";

export interface StadiumLook {
  /** seat colours, alternating per row band (club colours) */
  seats: number[][];
  /** canopy roof and outer wall colours */
  canopy: number[];
  wall: number[];
  /** height of the canopy above the ground (m); default: the LoD2 stands' height */
  height?: number;
}

/** First crossing of the ray from c along (dx, dy) with a ring, as a distance (Infinity: none). */
function ray(c: P2, dx: number, dy: number, ring: P2[], last = false) {
  let best = last ? -Infinity : Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - c[0]) * ey - (a[1] - c[1]) * ex) / den, u = ((a[0] - c[0]) * dy - (a[1] - c[1]) * dx) / den;
    if (t > 0 && u >= 0 && u <= 1) best = last ? Math.max(best, t) : Math.min(best, t);
  }
  return best;
}

/** The stands between `pitch` (the inner edge) and `outer`, standing on `base`, canopy `H` m high. */
export function stadiumStands(outer: P2[], pitch: P2[], base: number, H: number, look: StadiumLook): Piece[] {
  const c: P2 = [pitch.reduce((s, p) => s + p[0], 0) / pitch.length, pitch.reduce((s, p) => s + p[1], 0) / pitch.length];
  const N = 180, rows = 6;
  const at = (k: number) => { const a = (2 * Math.PI * k) / N, dx = Math.cos(a), dy = Math.sin(a); return { dx, dy, ri: ray(c, dx, dy, pitch), ro: ray(c, dx, dy, outer, true) }; };
  const pt = (s: ReturnType<typeof at>, r: number): P2 => [c[0] + s.dx * r, c[1] + s.dy * r];
  const mk = (roof: number[] | null, wall: number[] | null, height: number): Piece => ({ roof: [], wall: [], footprint: outer, height, base, look: { roof, wall, style: CLAD, bare: 1 } });
  const seats = look.seats.map((s) => mk(s, look.wall, H * 0.75));
  const canopy = mk(look.canopy, look.canopy, H), shell = mk(look.wall, look.wall, H), riser = mk([0.5, 0.5, 0.52], [0.5, 0.5, 0.52], H * 0.75);
  for (let k = 0; k < N; k++) {
    const s0 = at(k), s1 = at(k + 1);
    if (![s0.ri, s0.ro, s1.ri, s1.ro].every(Number.isFinite) || s0.ro <= s0.ri + 3 || s1.ro <= s1.ri + 3) continue;
    const band = (s: typeof s0, f: number) => s.ri + 1.5 + (s.ro - s.ri - 1.5) * f;
    // seat rows: from just behind the pitch (1.2 m) up to 75 % of the canopy height at 62 % of the band
    for (let r = 0; r < rows; r++) {
      const f0 = (0.62 * r) / rows, f1 = (0.62 * (r + 1)) / rows, z0 = 1.2 + (H * 0.75 - 1.2) * (r / rows), z1 = 1.2 + (H * 0.75 - 1.2) * ((r + 1) / rows);
      const a0 = pt(s0, band(s0, f0)), a1 = pt(s1, band(s1, f0)), b0 = pt(s0, band(s0, f1)), b1 = pt(s1, band(s1, f1));
      roofFace(seats[r % seats.length], [[a0[0], a0[1], z0], [a1[0], a1[1], z0], [b1[0], b1[1], z1], [b0[0], b0[1], z1]]);
    }
    // the front riser along the pitch
    const p0 = pt(s0, band(s0, 0)), p1 = pt(s1, band(s1, 0));
    const behind = pt(s0, band(s0, 0.1));
    face(riser, [[p0[0], p0[1], 0], [p1[0], p1[1], 0], [p1[0], p1[1], 1.2], [p0[0], p0[1], 1.2]], [behind[0], behind[1], 0.6]);
    // the canopy: level, from 48 % of the band to the outer wall, with a 1.2 m fascia at its front edge
    const q0 = pt(s0, band(s0, 0.48)), q1 = pt(s1, band(s1, 0.48)), o0 = pt(s0, s0.ro), o1 = pt(s1, s1.ro);
    roofFace(canopy, [[q0[0], q0[1], H], [q1[0], q1[1], H], [o1[0], o1[1], H], [o0[0], o0[1], H]]);
    face(canopy, [[q0[0], q0[1], H - 1.2], [q1[0], q1[1], H - 1.2], [q1[0], q1[1], H], [q0[0], q0[1], H]], [o0[0], o0[1], H - 0.6]);
    // the outer wall
    face(shell, [[o0[0], o0[1], 0], [o1[0], o1[1], 0], [o1[0], o1[1], H], [o0[0], o0[1], H]], [c[0], c[1], H / 2]);
  }
  return [...seats, riser, canopy, shell];
}
