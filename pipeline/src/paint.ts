/**
 * Repaint the open-data 3D render into crisp, realistic isometric art with the local Codex CLI
 * (ChatGPT login, built-in image generation; no API key).
 *
 * Painting happens in overlapping 1024px windows on a global grid (stride 896). Each window gets
 * its already-painted neighbours (any side) pasted into the 128 px overlap, then windows are feather-blended
 * into 1024px art tiles aligned with the render tiles.
 *
 *   npm run paint -- tlv-core --plan
 *   npm run paint -- tlv-core --window 4,-3
 *   npm run paint -- tlv-core --near 32.064,34.775 --radius 2   # a patch of windows
 *   npm run paint -- tlv-core -j 3                              # everything, centre first (--center lat,lon)
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp, { type OverlayOptions } from "sharp";
import { groundH, openArea } from "./areas.ts";
import { CAMERA, llhToPixel } from "./camera.ts";
import { DERIVED, PIPELINE, readJson, writeAtomic } from "./paths.ts";
import { seaH, readHeights } from "./heights.ts";
import { applyRegistration, register } from "./register.ts";

const WIN = 1024, OVERLAP = 128, STRIDE = WIN - OVERLAP, T = CAMERA.tile;
/** Blend band in the middle of each overlap; outside it a window's own pixels win outright. */
const FEATHER = 64;
const STYLE = join(PIPELINE, "style", "reference.png");
/**
 * What the prompt says about each region: country, tree legend and sheet (painted once with Codex),
 * roofs and materials. The house style (reference.png) stays the same everywhere.
 */
interface RegionText { country: string; trees: string; treeSheet: string; legend: string; roofs: string; materials: string; paving: string }
const REGION_TEXT: Record<string, RegionText> = {
  "israel-center": {
    country: "Israel",
    trees: "trees.png",
    treeSheet: "Tel Aviv street and park trees",
    legend: "dark green = ficus, light green = tipuana, \
lilac = jacaranda in bloom, red-orange = flame tree, grey-green = olive, dark teal = Aleppo pine, \
blue-green tall = eucalyptus, small crown on a thin brown trunk = date palm (shorter) or Washingtonia fan palm (taller).",
    roofs: "flat roofs with rooftop details",
    materials: "Draw believable Tel Aviv \
materials: white/cream plaster Bauhaus blocks with rounded balconies, stone public buildings, glass towers, \
real window grids, balconies, shutters, rooftop solar heaters and AC units.",
    paving: "pale grey/cream stone paving — not orange or terracotta —",
  },
  "poland-south": {
    country: "Poland",
    trees: "trees-central-european.png",
    treeSheet: "Kraków street and park trees, in summer",
    legend: "mid green = small-leaved lime, deep green = Norway maple, \
light yellow-green small = field maple, very dark green = horse chestnut, pale olive = London plane, \
light lime green = black locust, pale tall narrow = silver birch, dark olive = oak, dark teal tall narrow cone = Norway spruce.",
    roofs: "steep pitched clay-tile and copper roofs on historic buildings, flat roofs on modern ones",
    materials: "Draw believable Kraków \
materials: 19th-century tenements (kamienice) with cream, ochre, pastel and grey plaster facades, cornices and tall \
windows; Gothic brick churches and stone public buildings; steep red-brown clay-tile roofs and green copper roofs and \
spires on historic buildings; plain post-war blocks with flat roofs. The render shows every building as a flat-topped \
block at its measured height: on historic buildings draw a pitched roof inside the same footprint, its ridge at that height.",
    paving: "grey granite setts and pale stone paving on squares and in the Old Town, grey asphalt elsewhere,",
  },
};

const SEA = join(PIPELINE, "style", "sea.png");
/** Minimum edge-map correlation between render and painted window (pilot range 0.58–0.90). */
const MIN_MATCH = 0.45;
/** Below this share of strong edges in the render (sea, sand, empty lots) the match check is skipped. */
const MIN_TEXTURE = 0.05;

