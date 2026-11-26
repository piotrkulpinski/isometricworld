/**
 * Wieliczka's hand-modelled landmarks (registries merged in landmarks.ts). Dimensions from pl.wikipedia, the
 * town's culture centre (WCK) and the salt mine museum, and measured on GUGiK data (LoD2, NMPT − NMT, the
 * orthophoto); the Wikimedia Commons photos in ATTRIBUTION.md were only looked at for shapes and colours.
 */
import type { Placed } from "../landmarks.ts";
import type { StadiumLook } from "./stadium.ts";
import { beam, CLAD, disc, face, frame, lathe, type Look, type P2, type P3, panel, type Piece, piece, prism, roofFace } from "./shapes.ts";

const BRUSHWOOD = [0.31, 0.25, 0.20], LARCH = [0.78, 0.60, 0.38], SHADE = [0.30, 0.24, 0.19], TILE = [0.76, 0.36, 0.25];

/**
 * Viewing tower of the graduation tower in Park św. Kingi (2014, Asa Stożek Architekci): an octagon about 13 m
 * across, clad in blackthorn brushwood like the walls, an open larch deck under an octagonal tiled roof, 22.5 m
 * (pl.wikipedia; NMPT − NMT: 22.5 m, the part above 15 m is 6.7 m in radius with the eaves).
 */
function tezniaTower(c: P2, base: number): Piece[] {
  const N = 8, R = 6.0, deck = 15.5, rail = 16.6, eaves = 18.8, apex = 22.3;
  const body = piece(c, base, R, deck, { roof: LARCH, wall: BRUSHWOOD, style: CLAD, bare: 1 });
  lathe(body, c, [[-0.5, R], [deck, R]], N);
  disc(body, c, deck, R, 0, N);
  const railing = piece(c, base, R, rail, { roof: LARCH, wall: LARCH, style: CLAD, bare: 1 });
  lathe(railing, c, [[deck, R], [rail, R]], N);
  const inner = piece(c, base, 5.2, eaves, { roof: SHADE, wall: SHADE, style: CLAD, bare: 1 }); // the shaded deck behind the posts
  lathe(inner, c, [[deck, 5.2], [eaves, 5.2]], N);
  const posts = piece(c, base, R, eaves, { roof: LARCH, wall: LARCH, style: CLAD, bare: 1 });
  for (let i = 0; i < N; i++) {
    const a = (i / N) * 2 * Math.PI, p: P2 = [c[0] + (R - 0.2) * Math.cos(a), c[1] + (R - 0.2) * Math.sin(a)];
    lathe(posts, p, [[rail, 0.2], [eaves, 0.2]], 6);
  }
  const roof = piece(c, base, 7.0, apex + 0.6, { roof: TILE, wall: TILE, style: CLAD, bare: 1 });
  lathe(roof, c, [[eaves - 0.25, 7.0], [eaves, 7.0], [apex, 0.35], [apex + 0.6, 0.05]], N);
  return [body, railing, inner, posts, roof];
}

/** A piece with one look whose footprint is the given ring (for shadows and binning). */
const part = (ring: P2[], base: number, height: number, look: Look): Piece => ({ roof: [], wall: [], footprint: ring, height, base, look });
const clad = (c: number[], roof = c): Look => ({ roof, wall: c, style: CLAD, bare: 1 });

/** X-braced lattice between two levels of four corners each (counter-clockwise), `n` panels high. */
function lattice(p: Piece, lo: P3[], hi: P3[], n: number, leg: number, brace: number) {
  const lvl = (k: number) => lo.map((a, i) => a.map((v, j) => v + ((hi[i][j] - v) * k) / n) as P3);
  for (let i = 0; i < 4; i++) beam(p, lo[i], hi[i], leg);
  for (let k = 0; k <= n; k++) { const L = lvl(k); for (let i = 0; i < 4; i++) beam(p, L[i], L[(i + 1) % 4], brace); }
  for (let k = 0; k < n; k++) {
    const A = lvl(k), B = lvl(k + 1);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; beam(p, A[i], B[j], brace); beam(p, A[j], B[i], brace); }
  }
}

