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
 *   npm run paint -- tlv-core --parts                           # windows over the buildings scene.ts gave OSM 3D shapes
 *   npm run paint -- tlv-core --window=-1,-2 --model=<codex model> --effort=low
 * (--model / --effort: the Codex model that drives the image tool, when the one in ~/.codex/config.toml isn't
 * available to the logged-in ChatGPT account; negative window or centre values need the `=` form)
 */
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp, { type OverlayOptions } from "sharp";
import { AREAS, openArea } from "./areas.ts";
import { CAMERA, llhToPixel } from "./camera.ts";
import { DERIVED, PIPELINE, readJson, writeAtomic } from "./paths.ts";
import { groundPixel, seaH, readHeights } from "./heights.ts";
import { areaPois } from "./pois.ts";
import { applyRegistration, register } from "./register.ts";
import { codex } from "./codex.ts";

const WIN = 1024, OVERLAP = 128, STRIDE = WIN - OVERLAP, T = CAMERA.tile;
/** Blend band in the middle of each overlap; outside it a window's own pixels win outright. */
const FEATHER = 64;
const STYLE = join(PIPELINE, "style", "reference.png");
/** --look simple: a crop of the procedural Stuttgart render (flat fills, outlines, low-poly trees). */
const STYLE_SIMPLE = join(PIPELINE, "style", "reference-simple.png");
const TREES = join(PIPELINE, "style", "trees.png"); // species sheet (painted once with Codex)
const SEA = join(PIPELINE, "style", "sea.png");
/** Minimum edge-map correlation between render and painted window (pilot range 0.58–0.90). */
const MIN_MATCH = 0.45;
/** Below this share of strong edges in the render (sea, sand, empty lots) the match check is skipped. */
const MIN_TEXTURE = 0.05;

const PROMPT = `Use your image generation tool. {count} images are attached:
1. input.png: an orthographic aerial render (camera tilted 45° down, no perspective) of a simple 3D model \
of {title}, {country}, built from map data. ~256 m across. {render}
2. height.png: the height map from the SAME camera, pixel-aligned with image 1. Black = ground \
(streets, squares, sea), grey→white = buildings and trees, brighter = taller. Use it to find exact \
building footprints, edges and heights; open black areas are streets/plazas, not trees.
3. style.png: the STYLE REFERENCE.
4. trees.png: what each tree species looks like ({treesOf} street and park trees), in the same style.
{aerialImage}
{style}

Geometry comes ONLY from images 1 and 2 — this is a tracing job:
- Same orthographic camera, framing and scale: the output overlays image 1 pixel-for-pixel.
- Every building keeps its exact footprint, position, height and roof outline. {materials} \
Do not add, remove, merge or move buildings or trees; do not invent trees over open streets.
- {ground} stay exactly where they are; {groundLook}.
- Layering is exactly as in image 1: where a road bridge crosses rail tracks, a river or another road, the \
bridge deck is continuous and on top, and whatever passes underneath is hidden beneath it — never draw \
rails or lane markings across a bridge deck.
- Image 3 is only for style. Do not copy its buildings, layout or architecture.
{aerialRule}{facades}{continuation}Output: one square 1024x1024 image, no text, no labels, no border, no vignette.

When done, copy the final PNG to {out} and reply only with that path.
`;
const PAINTED_STYLE = `Redraw image 1 as detailed isometric pixel-art-style city illustration in EXACTLY the style of image 3: \
clean crisp 3D blocks with straight vertical walls, every facade drawn with regular window grids and \
balconies, flat roofs with rooftop details, saturated but natural colours, realistic varied trees \
drawn as the species of image 4 seen from above{treeHint}, smooth grey asphalt with lane markings, clean pavements, soft even daylight, light ambient \
occlusion, no long shadows, no haze, no photographic noise.`;
const PAINTED_GROUND = `give them real texture \
(pale grey/cream stone paving — not orange or terracotta —, crosswalks at junctions, grass, sand, water ripples, parked cars along kerbs only, \
no cars in the driving lanes)`;
/**
 * --look simple: readable at every zoom. Painted detail turned to noise up close (and cost twice the bytes)
 * and to mush zoomed out; the procedural look's flat fills and outlines survive both.
 */
const SIMPLE_STYLE = `Redraw image 1 as a clean, SIMPLE isometric city illustration in EXACTLY the style of image 3: \
flat-shaded 3D blocks with straight vertical walls and a thin dark outline along every building and roof edge, \
each surface ONE flat colour with at most a soft gradient, facades as simple even window grids, \
tree crowns as LOW-POLY FACETED balls with a dark outline and a soft round shadow on the ground (shaped like the \
trees in image 3, coloured like the species of image 4), smooth flat asphalt with crisp white markings, soft even \
daylight, light ambient occlusion. Few large, clearly separated shapes: it must read clearly when shown small. \
NO fine texture: no gravel or grass speckle, no plant noise on green roofs (flat green), no roof clutter, \
no photographic noise, haze, blur or long shadows.`;
const SIMPLE_GROUND = `draw each as one clean flat colour \
(pale grey/cream paving, flat green lawns, flat grey asphalt with crisp white markings, blue water) with only the \
markings that matter (lanes, crosswalks, aircraft stand and taxiway lines). No vehicles in driving lanes, \
no aircraft anywhere (the map animates traffic and planes); parked cars only in car parks`;