const promptFor = (REGION: RegionText) => `Use your image generation tool. Four images are attached:
1. input.png: an orthographic aerial render (camera tilted 45° down, no perspective) of a simple 3D model \
of {title}, ${REGION.country}, built from map data. ~256 m across. The layout is exact; the colours are flat \
placeholders (grey = asphalt with lane markings, pale = pavement/plaza, green = grass/park, sand = beach, \
blue = water, brown dashes = rail, terracotta = bike path) and the window patterns are schematic hints. \
Tree crowns are colour-coded by species (see image 4): ${REGION.legend}
2. height.png: the height map from the SAME camera, pixel-aligned with image 1. Black = ground \
(streets, squares, sea), grey→white = buildings and trees, brighter = taller. Use it to find exact \
building footprints, edges and heights; open black areas are streets/plazas, not trees.
3. style.png: the STYLE REFERENCE.
4. trees.png: what each tree species looks like (${REGION.treeSheet}), in the same style.

Redraw image 1 as detailed isometric pixel-art-style city illustration in EXACTLY the style of image 3: \
clean crisp 3D blocks with straight vertical walls, every facade drawn with regular window grids and \
balconies, ${REGION.roofs}, saturated but natural colours, realistic varied trees \
drawn as the species of image 4 seen from above${REGION.trees === "trees.png" ? " (palms as star-shaped frond crowns with a visible trunk)" : ""}, smooth grey asphalt with lane markings, clean pavements, soft even daylight, light ambient \
occlusion, no long shadows, no haze, no photographic noise.

Geometry comes ONLY from images 1 and 2 — this is a tracing job:
- Same orthographic camera, framing and scale: the output overlays image 1 pixel-for-pixel.
- Every building keeps its exact footprint, position, height and roof outline. ${REGION.materials} Tall towers stay tall. \
Do not add, remove, merge or move buildings or trees; do not invent trees over open streets.
- Streets, squares, parks, beach and sea stay exactly where they are; give them real texture \
(${REGION.paving} crosswalks at junctions, grass, sand, water ripples, parked cars along kerbs only, \
no cars in the driving lanes).
- Layering is exactly as in image 1: where a road bridge crosses rail tracks, a river or another road, the \
bridge deck is continuous and on top, and whatever passes underneath is hidden beneath it — never draw \
rails or lane markings across a bridge deck.
- Image 3 is only for style. Do not copy its buildings, layout or architecture.
{continuation}Output: one square 1024x1024 image, no text, no labels, no border, no vignette.

When done, copy the final PNG to {out} and reply only with that path.
`;
const CONTINUATION = `- The strip(s) along the {edges} edge(s) of image 1 are ALREADY-PAINTED neighbouring artwork. \
Reproduce them unchanged and continue the same palette and detail seamlessly into the rest.
`;

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plan: { type: "boolean", default: false },
    window: { type: "string" },
    near: { type: "string" },
    radius: { type: "string", default: "1" },
    force: { type: "boolean", default: false },
    // repaint windows painted before this time (e.g. after a style change); runs alongside a normal paint
    older: { type: "string" },
    assemble: { type: "boolean", default: false }, // only rebuild every art tile from the windows
    j: { type: "string", default: "3" },
    center: { type: "string" }, // lat,lon painted first (default: Tel Aviv's Rothschild / Dizengoff / beach, else the area centre)
  },
});
const areaName = positionals[0] ?? "tlv-core";
const base = join(DERIVED, areaName);
const manifest = readJson(join(base, "manifest.json"));
const { title, region } = openArea(areaName);
const REGION = REGION_TEXT[region];
if (!REGION) throw new Error(`no paint prompt for region ${region}: add it to REGION_TEXT`);
const PROMPT = promptFor(REGION);
const TREES = join(PIPELINE, "style", REGION.trees);
/** Codex model for painting (needs the built-in image generation tool); default: the Codex CLI's own. */
const MODEL = process.env.CODEX_PAINT_MODEL ? ["-m", process.env.CODEX_PAINT_MODEL] : [];
const OLDER = args.older ? new Date(args.older).getTime() : 0;
const mtime = (f: string) => (existsSync(f) ? statSync(f).mtimeMs : 0);
/** painted in the current style (with --older, windows painted before the cut-off don't count) */
const current = (i: number, j: number) => existsSync(winFile(i, j)) && mtime(winFile(i, j)) >= OLDER;
const tileSet = new Set<string>(manifest.tiles.map((t: any) => `${t.x}_${t.y}`));
const winDir = join(base, "windows");
mkdirSync(winDir, { recursive: true });

