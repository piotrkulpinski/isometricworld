import OpenSeadragon from "openseadragon";
// traffic, cats and sky are loaded after the first view (loadAnimations): not in the first script
import type { Traffic } from "./traffic.ts";
import type { Trains } from "./trains.ts";
import type { Cats } from "./cats.ts";
import type { Planes, Parrots, Pigeons, Airport, LightAircraft, Signs } from "./sky.ts";
import type { AirportTraffic } from "./airport.ts";
import type { Pigeons as PeckingPigeons } from "./pigeons.ts";
import type { Carriages } from "./carriages.ts";
import { Foreground, type FgIndex } from "./foreground.ts";
import type { Mine, MineData } from "./mine.ts";
import type { Fly } from "./fly.ts";
import type { Clouds } from "./clouds.ts";
import type { SearchItem } from "./search.ts";
import { CAMERA, ecefToEnu, llhToEcef, llhToPixel, useRegion } from "../../../pipeline/src/camera.ts";
import { CITIES, REGIONS } from "../../../pipeline/src/places.ts";
declare const __TILES_ORIGIN__: string; // TILES_ORIGIN from .env, injected by astro.config.mjs

interface World {
  tile_size: number;
  native_zoom: number;
  min_zoom: number;
  bounds: [[number, number], [number, number]]; // [[y0, x0], [y1, x1]] global art px
  origin: [number, number];                     // global px of image (0, 0)
  size: [number, number];
  enu2px: number[][];
  camera: { headingDeg: number; origin: { lat: number; lon: number } };
  airport: Airport | null;
  areas: Array<{ id: string; title?: string }>;
  layers: { photo: number; art: number };
  attributions: string[];
  /** content-hashed data files (absent in data exported before them: then the legacy names) */
  files?: { "tiles-map"?: string; "tiles-photo"?: string; "tiles-fg"?: string; "tiles-height"?: string; borders?: string; roads?: string; trains?: string; airport?: string; mine?: string; search?: string };
  format?: string;
}
type Index = Record<number, Record<string, string>>; // zoom → "x_y" → content hash
interface Border { id: number; name: string; name_en?: string; rings: Array<Array<[number, number]>>; label?: [number, number] }

// the page says which city it is; the city's region is one flat map under /regions/<region>/
const city = CITIES[document.body.dataset.city!], REGION = document.body.dataset.region!;
// map data lives on R2; the dev server serves /regions from the export cache, falling back to R2
const BASE = `${import.meta.env.DEV ? "" : __TILES_ORIGIN__}/regions/${REGION}`;
useRegion(REGION);
const json = <T>(file: string) => fetch(`${BASE}/data/${file}`).then((r) => r.json() as Promise<T>);
// the page preloads the data files named in world.json at build time (MapPage.astro); world.json is
// the truth (a publish after the build renames them; those preloads then go unused)
const worldReady = json<World>("world.json");
// AVIF tiles (40% smaller); browsers without AVIF get the last WebP pyramid (data/tiles.json): Tel Aviv only,
// newer regions have none
const avifReady = new Promise<boolean>((done) => {
  const img = new Image();
  img.onload = () => done(img.width === 1);
  img.onerror = () => done(false);
  img.src = "data:image/avif;base64,AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAAB0AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAlbWRhdBIACgc4AAaQENBpMhAdgmLE4AAWAACQNY48fpPA";
});
const [world, avif] = await Promise.all([worldReady, avifReady]);
const files = world.files ?? {}, modern = Boolean(avif && files["tiles-map"]);
const EXT = modern ? world.format ?? "avif" : "webp";
const legacy = modern ? null : json<Record<string, Index>>("tiles.json");
/** a layer's tile index; the photo layer's only when it is first shown */
const layerIndex = (layer: "map" | "photo") => (legacy ? legacy.then((all) => all[layer] ?? {}) : json<Index>(files[`tiles-${layer}`]!));
const [borders, mapIndex] = await Promise.all([json<Border[]>(files.borders ?? "borders.json"), layerIndex("map")]);
const [ox, oy] = world.origin;
const TS = world.tile_size, NZ = world.native_zoom;