/** Open railing on a closed ring: a handrail band (thicker than life, to read at 0.25 m/px) and posts every ~1.3 m. */
function railing(p: Piece, ring: P2[], z0: number, h: number) {
  panel(p, ring, z0 + h - 0.3, z0 + h);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.3));
    for (let k = 0; k < n; k++) { const q = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]; beam(p, [q[0], q[1], z0], [q[0], q[1], z0 + h - 0.3], 0.12); }
  }
}

const SALMON = [0.94, 0.83, 0.79], KHAKI = [0.89, 0.85, 0.68];
const BLACK_STEEL = [0.21, 0.22, 0.24], HOOD = [0.25, 0.26, 0.28], GALLERY = [0.36, 0.36, 0.37];

/**
 * Szyb Regis: the black steel lattice headframe rising out of the shaft house's roof, a railed gallery on top
 * and a curved hood over the sheaves. Hood outline and heights from LoD2 (3.85 × 6.75 m, long axis 352.5°,
 * eaves 23.4 m, ridge 24.3 m above the building's ground); the lattice's taper and panels from the photos.
 */
function regisHeadframe(c: P2, base: number, ground: number): Piece[] {
  const at = frame(c, 352.5), z = (h: number) => h - (base - ground), cap = base - ground;
  const rect = (U: number, V: number): P2[] => [at(-U, -V), at(U, -V), at(U, V), at(-U, V)];
  const corners = (U: number, V: number, h: number): P3[] => rect(U, V).map((q) => [q[0], q[1], z(h)]);
  const hoodRing = rect(3.38, 1.93), deckRing = rect(3.1, 1.7);
  const steel = part(rect(3.2, 1.8), base, z(20.8), clad(BLACK_STEEL));
  lattice(steel, corners(3.15, 1.78, cap), corners(2.6, 1.3, 20.55), 2, 0.32, 0.13);
  const gallery = part(deckRing, base, z(21.85), clad(GALLERY));
  prism(gallery, deckRing, z(20.55), z(20.8));
  const rail = part(deckRing, base, z(21.85), clad(BLACK_STEEL));
  railing(rail, deckRing, z(20.8), 1.05);
  for (const q of corners(3.0, 1.6, 20.8)) beam(rail, q, [q[0], q[1], z(22.9)], 0.24);
  // hood: a fascia, then a shallow barrel vault along the long axis (gable ends closed)
  const hood = part(hoodRing, base, z(24.3), clad(HOOD));
  prism(hood, hoodRing, z(22.85), z(23.4), false);
  const N = 6, arc = Array.from({ length: N + 1 }, (_, k) => { const v = -1.93 + (3.86 * k) / N; return [v, 23.4 + 0.9 * (1 - (v / 1.93) ** 2)]; });
  for (let k = 0; k < N; k++) {
    const [v0, h0] = arc[k], [v1, h1] = arc[k + 1], a0 = at(-3.38, v0), a1 = at(-3.38, v1), b0 = at(3.38, v0), b1 = at(3.38, v1);
    roofFace(hood, [[a0[0], a0[1], z(h0)], [b0[0], b0[1], z(h0)], [b1[0], b1[1], z(h1)], [a1[0], a1[1], z(h1)]]);
  }
  const mid = at(0, 0);
  for (const u of [-3.38, 3.38]) // the gable ends above the eaves line (convex: the arc and its chord)
    face(hood, arc.map(([v, h]) => { const q = at(u, v); return [q[0], q[1], z(h)] as P3; }), [mid[0], mid[1], z(23.6)]);
  return [steel, gallery, rail, hood];
}

const GRAPHITE = [0.29, 0.31, 0.33], STEEL = [0.78, 0.80, 0.81], YELLOW = [0.95, 0.78, 0.18], WHITE = [0.92, 0.93, 0.93];
const CAGE_ROOF = [0.47, 0.49, 0.51], FASCIA = [0.30, 0.31, 0.33], FLAG_RED = [0.83, 0.13, 0.20];

/**
 * Szyb Daniłowicza: a column clad in graphite panels rising out of the shaft house, a balcony half way up, a
 * steel platform with an open cage on top (a landing inside, yellow stairs and railings) under a flat pyramid
 * roof with a flagpole, and a white lattice strut down to the back (south-west). Roof outline and heights from
 * LoD2 (5.3 m square on the building's axes, 59.6°; eaves 27.9 m, top 29.5 m); the column, cage and strut from
 * the photos (column ≈ 0.7 of the roof's width, platform at ≈ 22 m).
 */