/** What differs per region in the prompt (and the tree species sheet). */
interface Local {
  ground: string; country: string; render: string; treesOf: string; treeHint: string; materials: string; trees: string;
  /**
   * Optional second style reference: the house style of image 3 applied to this region's architecture. Attached as
   * the last image; regions without it get exactly the prompt and inputs they had before.
   */
  styleLocal?: string;
  /**
   * Refuse paintings with invented roofs or far busier than the render (inventedRoofs, inventedStructure), and
   * leave the window unpainted after 3 tries. Thresholds tuned on Zagreb's render; other regions opt in after
   * checking them on their own paintings.
   */
  inventionChecks?: boolean;
}
const LOCAL: Record<string, Local> = {
  "israel-center": {
    ground: "Streets, squares, parks, beach and sea",
    country: "Israel",
    render: `The layout is exact; the colours are flat \
placeholders (grey = asphalt with lane markings, pale = pavement/plaza, green = grass/park, sand = beach, \
blue = water, brown dashes = rail, terracotta = bike path) and the window patterns are schematic hints. \
Tree crowns are colour-coded by species (see image 4): dark green = ficus, light green = tipuana, \
lilac = jacaranda in bloom, red-orange = flame tree, grey-green = olive, dark teal = Aleppo pine, \
blue-green tall = eucalyptus, small crown on a thin brown trunk = date palm (shorter) or Washingtonia fan palm (taller).`,
    treesOf: "Tel Aviv",
    treeHint: " (palms as star-shaped frond crowns with a visible trunk)",
    materials: `Draw believable Tel Aviv \
materials: white/cream plaster Bauhaus blocks with rounded balconies, stone public buildings, glass towers, \
real window grids, balconies, shutters, rooftop solar heaters and AC units. Tall towers stay tall.`,
    trees: TREES,
  },
  stuttgart: {
    ground: "Streets, squares, parks, vineyards, rail yards, airport aprons and the river",
    country: "Germany",
    render: `The layout and every roof shape are exact (real \
pitched, hipped and flat roofs from the city's 3D building data); the colours and window patterns are stylised hints \
(grey = asphalt with lane markings, pale = pavement/plaza, green = grass/park, olive with fine stripes = vineyard, \
blue = water, brown lines = rail, terracotta = bike path). Tree crowns are colour-coded by species (see image 4): \
yellow-green = plane tree, lime or maple, dark green = horse chestnut, oak or beech, pale yellow-green small = birch, \
pink = ornamental cherry in bloom, dark blue-green narrow = spruce.`,
    treesOf: "Stuttgart",
    treeHint: " (broad rounded deciduous crowns in late-spring green, spruces as narrow dark cones)",
    materials: `Draw believable Stuttgart \
materials: yellow-beige and red sandstone (Schlossplatz palaces, churches, public buildings), pale plaster \
Gründerzeit and post-war blocks, red and brown clay-tile pitched roofs, grey slate, green copper on churches and \
palaces, glass and concrete offices, dormers, chimneys, real window grids, solar panels where the render shows them. \
Tall towers stay tall.`,
    trees: join(PIPELINE, "style", "trees-stuttgart.png"),
  },
  zagreb: {
    ground: "Streets, squares, the market, parks and tram tracks",
    country: "Croatia",
    render: `The layout and every roof shape are exact (real \
pitched, hipped and flat roofs from the city's 3D building data); the colours and window patterns are a stylised draft \
of the real ones (ochre, yellow, cream and pastel plaster, red-brown tile, green copper). Grey = asphalt, pale = \
pavement/plaza, green = grass/park, brown lines = tram tracks, the rows of red discs = the red market umbrellas of Dolac. \
Tree crowns are round deciduous crowns.`,
    treesOf: "Zagreb",
    treeHint: " (broad rounded deciduous crowns: plane trees, horse chestnuts, limes, in summer green)",
    materials: `Draw believable Zagreb \
materials: Austro-Hungarian blocks in ochre, Maria-Theresa yellow, cream, salmon and pastel plaster with cornices and \
tall windows, red and brown clay-tile roofs with dormers and chimneys, green copper on churches and public buildings. \
Keep every building's colour from image 1, and draw a church, tower or market only where image 1 shows one. Woods, \
parks, fields and water stay exactly that: never add buildings, streets or squares where image 1 shows trees, grass or \
water. Tall towers stay tall. Draw no trains, trams or buses anywhere (they are animated on top of the map): leave rail \
and tram tracks empty.`,
    trees: join(PIPELINE, "style", "trees-stuttgart.png"),
    inventionChecks: true,
  },
  // Kraków and Wieliczka (one region): painted like Tel Aviv and Zagreb. The house style is image 3, the Polish building
  // character comes from styleLocal; named buildings go to FACADES or landmarks, never here.
  wieliczka: {
    ground: "Streets, squares, parks, the river and its boulevards, fields, rail, tram tracks and streams",
    country: "Poland",
    render: `The layout and every roof shape are exact (real \
pitched, hipped and flat roofs from Poland's national 3D building models) and the roof colours come from the aerial \
photo; the walls' colours and window patterns are stylised hints (grey = asphalt with lane markings, pale = pavement/plaza, \
green = grass/park, beige-yellow = fields, blue = water, brown lines = rail and tram tracks). Tree crowns are rounded \
deciduous crowns and dark narrow cones (spruce, pine), as in image 4.`,
    treesOf: "Kraków",
    treeHint: " (broad rounded deciduous crowns in early-summer green, spruces and pines as narrow dark cones)",
    materials: `Draw believable Kraków \
and Lesser Poland materials: historic tenement houses (kamienice) in cream, ochre, salmon, pale yellow and grey plaster with \
cornices, tall windows and red clay-tile roofs with dormers around courtyards; older districts mixing exposed red brick and \
plaster; Gothic churches in dark red brick with steep red tile or green copper roofs; 19th-century Austrian-era public \
buildings and villas in plaster and stone; interwar modernist blocks with plain pale walls and flat roofs; 1960s–80s \
prefabricated concrete blocks of flats in grey and pastel with long window bands and flat roofs; 1950s socialist-realist \
blocks in warm grey and beige with heavy cornices and arcades; small towns of plastered houses with red, brown or grey \
pitched roofs. Keep every building's colour and roof from image 1, and draw a church, tower or market only where image 1 \
shows one. Woods, parks, fields and water stay exactly that: never add buildings, streets or squares where image 1 shows \
trees, grass or water. Tall towers stay tall. Draw no trains, trams or buses anywhere (they are animated on top of the \
map): leave rail and tram tracks empty.`,
    trees: join(PIPELINE, "style", "trees-stuttgart.png"),
  },
};

/** Optional image 5: a real orthophoto draped onto the same view (aerial.ts). */
const AERIAL_IMAGE = `5. aerial.png: a real aerial photo of the same place, draped onto the SAME camera view and pixel-aligned \
with image 1. Flat mid-grey areas are walls (the photo has no information there); black = nothing.
`;
const AERIAL_RULE = `- Image 5 is a guide for COLOURS AND MATERIALS of roofs and ground only: copy roof colours (clay tile, slate, \
copper, gravel, green roofs), solar panels, skylights, rooftop plant rooms, courtyard planting, paving colours and \
patterns, and where trees and lawns really are. Where it disagrees with images 1 and 2 about geometry \
(buildings, roof outlines, streets), images 1 and 2 win. Never copy its photographic look: no blur, haze, \
noise, photo shadows, smeared edges or tiny cars. Walls and facades come from image 1, drawn in the style of image 3.
`;

/** --ref: photos of what stands here (rides, tents…), for looks only. */
const REF_IMAGES = (from: number, n: number) => Array.from({ length: n }, (_, k) => `${from + k}. ref${k + 1}.png: a ground-level \
photo of the kind of objects that stand at this place (see the notes below). Use it ONLY for what those objects look like \
(shapes, colours, details), redrawn in the style of image 3. It says nothing about where anything stands, and never copy its \
photographic look.
`).join("");

/** Region's second style reference (Local.styleLocal): the local building character, in the house style. */
const STYLE_LOCAL_IMAGE = (n: number) => `${n}. style-local.png: a second STYLE REFERENCE showing the local architecture of \
{country}, drawn in the style of image 3.
`;
const STYLE_LOCAL_RULE = (n: number) => `- Take the rendering style (line, detail, colour, light) from image 3 and the local building \
character (roof shapes, materials, facade details, colours) from image ${n}. Like image 3, image ${n} is only a reference: \
never copy its buildings, layout or architecture into the painting.
`;

/** --aerial-input: roofs, ground and trees of image 1 are the draped orthophoto, walls the render. */
const HYBRID_RENDER = `Walls and facades come from the 3D model (exact \
geometry; their colours and window patterns are stylised hints). Streets, rail tracks, bridges, pedestrian \
squares, fountains and water are drawn from the map in flat clean colours: that is exact geometry. Everything \
else seen from above (roofs, courtyards, lawns, woods, tree crowns, car parks) is a REAL AERIAL PHOTO draped onto \
that model, so its colours and materials are true: green roofs, gravel roofs, solar panel arrays, skylights, \
rooftop plant rooms, paving, planting. The photo part is hazy and blurred and has photographic shadows, parked and moving cars and slightly \
ragged roof edges: none of that is wanted.`;
const HYBRID_RULE = `- Keep the real colours and materials of every roof and ground surface in image 1 (a green roof stays a \
green roof, a solar array stays a solar array in the same place, gravel stays gravel, lawns stay lawns) but redraw \
them crisply in the style of image 3, with clean straight roof edges from image 2. No photo shadows, haze, blur or \
noise; cars only parked along kerbs.
- The flat map-drawn streets, rail tracks, bridges, tunnel mouths, squares, fountains and water in image 1 are exact: \
keep every one where it is, at its width, with its kerbs, lanes, turning loops and outlines. Never move, narrow, \
straighten or redraw them to follow the photo, and never cover them with photo objects.
`;