/** Sparse pyramid in global tile indices, exposed to OpenSeadragon with a non-negative origin. */
function tileSource(layer: string, have: Index) {
  const global = (level: number, x: number, y: number) => {
    const span = TS * 2 ** (NZ - level);
    return [x + Math.round(ox / span), y + Math.round(oy / span)];
  };
  return {
    width: world.size[0], height: world.size[1], tileSize: TS, tileOverlap: 0,
    minLevel: world.min_zoom, maxLevel: NZ,
    getTileUrl: (level: number, x: number, y: number) => {
      const [tx, ty] = global(level, x, y);
      return `${BASE}/tiles/${layer}/${level}/${tx}/${ty}.${EXT}?v=${have[level]?.[`${tx}_${ty}`]}`; // immutable URL per content
    },
    tileExists: (level: number, x: number, y: number) => {
      const [tx, ty] = global(level, x, y);
      return have[level]?.[`${tx}_${ty}`] !== undefined;
    },
  };
}

/**
 * Tiles kept decoded. The canvas drawer keeps each tile as a canvas of its own, 1 MB for a 512 px tile, so a fixed 600
 * could hold 630 MB of canvases (iOS Safari caps a page's canvas memory well below that). Measured, one layer draws at
 * most ~8 tiles per megapixel of the screen + 12 in a frame, and a salt mine's levels (surface dimmed, levels fading)
 * up to ~3× that: keep four screens' worth, at least 150. The physical screen, so a window made larger still fits.
 */
function cacheTiles() {
  const dpr = window.devicePixelRatio || 1, mpx = (screen.width * dpr * screen.height * dpr) / 1e6;
  return Math.max(150, Math.round(4 * (8 * mpx + 12)));
}

const viewer = OpenSeadragon({
  element: document.getElementById("map")!,
  tileSources: tileSource("map", mapIndex) as unknown as OpenSeadragon.TileSourceOptions,
  showNavigationControl: false,
  drawer: "canvas",       // WebGL drawer leaves coloured fringes at transparent tile edges
  subPixelRoundingForTransparency: { "*": OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS }, // no hairline seams between tiles
  // smooth deep zoom: blend levels while loading, spring animation, modest overzoom
  blendTime: 0.15,
  animationTime: 0.9,
  springStiffness: 9,
  immediateRender: false,
  imageLoaderLimit: 8,
  // fetch the finer level only once it is really needed (~40% fewer bytes). Stuttgart: once the shown one would be
  // stretched past 1/0.6 = 1.2× in device pixels (0.8 stretched up to 1.6× and blurred its thin rails)
  minPixelRatio: REGION === "stuttgart" ? 0.6 : 0.8,
  maxImageCacheCount: cacheTiles(),
  minZoomImageRatio: 0.01, // real limit is set on open: the whole metro
  maxZoomPixelRatio: 2.5,
  visibilityRatio: 0.4,
  zoomPerScroll: 1.35,
  smoothTileEdgesMinZoom: Infinity,
  gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true, flickEnabled: true },
  preserveImageSizeOnResize: true,
});
Object.assign(window as object, { __viewer: viewer, OpenSeadragon, __world: world });

// ---- coordinate helpers (global art px <-> canvas px) -----------------------------------------
const canvas = document.createElement("canvas");
canvas.id = "overlay";
document.getElementById("map")!.appendChild(canvas);
const ctx = canvas.getContext("2d")!;
let k = 1, tx = 0, ty = 0; // canvas = global * k + t (no rotation)
const base = () => viewer.world.getItemAt(0);
function updateTransform() {
  const vp = viewer.viewport, item = base();
  if (!item) return;
  const a = vp.viewportToViewerElementCoordinates(item.imageToViewportCoordinates(0, 0, true));
  const b = vp.viewportToViewerElementCoordinates(item.imageToViewportCoordinates(1000, 0, true));
  const dpr = window.devicePixelRatio || 1;
  k = ((b.x - a.x) / 1000) * dpr;
  tx = a.x * dpr - ox * k;
  ty = a.y * dpr - oy * k;
}
const toScreen = (x: number, y: number): [number, number] => [x * k + tx, y * k + ty];
const globalToViewport = (x: number, y: number) => base().imageToViewportCoordinates(x - ox, y - oy);