const renderFile = (tx: number, ty: number) => join(base, "render", `${tx}_${ty}.png`);
const winFile = (i: number, j: number) => join(winDir, `${i}_${j}.png`);

/** Crop a global-pixel box out of tiles produced by `load(tx, ty)` (1024² PNG buffers or null). */
async function cropGlobal(x: number, y: number, w: number, h: number,
  load: (tx: number, ty: number) => Promise<Buffer | null> = async (tx, ty) =>
    existsSync(renderFile(tx, ty)) ? sharp(renderFile(tx, ty)).png().toBuffer() : null) {
  const comps: OverlayOptions[] = [];
  for (let ty = Math.floor(y / T); ty <= Math.floor((y + h - 1) / T); ty++)
    for (let tx = Math.floor(x / T); tx <= Math.floor((x + w - 1) / T); tx++) {
      const buf = await load(tx, ty);
      if (!buf) continue;
      const left = tx * T - x, top = ty * T - y;
      const sx = Math.max(0, -left), sy = Math.max(0, -top);
      const width = Math.min(T - sx, w - Math.max(0, left)), height = Math.min(T - sy, h - Math.max(0, top));
      comps.push({ input: await sharp(buf).extract({ left: sx, top: sy, width, height }).toBuffer(), left: Math.max(0, left), top: Math.max(0, top) });
    }
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).composite(comps);
}

/** Height pass as a grayscale structure image: black = ground, white = 60 m above `ground`. */
async function heightTile(tx: number, ty: number, ground: number): Promise<Buffer | null> {
  const f = join(base, "height", `${tx}_${ty}.png`);
  if (!existsSync(f)) return null;
  const h = await readHeights(f);
  const g = Buffer.alloc(h.length);
  for (let i = 0; i < h.length; i++) g[i] = Number.isNaN(h[i]) ? 0 : Math.max(0, Math.min(255, Math.sqrt(Math.max(0, h[i] - ground) / 60) * 255));
  return sharp(g, { raw: { width: 256, height: 256, channels: 1 } }).resize(T, T, { kernel: "cubic" }).png().toBuffer();
}

/** Local ground level of a window: low percentile of all surface heights it covers. */
async function windowGround(x: number, y: number) {
  const all: number[] = [];
  for (let ty = Math.floor(y / T); ty <= Math.floor((y + WIN - 1) / T); ty++)
    for (let tx = Math.floor(x / T); tx <= Math.floor((x + WIN - 1) / T); tx++) {
      const f = join(base, "height", `${tx}_${ty}.png`);
      if (existsSync(f)) for (const v of await readHeights(f)) if (!Number.isNaN(v) && v > seaH() - 0.5) all.push(v);
    }
  all.sort((a, b) => a - b);
  return all[Math.floor(all.length * 0.05)] ?? seaH();
}

function windows(): Array<[number, number]> {
  const out = new Set<string>();
  for (const k of tileSet) {
    const [tx, ty] = k.split("_").map(Number);
    for (let j = Math.floor((ty * T - WIN) / STRIDE) + 1; j * STRIDE < (ty + 1) * T; j++)
      for (let i = Math.floor((tx * T - WIN) / STRIDE) + 1; i * STRIDE < (tx + 1) * T; i++)
        out.add(`${i}_${j}`);
  }
  return [...out].map((s) => s.split("_").map(Number) as [number, number]);
}

async function composeInput(i: number, j: number, file: string, heightFile: string) {
  const ground = await windowGround(i * STRIDE, j * STRIDE);
  await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN, (tx, ty) => heightTile(tx, ty, ground))).png().toFile(heightFile);
  // lift baked photogrammetry shadows so footprints and streets read clearly
  const lifted = await sharp(await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN)).png().toBuffer())
    .removeAlpha().clahe({ width: 128, height: 128, maxSlope: 2 }).modulate({ saturation: 1.1 }).png().toBuffer();
  const img = sharp(lifted);
  const comps: OverlayOptions[] = [];
  const edges: string[] = [];
  // already-painted neighbours on any side: paste their overlap strip so this window continues them
  const sides: Array<[string, number, number, { left: number; top: number; width: number; height: number }, number, number]> = [
    ["left", i - 1, j, { left: STRIDE, top: 0, width: OVERLAP, height: WIN }, 0, 0],
    ["right", i + 1, j, { left: 0, top: 0, width: OVERLAP, height: WIN }, STRIDE, 0],
    ["top", i, j - 1, { left: 0, top: STRIDE, width: WIN, height: OVERLAP }, 0, 0],
    ["bottom", i, j + 1, { left: 0, top: 0, width: WIN, height: OVERLAP }, 0, STRIDE],
  ];
  for (const [side, ni, nj, box, left, top] of sides) {
    if (!current(ni, nj)) continue; // old-style neighbours are being repainted too: don't continue them
    comps.push({ input: await sharp(winFile(ni, nj)).resize(WIN, WIN).extract(box).toBuffer(), left, top });
    edges.push(side);
  }
  await sharp(await img.png().toBuffer()).composite(comps).png().toFile(file);
  return edges;
}

