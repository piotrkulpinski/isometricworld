/**
 * Ground surface drawn from OSM onto a canvas (top-down, ENU meters) and draped on the terrain:
 * landuse, parks, beach, water and sea, pavements, roads at real widths with lane markings,
 * paths, rail, soft contact shadows of buildings and trees. Flat clean colours: the paint
 * step turns them into textured art.
 */

type P2 = [number, number];
export interface Feature { k: string; r?: P2[][]; l?: P2[]; w?: number; o?: 1; n?: number; y?: number; s?: 1; j?: number[][] }
interface Objects { b: Array<[P2[], number, number, number | null]>; t: number[][] }

const FILL: Record<string, string> = {
  residential: "#dcd5c6", commercial: "#dfdbd2", industrial: "#cfcbc2", campus: "#e1dacb",
  farm: "#c9cd8c", dirt: "#d2b98f", cemetery: "#b2c798",
  park: "#9dcb6c", wood: "#73a851", scrub: "#adbb7b", sand: "#eedbab", pitch: "#6db35a", track: "#c97a5c",
  playground: "#dccba1", parking: "#bebcb7", paving: "#e6e0d4", water: "#3f95c2", pool: "#5ccbe6",
};
/** paint order of area kinds: broad landuse first, details on top */
const AREA_ORDER = ["residential", "commercial", "industrial", "campus", "farm", "dirt", "cemetery", "scrub", "wood",
  "park", "sand", "parking", "paving", "pitch", "track", "playground", "water", "pool"];
const BASE = "#d9d3c4";
const SEA = "#2c80b2", SHALLOW = "#4ea6cb";
const ASPHALT: Record<string, string> = { highway: "#6c7077", street: "#7b7e85", lane: "#8b8d91", dirtroad: "#c3ab82" };
const PATHS: Record<string, string> = { path: "#ebe5d6", cycle: "#c98e6c", plaza: "#e6e0d4" };
const SIDEWALK = "#e4ded2", KERB = "#c9c4b9", SETT = "#a9a196";
const SHADOW_DIR: P2 = [0.84, 0.54]; // away from the renderer's sun (-0.55, -0.35, 0.76)