// ---- overlay: borders, labels, traffic ------------------------------------------------------
let showBorders = false, showTraffic = true;
const heading = (world.camera.headingDeg * Math.PI) / 180;
let trains: Trains | null = null;
let traffic: Traffic | null = null, cats: Cats | null = null, parrots: Parrots | null = null, pigeons: Pigeons | null = null, planes: Planes | null = null;
/** pigeons pecking on a square and taking off (life.pigeons; pigeons.ts), apart from the flocks wheeling over squares (sky.ts) */
let pecking: PeckingPigeons | null = null;
/** Kraków's dorożki round Rynek Główny (life.carriages; carriages.ts) */
let carriages: Carriages | null = null;
/** what stands higher than a car, drawn back over the vehicles (life.foreground; AVIF only) */
let foreground: Foreground | null = null;
if (modern && files["tiles-fg"]) json<FgIndex>(files["tiles-fg"]).then((index) => {
  foreground = new Foreground(index, (z, x, y, v) => `${BASE}/tiles/fg/${z}/${x}/${y}.${EXT}?v=${v}`, TS, NZ, world.min_zoom);
});
// a salt mine's levels under the town (Wieliczka; mine.ts): a lift panel, each level its own layer
let mine: Mine | null = null;
if (modern && files.mine) Promise.all([import("./mine.ts"), json<MineData>(files.mine)]).then(([{ Mine: MineView }, data]) => {
  mine = new MineView(data, {
    enu2px: world.enu2px,
    addLayer: (layer, indexFile) => json<Index>(indexFile).then((have) => new Promise((resolve) => viewer.addTiledImage({
      tileSource: tileSource(layer, have) as unknown as OpenSeadragon.TileSourceOptions, opacity: 0,
      success: (e) => resolve((e as unknown as { item: OpenSeadragon.TiledImage }).item),
    }))),
    dimSurface: (o) => { if (base()) base().setOpacity(o); else viewer.addOnceHandler("open", () => base().setOpacity(o)); },
  });
  Object.assign(window as object, { __mine: mine });
});
// a biplane to fly over the map (effects.fly; fly.ts): the map follows it and stops panning by drag meanwhile
let fly: Fly | null = null;
if (REGIONS[REGION]?.effects?.fly) import("./fly.ts").then(({ Fly: Biplane }) => {
  const gestures = viewer as unknown as { gestureSettingsMouse: { dragToPan: boolean; flickEnabled: boolean }; gestureSettingsTouch: { dragToPan: boolean; flickEnabled: boolean } };
  const [[by0, bx0], [by1, bx1]] = world.bounds;
  fly = new Biplane({
    enu2px: world.enu2px,
    groundZ: REGIONS[REGION].groundH,
    bounds: [bx0, by0, bx1, by1],
    center: () => { const c = base().viewportToImageCoordinates(viewer.viewport.getCenter(true)); return [c.x + ox, c.y + oy]; },
    screenToGlobal: (sx, sy) => { const dpr = window.devicePixelRatio || 1; return [(sx * dpr - tx) / k, (sy * dpr - ty) / k]; },
    follow: (x, y) => viewer.viewport.panTo(globalToViewport(x, y), true),
    // the surface heights its shadow is laid over (lossless WebP whatever the map's format)
    heights: files["tiles-height"] ? { index: () => json<Record<string, string>>(files["tiles-height"]!), url: (x, y, v) => `${BASE}/tiles/height/${x}/${y}.webp?v=${v}` } : undefined,
    onChange: (flying) => {
      for (const g of [gestures.gestureSettingsMouse, gestures.gestureSettingsTouch]) { g.dragToPan = !flying; g.flickEnabled = !flying; }
      if (!flying) return;
      if (mine?.underground) mine.open(false); // up from the mine to take off
      // the plane is ~24 m across, like the map's houses: from farther out than ~1 km across, close in to take off
      const dpr = window.devicePixelRatio || 1, across = ((canvas.clientWidth * dpr) / k) * CAMERA.mpp;
      if (across > 1000) viewer.viewport.zoomTo(base().getContentSize().x / (600 / CAMERA.mpp));
    },
  }, document.getElementById("map")!);
  Object.assign(window as object, { __fly: fly });
});
// going somewhere (the search): the plane lands, the mine comes up, the spot is marked a while
let mark: { x: number; y: number; label: string; t: number } | null = null;
function goTo(x: number, y: number, widthM?: number, label?: string) {
  if (fly?.flying) fly.stop();
  if (mine?.underground) mine.open(false);
  viewer.viewport.panTo(globalToViewport(x, y));
  if (widthM) viewer.viewport.zoomTo(base().getContentSize().x / (widthM / CAMERA.mpp));
  if (label) mark = { x, y, label, t: performance.now() };
}
const effects = REGIONS[REGION]?.effects ?? {};
// cloud shadows drifting over the map (effects.clouds; clouds.ts)
let clouds: Clouds | null = null;
if (effects.clouds) import("./clouds.ts").then(({ Clouds: C }) => { clouds = new C(world.enu2px); Object.assign(window as object, { __clouds: clouds }); });
// finding streets and places (effects.search; search.ts)
if (effects.search && files.search) Promise.all([import("./search.ts"), json<SearchItem[]>(files.search)]).then(([{ Search }, items]) => new Search(items, { go: goTo }));
let lightAircraft: LightAircraft | null = null, airport: AirportTraffic | null = null, signs: Signs | null = null;
// the animations (their code and the roads, ~0.7 MB) wait until the first view's tiles are in
let animationsRequested = false;
function loadAnimations() {
  if (animationsRequested) return;
  animationsRequested = true;
  Promise.all([
    import("./traffic.ts"), import("./cats.ts"), import("./sky.ts"), import("./roads.ts"), import("./pigeons.ts"),
    fetch(`${BASE}/data/${files.roads ?? "roads.json"}`).then((r) => (r.ok ? r.json() : [])),
    files.trains ? Promise.all([import("./trains.ts"), fetch(`${BASE}/data/${files.trains}`).then((r) => (r.ok ? r.json() : null))]) : null,
    files.airport ? Promise.all([import("./airport.ts"), fetch(`${BASE}/data/${files.airport}`).then((r) => (r.ok ? r.json() : null))]) : null,
    REGIONS[REGION]?.life?.carriages ? import("./carriages.ts") : null,
  ]).then(([{ Traffic }, { Cats }, { Planes, Parrots, Pigeons, LightAircraft, Signs }, { decodeRoads }, { Pigeons: Pecking }, data, rail, taxi, carriagesModule]) => {
    const roads = decodeRoads(data, !files.trains); // no trains: exported before terrain road heights
    if (rail?.[1]) trains = new rail[0].Trains(rail[0].decodeTrains(rail[1]), world.enu2px, [Math.sin(heading), Math.cos(heading)], REGIONS[REGION].rail?.stock);
    // with the taxi network the airliners land, park and take off again; without it they fade out on the runway
    const ap = REGIONS[REGION]?.airport;
    if (taxi?.[1] && ap) airport = new taxi[0].AirportTraffic(world.enu2px, ap, taxi[1]);
    else if (world.airport) planes = new Planes(world.enu2px, world.airport);
    const airfield = REGIONS[REGION]?.airfield; // from places.ts directly: no re-export of world.json needed
    if (airfield) lightAircraft = new LightAircraft(world.enu2px, airfield);
    const roofSigns = REGIONS[REGION]?.signs; // places.ts directly, like the airfield
    if (roofSigns?.length) signs = new Signs(world.enu2px, roofSigns);
    const life = REGIONS[REGION]?.life;
    if (roads.length) traffic = new Traffic(roads, world.enu2px, [Math.sin(heading), Math.cos(heading)], 1, { detailed: life?.vehicles === "detailed", coaches: life?.coaches });
    if (roads.length) cats = new Cats(roads, world.enu2px);
    if (traffic && trains && REGIONS[REGION].rail) traffic.yieldTo(trains); // Zagreb's trams share the streets
    if (roads.length && life?.pigeons?.length) { // the paving's height: the nearest road sample's
      const ground = (x: number, y: number) => {
        let best = Infinity, z = 0;
        for (const r of roads) for (let i = 0; i < r.s.length; i += 4) { const d = Math.hypot(r.s[i] - x, r.s[i + 1] - y); if (d < best) { best = d; z = r.s[i + 2]; } }
        return z;
      };
      pecking = new Pecking(world.enu2px, life.pigeons, ground, [Math.sin(heading), Math.cos(heading)]);
    }
    if (roads.length && carriagesModule && life?.carriages)
      carriages = new carriagesModule.Carriages(world.enu2px, life.carriages.loop, life.carriages.count, roads, [Math.sin(heading), Math.cos(heading)]);
    if (roads.length && REGION === "israel-center") { // Tel Aviv's feral parakeets roam over the streets' extent
      const a = [Infinity, Infinity, -Infinity, -Infinity];
      for (const r of roads) for (let i = 0; i < r.s.length; i += 4) {
        a[0] = Math.min(a[0], r.s[i]); a[1] = Math.min(a[1], r.s[i + 1]); a[2] = Math.max(a[2], r.s[i]); a[3] = Math.max(a[3], r.s[i + 1]);
      }
      parrots = new Parrots(world.enu2px, a);
    }
    // pigeons over the region's squares; their ground height from the nearest street (the squares are on the map's roads)
    const squares = REGIONS[REGION].pigeons ?? [], roosts: Array<[number, number, number]> = [];
    for (const [lat, lon] of squares) {
      const [e, n] = ecefToEnu(llhToEcef(lat, lon, 0));
      let best = 150 * 150, u = NaN;
      for (const r of roads) for (let i = 0; i < r.s.length; i += 4) {
        const d = (r.s[i] - e) ** 2 + (r.s[i + 1] - n) ** 2;
        if (d < best) { best = d; u = r.s[i + 2]; }
      }
      if (Number.isFinite(u)) roosts.push([e, n, u]); // no street near: the square is outside the exported areas
    }
    if (roosts.length) pigeons = new Pigeons(world.enu2px, roosts);
    Object.assign(window as object, { __trains: trains, __traffic: traffic, __cats: cats, __parrots: parrots, __pigeons: pigeons, __pecking: pecking, __carriages: carriages, __planes: planes, __lightAircraft: lightAircraft, __airport: airport, __signs: signs });
  });
}
setTimeout(loadAnimations, 6000); // slow connection: don't wait for every tile forever