/** Codex/ChatGPT usage or rate limit: every worker pauses until `resumeAt`, then retries. */
let resumeAt = 0, backoff = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIMIT = /usage limit|rate.?limit|too many requests|\b429\b|quota/i;

/** How long a limit message asks us to wait (ms); falls back to exponential backoff 5 → 60 min. */
function limitWait(log: string) {
  const at = log.match(/try again at ([0-9]{1,2}:[0-9]{2}\s*(?:[AP]M)?)/i);
  if (at) {
    const [, t] = at, [h, m] = t.match(/\d+/g)!.map(Number), pm = /pm/i.test(t), am = /am/i.test(t);
    const d = new Date();
    d.setHours(pm && h < 12 ? h + 12 : am && h === 12 ? 0 : h, m, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime() - Date.now() + 60_000;
  }
  const inMin = log.match(/try again in (\d+)\s*(second|minute|hour)/i);
  if (inMin) return Number(inMin[1]) * ({ second: 1e3, minute: 6e4, hour: 36e5 } as Record<string, number>)[inMin[2].toLowerCase()] + 30_000;
  backoff = Math.min(60, backoff ? backoff * 2 : 5);
  return backoff * 60_000;
}

function codex(cwd: string, prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const log = openSync(join(cwd, "codex.log"), "w");
    const p = spawn("codex", ["exec", "--skip-git-repo-check", "-s", "workspace-write", ...MODEL, "-C", cwd, "-i", "input.png", "-i", "height.png", "-i", "style.png", "-i", "trees.png", "-"],
      { stdio: ["pipe", log, log] });
    const timer = setTimeout(() => p.kill("SIGTERM"), 900_000);
    p.on("close", () => { clearTimeout(timer); closeSync(log); resolve(); });
    p.stdin!.end(prompt);
  });
}

/** Share of a window's surface at sea level (from the height pass). */
async function seaFraction(i: number, j: number) {
  let wet = 0, n = 0;
  for (let y = j * STRIDE; y < j * STRIDE + WIN; y += 32)
    for (let x = i * STRIDE; x < i * STRIDE + WIN; x += 32) {
      const tx = Math.floor(x / T), ty = Math.floor(y / T), f = join(base, "height", `${tx}_${ty}.png`);
      if (!existsSync(f)) continue;
      const h = (await readHeights(f))[Math.floor((y - ty * T) / 4) * 256 + Math.floor((x - tx * T) / 4)];
      n++;
      if (h <= seaH() + 0.3) wet++;
    }
  return n ? wet / n : 0;
}

/** Mean brightness of each cell of an 8×8 grid (catches black bands or patches a mean over the image hides). */
async function cells(file: string | Buffer) {
  const d = await sharp(file).removeAlpha().resize(8, 8, { fit: "fill" }).raw().toBuffer();
  return Array.from({ length: 64 }, (_, k) => (d[k * 3] + d[k * 3 + 1] + d[k * 3 + 2]) / 3);
}

/** Codex sometimes returns black bands or near-black images: any cell much darker than the render. */
async function hasDarkPatch(out: string | Buffer, input: string | Buffer) {
  const [o, n] = [await cells(out), await cells(input)];
  return o.some((v, k) => v < 40 && v < 0.5 * n[k]);
}

/** Blue everywhere and not dark (checked per cell). */
async function looksLikeSea(file: string) {
  const d = await sharp(file).removeAlpha().resize(8, 8, { fit: "fill" }).raw().toBuffer();
  for (let k = 0; k < 64; k++) if (d[k * 3 + 2] < 80 || d[k * 3 + 2] < d[k * 3] + 25) return false;
  return true;
}