export function drawGround(
  ctx: CanvasRenderingContext2D, features: Feature[], [x0, y0, x1, y1]: number[], mpt: number,
  objects: Objects, ground: (x: number, y: number) => number,
) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BASE;
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(1 / mpt, 0, 0, -1 / mpt, -x0 / mpt, y1 / mpt); // ENU meters -> canvas px (north up)
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const path = (rings: P2[][]) => {
    ctx.beginPath();
    for (const r of rings) { r.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
  };
  const line = (l: P2[]) => { ctx.beginPath(); l.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
  const stroke = (l: P2[], w: number, c: string, dash?: number[]) => {
    line(l); ctx.lineWidth = w; ctx.strokeStyle = c; ctx.setLineDash(dash ?? []); ctx.stroke();
  };
  const of = (k: string) => features.filter((f) => f.k === k);
  const inView = (p: number[]) => p[0] > x0 - 50 && p[0] < x1 + 50 && p[1] > y0 - 50 && p[1] < y1 + 50;
  const junctions = (of("junctions")[0]?.j ?? []).filter(inView);
  const zebras = (of("zebras")[0]?.j ?? []).filter(inView);

  // 1. areas
  for (const k of AREA_ORDER) for (const f of of(k)) {
    path(f.r!); ctx.fillStyle = FILL[k]; ctx.fill("evenodd");
    if (k === "pitch") { ctx.lineWidth = 0.25; ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.stroke(); }
    if (k === "pool") { ctx.lineWidth = 0.6; ctx.strokeStyle = "#e9ecee"; ctx.stroke(); }
    if (k === "water") { ctx.lineWidth = 1; ctx.strokeStyle = "rgba(220,235,240,0.5)"; ctx.stroke(); }
  }

  // 2. sea: deep, shallows along the shore (clipped to the water), surf line
  for (const f of of("sea")) {
    path(f.r!); ctx.fillStyle = SEA; ctx.fill("evenodd");
    ctx.save(); path(f.r!); ctx.clip("evenodd");
    for (const s of of("shore")) {
      stroke(s.l!, 90, "rgba(78,166,203,0.45)");
      stroke(s.l!, 36, SHALLOW);
      stroke(s.l!, 10, "#78c0d8");
      stroke(s.l!, 3, "rgba(255,255,255,0.75)");
    }
    ctx.restore();
  }

  // 3. soft contact shadows (short: the art has no long shadows)
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = "#3a3a40";
  for (const [ring, h] of objects.b) {
    const L = Math.min(9, h * 0.35), dx = SHADOW_DIR[0] * L, dy = SHADOW_DIR[1] * L;
    ctx.beginPath();
    // swept footprint = footprint ∪ shifted footprint ∪ every edge's sweep
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(bx + dx, by + dy); ctx.lineTo(ax + dx, ay + dy); ctx.closePath();
    }
    ring.forEach(([x, y], i) => (i ? ctx.lineTo(x + dx, y + dy) : ctx.moveTo(x + dx, y + dy)));
    ctx.closePath();
    ctx.fill("nonzero");
  }
  for (const [x, y, r, ch] of objects.t) {
    const L = Math.min(6, ch * 0.3);
    ctx.beginPath(); ctx.arc(x + SHADOW_DIR[0] * L, y + SHADOW_DIR[1] * L, r * 0.95, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  void ground;

  // 4. paths and plazas, then pavements under streets
  for (const f of [...of("path"), ...of("plaza"), ...of("cycle")]) stroke(f.l!, f.w!, PATHS[f.k]);
  for (const f of of("pier")) stroke(f.l!, f.w!, "#d8d2c4");
  // Roads have butt ends: a round cap on a bridge end or a wide road's end bulges over whatever it
  // meets. Joins between ways are filled by junction disks instead, drawn in the junction's layer.
  ctx.lineCap = "butt";
  const roads = features.filter((f) => ASPHALT[f.k]).sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || order(a) - order(b));
  const rails = of("rail");
  const layers = [...new Set([...roads, ...rails].map((f) => f.y ?? 0))].sort((a, b) => a - b);
  const disks = (js: number[][], grow: number, c?: string) => {
    for (const [x, y, r, , k] of js) {
      ctx.beginPath(); ctx.arc(x, y, r - 3 + grow, 0, Math.PI * 2);
      ctx.fillStyle = c ?? ASPHALT[CLASS[k] ?? "street"]; ctx.fill();
    }
  };
  for (const layer of layers) {
    const rs = roads.filter((f) => (f.y ?? 0) === layer);
    const js = junctions.filter((j) => (j[3] ?? 0) === layer);
    if (layer > 0) {
      // a bridge must read as passing OVER what's below: cast shadow, dark outline, concrete parapets
      for (const f of rs) stroke(f.l!.map(([x, y]) => [x + SHADOW_DIR[0] * 4, y + SHADOW_DIR[1] * 4] as P2), f.w! + 3, "rgba(40,40,48,0.35)");
      for (const f of rs) stroke(f.l!, f.w! + 3, "#55565c");
      for (const f of rs) stroke(f.l!, f.w! + 2.4, "#e2ddd2");
    }
    const streets = rs.filter((f) => f.k === "street");
    for (const f of streets) stroke(f.l!, f.w! + 6, KERB);
    const streetJs = layer === 0 ? js.filter((j) => CLASS[j[4]] === "street") : []; // pavements round street corners
    disks(streetJs, 3, KERB);
    for (const f of streets) stroke(f.l!, f.w! + 5.4, SIDEWALK);
    disks(streetJs, 2.7, SIDEWALK);
    for (const f of rs) stroke(f.l!, f.w!, f.s && f.k !== "highway" ? SETT : ASPHALT[f.k]);
    disks(js, 0);
    // 5. markings, kept out of junctions (lines of crossing roads would scribble over each other)
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - 1e4, y1 - 1e5, 2e5, 2e5);
    for (const [x, y, r] of junctions) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
    ctx.clip("evenodd");
    for (const f of rs) {
      if ((f.k !== "street" && f.k !== "highway") || f.s) continue;
      const w = f.w!;
      if (f.k === "highway") { for (const s of [-1, 1]) stroke(offset(f.l!, s * (w / 2 - 0.5)), 0.15, "rgba(255,255,255,0.9)"); }
      const lanes = f.n ?? Math.max(1, Math.round(w / 3.3));
      if (!f.o && w >= 7) stroke(f.l!, 0.15, "rgba(255,255,255,0.9)", lanes >= 4 ? undefined : [3, 5]);
      const per = f.o ? lanes : Math.floor(lanes / 2);
      for (let k = 1; k < per; k++) {
        const d = -w / 2 + (k * w) / lanes;
        if (f.o) stroke(offset(f.l!, d), 0.12, "rgba(255,255,255,0.85)", [3, 6]);
        else for (const s of [-1, 1]) stroke(offset(f.l!, (s * k * w) / lanes), 0.12, "rgba(255,255,255,0.85)", [3, 6]);
      }
    }
    ctx.restore();
    // 6. rail of this layer: ballast, sleepers, two rails (a road bridge above covers it)
    ctx.lineCap = "round";
    for (const f of rails.filter((f) => (f.y ?? 0) === layer)) {
      stroke(f.l!, 3.4, "#a9a49a");
      stroke(f.l!, 2.6, "#7d6a58", [0.25, 0.4]);
      ctx.setLineDash([]);
      for (const s of [-0.72, 0.72]) stroke(offset(f.l!, s), 0.12, "#4b4d52");
    }
    ctx.setLineDash([]);
    ctx.lineCap = "butt";
  }
  ctx.setLineDash([]);
  // zebra crossings: bars parallel to the street, across its full width
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  for (const [x, y, dx, dy, w] of zebras) {
    const nx = -dy, ny = dx;
    for (let o = -w / 2 + 0.4; o <= w / 2 - 0.4; o += 1.0) {
      const cx = x + nx * o, cy = y + ny * o;
      ctx.beginPath();
      ctx.moveTo(cx - dx * 1.5 - nx * 0.25, cy - dy * 1.5 - ny * 0.25);
      ctx.lineTo(cx + dx * 1.5 - nx * 0.25, cy + dy * 1.5 - ny * 0.25);
      ctx.lineTo(cx + dx * 1.5 + nx * 0.25, cy + dy * 1.5 + ny * 0.25);
      ctx.lineTo(cx - dx * 1.5 + nx * 0.25, cy - dy * 1.5 + ny * 0.25);
      ctx.fill();
    }
  }

  ctx.setLineDash([]);
}

const CLASS = ["dirtroad", "lane", "street", "highway"];
const order = (f: Feature) => CLASS.indexOf(f.k) * 100 + (f.w ?? 0);

/** Parallel polyline at signed distance d (left > 0). */
function offset(l: P2[], d: number): P2[] {
  return l.map((p, i) => {
    const a = l[Math.max(0, i - 1)], b = l[Math.min(l.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / L) * d, p[1] + (dx / L) * d];
  });
}
