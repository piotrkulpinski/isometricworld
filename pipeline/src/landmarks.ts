/**
 * Hand-modelled landmarks for the procedural (LoD2) look, where LoD2 and OSM building:parts are too coarse:
 * the registries below, matched by OSM `name`, merge every region's file in landmarks/ (stuttgart.ts …);
 * shared building blocks are in landmarks/shapes.ts. Shapes come from published dimensions; the Wikimedia
 * Commons photos in ATTRIBUTION.md were only looked at for proportions and colours.
 */
import * as stuttgart from "./landmarks/stuttgart.ts";
import { graduationTower } from "./landmarks/structures.ts";
import * as wieliczka from "./landmarks/wieliczka.ts";
import { CLAD, lathe, type P2, type Piece } from "./landmarks/shapes.ts";

export { lathe, type Piece };

/**
 * Colonnades carved into a LoD2 block, whose front is a flat wall: `facing` (compass °) picks the front, the
 * wall below `height` (m above base) moves back by `depth` into a shaded hall, columns stand on the old wall
 * line every `spacing` m; the wall above stays as entablature.
 */
export type Arcade = { facing: number; height: number; depth: number; spacing: number; r: number };

type V5 = [number, number, number, number, number];
/** Carve `a` into a mesh's walls (edited in place); returns the hall wall, floor and columns. */
export function arcade(b: { wall: number[]; base: number; footprint: P2[]; height: number }, a: Arcade): Piece[] {
  const az = (a.facing * Math.PI) / 180, n: P2 = [Math.sin(az), Math.cos(az)], t: P2 = [-n[1], n[0]];
  const dn = (v: number[]) => v[0] * n[0] + v[1] * n[1], dt = (v: number[]) => v[0] * t[0] + v[1] * t[1];
  const tris: V5[][] = [];
  for (let i = 0; i + 14 < b.wall.length; i += 15) tris.push([0, 1, 2].map((k) => b.wall.slice(i + k * 5, i + k * 5 + 5) as V5));
  // front triangles: normal within ~15° of `facing`, on the outermost plane that way (±1.5 m)
  const facingN = (tr: V5[]) => {
    const ux = tr[1][0] - tr[0][0], uy = tr[1][1] - tr[0][1], uz = tr[1][2] - tr[0][2], vx = tr[2][0] - tr[0][0], vy = tr[2][1] - tr[0][1], vz = tr[2][2] - tr[0][2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, L = Math.hypot(nx, ny) || 1;
    return Math.abs((nx * n[0] + ny * n[1]) / L);
  };
  const cand = tris.filter((tr) => facingN(tr) > 0.96);
  if (!cand.length) return [];
  const front = Math.max(...cand.flatMap((tr) => tr.map(dn)));
  const isFront = (tr: V5[]) => facingN(tr) > 0.96 && tr.every((v) => dn(v) > front - 1.5);
  const keep: number[] = [], hall: number[] = [];
  let s0 = Infinity, s1 = -Infinity;
  for (const tr of tris) {
    if (!isFront(tr)) { for (const v of tr) keep.push(...v); continue; }
    for (const v of tr) { s0 = Math.min(s0, dt(v)); s1 = Math.max(s1, dt(v)); }
    // split at `height` above base (Sutherland–Hodgman on one plane), fan-triangulate both halves
    const lo: V5[] = [], hi: V5[] = [];
    for (let k = 0; k < 3; k++) {
      const p = tr[k], q = tr[(k + 1) % 3], fp = p[4] - a.height, fq = q[4] - a.height;
      (fp <= 0 ? lo : hi).push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
        const f = fp / (fp - fq), x = p.map((c, j) => c + (q[j] - c) * f) as V5;
        lo.push(x); hi.push(x);
      }
    }
    for (let k = 1; k + 1 < hi.length; k++) for (const v of [hi[0], hi[k], hi[k + 1]]) keep.push(...v);
    for (let k = 1; k + 1 < lo.length; k++) for (const v of [lo[0], lo[k], lo[k + 1]])
      hall.push(v[0] - n[0] * a.depth, v[1] - n[1] * a.depth, v[2], v[3], v[4]);
  }
  b.wall.splice(0, b.wall.length, ...keep);
  if (!hall.length) return [];
  const SAND = [0.88, 0.8, 0.64], SHADE = [0.58, 0.52, 0.44];
  const hallP: Piece = { roof: [], wall: hall, footprint: b.footprint, height: a.height, base: b.base, look: { roof: null, wall: SHADE, style: 2 } };
  // floor of the hall, in shade: from the moved wall to the column line
  const at = (s: number, d: number, z: number) => [n[0] * d + t[0] * s, n[1] * d + t[1] * s, z];
  const floor: Piece = { roof: [], wall: [], footprint: b.footprint, height: 0.1, base: b.base, look: { roof: [0.5, 0.47, 0.42], wall: SHADE, style: 4 } };
  const z = b.base + 0.08, f0 = at(s0, front - a.depth, z), f1 = at(s1, front - a.depth, z), f2 = at(s1, front, z), f3 = at(s0, front, z);
  floor.roof.push(...f0, ...f1, ...f2, ...f0, ...f2, ...f3);
  // columns: evenly over the front, base and capital a little wider than the tapering shaft
  const cols: Piece = { roof: [], wall: [], footprint: b.footprint, height: a.height, base: b.base, look: { roof: SAND, wall: SAND, style: CLAD } };
  const count = Math.max(2, Math.round((s1 - s0) / a.spacing)), step = (s1 - s0 - 2 * a.r) / (count - 1);
  for (let k = 0; k < count; k++) {
    const c = at(s0 + a.r + k * step, front - a.r - 0.15, 0), r = a.r, H = a.height;
    lathe(cols, [c[0], c[1]], [[0, r * 1.3], [0.5, r * 1.3], [0.5, r], [H - 0.7, r * 0.86], [H - 0.7, r * 1.25], [H, r * 1.25]], 10);
  }
  return [hallP, floor, cols];
}