/** Delete finished windows with a black band or patch the render doesn't have, so they get repainted. */
async function dropDarkWindows(wins: Array<[number, number]>) {
  let n = 0;
  for (const [i, j] of wins) {
    if (!existsSync(winFile(i, j))) continue;
    const render = await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN)).png().toBuffer();
    if (await hasDarkPatch(winFile(i, j), render)) { rmSync(winFile(i, j)); n++; console.warn(`  ${i}_${j}: black patch, will repaint`); }
  }
  if (n) console.log(`  dropped ${n} windows with black patches`);
}

async function paintWindow(i: number, j: number) {
  if (existsSync(winFile(i, j)) && !args.force && !(OLDER && !current(i, j))) return;
  // open sea: reuse the painted sea texture (mirrored per window so repeats don't line up)
  if (existsSync(SEA) && (await seaFraction(i, j)) >= 0.995) {
    let img = sharp(SEA).resize(WIN, WIN);
    if ((i + j) & 1) img = img.flop();
    if (j & 1) img = img.flip();
    await writeAtomic(img.png(), winFile(i, j));
    console.log(`  ${i}_${j}: sea texture`);
    return;
  }
  const work = join(base, "work", `${i}_${j}`);
  mkdirSync(work, { recursive: true });
  const edges = await composeInput(i, j, join(work, "input.png"), join(work, "height.png"));
  copyFileSync(STYLE, join(work, "style.png"));
  copyFileSync(TREES, join(work, "trees.png"));
  const prompt = PROMPT.replace("{title}", title).replace("{out}", join(work, "out.png"))
    .replace("{continuation}", edges.length ? CONTINUATION.replace("{edges}", edges.join(" and ")) : "");
  for (let attempt = 1; attempt <= 3; attempt++) {
    while (Date.now() < resumeAt) await sleep(Math.min(60_000, resumeAt - Date.now()));
    rmSync(join(work, "out.png"), { force: true });
    const t0 = Date.now();
    await codex(work, prompt);
    if (!existsSync(join(work, "out.png"))) {
      const log = readFileSync(join(work, "codex.log"), "utf8").slice(-4000);
      if (LIMIT.test(log)) {
        const wait = limitWait(log);
        resumeAt = Math.max(resumeAt, Date.now() + wait);
        console.warn(`  ${i}_${j}: Codex limit reached, pausing all workers until ${new Date(resumeAt).toLocaleTimeString()}`);
        attempt--; // a limit is not the window's fault: retry without using up an attempt
        continue;
      }
    } else backoff = 0;
    if (existsSync(join(work, "out.png"))) {
      // geometric QA: undo any shift/scale drift; repaint if the output doesn't follow the render
      const r = await register(join(work, "input.png"), join(work, "out.png"));
      writeFileSync(join(work, "qa.json"), JSON.stringify(r));
      if ((await hasDarkPatch(join(work, "out.png"), join(work, "input.png"))) && attempt < 3) {
        console.warn(`  ${i}_${j}: black band or patch in the paint, repainting`);
        continue;
      }
      const structured = r.texture >= MIN_TEXTURE; // open sea / empty land: correlation is meaningless
      if (structured && r.score < MIN_MATCH && attempt < 3) {
        console.warn(`  ${i}_${j}: match ${r.score.toFixed(2)} < ${MIN_MATCH}, repainting`);
        continue;
      }
      const warp = structured && r.score > r.identity + 0.01;
      await applyRegistration(join(work, "out.png"), winFile(i, j), warp ? r : { ...r, scale: 1, dx: 0, dy: 0 });
      console.log(`  ${i}_${j}: ${((Date.now() - t0) / 1000).toFixed(0)}s edges=${edges.join("+") || "-"} match=${r.score.toFixed(2)}`
        + (structured ? "" : " (low texture)") + (warp ? ` shift=(${r.dx},${r.dy}) scale=${r.scale.toFixed(2)}` : ""));
      // keep qa.json + codex.log for debugging; the images are ~6 MB per window
      for (const f of ["input.png", "height.png", "style.png", "trees.png", "out.png"]) rmSync(join(work, f), { force: true });
      return;
    }
    console.error(`  ${i}_${j}: attempt ${attempt} failed, see ${join(work, "codex.log")}`);
  }
}