// biggest cities get their label first when labels would collide
const ringArea = (r: Array<[number, number]>) => Math.abs(r.reduce((a, [y, x], i) => { const [y2, x2] = r[(i + 1) % r.length]; return a + x * y2 - x2 * y; }, 0) / 2);
const labelOrder = [...borders].sort((a, b) => ringArea(b.rings[0]) - ringArea(a.rings[0]));

function drawBorders(dpr: number) {
  ctx.lineWidth = 2 * dpr;
  ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.strokeStyle = "#ffd84d";
  for (const c of borders) for (const ring of c.rings) {
    ctx.beginPath();
    let last: [number, number] | null = null;
    for (const [y, x] of ring) {
      const p = toScreen(x, y);
      if (last && Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 2) continue; // decimate
      if (last) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
      last = p;
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = `600 ${13 * dpr}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.fillStyle = "#fff";
  const placed: Array<[number, number, number, number]> = [];
  for (const c of labelOrder) {
    if (!c.label) continue;
    const [px, py] = toScreen(c.label[1], c.label[0]);
    // Zagreb's districts are tagged "Gradska četvrt Donji grad": the map shows "Donji grad"
    const label = c.name_en === "Tel-Aviv" ? "Tel Aviv-Yafo" : c.name_en ?? c.name.replace(/^Gradska četvrt /, "");
    const w = ctx.measureText(label).width + 8 * dpr, hh = 16 * dpr;
    const box: [number, number, number, number] = [px - w / 2, py - hh, px + w / 2, py + 4 * dpr];
    if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    placed.push(box);
    ctx.strokeText(label, px, py);
    ctx.fillText(label, px, py);
  }
}

let lastT = performance.now();
function frame(t: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr), hgt = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
  updateTransform();
  ctx.clearRect(0, 0, w, hgt);
  // film mode (pipeline/src/film.ts): the recorder hands out exactly one frame of sim time per capture
  const film = (window as { __film?: { dt: number } }).__film;
  const dt = film ? film.dt : (t - lastT) / 1000;
  if (film) film.dt = 0;
  // zoomed out too far to see them (their draw() thresholds), cars and cats pause instead of
  // simulating thousands of invisible movers every frame
  const px = k / dpr;
  const above = showTraffic && !mine?.underground; // below ground, the town's life stays up there
  if (trains && above && px >= 0.08) { // under the cars: road bridges cross the tracks, rarely the reverse
    trains.step(dt);
    trains.draw(ctx, toScreen, px, [0, 0, w, hgt]);
    foreground?.draw(ctx, k, tx, ty, trains.boxes);
  }
  if (traffic && above && px >= 0.14) {
    traffic.step(dt);
    traffic.draw(ctx, toScreen, px, [0, 0, w, hgt]);
    foreground?.draw(ctx, k, tx, ty, traffic.boxes);
  }
  if (cats && above && px >= 0.6) {
    cats.step(dt);
    cats.draw(ctx, toScreen, px, [0, 0, w, hgt]);
  }
  if (carriages && above && px >= 0.2) {
    carriages.step(dt);
    carriages.draw(ctx, toScreen, px, [0, 0, w, hgt]);
    foreground?.draw(ctx, k, tx, ty, carriages.boxes);
  }
  if (pecking && above) { // they keep pecking (and taking off) out of sight too: cheap
    pecking.step(dt);
    pecking.draw(ctx, toScreen, px, [0, 0, w, hgt]);
  }
  if (clouds && !mine?.underground) { clouds.step(dt); clouds.draw(ctx, k, tx, ty, w, hgt, px); } // over the town, under the sky
  if (signs && !mine?.underground) { signs.step(dt); signs.draw(ctx, toScreen, [0, 0, w, hgt]); } // part of the buildings: shown with traffic off too
  if (above) { // sky above everything: parakeets or pigeons, light aircraft, then the airliner
    if (parrots) { parrots.step(dt); parrots.draw(ctx, toScreen, k / dpr, [0, 0, w, hgt]); }
    if (pigeons) { pigeons.step(dt); pigeons.draw(ctx, toScreen, k / dpr, [0, 0, w, hgt]); }
    if (airport) { airport.step(dt); airport.draw(ctx, toScreen, [0, 0, w, hgt]); }
    if (lightAircraft) { lightAircraft.step(dt); lightAircraft.draw(ctx, toScreen, k / dpr, [0, 0, w, hgt]); }
    if (planes) { planes.step(dt); planes.draw(ctx, toScreen, k / dpr, [0, 0, w, hgt]); }
  }
  if (fly?.flying) { // over everything; down into the mine it lands
    if (mine?.underground) fly.stop();
    else { fly.step(dt); fly.draw(ctx, toScreen); }
  }
  mine?.draw(ctx, toScreen, px, dpr, [0, 0, w, hgt]);
  if (mark && !mine?.underground) drawMark(dpr, t);
  if (showBorders || k / dpr < 0.05) drawBorders(dpr); // borders appear automatically far out
  lastT = t;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** the spot the search went to: a pin with its name, for a few seconds, then fading */
function drawMark(dpr: number, t: number) {
  const age = (t - mark!.t) / 1000;
  if (age > 8) { mark = null; return; }
  const [x, y] = toScreen(mark!.x, mark!.y), a = Math.min(1, (8 - age) / 1.5), bob = Math.max(0, 1 - age * 2) * 14 * dpr;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.beginPath(); ctx.ellipse(x, y, 7 * dpr, 3 * dpr, 0, 0, 2 * Math.PI); ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fill();
  const py = y - bob;
  ctx.beginPath(); ctx.moveTo(x, py); ctx.bezierCurveTo(x - 11 * dpr, py - 16 * dpr, x - 11 * dpr, py - 30 * dpr, x, py - 30 * dpr);
  ctx.bezierCurveTo(x + 11 * dpr, py - 30 * dpr, x + 11 * dpr, py - 16 * dpr, x, py); ctx.fillStyle = "#d64b3c"; ctx.fill();
  ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = "#fff"; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, py - 21 * dpr, 3.5 * dpr, 0, 2 * Math.PI); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.font = `600 ${13 * dpr}px ui-sans-serif, system-ui, sans-serif`; ctx.textAlign = "center";
  ctx.lineWidth = 3.5 * dpr; ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.fillStyle = "#1f2a37";
  ctx.strokeText(mark!.label, x, py - 37 * dpr); ctx.fillText(mark!.label, x, py - 37 * dpr);
  ctx.restore();
}

// ---- controls ----------------------------------------------------------------------------------
let photo: OpenSeadragon.TiledImage | null = null, photoRequested = false;
function togglePhoto() {
  if (!photo) {
    if (photoRequested) return; // still loading its index
    photoRequested = true;
    layerIndex("photo").then((have) => viewer.addTiledImage({
      tileSource: tileSource("photo", have) as unknown as OpenSeadragon.TileSourceOptions,
      success: (e) => { photo = (e as unknown as { item: OpenSeadragon.TiledImage }).item; },
    }));
  } else photo.setOpacity(photo.getOpacity() > 0 ? 0 : 1);
}

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement)?.closest?.("input, textarea")) return; // typing in the search
  const key = e.key.toLowerCase();
  if (key === "b") showBorders = !showBorders;
  if (key === "t") showTraffic = !showTraffic;
  if (key === "p") togglePhoto();
  if (key === "v") document.body.classList.toggle("video");
});
if (new URLSearchParams(location.search).has("video")) document.body.classList.add("video");

// ---- opening preview (MapPage.astro): the city's view as one small image until the tiles are in ----
const preview = document.getElementById("preview");
function hidePreview(fast: boolean) {
  if (!preview?.isConnected) return;
  preview.style.transition = `opacity ${fast ? 0.15 : 0.45}s ease-out`;
  preview.style.opacity = "0";
  setTimeout(() => preview.remove(), fast ? 200 : 500);
}
if (preview) {
  // the image is laid out for the plain city view only; any gesture moves the map away from it
  for (const ev of ["canvas-press", "canvas-scroll", "canvas-pinch", "canvas-key"] as const) viewer.addOnceHandler(ev, () => hidePreview(true));
  setTimeout(() => hidePreview(false), 15000);
}

// Opening view, first match wins:
//   #@x,y,zoom          deep link (global art px, viewer zoom), kept up to date while you pan
//   ?at=lat,lon[,km]    a place, with the screen width in km (default 1.5)
//   #metro              the whole region with borders
//   otherwise           the page's city (centre + width from places.ts)
viewer.addOnceHandler("open", () => {
  base().addOnceHandler("fully-loaded-change", () => { loadAnimations(); hidePreview(false); }); // first view's tiles are drawn
  const [[y0, x0], [y1, x1]] = world.bounds;
  // never zoom out past the whole metro (all city borders) with a small margin
  let mx0 = x0, my0 = y0, mx1 = x1, my1 = y1;
  for (const c of borders) for (const r of c.rings) for (const [y, x] of r) { mx0 = Math.min(mx0, x); mx1 = Math.max(mx1, x); my0 = Math.min(my0, y); my1 = Math.max(my1, y); }
  const ma = globalToViewport(mx0, my0), mb = globalToViewport(mx1, my1);
  const metro = new OpenSeadragon.Rect(ma.x, ma.y, mb.x - ma.x, mb.y - ma.y);
  const vpw = viewer.viewport.getContainerSize();
  const fitZoom = Math.min(1 / (metro.width * 1.1), (vpw.y / vpw.x) / (metro.height * 1.1));
  Object.assign(viewer.viewport, { minZoomLevel: fitZoom }); // runtime option, missing from typings

  const at = location.hash.match(/^#@(-?[\d.]+),(-?[\d.]+),([\d.]+)$/);
  const ll = new URLSearchParams(location.search).get("at")?.split(",").map(Number);
  /** centre on lat/lon with `widthM` metres across the screen */
  const show = (lat: number, lon: number, widthM: number) => {
    const [x, y] = llhToPixel(lat, lon, REGIONS[REGION].groundH), vp = viewer.viewport; // at the region's typical ground (25 m Tel Aviv, 300 m Stuttgart)
    vp.zoomTo(base().getContentSize().x / (widthM / CAMERA.mpp), undefined, true);
    vp.panTo(globalToViewport(x, y), true);
  };
  if (at) {
    viewer.viewport.panTo(globalToViewport(Number(at[1]), Number(at[2])), true);
    viewer.viewport.zoomTo(Number(at[3]), undefined, true);
  } else if (ll && ll.length >= 2 && ll.slice(0, 3).every(Number.isFinite)) {
    show(ll[0], ll[1], (ll[2] ?? 1.5) * 1000);
  } else if (location.hash === "#metro") {
    showBorders = true;
    viewer.viewport.fitBounds(metro, true);
  } else {
    show(city.center[0], city.center[1], city.widthM);
  }
  viewer.addHandler("animation-finish", () => {
    // fully zoomed out: settle on the metro instead of wherever the cursor was
    if (viewer.viewport.getZoom() <= fitZoom * 1.03) viewer.viewport.panTo(metro.getCenter());
    if (location.hash === "#metro") return;
    const c = base().viewportToImageCoordinates(viewer.viewport.getCenter(true));
    history.replaceState(null, "", `#@${Math.round(c.x + ox)},${Math.round(c.y + oy)},${viewer.viewport.getZoom(true).toFixed(2)}`);
  });
});