/**
 * Facades the render can't know (no OSM colour/material, invisible from above): named in the prompt when the
 * building's footprint centre (OSM) falls inside the window.
 */
const FACADES: Array<{ region: string; name: string; lat: number; lon: number; facade: string }> = [
  {
    region: "stuttgart", name: "Stadtbibliothek am Mailänder Platz", lat: 48.79016, lon: 9.18312,
    facade: "a plain cube; all four facades are pale grey-white concrete with a strict grid of identical small square \
glass-block windows, no balconies, no colour",
  },
];

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
    // repaint the windows over the buildings scene.ts swapped for OSM 3D shapes (data/derived/<area>/osm-parts.json)
    parts: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    // repaint windows painted before this time (e.g. after a style change); runs alongside a normal paint
    older: { type: "string" },
    assemble: { type: "boolean", default: false }, // only rebuild every art tile from the windows
    j: { type: "string", default: "3" },
    model: { type: "string" },
    effort: { type: "string" },
    center: { type: "string", default: "32.0715,34.7745" }, // lat,lon painted first (Rothschild / Dizengoff / beach)
    // aerial source (aerial.ts): add its draped orthophoto as image 5 (colour/material guide)
    aerial: { type: "string" },
    // with --aerial: bake the orthophoto into image 1 (roofs/ground/trees) instead of attaching it as image 5
    "aerial-input": { type: "boolean", default: false },
    // coarse-to-fine: a low-res painting of a whole block (e.g. one Codex image of the Wasen) becomes image 1 of every
    // window, upscaled, so all windows refine ONE agreed layout instead of each inventing its own;
    // --guide-frame x,y,w,h = the global art-px box the guide image covers
    guide: { type: "string" },
    "guide-frame": { type: "string" },
    // experiments: windows/paint/work go to <dir>-<tag> (export only reads paint/)
    tag: { type: "string" },
    // painted (detailed, the Tel Aviv look) | simple (flat fills, outlines, low-poly trees; see SIMPLE_STYLE)
    look: { type: "string", default: "painted" },
    // extra prompt line for this run (cutouts: what the building at the window centre is and how it looks)
    hint: { type: "string" },
    // extra reference photos, comma-separated (public domain / CC0 only: their pixels reach the painting): what the
    // objects of this place look like (e.g. fairground rides), never where they stand
    ref: { type: "string" },
  },
});
const GUIDE = args.guide ? { file: args.guide, box: args["guide-frame"]!.split(",").map(Number) } : null;
if (GUIDE && (GUIDE.box.length !== 4 || !existsSync(GUIDE.file))) throw new Error("--guide <png> needs --guide-frame x,y,w,h");
const GUIDE_IMAGE = `1. input.png: a LOW-RESOLUTION PAINTING of this exact place, upscaled (so it looks soft and blurry): the APPROVED \
DESIGN of this area, orthographic camera tilted 45° down, ~256 m across. Redraw it SHARP at full resolution.
`;
const GUIDE_RULE = `- Image 1 is the approved layout: keep every tent, ride, stall row, path, tree and building exactly where and as \
large as it is in image 1; only make it crisp and detailed. Where image 2 (the ground before the event) disagrees with \
image 1, follow image 1.
`;
const REFS = args.ref ? args.ref.split(",").map((f) => f.trim()).filter(Boolean) : [];
for (const f of REFS) if (!existsSync(f)) throw new Error(`--ref: ${f} not found`);
const areaName = positionals[0] ?? "tlv-core";
const base = join(DERIVED, areaName);
const manifest = readJson(join(base, "manifest.json"));
const AREA = openArea(areaName), title = AREA.title;
const local = LOCAL[AREA.region];
if (!local) throw new Error(`paint: no prompt for region ${AREA.region} (LOCAL in paint.ts)`);
const OLDER = args.older ? new Date(args.older).getTime() : 0;
const mtime = (f: string) => (existsSync(f) ? statSync(f).mtimeMs : 0);
/** painted in the current style (with --older, windows painted before the cut-off don't count) */
const current = (i: number, j: number) => existsSync(winFile(i, j)) && mtime(winFile(i, j)) >= OLDER;
const tileSet = new Set<string>(manifest.tiles.map((t: any) => `${t.x}_${t.y}`));
const SUFFIX = args.tag ? `-${args.tag}` : "";
const winDir = join(base, `windows${SUFFIX}`);
mkdirSync(winDir, { recursive: true });

/** A render or height tile of this area, else of any other area of the region (all share the region's grid). */
const SIBLINGS = Object.entries(AREAS).filter(([n, a]) => a.region === AREA.region && n !== areaName).map(([n]) => join(DERIVED, n));
function regionFile(kind: "render" | "height", tx: number, ty: number) {
  const own = join(base, kind, `${tx}_${ty}.png`);
  if (existsSync(own)) return own;
  return SIBLINGS.map((d) => join(d, kind, `${tx}_${ty}.png`)).find((f) => existsSync(f)) ?? own;
}
const renderFile = (tx: number, ty: number) => regionFile("render", tx, ty);
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
  const f = regionFile("height", tx, ty);
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
      const f = regionFile("height", tx, ty);
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

const HYBRID = !!args.aerial && args["aerial-input"];
if (!["painted", "simple"].includes(args.look!)) throw new Error(`--look painted|simple (got ${args.look})`);
const SIMPLE = args.look === "simple";
/** Hybrid paintings follow the photo, not the render, so they correlate less with it (0.48-0.57 when right). */
const minMatch = HYBRID ? 0.35 : MIN_MATCH;
/** Render tile with the draped orthophoto on every surface that isn't a wall (aerial.ts marks walls 128 grey)
 *  or masked map geometry (aerial.ts mask/). */
async function hybridTile(tx: number, ty: number): Promise<Buffer | null> {
  if (!existsSync(renderFile(tx, ty))) return null;
  const af = join(base, `aerial-${args.aerial}`, `${tx}_${ty}.png`);
  if (!existsSync(af)) return sharp(renderFile(tx, ty)).png().toBuffer();
  const r = await sharp(renderFile(tx, ty)).removeAlpha().raw().toBuffer(), a = await sharp(af).removeAlpha().raw().toBuffer();
  // simple look: a median (2.25 m) flattens photo grain (gravel, cars, roof clutter) but keeps surface edges
  const flat = SIMPLE ? await sharp(af).removeAlpha().median(9).raw().toBuffer() : a;
  // data mask (aerial.ts): streets, rails, squares, water and bridge decks keep the render's exact OSM geometry
  const mf = join(base, "mask", `${tx}_${ty}.png`);
  const mask = existsSync(mf) ? await sharp(mf).extractChannel(0).raw().toBuffer() : null;
  for (let k = 0; k < a.length; k += 3) {
    const wall = a[k] === 128 && a[k + 1] === 128 && a[k + 2] === 128, none = !a[k] && !a[k + 1] && !a[k + 2];
    if (!wall && !none && !mask?.[k / 3]) { r[k] = flat[k]; r[k + 1] = flat[k + 1]; r[k + 2] = flat[k + 2]; }
  }
  return sharp(r, { raw: { width: T, height: T, channels: 3 } }).png().toBuffer();
}