/** Feather-blend painted windows into 1024 art tiles; only tiles fully covered are written. */
// ---- sea colour harmonisation -------------------------------------------------------------------
// Codex paints open water in slightly different blues per window, which shows as window-sized
// rectangles. In each window, deep water (sea level, far from land) is shifted to the median
// deep-water colour of all windows, fading in from the shore so surf and harbours keep their colours.
const CELL = 8, PAD = 256, NEAR = 12, FULL = 28; // 8 px cells; fade from 12 to 28 cells (24 → 56 m) off the coast
const heightCache = new Map<string, Float32Array | null>();
async function heightAt(x: number, y: number) {
  const tx = Math.floor(x / T), ty = Math.floor(y / T), k = `${tx}_${ty}`;
  if (!heightCache.has(k)) {
    const f = join(base, "height", `${k}.png`);
    heightCache.set(k, existsSync(f) ? await readHeights(f) : null);
  }
  const h = heightCache.get(k);
  return h ? h[Math.floor((y - ty * T) / 4) * 256 + Math.floor((x - tx * T) / 4)] : NaN;
}

/** Per window cell (WIN/CELL)²: 0 on land or near the coast → 1 in open water. Null if no open water. */
async function deepWater(i: number, j: number) {
  const n = (WIN + 2 * PAD) / CELL, x0 = i * STRIDE - PAD, y0 = j * STRIDE - PAD;
  const d = new Float32Array(n * n);
  let any = false;
  for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) {
    const h = await heightAt(x0 + cx * CELL + CELL / 2, y0 + cy * CELL + CELL / 2);
    const land = !Number.isNaN(h) && h > seaH() + 0.3;
    d[cy * n + cx] = land ? 0 : 1e9;
    if (!land && !Number.isNaN(h)) any = true;
  }
  if (!any) return null;
  // chamfer distance to land, in cells
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = d[y * n + x];
    if (x) v = Math.min(v, d[y * n + x - 1] + 1);
    if (y) v = Math.min(v, d[(y - 1) * n + x] + 1);
    if (x && y) v = Math.min(v, d[(y - 1) * n + x - 1] + 1.414);
    if (y && x < n - 1) v = Math.min(v, d[(y - 1) * n + x + 1] + 1.414);
    d[y * n + x] = v;
  }
  for (let y = n - 1; y >= 0; y--) for (let x = n - 1; x >= 0; x--) {
    let v = d[y * n + x];
    if (x < n - 1) v = Math.min(v, d[y * n + x + 1] + 1);
    if (y < n - 1) v = Math.min(v, d[(y + 1) * n + x] + 1);
    if (x < n - 1 && y < n - 1) v = Math.min(v, d[(y + 1) * n + x + 1] + 1.414);
    if (y < n - 1 && x) v = Math.min(v, d[(y + 1) * n + x - 1] + 1.414);
    d[y * n + x] = v;
  }
  const m = WIN / CELL, w = new Float32Array(m * m), p = PAD / CELL;
  let deep = 0;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const h = await heightAt(i * STRIDE + x * CELL + CELL / 2, j * STRIDE + y * CELL + CELL / 2);
    if (Number.isNaN(h)) continue;
    const v = Math.min(1, Math.max(0, (d[(y + p) * n + x + p] - NEAR) / (FULL - NEAR)));
    w[y * m + x] = v;
    if (v >= 1) deep++;
  }
  return deep >= 64 ? w : null;
}

/** window -> [cell weights, RGB offset to the reference deep-water colour] */
const seaFix = new Map<string, [Float32Array, number[]]>();
async function harmoniseSea() {
  const means: Array<[string, Float32Array, number[]]> = [];
  for (const [i, j] of windows()) {
    if (!existsSync(winFile(i, j))) continue;
    const w = await deepWater(i, j);
    if (!w) continue;
    const m = WIN / CELL, px = await sharp(winFile(i, j)).removeAlpha().resize(m, m, { kernel: "cubic" }).raw().toBuffer();
    const sum = [0, 0, 0];
    let n = 0;
    for (let k = 0; k < m * m; k++) if (w[k] >= 1) { for (let c = 0; c < 3; c++) sum[c] += px[k * 3 + c]; n++; }
    means.push([`${i}_${j}`, w, sum.map((v) => v / n)]);
  }
  const ref = [0, 1, 2].map((c) => means.map((m) => m[2][c]).sort((a, b) => a - b)[Math.floor(means.length / 2)]);
  for (const [k, w, mean] of means) seaFix.set(k, [w, mean.map((v, c) => ref[c] - v)]);
  console.log(`  sea: ${means.length} windows with open water, reference rgb(${ref.map(Math.round).join(",")})`);
}