function danilowiczHeadframe(c: P2, base: number, ground: number): Piece[] {
  const at = frame(c, 59.6), z = (h: number) => h - (base - ground); // u: north-east, to the lawn and the gable
  const sq = (h: number): P2[] => [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
  const column = part(sq(1.9), base, z(22.1), clad(GRAPHITE));
  prism(column, sq(1.9), 0, z(21.8), false);
  const decks = part(sq(2.6), base, z(25), clad(STEEL));
  prism(decks, sq(2.6), z(16.65), z(16.9)); // balcony
  prism(decks, sq(2.6), z(21.8), z(22.1)); // platform under the cage
  prism(decks, sq(1.5), z(22.1), z(24.6)); // sheave housing
  prism(decks, sq(2.3), z(24.85), z(25.0)); // landing
  for (const q of sq(2.4)) beam(decks, [q[0], q[1], z(22.1)], [q[0], q[1], z(27.6)], 0.3);
  const rails = part(sq(2.6), base, z(26), clad(YELLOW));
  railing(rails, sq(2.6), z(16.9), 1.05);
  railing(rails, sq(2.6), z(22.1), 1.05);
  railing(rails, sq(2.3), z(25.0), 1.0);
  const top = part(sq(2.65), base, z(29.5), clad(FASCIA, CAGE_ROOF));
  prism(top, sq(2.65), z(27.55), z(27.85), false);
  const r = sq(2.65), apex: P3 = [c[0], c[1], z(29.5)];
  for (let i = 0; i < 4; i++) { const a = r[i], b = r[(i + 1) % 4]; roofFace(top, [[a[0], a[1], z(27.85)], [b[0], b[1], z(27.85)], apex]); }
  // flagpole and the Polish flag (white over red), flying north-west
  const pole = part(sq(0.5), base, z(35), clad(WHITE));
  beam(pole, apex, [c[0], c[1], z(35)], 0.14);
  const fly = [c, at(0, -1.5)];
  panel(pole, fly, z(34.35), z(34.8), false);
  const red = part(sq(0.5), base, z(34.4), clad(FLAG_RED));
  panel(red, fly, z(33.9), z(34.35), false);
  // strut: two white tubes from under the platform down to the low building at the back, laced together
  const strut = part([at(-11, -1.6), at(-2.4, -1.6), at(-2.4, 1.6), at(-11, 1.6)], base, z(22), clad(WHITE));
  const tube = (v: number, t: number): P3 => { const q = at(-2.4 - 8.6 * t, v); return [q[0], q[1], z(22.0 - 17.5 * t)]; };
  for (const v of [-1.3, 1.3]) beam(strut, tube(v, 0), tube(v, 1), 0.38);
  for (let k = 0; k < 7; k++) beam(strut, tube(k % 2 ? 1.3 : -1.3, k / 7), tube(k % 2 ? -1.3 : 1.3, (k + 1) / 7), 0.16);
  return [column, decks, rails, top, pole, red, strut];
}

const OCHRE = [0.90, 0.84, 0.64], RED_TILE = [0.68, 0.30, 0.22], CAP = [0.30, 0.31, 0.33], GREY_GREEN = [0.66, 0.70, 0.64];

/** Laced strut: two chords `w` apart from (u0, h0) to (u1, h1) along a frame's u axis, zig-zag lacing between. */
function strut(p: Piece, at: (u: number, v: number) => P2, z: (h: number) => number, u0: number, h0: number, u1: number, h1: number, w: number, chord: number, lace: number, n: number) {
  const q = (v: number, t: number): P3 => { const a = at(u0 + (u1 - u0) * t, v); return [a[0], a[1], z(h0 + (h1 - h0) * t)]; };
  for (const v of [-w / 2, w / 2]) beam(p, q(v, 0), q(v, 1), chord);
  for (let k = 0; k < n; k++) beam(p, q(k % 2 ? w / 2 : -w / 2, k / n), q(k % 2 ? -w / 2 : w / 2, (k + 1) / n), lace);
}

/**
 * Szyb św. Kingi (1864): a steep red-tiled pyramid on the shaft house's roof, out of which rises a short dark
 * lattice with a railed gallery round the sheave wheel, a flat hipped cap on posts and a mast; a laced strut runs
 * down north-west to the next roof. Cap from LoD2 (5.75 m square on the building's axes, 24°; eaves 28.0 m, top
 * 29.2 m); the strut from the surface model (NMPT − NMT falls from 24 m to 10 m 4–9 m out at 295–330°); the
 * pyramid and the gallery from the photos.
 */
function kingaHeadframe(c: P2, base: number, ground: number): Piece[] {
  const at = frame(c, 24.2), z = (h: number) => h - (base - ground), capH = base - ground;
  const sq = (h: number): P2[] => [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
  const corners = (h: number, zz: number): P3[] => sq(h).map((q) => [q[0], q[1], z(zz)]);
  // the pyramid: 3.0 m half-width where the LoD2 block was cut (so it encloses the stump), 1.3 m at 22 m
  const half = (zz: number) => 1.3 + ((22 - zz) * (3.0 - 1.3)) / (22 - capH), z0 = capH - 2.5;
  const pyramid = part(sq(half(z0)), base, z(22), { roof: RED_TILE, wall: RED_TILE, style: CLAD, bare: 1 });
  const lo = corners(half(z0), z0), hi = corners(1.3, 22);
  for (let i = 0; i < 4; i++) roofFace(pyramid, [lo[i], lo[(i + 1) % 4], hi[(i + 1) % 4], hi[i]]);
  roofFace(pyramid, hi);
  const steel = part(sq(2.6), base, z(29.2), clad(BLACK_STEEL));
  lattice(steel, corners(1.1, 22), corners(1.7, 23.6), 1, 0.3, 0.14);
  prism(steel, sq(2.6), z(23.55), z(23.8));
  railing(steel, sq(2.6), z(23.8), 1.05);
  for (const q of corners(2.45, 23.8)) beam(steel, q, [q[0], q[1], z(27.6)], 0.25);
  beam(steel, [c[0], c[1], z(29.2)], [c[0], c[1], z(33.5)], 0.12); // mast
  // the sheave wheel, in the plane of the rope (towards the strut)
  const rope = frame(c, 295), ring: P3[] = [];
  for (let k = 0; k < 14; k++) { const t = (k / 14) * 2 * Math.PI, q = rope(1.5 * Math.cos(t), 0); ring.push([q[0], q[1], z(25.0 + 1.5 * Math.sin(t))]); }
  for (let k = 0; k < 14; k++) beam(steel, ring[k], ring[(k + 1) % 14], 0.16);
  for (const k of [0, 4, 9]) beam(steel, ring[k], ring[(k + 7) % 14], 0.08);
  const cap = part(sq(2.875), base, z(29.2), clad(CAP));
  prism(cap, sq(2.875), z(27.6), z(28.0), false);
  const r = sq(2.875), apex: P3 = [c[0], c[1], z(29.2)];
  for (let i = 0; i < 4; i++) { const a = r[i], b = r[(i + 1) % 4]; roofFace(cap, [[a[0], a[1], z(28.0)], [b[0], b[1], z(28.0)], apex]); }
  const back = part([rope(1.5, -1), rope(9.5, -1), rope(9.5, 1), rope(1.5, 1)], base, z(23.6), clad(BLACK_STEEL));
  strut(back, rope, z, 1.7, 23.5, 9.0, 10.8, 1.6, 0.28, 0.12, 6);
  return [pyramid, steel, cap, back];
}

/**
 * Szyb Kościuszko: a modern pale grey-green steel headframe (2000s) rising out of a flat-roofed hall, LoD2 leaves
 * it out: an X-braced square column, a platform with an open frame on top (yellow railings), yellow stair flights
 * with landings on the south side, and a box-girder strut to the ground north-north-east. From the surface model
 * (NMPT − NMT: top 28.7 m; above 22 m about 7.6 m square; the strut falls from 16 m to the ground 4–11 m out at
 * 0–45°) and the hall's axes in LoD2 (20°, 110°); the column, frame and stairs from a 2008 photo.
 */
function kosciuszkoHeadframe(c: P2, base: number): Piece[] {
  const at = frame(c, 20); // u: north-north-east, along the strut
  const sq = (h: number): P2[] => [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
  const corners = (h: number, zz: number): P3[] => sq(h).map((q) => [q[0], q[1], zz]);
  const steel = part(sq(3.8), base, 27.2, clad(GREY_GREEN));
  lattice(steel, corners(2.8, 8.5), corners(2.8, 20.0), 4, 0.36, 0.15);
  prism(steel, sq(3.8), 20.0, 20.6);
  for (const q of corners(3.6, 20.6)) beam(steel, q, [q[0], q[1], 27.2], 0.3);
  for (const zz of [24.0, 27.2]) { const L = corners(3.6, zz); for (let i = 0; i < 4; i++) beam(steel, L[i], L[(i + 1) % 4], 0.24); }
  beam(steel, [...at(0, -3.6), 27.2] as P3, [...at(0, 3.6), 27.2] as P3, 0.3); // sheave beam
  // strut: a box girder from under the platform to the ground
  beam(steel, [...at(3.6, 0), 20.0] as P3, [...at(11.2, 0), 0.0] as P3, 1.1);
  const yellow = part(sq(3.8), base, 28.2, clad(YELLOW));
  railing(yellow, sq(3.8), 20.6, 1.05);
  railing(yellow, sq(3.6), 27.2, 1.0);
  // stairs on the south side: landings with railings, flights between them
  const landing: P2[] = [at(-4.2, -2.6), at(-2.8, -2.6), at(-2.8, -0.2), at(-4.2, -0.2)];
  for (const zz of [11.5, 14.5, 17.5]) { prism(steel, landing, zz - 0.15, zz); railing(yellow, landing, zz, 1.0); }
  for (const [z0, z1, v] of [[9.0, 11.5, -2.2], [11.5, 14.5, -0.6], [14.5, 17.5, -2.2], [17.5, 20.0, -0.6]]) {
    const v1 = v < -1 ? -0.6 : -2.2;
    beam(yellow, [...at(-3.5, v), z0] as P3, [...at(-3.5, v1), z1] as P3, 0.22);
  }
  return [steel, yellow];
}

const SILO = [0.86, 0.87, 0.86], HALL_ROOF = [0.80, 0.81, 0.80];

/**
 * The three round silos beside Szyb Kościuszko (white tops with a hatch on the orthophoto, ≈ 3.3 m across;
 * NMPT − NMT 14–18 m), which the surface model otherwise turns into tree crowns. Offsets in m east, north.
 */
function kosciuszkoSilos(c: P2, base: number): Piece[] {
  const out: Piece[] = [];
  for (const [dx, dy] of [[1.1, 1.85], [-3.9, -0.9], [-0.4, -2.0]]) {
    const q: P2 = [c[0] + dx, c[1] + dy], s = piece(q, base, 1.65, 16.6, clad(SILO));
    lathe(s, q, [[0, 1.65], [16.0, 1.65], [16.6, 0.5]], 16);
    disc(s, q, 16.6, 0.5, 0, 16);
    out.push(s);
  }
  return out;
}

const LARCH_BOARDS = [0.82, 0.58, 0.36], SHINGLE = [0.36, 0.31, 0.28], PATINA = [0.34, 0.47, 0.42], PATINA_DARK = [0.27, 0.37, 0.34], GILT = [0.80, 0.66, 0.30];

/**
 * The turret (sygnaturka) on the nave ridge of St Sebastian's, a larch church of 1581–98: a square base and a
 * bell-shaped cap in green patinated copper, an open lantern on four posts, an onion cupola, a gilt ball and a
 * cross. Not in LoD2; its place and height from NMPT − NMT (a 20.1 m peak on the ridge, which is at ≈ 13 m
 * there), the shape from a photo. On the nave's axis (76°); heights above the ground at the point.
 */
function sebastianTurret(c: P2, base: number): Piece[] {
  const turn = ((90 - 76 + 45) * Math.PI) / 180, R = (h: number) => h * Math.SQRT2; // square on the axis: corner radius
  const body = piece(c, base, 1.7, 20.1, { roof: PATINA, wall: PATINA_DARK, style: CLAD, bare: 1 });
  // the base from inside the roof, then the bell-shaped cap, closed at the lantern's floor
  lathe(body, c, [[10.5, R(1.15)], [15.0, R(1.15)], [15.4, R(1.05)], [16.1, R(0.8)], [16.7, R(0.62)], [16.75, 0.01]], 4, turn);
  lathe(body, c, [[17.95, R(0.75)], [18.15, R(0.75)], [18.15, R(0.5)]], 4, turn); // the lantern's cornice
  const posts = piece(c, base, 0.8, 18.0, { roof: PATINA, wall: PATINA, style: CLAD, bare: 1 });
  const at = frame(c, 76);
  for (const [u, v] of [[-0.55, -0.55], [0.55, -0.55], [0.55, 0.55], [-0.55, 0.55]]) { const q = at(u, v); beam(posts, [q[0], q[1], 16.6], [q[0], q[1], 18.0], 0.16); }
  const onion = piece(c, base, 0.9, 19.6, { roof: PATINA, wall: PATINA, style: CLAD, bare: 1 });
  lathe(onion, c, [[18.15, 0.45], [18.45, 0.8], [18.85, 0.7], [19.25, 0.3], [19.55, 0.08]], 10);
  const gilt = piece(c, base, 0.3, 20.1, { roof: GILT, wall: GILT, style: CLAD, bare: 1 });
  lathe(gilt, c, [[19.55, 0.05], [19.62, 0.17], [19.75, 0.2], [19.88, 0.17], [19.95, 0.05]], 8);
  beam(gilt, [c[0], c[1], 19.95], [c[0], c[1], 20.9], 0.08);
  const q0 = at(0, -0.3), q1 = at(0, 0.3);
  beam(gilt, [q0[0], q0[1], 20.55], [q1[0], q1[1], 20.55], 0.07);
  return [body, posts, onion, gilt];
}

const STONE = [0.84, 0.82, 0.78], BASZTA_ROOF = [0.60, 0.29, 0.21], TIMBER = [0.33, 0.22, 0.16];

/**
 * Baszta, the castle's 14th-century tower (8.0 × 6.8 m, eaves ≈ 17–18 m, a steep pyramid to 23.7 m in LoD2):
 * on its LoD2 block, plain rubble stone without the window rows of the house style, a dark timber balcony and
 * an outside stair to the door on the courtyard side (east-south-east), a ball and a weathervane on the apex.
 * The balcony and stair from the photos; their heights above the ground at the tower's centre.
 */
function basztaDetails(c: P2, base: number, ground: number): Piece[] {
  const at = frame(c, 23), face = 2.75; // u along the courtyard face (23°), v out of it (113°)
  const wood = part([at(-2, face), at(2, face), at(2, face + 2), at(-2, face + 2)], base, 10.6, { roof: TIMBER, wall: TIMBER, style: CLAD, bare: 1 });
  const deck: P2[] = [at(-0.4, face), at(2.8, face), at(2.8, face + 0.9), at(-0.4, face + 0.9)];
  prism(wood, deck, 9.4, 9.6);
  railing(wood, [deck[1], deck[2], deck[3], deck[0]], 9.6, 1.0);
  // the stair: a flight along the face up to a landing at the door (4.7 m), on two timber posts
  const land: P2[] = [at(-1.6, face), at(-0.4, face), at(-0.4, face + 1.2), at(-1.6, face + 1.2)];
  prism(wood, land, 4.5, 4.7);
  for (const q of [land[1], land[2]]) beam(wood, [q[0], q[1], 0], [q[0], q[1], 4.5], 0.2);
  const f0 = at(-6.0, face + 0.1), f1 = at(-6.0, face + 1.1), f2 = at(-1.6, face + 1.1), f3 = at(-1.6, face + 0.1);
  roofFace(wood, [[f0[0], f0[1], 0.1], [f1[0], f1[1], 0.1], [f2[0], f2[1], 4.7], [f3[0], f3[1], 4.7]]);
  beam(wood, [f1[0], f1[1], 1.0], [f2[0], f2[1], 5.6], 0.12); // handrail
  // ball and weathervane on the apex
  const top = part([at(-0.5, -0.5), at(0.5, -0.5), at(0.5, 0.5), at(-0.5, 0.5)], base, 25.6, { roof: PATINA, wall: PATINA, style: CLAD, bare: 1 });
  const apex = at(-0.32, -0.08), az = 23.7 - (base - ground); // LoD2: 23.7 m over its base, 0.2 m W, 0.26 m S of the centre
  lathe(top, apex, [[az + 0.55, 0.05], [az + 0.65, 0.25], [az + 0.85, 0.3], [az + 1.05, 0.25], [az + 1.15, 0.05]], 8);
  beam(top, [apex[0], apex[1], az + 1.15], [apex[0], apex[1], az + 2.4], 0.07);
  panel(top, [apex, at(0.38, -0.08)], az + 1.9, az + 2.3, false);
  return [wood, top];
}

/** Named buildings whose OSM tags give no look (merged over their tags, scene.ts); roofs stay the orthophoto's. */
export const LOOKS: Record<string, Record<string, string>> = {
  // a closed arena: a plain light roof (a LOOKS entry makes it bare: no made-up solar panels or plant rooms)
  "Tauron Arena Kraków": {},
  // the salt works castle: pale butter-yellow plaster, red tiles
  "Zamek Żupny": { "building:colour": "yellow" },
  "Zamek Południowy": { "building:colour": "yellow" },
  // St Clement's: salmon-pink plaster with cream pilasters (photos 2023); its new copper roof reads brown-grey on
  // the 2025 orthophoto (the light green of early 2023 photos was the old one)
  "Kościół pw. Świętego Klemensa w Wieliczce": { "building:colour": "pink" },
};

/**
 * Football stadiums rebuilt as open stands (landmarks/stadium.ts), by the OSM name of their outline. Cracovia: red
 * and white seats, a white steel canopy (photos: pl.wikipedia, Stadion Cracovii); Wisła: red, white and blue seats
 * under a grey canopy (pl.wikipedia, Stadion Miejski im. Henryka Reymana).
 */
export const STADIUMS: Record<string, StadiumLook> = {
  "Stadion Cracovii im. Józefa Piłsudskiego": { seats: [[0.78, 0.16, 0.18], [0.92, 0.92, 0.92]], canopy: [0.90, 0.91, 0.92], wall: [0.62, 0.63, 0.65], height: 20 },
  "Synerise Arena - Stadion Miejski im. Henryka Reymana": { seats: [[0.80, 0.14, 0.16], [0.92, 0.92, 0.92], [0.20, 0.32, 0.62]], canopy: [0.72, 0.74, 0.77], wall: [0.58, 0.60, 0.63] },
};

/** Models at a measured point, for parts OSM does not map on their own. */
export const PLACED: Placed[] = [
  // centre of the round part of the graduation tower's OSM outline (a circle fitted to its outer and inner arcs,
  // r 7.6 m), as the walls are drawn from that outline; the surface model has the roof 1.2 m further east
  { name: "Tężnia solankowa: wieża widokowa", at: [49.984448, 20.052061], clear: 8, model: tezniaTower },
  // headframes: the centre of the LoD2 block standing in for each (its roof outline), cut off at the roofs around
  { name: "Szyb Regis", at: [49.983825, 20.061206], clear: 4, cut: 4.3, building: { wall: SALMON }, model: regisHeadframe },
  { name: "Szyb Daniłowicza", at: [49.983034, 20.055672], clear: 4, cut: 4.0, building: { wall: KHAKI }, model: danilowiczHeadframe },
  { name: "Szyb Kinga", at: [49.983251, 20.051488], clear: 4, cut: 4.4, building: { wall: OCHRE }, model: kingaHeadframe },
  // not in LoD2: the centre of the NMPT − NMT area above 18 m
  { name: "Szyb Kościuszko", at: [49.982752, 20.045126], clear: 6, building: { roof: HALL_ROOF }, model: kosciuszkoHeadframe },
  // the tower's LoD2 footprint centre; its stone without window rows
  { name: "Baszta (Zamek Żupny)", at: [49.984007, 20.058908], clear: 3, building: { wall: STONE, roof: BASZTA_ROOF, style: CLAD }, model: basztaDetails },
  // the turret: the NMPT − NMT peak on the nave ridge; the church's honey larch boards and dark shingles
  { name: "Kościół św. Sebastiana: sygnaturka", at: [49.978003, 20.066010], clear: 3, building: { wall: LARCH_BOARDS, roof: SHINGLE, style: CLAD }, model: sebastianTurret },
  // the silos on the orthophoto, offsets from here
  { name: "Szyb Kościuszko: silosy", at: [49.982735, 20.045266], clear: 5.5, model: kosciuszkoSilos },
];