async function composeInput(i: number, j: number, file: string, heightFile: string) {
  const ground = await windowGround(i * STRIDE, j * STRIDE);
  await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN, (tx, ty) => heightTile(tx, ty, ground))).png().toFile(heightFile);
  // lift baked photogrammetry shadows so footprints and streets read clearly
  // (not in the simple look: the contrast lift turns photo grain into texture the model copies)
  const crop = sharp(await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN, HYBRID ? hybridTile : undefined)).png().toBuffer()).removeAlpha();
  const lifted = await (SIMPLE ? crop : crop.clahe({ width: 128, height: 128, maxSlope: 2 }).modulate({ saturation: 1.1 })).png().toBuffer();
  let img = sharp(lifted);
  if (GUIDE) { // the guide's part of this window, upscaled to art px, over the render (outside the guide's box)
    const [gx, gy, gw, gh] = GUIDE.box, gm = await sharp(GUIDE.file).metadata(), s = gm.width! / gw;
    const x0 = Math.max(gx, i * STRIDE), y0 = Math.max(gy, j * STRIDE), x1 = Math.min(gx + gw, i * STRIDE + WIN), y1 = Math.min(gy + gh, j * STRIDE + WIN);
    if (x1 > x0 && y1 > y0) {
      const part = await sharp(GUIDE.file).removeAlpha()
        .extract({ left: Math.floor((x0 - gx) * s), top: Math.floor((y0 - gy) * s), width: Math.max(1, Math.round((x1 - x0) * s)), height: Math.max(1, Math.round((y1 - y0) * s)) })
        .resize(x1 - x0, y1 - y0, { kernel: "lanczos3", fit: "fill" }).png().toBuffer();
      img = sharp(await img.composite([{ input: part, left: x0 - i * STRIDE, top: y0 - j * STRIDE }]).png().toBuffer());
    }
  }
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
  const resets = log.match(/resets_in_seconds\\?":\s*(\d+)/); // image tool: JSON error with the exact reset
  if (resets) return Number(resets[1]) * 1000 + 60_000;
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

/**
 * Painter: the Codex CLI (ChatGPT plan, the default) or an image model through fal.ai (PAINT_BACKEND=fal: pay per
 * call, many windows at once). The bake-off on Zagreb (Nov 2026) picked openai/gpt-image-2.6/sunburst/edit at "high".
 * google/nano-banana-2.1/edit changes the layout least (a retouched render more than a painting, ~$0.03): Zagreb's
 * last windows, where gpt-image kept inventing buildings on fields and woods, were filled with it.
 * Every fal call's billed cost (x-fal-billable-units, USD) goes to paint-spend.jsonl; PAINT_BUDGET_USD stops new calls.
 */
const BACKEND = process.env.PAINT_BACKEND ?? "codex";
const FAL_ENDPOINT = process.env.PAINT_FAL_ENDPOINT ?? "openai/gpt-image-2.6/sunburst/edit";
const FAL_QUALITY = process.env.PAINT_QUALITY ?? "high";
/** Google's image models on fal (Nano Banana) take an aspect ratio and a resolution, not a size and a quality */
const GOOGLE = /nano-banana|gemini/.test(FAL_ENDPOINT);
const BUDGET = Number(process.env.PAINT_BUDGET_USD) || Infinity;
const SPEND = join(base, "paint-spend.jsonl");
const spendLog: Array<{ usd?: number }> = existsSync(SPEND) ? readFileSync(SPEND, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
let spent = spendLog.reduce((a, l) => a + (l.usd || 0), 0);
/** cost held back for calls in flight (-j workers call at once): the most one call has cost so far, $0.20 before any */
let reserved = 0, perCall = Math.max(0.2, ...spendLog.map((l) => l.usd || 0));
const overBudget = () => BACKEND === "fal" && spent + reserved + perCall > BUDGET;

/**
 * USD per billable unit of the endpoint (fal's pricing API): gpt-image-2.6 and Nano Banana 2.1 bill in dollar units,
 * Nano Banana Pro per image ($0.15). Unknown: 1 (the units are logged too, so the ledger can be corrected).
 */
let price: Promise<number> | undefined;
function unitPrice(): Promise<number> {
  price ??= fetch(`https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(FAL_ENDPOINT)}`,
    { headers: { Authorization: `Key ${process.env.FAL_KEY}` }, signal: AbortSignal.timeout(30_000) })
    .then((r) => r.json()).then((j: any) => Number(j.prices?.[0]?.unit_price) || 1).catch(() => 1);
  return price;
}

async function falPaint(cwd: string, prompt: string, id: string): Promise<void> {
  const log = join(cwd, "codex.log");
  if (overBudget()) { writeFileSync(log, `budget of $${BUDGET} reached`); return; }
  // the API gets the images directly: drop the Codex-only instructions (use the tool, copy the file)
  let text = prompt.replace(/^Use your image generation tool\. /, "").replace(/\s*When done, copy[\s\S]*$/, "").trim();
  // Google's models keep the render's own look unless told otherwise: paint like the painted edge strips
  if (GOOGLE && text.includes("ALREADY-PAINTED")) text += "\nRepaint ALL of image 1 in the exact style of its already-painted edge strips: the same small, "
    + "finely drawn tree crowns, the same light ground showing between them, the same colours and brightness. No part of the "
    + "result may keep the flat, chunky look of the 3D render: it must be impossible to tell where the strips end.";
  const uri = (f: string) => `data:image/png;base64,${readFileSync(join(cwd, f)).toString("base64")}`;
  let r: Response | undefined, j: any = {}, usd = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (overBudget()) { writeFileSync(log, `budget of $${BUDGET} reached`); return; }
    const hold = perCall;
    reserved += hold;
    try {
      r = await fetch(`https://fal.run/${FAL_ENDPOINT}`, {
        method: "POST", headers: { Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, image_urls: ["input.png", "height.png", "style.png", "trees.png", ...(local.styleLocal ? ["style-local.png"] : [])].map(uri),
          num_images: 1, output_format: "png",
          ...(GOOGLE ? { aspect_ratio: "1:1", resolution: "1K", ...(process.env.PAINT_THINKING ? { thinking_level: process.env.PAINT_THINKING } : {}) } : { image_size: { width: WIN, height: WIN }, quality: FAL_QUALITY }) }),
        signal: AbortSignal.timeout(600_000),
      });
      const units = Number(r.headers.get("x-fal-billable-units") ?? 0);
      usd = units * (await unitPrice());
      spent += usd;
      perCall = Math.max(perCall, usd);
      appendFileSync(SPEND, JSON.stringify({ window: id, usd, units, status: r.status, request: r.headers.get("x-fal-request-id"), at: new Date().toISOString() }) + "\n");
      j = await r.json().catch(() => ({}));
    } catch (err) { // no response: nothing billed, call again
      writeFileSync(log, String(err));
      r = undefined;
      await sleep(10_000 * attempt);
      continue;
    } finally {
      reserved -= hold;
    }
    if (r.status === 429 || r.status >= 500) { writeFileSync(log, JSON.stringify(j)); await sleep(20_000 * attempt); continue; }
    break;
  }
  if (!r || !r.ok || !j.images?.[0]?.url) { if (r) writeFileSync(log, JSON.stringify(j)); return; }
  // the image is paid for: retry only its download, never the generation
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const d = await fetch(j.images[0].url, { signal: AbortSignal.timeout(120_000) });
      if (!d.ok) throw new Error(`HTTP ${d.status}`);
      const img = Buffer.from(await d.arrayBuffer());
      // Google's models pick their own pixel size for 1:1 at 1K: back to the window's
      const meta = await sharp(img).metadata();
      writeFileSync(join(cwd, "out.png"), meta.width === WIN && meta.height === WIN ? img : await sharp(img).resize(WIN, WIN, { fit: "fill" }).png().toBuffer());
      writeFileSync(log, `fal ${FAL_ENDPOINT} ${FAL_QUALITY} $${usd} request ${r.headers.get("x-fal-request-id")}`);
      return;
    } catch (err) {
      writeFileSync(log, `paid image ${j.images[0].url} not downloaded: ${String(err)}`);
      await sleep(5_000 * attempt);
    }
  }
}