document.getElementById("credits")!.innerHTML = [
  `© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>`,
  // the region's own data sources
  ...(REGION === "stuttgart"
    ? [`Datenquelle: <a href="https://www.lgl-bw.de">LGL</a>, <a href="https://www.govdata.de/dl-de/by-2-0">dl-de/by-2-0</a> (verändert)`,
      `<a href="https://opendata.stuttgart.de/dataset/luftbilder-2021">Luftbilder: Landeshauptstadt Stuttgart</a>, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> (verändert)`,
      // the painted landmarks' reference photos (CC BY authors named; all of them in ATTRIBUTION.md)
      `Landmarks after <a href="https://github.com/krasun/isometricworld/blob/main/ATTRIBUTION.md">Wikimedia Commons photos</a> by J. Herzog, A. Praefcke, F. König, Enslin et al. (CC BY, verändert)`]
    : REGION === "zagreb" // Otvorena dozvola: source, date of its last change, link, change notice
      ? [`<a href="https://data.zagreb.hr/dataset/zg3d-2022-3d-model-gz">Grad Zagreb, ZG3D 2022</a> (7. 5. 2025.)`,
        `<a href="https://data.gov.hr/otvorena-dozvola">Otvorena dozvola</a>, izmijenjeno`]
      : REGION === "wieliczka" // GUGiK (PZGiK material, CC BY 4.0) requires this notice: "prepared from the national geodetic and cartographic resource"
        ? [`Opracowano na podstawie materiałów państwowego zasobu geodezyjnego i kartograficznego (<a href="https://www.geoportal.gov.pl/">GUGiK</a>, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>)`]
        : [`<a href="https://opendatasource.tel-aviv.gov.il/">Tel Aviv-Yafo Municipality</a>`]),
  `<span title="© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA">Copernicus DEM</span>`,
  // the salt mine's levels (mine.ts): Hondius's 1645 plan; the facts' sources are listed in the mine panel.
  // Every city of the region can open the mine (Kraków too), so every one credits it
  ...(files.mine ? [`Salt mine: plan by <a href="https://commons.wikimedia.org/wiki/File:Wieliczka_Salt_Mines_2.jpg">W. Hondius, 1645</a> (public domain)`] : []),
  // painted regions say so (their credits in places.ts carry the label for clips too)
  ...(REGIONS[REGION].credits.some((c) => /painted with ai/i.test(c)) ? ["Painted with AI"] : []),
  // the method to recreate the derived database (ODbL) and the code
  `<a href="https://github.com/krasun/isometricworld">Source</a>`,
  REGION === "stuttgart" // the Stuttgart region was built by Lukas Hermann
    ? `Made by <a href="https://lukashermann.dev/">Lukas Hermann</a> with <a href="https://dmytrokrasun.com">Dmytro Krasun</a>`
    : REGION === "zagreb" // the Zagreb region was built by Andrej Šimunaj (ZeroPointStudio)
      ? `Made by <a href="https://zeropointstudio.io">Andrej Šimunaj</a> with <a href="https://dmytrokrasun.com">Dmytro Krasun</a>`
      : REGION === "wieliczka" && document.body.dataset.city === "krakow" // Kraków, a city of the Wieliczka region, by Piotr Kulpiński
        ? `Made by <a href="https://kulpinski.dev">Piotr Kulpiński</a> with <a href="https://dmytrokrasun.com">Dmytro Krasun</a>`
      : REGION === "wieliczka" // the Wieliczka region was built by Maciek Chmura
        ? `Made by <a href="https://maciek.cloud/">Maciek Chmura</a> with <a href="https://dmytrokrasun.com">Dmytro Krasun</a>`
        : `Made by <a href="https://dmytrokrasun.com">Dmytro Krasun</a>`,
// each credit stays on one line; the separator rides at the end of the previous one so no line starts with "·"
].map((c, i, all) => `<span class="credit">${c}${i < all.length - 1 ? " ·" : ""}</span>`).join(" ");