async function assemble(all = false) {
  const ramp = new Float32Array(WIN);
  // 0 → 1 across a FEATHER-wide band centred in the overlap (complementary for neighbours)
  const edge = (k: number) => Math.min(1, Math.max(0, (k + 0.5 - (OVERLAP - FEATHER) / 2) / FEATHER));
  for (let k = 0; k < WIN; k++) ramp[k] = Math.min(edge(k), edge(WIN - 1 - k));
  mkdirSync(join(base, "paint"), { recursive: true });
  let written = 0;
  for (const k of tileSet) {
    const [tx, ty] = k.split("_").map(Number);
    const covering: Array<[number, number]> = [];
    for (let j = Math.floor((ty * T - WIN) / STRIDE) + 1; j * STRIDE < (ty + 1) * T; j++)
      for (let i = Math.floor((tx * T - WIN) / STRIDE) + 1; i * STRIDE < (tx + 1) * T; i++) covering.push([i, j]);
    if (!covering.every(([i, j]) => existsSync(winFile(i, j)))) continue;
    const tile = join(base, "paint", `${tx}_${ty}.png`);
    // rebuilt when any covering window was repainted since
    if (existsSync(tile) && !args.force && !all && covering.every(([i, j]) => mtime(winFile(i, j)) <= mtime(tile))) continue;
    const acc = new Float32Array(T * T * 3), wsum = new Float32Array(T * T);
    for (const [i, j] of covering) {
      const px = await sharp(winFile(i, j)).resize(WIN, WIN).removeAlpha().raw().toBuffer();
      const fix = seaFix.get(`${i}_${j}`);
      if (fix) { // bilinear cell weights × colour offset
        const [w, off] = fix, m = WIN / CELL;
        for (let y = 0; y < WIN; y++) {
          const fy = Math.min(m - 1, Math.max(0, (y + 0.5) / CELL - 0.5)), y0 = Math.floor(fy), y1 = Math.min(m - 1, y0 + 1), ay = fy - y0;
          for (let x = 0; x < WIN; x++) {
            const fx = Math.min(m - 1, Math.max(0, (x + 0.5) / CELL - 0.5)), x0 = Math.floor(fx), x1 = Math.min(m - 1, x0 + 1), ax = fx - x0;
            const a = (w[y0 * m + x0] * (1 - ax) + w[y0 * m + x1] * ax) * (1 - ay) + (w[y1 * m + x0] * (1 - ax) + w[y1 * m + x1] * ax) * ay;
            if (a <= 0) continue;
            const s = (y * WIN + x) * 3;
            for (let c = 0; c < 3; c++) px[s + c] = Math.max(0, Math.min(255, px[s + c] + off[c] * a));
          }
        }
      }
      const ox = i * STRIDE - tx * T, oy = j * STRIDE - ty * T;
      for (let y = Math.max(0, oy); y < Math.min(T, oy + WIN); y++)
        for (let x = Math.max(0, ox); x < Math.min(T, ox + WIN); x++) {
          const wx = x - ox, wy = y - oy, w = ramp[wx] * ramp[wy], s = (wy * WIN + wx) * 3, d = y * T + x;
          acc[d * 3] += px[s] * w; acc[d * 3 + 1] += px[s + 1] * w; acc[d * 3 + 2] += px[s + 2] * w;
          wsum[d] += w;
        }
    }
    const out = Buffer.alloc(T * T * 3);
    for (let d = 0; d < T * T; d++) for (let c = 0; c < 3; c++) out[d * 3 + c] = acc[d * 3 + c] / Math.max(wsum[d], 1e-6);
    await writeAtomic(sharp(out, { raw: { width: T, height: T, channels: 3 } }).png(), join(base, "paint", `${tx}_${ty}.png`));
    written++;
  }
  console.log(`  assembled ${written} art tiles`);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()!); }));
}