function codexWindow(cwd: string, prompt: string): Promise<void> {
  const images = ["input.png", "height.png", "style.png", "trees.png", ...(args.aerial && !HYBRID ? ["aerial.png"] : []), ...REFS.map((_, k) => `ref${k + 1}.png`),
    ...(local.styleLocal ? ["style-local.png"] : [])];
  return codex(cwd, images, prompt, { model: args.model, effort: args.effort });
}

/** Share of a window's surface at sea level (from the height pass). */
async function seaFraction(i: number, j: number) {
  let wet = 0, n = 0;
  for (let y = j * STRIDE; y < j * STRIDE + WIN; y += 32)
    for (let x = i * STRIDE; x < i * STRIDE + WIN; x += 32) {
      const tx = Math.floor(x / T), ty = Math.floor(y / T), f = regionFile("height", tx, ty);
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

/**
 * Share of a painting's area that is roof tile (red/orange, saturated) with no roof in the render within ~16 m:
 * buildings the model invented. Normal paintings stay under ~3 %; invented towns in woods reach 10–16 %.
 */
async function inventedRoofs(out: string, input: string) {
  const mask = async (f: string) => {
    const d = await sharp(f).removeAlpha().resize(128, 128, { fit: "fill" }).raw().toBuffer(), m = new Uint8Array(128 * 128);
    for (let k = 0; k < m.length; k++) { const r = d[k * 3], g = d[k * 3 + 1], b = d[k * 3 + 2]; m[k] = r > 120 && r > g * 1.35 && r > b * 1.6 ? 1 : 0; }
    return m;
  };
  const [pm, rm] = [await mask(out), await mask(input)];
  let invented = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    if (!pm[y * 128 + x]) continue;
    let near = false;
    for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3 && !near; dx++) {
      const yy = y + dy, xx = x + dx;
      near = yy >= 0 && xx >= 0 && yy < 128 && xx < 128 && rm[yy * 128 + xx] === 1;
    }
    if (!near) invented++;
  }
  return invented / (128 * 128);
}
const MAX_INVENTED = 0.04;

/** Share of pixels with a strong edge (256 px greyscale): good paintings stay within ~1.0–1.4× their render's. */
async function edgeDensity(f: string) {
  const N = 256, g = await sharp(f).removeAlpha().greyscale().resize(N, N, { fit: "fill" }).raw().toBuffer();
  let e = 0;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++)
    if (Math.hypot(g[y * N + x + 1] - g[y * N + x - 1], g[(y + 1) * N + x] - g[(y - 1) * N + x]) > 40) e++;
  return e / ((N - 2) * (N - 2));
}
/** Structure invented on a nearly blank render (fields, tracks, squares): much busier painting than render. */
async function inventedStructure(out: string, input: string) {
  const [p, r] = [await edgeDensity(out), await edgeDensity(input)];
  return p - r > 0.15 && p > 2 * r;
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

const MAX_USES = 12;

async function facadeNotes(i: number, j: number) {
  const here = FACADES.filter((f) => f.region === AREA.region);
  const pois = AREA.region === "israel-center" ? [] : await areaPois(areaName, AREA);
  if (!here.length && !pois.length) return "";
  const ground = await windowGround(i * STRIDE, j * STRIDE);
  const at = (lat: number, lon: number) => {
    const [x, y] = llhToPixel(lat, lon, ground), lx = Math.round(x - i * STRIDE), ly = Math.round(y - j * STRIDE);
    return lx >= 32 && ly >= 32 && lx < WIN - 32 && ly < WIN - 32 ? `(${lx}, ${ly})` : null;
  };
  const facades = here.map((f) => {
    const p = at(f.lat, f.lon);
    return p ? `- The building whose footprint is centred at about ${p} px in image 1 is the ${f.name}: ${f.facade}.\n` : "";
  }).join("");
  const uses = pois.map((p) => ({ ...p, px: at(p.lat, p.lon) })).filter((p) => p.px)
    .sort((a, b) => a.rank - b.rank).slice(0, MAX_USES).map((p) => `  - at about ${p.px} px: ${p.what}\n`).join("");
  return facades + (uses ? `- What some places in image 1 are (OpenStreetMap). Give each the look such a place has in \
reality (roof, canopy, colours, car park, yard), in the house style, on the building or ground already there; never \
add or move buildings, never write text, names or logos:\n${uses}` : "");
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
  const work = join(base, `work${SUFFIX}`, `${i}_${j}`);
  mkdirSync(work, { recursive: true });
  const edges = await composeInput(i, j, join(work, "input.png"), join(work, "height.png"));
  copyFileSync(SIMPLE ? STYLE_SIMPLE : STYLE, join(work, "style.png"));
  copyFileSync(local.trees, join(work, "trees.png"));
  if (local.styleLocal) copyFileSync(local.styleLocal, join(work, "style-local.png"));
  for (const [k, f] of REFS.entries()) await sharp(f).resize(1024, 1024, { fit: "inside" }).png().toFile(join(work, `ref${k + 1}.png`));
  if (args.aerial && !HYBRID) {
    const dir = join(base, `aerial-${args.aerial}`);
    const load = async (tx: number, ty: number) => (existsSync(join(dir, `${tx}_${ty}.png`)) ? sharp(join(dir, `${tx}_${ty}.png`)).png().toBuffer() : null);
    await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN, load)).removeAlpha().png().toFile(join(work, "aerial.png"));
  }
  const extra = (args.aerial && !HYBRID ? 1 : 0) + REFS.length, localN = 5 + extra; // style-local.png comes last
  let prompt = PROMPT.replace("{style}", SIMPLE ? SIMPLE_STYLE : PAINTED_STYLE).replace("{groundLook}", SIMPLE ? SIMPLE_GROUND : PAINTED_GROUND)
    .replace("{title}", title).replace("{country}", local.country).replace("{render}", HYBRID ? HYBRID_RENDER : local.render)
    .replace("{treesOf}", local.treesOf).replace("{treeHint}", local.treeHint).replace("{materials}", local.materials).replace("{ground}", local.ground).replace("{out}", join(work, "out.png"))
    .replace("{continuation}", edges.length ? CONTINUATION.replace("{edges}", edges.join(" and ")) : "")
    .replace("{count}", ["Four", "Five", "Six", "Seven", "Eight", "Nine"][extra + (local.styleLocal ? 1 : 0)])
    .replace("{aerialImage}", (args.aerial && !HYBRID ? AERIAL_IMAGE : "") + REF_IMAGES(args.aerial && !HYBRID ? 6 : 5, REFS.length)
      + (local.styleLocal ? STYLE_LOCAL_IMAGE(localN).replace("{country}", local.country) : ""))
    .replace("{facades}", (await facadeNotes(i, j)) + (args.hint ? `- ${args.hint}\n` : ""))
    .replace("{aerialRule}", (HYBRID ? HYBRID_RULE : args.aerial ? AERIAL_RULE : "") + (GUIDE ? GUIDE_RULE : "")
      + (local.styleLocal ? STYLE_LOCAL_RULE(localN) : ""));
  if (GUIDE) prompt = prompt.replace(/1\. input\.png:[^\n]*\n/, GUIDE_IMAGE);
  for (let attempt = 1; attempt <= 3; attempt++) {
    while (Date.now() < resumeAt) await sleep(Math.min(60_000, resumeAt - Date.now()));
    if (overBudget()) { console.warn(`  ${i}_${j}: paint budget of $${BUDGET} reached ($${spent.toFixed(2)} spent), skipped`); return; }
    rmSync(join(work, "out.png"), { force: true });
    const t0 = Date.now();
    if (BACKEND === "fal") await falPaint(work, prompt, `${i}_${j}`);
    else await codexWindow(work, prompt);
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
      if (local.inventionChecks) {
        const invented = await inventedRoofs(join(work, "out.png"), join(work, "input.png"));
        if (invented > MAX_INVENTED && attempt < 3) {
          console.warn(`  ${i}_${j}: ${(invented * 100).toFixed(1)} % invented roofs (buildings the render doesn't have), repainting`);
          continue;
        }
        if (invented > MAX_INVENTED) { console.warn(`  ${i}_${j}: still inventing buildings after 3 attempts, left unpainted`); return; }
        if (await inventedStructure(join(work, "out.png"), join(work, "input.png"))) {
          if (attempt < 3) { console.warn(`  ${i}_${j}: painting far busier than its render (invented structure), repainting`); continue; }
          console.warn(`  ${i}_${j}: still inventing structure after 3 attempts, left unpainted`); return;
        }
      }
      const structured = r.texture >= MIN_TEXTURE; // open sea / empty land: correlation is meaningless
      if (structured && r.score < minMatch && attempt < 3) {
        console.warn(`  ${i}_${j}: match ${r.score.toFixed(2)} < ${minMatch}, repainting`);
        continue;
      }
      const warp = structured && r.score > r.identity + 0.01;
      await applyRegistration(join(work, "out.png"), winFile(i, j), warp ? r : { ...r, scale: 1, dx: 0, dy: 0 });
      console.log(`  ${i}_${j}: ${((Date.now() - t0) / 1000).toFixed(0)}s edges=${edges.join("+") || "-"} match=${r.score.toFixed(2)}`
        + (structured ? "" : " (low texture)") + (warp ? ` shift=(${r.dx},${r.dy}) scale=${r.scale.toFixed(2)}` : ""));
      // keep qa.json + codex.log for debugging; the images are ~6 MB per window
      for (const f of ["input.png", "height.png", "style.png", "trees.png", "style-local.png", "aerial.png", "out.png", ...REFS.map((_, k) => `ref${k + 1}.png`)]) rmSync(join(work, f), { force: true });
      return;
    }
    console.error(`  ${i}_${j}: attempt ${attempt} failed, see ${join(work, "codex.log")}`);
  }
}