/** Looks for named landmarks whose OSM tags are missing or off: merged over the building's OSM tags (scene.ts). */
export const LOOKS: Record<string, Record<string, string>> = { ...stuttgart.LOOKS, ...wieliczka.LOOKS };
/** Colonnades carved into LoD2 blocks (arcade). */
export const ARCADES: Record<string, Arcade> = { ...stuttgart.ARCADES };
/** Towers and monuments replaced as a whole: model at the centre of the OSM outline, standing on `base`. */
export const TOWERS: Record<string, (c: P2, base: number) => Piece[]> = { ...stuttgart.TOWERS };
/** Additions on top of a LoD2 building: model at its highest roof point inside the OSM outline (centre of that top face). */
export const TOPS: Record<string, (c: P2, top: number, headingDeg: number) => Piece[]> = { ...stuttgart.TOPS };

/** An OSM outline in ENU: outer rings counter-clockwise, inner rings (holes) as well (scene.ts ringFromLonLat). */
export type Rings = { outer: P2[][]; inner: P2[][] };
/** Structures built on their OSM outline, picked by tag (LoD2 and BDOT10k leave them out): `ql` selects them for fetch. */
export type Structure = { ql: string; match: (t: Record<string, string>) => boolean; model: (r: Rings, ground: (x: number, y: number) => number, t: Record<string, string>) => Piece[] };
export const STRUCTURES: Structure[] = [
  // the wall itself, mapped as a building (an attraction's fenced grounds carry the tag too, without building)
  { ql: `["man_made"="graduation_tower"]["building"]`, match: (t) => t.man_made === "graduation_tower" && !!t.building, model: graduationTower },
];
/**
 * Models at a measured point (lat, lon), for parts OSM does not map on their own; tree crowns within `clear` m go.
 * The model stands on `base` (the ground there); `ground` is the same, or the LoD2 building's base (its lowest
 * ground) with `cut` or `building`.
 *
 * `cut` replaces a solid LoD2 block (a headframe's stand-in): the LoD2 walls and roofs within `cut` m of the point
 * that rise above the roofs around them are cut off and capped level there, and the model stands on the cap.
 * `building` sets the wall and roof colour (and façade style) of that LoD2 building (without `cut`: the one under
 * the point), where OSM's outline does not cover it (LOOKS), the orthophoto reads its roof wrong (the headframe's
 * shadow on it) or a colour must stay as strong as it is (OSM building:colour is lightened to the house style).
 */
export type Placed = {
  name: string; at: [number, number]; clear: number; cut?: number; building?: { wall?: number[]; roof?: number[]; style?: number };
  model: (c: P2, base: number, ground: number) => Piece[];
};
export const PLACED: Placed[] = [...wieliczka.PLACED];
/** Football stadiums rebuilt as open stands on their OSM outline (landmarks/stadium.ts), by OSM name. */
export const STADIUMS = { ...wieliczka.STADIUMS };
export { stadiumStands, type StadiumLook } from "./landmarks/stadium.ts";

// Zagreb (landmarks/zagreb.ts): looks set directly, rebuilt LoD2 landmarks, the market umbrellas
export { PAINT, REBUILDS, UMBRELLAS, umbrellas, type MeshRef, type RebuildCtx } from "./landmarks/zagreb.ts";