async function main() {
  let wins = windows();
  if (args.near) {
    const [lat, lon] = args.near.split(",").map(Number);
    const [x, y] = llhToPixel(lat, lon, 25);
    const ci = Math.floor(x / STRIDE), cj = Math.floor(y / STRIDE), r = Number(args.radius);
    wins = wins.filter(([i, j]) => Math.abs(i - ci) <= r && Math.abs(j - cj) <= r);
  }
  if (args.window) wins = [args.window.split(",").map(Number) as [number, number]];
  if (OLDER) { // only land windows (sea-texture windows have no trees) painted before the cut-off
    const old: Array<[number, number]> = [];
    for (const [i, j] of wins) if (existsSync(winFile(i, j)) && !current(i, j) && !(await looksLikeSea(winFile(i, j)))) old.push([i, j]);
    wins = old;
  }
  if (args.plan) return console.log(`${wins.length} windows`);
  if (args.assemble) { await harmoniseSea(); return assemble(true); }
  // centre first: square rings around the city centre. Each ring runs in two passes over its
  // perimeter (even, then odd positions) so every window continues its painted inner/ring neighbours.
  const [s0, w0, n0, e0] = openArea(areaName).bbox;
  const center = args.center ?? (areaName === "tlv-core" || areaName === "rothschild" ? "32.0715,34.7745" : `${(s0 + n0) / 2},${(w0 + e0) / 2}`);
  const [cx, cy] = center.split(",").map(Number);
  const [px, py] = llhToPixel(cx, cy, groundH());
  const ci = Math.floor(px / STRIDE), cj = Math.floor(py / STRIDE);
  const have = new Set(wins.map(([i, j]) => `${i}_${j}`));
  const maxR = Math.max(...wins.map(([i, j]) => Math.max(Math.abs(i - ci), Math.abs(j - cj))));
  console.log(`${wins.length} windows in ${maxR + 1} rings around ${ci}_${cj}`);
  // first: paint one open-sea window and keep it as the reusable sea texture
  // (validated: a bad paint would otherwise be stamped over every open-sea window)
  // a bad sea texture (or windows painted with black bands) never survives a restart: drop and redo them
  if (existsSync(SEA) && !(await looksLikeSea(SEA))) { console.warn("  sea texture is bad, repainting it"); rmSync(SEA); }
  if (!args.window && !OLDER) await dropDarkWindows(wins);
  if (!existsSync(SEA) && !args.window && !OLDER) {
    const open = [];
    for (const [i, j] of windows()) if ((await seaFraction(i, j)) >= 0.995) open.push([i, j]);
    for (const [i, j] of open.slice(0, 3)) {
      rmSync(winFile(i, j), { force: true });
      await paintWindow(i, j);
      if (existsSync(winFile(i, j)) && (await looksLikeSea(winFile(i, j)))) {
        copyFileSync(winFile(i, j), SEA);
        console.log(`  sea texture from ${i}_${j}`);
        break;
      }
      console.warn(`  ${i}_${j}: painted sea doesn't look like sea, trying another window`);
      rmSync(winFile(i, j), { force: true });
    }
  }
  for (let r = 0; r <= maxR; r++) {
    const ring: Array<[number, number]> = [];
    if (r === 0) ring.push([ci, cj]);
    else {
      for (let k = 0; k < 2 * r; k++) ring.push([ci - r + k, cj - r]);  // top, left → right
      for (let k = 0; k < 2 * r; k++) ring.push([ci + r, cj - r + k]);  // right, top → bottom
      for (let k = 0; k < 2 * r; k++) ring.push([ci + r - k, cj + r]);  // bottom, right → left
      for (let k = 0; k < 2 * r; k++) ring.push([ci - r, cj + r - k]);  // left, bottom → top
    }
    for (const pass of [0, 1]) {
      const todo = ring.filter(([i, j], k) => k % 2 === pass && have.has(`${i}_${j}`));
      await pool(todo, Number(args.j), ([i, j]) => paintWindow(i, j));
    }
    await assemble(); // finished tiles become visible ring by ring
  }
  await harmoniseSea(); // then every tile with open water is rebuilt with the harmonised sea
  await assemble(!args.window);
  writeFileSync(join(base, "paint.json"), JSON.stringify({ updated: new Date().toISOString() }));
}

main();