/** Feather-blend painted windows into 1024 art tiles; partly covered tiles fade into the render. */
// ---- sea colour harmonisation -------------------------------------------------------------------
// Codex paints open water in slightly different blues per window, which shows as window-sized
// rectangles. In each window, deep water (sea level, far from land) is shifted to the median
// deep-water colour of all windows, fading in from the shore so surf and harbours keep their colours.
const CELL = 8, PAD = 256, NEAR = 12, FULL = 28; // 8 px cells; fade from 12 to 28 cells (24 → 56 m) off the coast
const heightCache = new Map<string, Float32Array | null>();
async function heightAt(x: number, y: number) {
  const tx = Math.floor(x / T), ty = Math.floor(y / T), k = `${tx}_${ty}`;
  if (!heightCache.has(k)) {
    const f = regionFile("height", tx, ty);
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
async function harmoniseSea(saved?: number[]) {
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
  const ref = saved ?? [0, 1, 2].map((c) => means.map((m) => m[2][c]).sort((a, b) => a - b)[Math.floor(means.length / 2)]);
  for (const [k, w, mean] of means) seaFix.set(k, [w, mean.map((v, c) => ref[c] - v)]);
  console.log(`  sea: ${means.length} windows with open water, ${saved ? "saved " : ""}reference rgb(${ref.map(Math.round).join(",")})`);
  return ref;
}

/**
 * Window colour matching. Codex gives every window its own slight colour cast (measured: up to ±11 per channel
 * between neighbours in the strip they share), which the 64 px feather can't hide. One constant RGB offset per
 * window, solved so that neighbours agree in their overlaps (least squares, pulled weakly toward 0 so the
 * overall colour stays the painter's).
 */
async function windowOffsets(): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  // mean colour of each painted window's four overlap strips
  const strips = new Map<string, number[][]>(); // left, right, top, bottom
  for (const [i, j] of windows()) {
    if (!existsSync(winFile(i, j))) continue;
    const px = await sharp(winFile(i, j)).resize(WIN, WIN).removeAlpha().raw().toBuffer();
    const m = [0, 1, 2, 3].map(() => [0, 0, 0]);
    for (let y = 0; y < WIN; y++) for (let x = 0; x < WIN; x++) {
      const s = (y * WIN + x) * 3;
      const which = [x < OVERLAP, x >= STRIDE, y < OVERLAP, y >= STRIDE];
      for (let k = 0; k < 4; k++) if (which[k]) for (let c = 0; c < 3; c++) m[k][c] += px[s + c];
    }
    strips.set(`${i}_${j}`, m.map((v) => v.map((c) => c / (OVERLAP * WIN))));
    out.set(`${i}_${j}`, [0, 0, 0]);
  }
  // d: how much brighter window w is than neighbour n in their shared strip
  const links = new Map<string, Array<[string, number[]]>>();
  for (const [k, m] of strips) {
    const [i, j] = k.split("_").map(Number);
    for (const [n, mine, theirs] of [[`${i + 1}_${j}`, 1, 0], [`${i}_${j + 1}`, 3, 2]] as const) {
      const o = strips.get(n);
      if (!o) continue;
      const d = [0, 1, 2].map((c) => m[mine][c] - o[theirs][c]);
      links.set(k, [...(links.get(k) ?? []), [n, d]]);
      links.set(n, [...(links.get(n) ?? []), [k, d.map((v) => -v)]]);
    }
  }
  const PULL = 0.25; // weight of the pull toward 0 (vs 1 per neighbour)
  for (let it = 0; it < 200; it++)
    for (const [k, ls] of links) {
      const sum = [0, 0, 0];
      for (const [n, d] of ls) for (let c = 0; c < 3; c++) sum[c] += out.get(n)![c] - d[c];
      out.set(k, sum.map((v) => v / (ls.length + PULL)));
    }
  const worst = Math.max(0, ...[...out.values()].flat().map(Math.abs));
  if (out.size) console.log(`  colour match: ${out.size} windows, largest offset ${worst.toFixed(1)}`);
  return out;
}

/** Width (px) of the cross-fade along a seam cut through the overlap of two neighbouring windows. */
const SEAM_FEATHER = 8;

/** Rebuild art tiles: every one (all), those under the given windows (only), else those a newer window covers. */
async function assemble(all = false, only?: Set<string>) {
  const offsets = await windowOffsets();
  const ramp = new Float32Array(WIN);
  // a 64 px cross-fade centred in the overlap: only as the tiny floor for corners no seam claims (below)
  const edge = (k: number) => Math.min(1, Math.max(0, (k + 0.5 - (OVERLAP - FEATHER) / 2) / FEATHER));
  for (let k = 0; k < WIN; k++) ramp[k] = Math.min(edge(k), edge(WIN - 1 - k));

  /** a window's pixels with its colour-match offset and sea fix applied (cached: seams and tiles both need them) */
  const pixCache = new Map<string, Promise<Buffer>>();
  const windowPixels = (i: number, j: number) => {
    const key = `${i}_${j}`;
    if (!pixCache.has(key)) {
      if (pixCache.size >= 48) pixCache.delete(pixCache.keys().next().value!);
      pixCache.set(key, (async () => {
        const px = await sharp(winFile(i, j)).resize(WIN, WIN).removeAlpha().raw().toBuffer();
        const off = offsets.get(key);
        if (off && off.some((v) => Math.abs(v) >= 0.5))
          for (let s = 0; s < px.length; s += 3) for (let c = 0; c < 3; c++) px[s + c] = Math.max(0, Math.min(255, Math.round(px[s + c] + off[c])));
        const fix = seaFix.get(key);
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
        return px;
      })());
    }
    return pixCache.get(key)!;
  };

  /**
   * Seam between window (i,j) and its right (dx=1) or lower (dy=1) neighbour: per row (or column) the band position
   * where the switch happens, found by dynamic programming as the path of least colour difference through the
   * overlap. Two windows rarely paint the overlap identically (a road a few px apart, cars in one only); a cut where
   * they agree avoids the ghost double images a wide cross-fade makes.
   */
  const seams = new Map<string, Int16Array>();
  const seam = async (i: number, j: number, vertical: boolean) => {
    const key = `${i}_${j}_${vertical ? "v" : "h"}`;
    if (seams.has(key)) return seams.get(key)!;
    const A = await windowPixels(i, j), B = await windowPixels(vertical ? i + 1 : i, vertical ? j : j + 1);
    // cost[t][b]: along the seam t (0..WIN), across the band b (0..OVERLAP)
    const cost = new Float32Array(WIN * OVERLAP);
    for (let t = 0; t < WIN; t++) for (let b = 0; b < OVERLAP; b++) {
      const sa = vertical ? (t * WIN + STRIDE + b) * 3 : ((STRIDE + b) * WIN + t) * 3;
      const sb = vertical ? (t * WIN + b) * 3 : (b * WIN + t) * 3;
      cost[t * OVERLAP + b] = Math.abs(A[sa] - B[sb]) + Math.abs(A[sa + 1] - B[sb + 1]) + Math.abs(A[sa + 2] - B[sb + 2]);
    }
    // the feather around the cut must fit in the band; the cut may move 1 px per step
    const lo = SEAM_FEATHER, hi = OVERLAP - SEAM_FEATHER;
    const acc = new Float32Array(WIN * OVERLAP).fill(Infinity), from = new Int8Array(WIN * OVERLAP);
    for (let b = lo; b < hi; b++) acc[b] = cost[b];
    for (let t = 1; t < WIN; t++) for (let b = lo; b < hi; b++) {
      let best = acc[(t - 1) * OVERLAP + b], d = 0;
      if (b > lo && acc[(t - 1) * OVERLAP + b - 1] < best) { best = acc[(t - 1) * OVERLAP + b - 1]; d = -1; }
      if (b < hi - 1 && acc[(t - 1) * OVERLAP + b + 1] < best) { best = acc[(t - 1) * OVERLAP + b + 1]; d = 1; }
      acc[t * OVERLAP + b] = best + cost[t * OVERLAP + b]; from[t * OVERLAP + b] = d;
    }
    const path = new Int16Array(WIN);
    let b = lo;
    for (let k = lo; k < hi; k++) if (acc[(WIN - 1) * OVERLAP + k] < acc[(WIN - 1) * OVERLAP + b]) b = k;
    for (let t = WIN - 1; t >= 0; t--) { path[t] = b; b += from[t * OVERLAP + b]; }
    seams.set(key, path);
    return path;
  };
  /** 0 → 1 across the cut at band position `cut` (the far window's share) */
  const across = (b: number, cut: number) => Math.min(1, Math.max(0, (b - cut + SEAM_FEATHER / 2 + 0.5) / SEAM_FEATHER));
  const isPainted = (i: number, j: number) => existsSync(winFile(i, j));
  /** per-pixel weight map of window (i,j): cut against each painted neighbour */
  const weightCache = new Map<string, Promise<Float32Array>>();
  const windowWeights = (i: number, j: number) => {
    const key = `${i}_${j}`;
    if (!weightCache.has(key)) {
      if (weightCache.size >= 48) weightCache.delete(weightCache.keys().next().value!);
      weightCache.set(key, (async () => {
      const w = new Float32Array(WIN * WIN);
      for (let y = 0; y < WIN; y++) for (let x = 0; x < WIN; x++) w[y * WIN + x] = 1;
      const L = isPainted(i - 1, j) ? await seam(i - 1, j, true) : null, R = isPainted(i + 1, j) ? await seam(i, j, true) : null;
      const U = isPainted(i, j - 1) ? await seam(i, j - 1, false) : null, D = isPainted(i, j + 1) ? await seam(i, j, false) : null;
      for (let y = 0; y < WIN; y++) for (let x = 0; x < WIN; x++) {
        let v = 1;
        if (L && x < OVERLAP) v *= across(x, L[y]);
        if (R && x >= STRIDE) v *= 1 - across(x - STRIDE, R[y]);
        if (U && y < OVERLAP) v *= across(y, U[x]);
        if (D && y >= STRIDE) v *= 1 - across(y - STRIDE, D[x]);
        w[y * WIN + x] = v;
      }
      return w;
    })());
    }
    return weightCache.get(key)!;
  };

  mkdirSync(join(base, `paint${SUFFIX}`), { recursive: true });
  let written = 0, withdrawn: string | undefined;
  // tile -> the windows a partial tile was assembled from (a full tile uses all that cover it: not listed)
  const partialFile = join(base, `paint${SUFFIX}-partial.json`);
  const partialTiles: Record<string, string> = existsSync(partialFile) ? readJson(partialFile) : {};
  for (const k of tileSet) {
    const [tx, ty] = k.split("_").map(Number);
    const covering: Array<[number, number]> = [];
    for (let j = Math.floor((ty * T - WIN) / STRIDE) + 1; j * STRIDE < (ty + 1) * T; j++)
      for (let i = Math.floor((tx * T - WIN) / STRIDE) + 1; i * STRIDE < (tx + 1) * T; i++) covering.push([i, j]);
    // a tile is painted as soon as one window covers it; where windows are missing the render shows through,
    // faded in across the window feather (no hard edge between the painted and the unpainted map)
    // (only): nothing outside the given windows is touched
    if (only && !covering.some(([i, j]) => only.has(`${i}_${j}`))) continue;
    const have = covering.filter(([i, j]) => existsSync(winFile(i, j)));
    const tile = join(base, `paint${SUFFIX}`, `${tx}_${ty}.png`);
    if (!have.length) { // windows withdrawn: back to the render; the old tile moves aside, never deleted
      if (existsSync(tile)) {
        withdrawn ??= join(base, `paint${SUFFIX}-withdrawn`, new Date().toISOString().slice(0, 19).replace(/:/g, "-"));
        mkdirSync(withdrawn, { recursive: true });
        renameSync(tile, join(withdrawn, `${tx}_${ty}.png`));
      }
      delete partialTiles[k];
      continue;
    }
    const partial = have.length < covering.length;
    // rebuilt when any covering window was (re)painted since, the set of windows changed (one withdrawn or added),
    // or, for a partial tile, the render showing through was re-rendered
    const used = have.map(([i, j]) => `${i}_${j}`).join(" ");
    const usedBefore = partialTiles[k] ?? covering.map(([i, j]) => `${i}_${j}`).join(" ");
    if (!only && existsSync(tile) && !args.force && !all && used === usedBefore
      && have.every(([i, j]) => mtime(winFile(i, j)) <= mtime(tile))
      && !(partial && existsSync(renderFile(tx, ty)) && mtime(renderFile(tx, ty)) > mtime(tile))) continue;
    const acc = new Float32Array(T * T * 3), wsum = new Float32Array(T * T);
    for (const [i, j] of have) {
      const px = await windowPixels(i, j), ww = await windowWeights(i, j);
      const ox = i * STRIDE - tx * T, oy = j * STRIDE - ty * T;
      for (let y = Math.max(0, oy); y < Math.min(T, oy + WIN); y++)
        for (let x = Math.max(0, ox); x < Math.min(T, ox + WIN); x++) {
          // the tiny ramp floor fills corners no seam claims: where four windows meet, the two vertical (and the two
          // horizontal) cuts can disagree and leave a patch with weight 0 in all of them (a black hole at the Wilhelma)
          const wx = x - ox, wy = y - oy, s = (wy * WIN + wx) * 3, d = y * T + x;
          const w = Math.max(ww[wy * WIN + wx], 1e-4 * ramp[wx] * ramp[wy]);
          if (w <= 0) continue;
          acc[d * 3] += px[s] * w; acc[d * 3 + 1] += px[s + 1] * w; acc[d * 3 + 2] += px[s + 2] * w;
          wsum[d] += w;
        }
    }
    const out = Buffer.alloc(T * T * 3);
    // seam cuts end hard at a patch edge: there the render only fills where no window paints
    const render = partial && existsSync(renderFile(tx, ty)) ? await sharp(renderFile(tx, ty)).removeAlpha().raw().toBuffer() : null;
    for (let d = 0; d < T * T; d++) {
      const w = wsum[d];
      for (let c = 0; c < 3; c++)
        out[d * 3 + c] = render && w < 1e-3 ? acc[d * 3 + c] + render[d * 3 + c] * (1 - w) : acc[d * 3 + c] / Math.max(w, 1e-6);
    }
    await writeAtomic(sharp(out, { raw: { width: T, height: T, channels: 3 } }).png(), join(base, `paint${SUFFIX}`, `${tx}_${ty}.png`));
    if (partial) partialTiles[k] = used; else delete partialTiles[k];
    writeFileSync(partialFile, JSON.stringify(partialTiles));
    written++;
  }
  writeFileSync(partialFile, JSON.stringify(partialTiles));
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
    const [x, y] = await groundPixel(join(base, "height"), lat, lon);
    const ci = Math.floor(x / STRIDE), cj = Math.floor(y / STRIDE), r = Number(args.radius);
    wins = wins.filter(([i, j]) => Math.abs(i - ci) <= r && Math.abs(j - cj) <= r);
  }
  if (args.window) wins = args.window.split(";").map((w) => w.split(",").map(Number) as [number, number]); // "i,j" or "i,j;i,j;…" (painted in that order)
  if (args.parts) {
    const boxes: number[][] = readJson(join(base, "osm-parts.json")).map((p: { px: number[] }) => p.px), m = 16;
    wins = wins.filter(([i, j]) => boxes.some(([x0, y0, x1, y1]) => i * STRIDE < x1 + m && i * STRIDE + WIN > x0 - m && j * STRIDE < y1 + m && j * STRIDE + WIN > y0 - m));
  }
  if (OLDER) { // windows painted before the cut-off or not yet at all (skip sea-texture windows: no trees)
    const old: Array<[number, number]> = [];
    for (const [i, j] of wins) if (!current(i, j) && !(existsSync(winFile(i, j)) && await looksLikeSea(winFile(i, j)))) old.push([i, j]);
    wins = old;
  }
  if (args.plan) return console.log(`${wins.length} windows`);
  if (args.parts) { // the old paintings move aside (not deleted), so neighbours in the set don't continue them
    const keep = join(base, "windows-replaced", new Date().toISOString().slice(0, 19).replace(/:/g, "-"));
    mkdirSync(keep, { recursive: true });
    for (const [i, j] of wins) if (existsSync(winFile(i, j))) renameSync(winFile(i, j), join(keep, `${i}_${j}.png`));
    console.log(`  ${wins.length} windows over OSM 3D buildings; old paintings in ${keep}`);
  }
  if (!args.window && !OLDER && !args.assemble && !args.parts) {
    // reuse what other areas of the region painted: this area's windows and their neighbours (for continuation).
    // Each window is considered once (windows-reused.json): one this area has or had is never linked back, so a
    // window deleted on purpose (a seam fix, a dark window dropped) is repainted, not restored from a sibling.
    const want = new Set<string>();
    for (const [i, j] of wins) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) want.add(`${i + di}_${j + dj}`);
    const ledgerFile = join(base, "windows-reused.json");
    const ledger = new Set<string>(existsSync(ledgerFile) ? readJson(ledgerFile) : []);
    let linked = 0;
    for (const k of want) {
      if (ledger.has(k)) continue;
      const own = join(winDir, `${k}.png`);
      if (existsSync(own)) { ledger.add(k); continue; }
      const sib = SIBLINGS.map((d) => join(d, "windows", `${k}.png`)).find((f) => existsSync(f));
      if (!sib) continue; // not painted anywhere yet: a sibling may still paint it
      try { linkSync(sib, own); } catch { copyFileSync(sib, own); }
      ledger.add(k);
      linked++;
    }
    writeFileSync(ledgerFile, JSON.stringify([...ledger].sort()));
    if (linked) console.log(`  reused ${linked} windows painted by other areas of the region`);
  }
  if (args.assemble) {
    const seaRef = await harmoniseSea();
    await assemble(true);
    return writeFileSync(join(base, `paint${SUFFIX}.json`), JSON.stringify({ updated: new Date().toISOString(), seaRef }));
  }
  if (args.window) { // listed windows, painted directly in order (each continues those painted before it); a cutout window may sit off the grid (16.5,2.5), so no rings round it
    if (existsSync(SEA) && !(await looksLikeSea(SEA))) { console.warn("  sea texture is bad, repainting it"); rmSync(SEA); }
    for (const [i, j] of wins) await paintWindow(i, j);
    const prev = existsSync(join(base, `paint${SUFFIX}.json`)) ? readJson(join(base, `paint${SUFFIX}.json`)) : {};
    const seaRef = await harmoniseSea(prev.seaRef); // the saved sea colour: nothing outside these windows changes
    await assemble(false, new Set(wins.map(([i, j]) => `${i}_${j}`)));
    writeFileSync(join(base, `paint${SUFFIX}.json`), JSON.stringify({ updated: new Date().toISOString(), seaRef }));
    return;
  }
  // centre first: square rings around the city centre. Each ring runs in two passes over its
  // perimeter (even, then odd positions) so every window continues its painted inner/ring neighbours.
  const [cx, cy] = args.center.split(",").map(Number);
  const [px, py] = await groundPixel(join(base, "height"), cx, cy);
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
  // then the tiles are rebuilt with the harmonised sea: all of them after a full run; after a partial one
  // (--window, --near, --parts) only those under its windows, with the saved sea colour, so nothing else changes
  const partial = !!(args.window || args.near || args.parts);
  const prev = existsSync(join(base, `paint${SUFFIX}.json`)) ? readJson(join(base, `paint${SUFFIX}.json`)) : {};
  const seaRef = await harmoniseSea(partial ? prev.seaRef : undefined);
  await assemble(!partial, partial ? new Set(wins.map(([i, j]) => `${i}_${j}`)) : undefined);
  writeFileSync(join(base, `paint${SUFFIX}.json`), JSON.stringify({ updated: new Date().toISOString(), seaRef }));
}

main();
