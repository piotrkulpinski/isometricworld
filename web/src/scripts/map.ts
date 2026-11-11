import OpenSeadragon from "openseadragon";
// traffic, cats and sky are loaded after the first view (loadAnimations): not in the first script
import type { Traffic } from "./traffic.ts";
import type { Cats } from "./cats.ts";
import type { Carriages } from "./carriages.ts";
import type { Trams } from "./trams.ts";
import type { Planes, Parrots, Pigeons, Airport } from "./sky.ts";
import { CAMERA, ecefToEnu, llhToEcef, llhToPixel, useRegion } from "../../../pipeline/src/camera.ts";
import { CITIES, REGIONS, type Fauna } from "../../../pipeline/src/places.ts";
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
  files?: { "tiles-map"?: string; "tiles-photo"?: string; borders?: string; roads?: string; trams?: string };
  format?: string;
}
type Index = Record<number, Record<string, string>>; // zoom → "x_y" → content hash
interface Border { id: number; name: string; name_en?: string; rings: Array<Array<[number, number]>>; label?: [number, number] }

// the page says which city it is; the city's region is one flat map under /regions/<region>/
const city = CITIES[document.body.dataset.city!], REGION = document.body.dataset.region!, region = REGIONS[REGION];
/** the region's animated local life (places.ts), e.g. cats and parakeets in Tel Aviv */
const fauna = <K extends Fauna["kind"]>(kind: K) => region.fauna.find((f): f is Extract<Fauna, { kind: K }> => f.kind === kind);
// map data lives on R2; the dev server serves /regions from the export cache, falling back to R2
const BASE = `${import.meta.env.DEV ? "" : __TILES_ORIGIN__}/regions/${REGION}`;
useRegion(REGION);
const json = <T>(file: string) => fetch(`${BASE}/data/${file}`).then((r) => r.json() as Promise<T>);
// the page preloads the data files named in world.json at build time (MapPage.astro); world.json is
// the truth (a publish after the build renames them; those preloads then go unused)
const worldReady = json<World>("world.json");
// AVIF tiles (40% smaller); browsers without AVIF get the last WebP pyramid (data/tiles.json)
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
      return `${BASE}/tiles/${layer}/${level}/${tx}/${ty}.${EXT}?v=${have[level][`${tx}_${ty}`]}`; // immutable URL per content
    },
    tileExists: (level: number, x: number, y: number) => {
      const [tx, ty] = global(level, x, y);
      return have[level]?.[`${tx}_${ty}`] !== undefined;
    },
  };
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
  minPixelRatio: 0.8,     // fetch the finer level only once it is really needed (~40% fewer bytes)
  maxImageCacheCount: 600,
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
let traffic: Traffic | null = null, cats: Cats | null = null, parrots: Parrots | null = null, planes: Planes | null = null;
let pigeons: Pigeons | null = null, carriages: Carriages | null = null, trams: Trams | null = null, trafficClear = false;
// the animations (their code and the roads, ~0.7 MB) wait until the first view's tiles are in
let animationsRequested = false;
function loadAnimations() {
  if (animationsRequested) return;
  animationsRequested = true;
  const carriageCfg = fauna("carriages"), pigeonCfg = fauna("pigeons");
  Promise.all([
    import("./traffic.ts"), fauna("cats") ? import("./cats.ts") : null, import("./sky.ts"), import("./roads.ts"),
    carriageCfg ? import("./carriages.ts") : null,
    fetch(`${BASE}/data/${files.roads ?? "roads.json"}`).then((r) => (r.ok ? r.json() : [])),
    fauna("trams") && files.trams
      ? Promise.all([import("./trams.ts"), fetch(`${BASE}/data/${files.trams}`).then((r) => (r.ok ? r.json() : null))])
      : null,
  ]).then(([{ Traffic }, catsModule, { Planes, Parrots, Pigeons }, { decodeRoads, decodeTrams, groundLookup }, carriagesModule, data, tramData]) => {
    const roads = decodeRoads(data);
    // places.ts is the truth for the airport (world.json has it only after a re-export)
    const airport = region.airport ?? world.airport;
    if (airport) planes = new Planes(world.enu2px, airport);
    const fwd: [number, number] = [Math.sin(heading), Math.cos(heading)];
    if (roads.length) traffic = new Traffic(roads, world.enu2px, fwd);
    if (tramData?.[1]) {
      const { tracks, stops } = decodeTrams(tramData[1]);
      if (tracks.length) trams = new tramData[0].Trams(tracks, stops, world.enu2px, fwd);
      if (tracks.length) traffic?.useTracks(tracks);
    }
    if (roads.length && catsModule) cats = new catsModule.Cats(roads, world.enu2px);
    if (roads.length && carriagesModule && carriageCfg) carriages = new carriagesModule.Carriages(world.enu2px, carriageCfg.loop, carriageCfg.count, roads, fwd);
    if (roads.length && pigeonCfg) { // squares on the map, standing on the height of the nearest street
      const ground = groundLookup(roads, 150);
      const plazas = pigeonCfg.plazas.flatMap((p) => {
        const [e, n] = ecefToEnu(llhToEcef(p.lat, p.lon, 0)), g = ground(e, n);
        return g ? [{ e, n, u: g.u, r: p.r }] : [];
      });
      if (plazas.length) pigeons = new Pigeons(world.enu2px, plazas);
    }
    if (roads.length && fauna("parakeets")) { // parakeets roam over the streets' extent
      const a = [Infinity, Infinity, -Infinity, -Infinity];
      for (const r of roads) for (let i = 0; i < r.s.length; i += 4) {
        a[0] = Math.min(a[0], r.s[i]); a[1] = Math.min(a[1], r.s[i + 1]); a[2] = Math.max(a[2], r.s[i]); a[3] = Math.max(a[3], r.s[i + 1]);
      }
      parrots = new Parrots(world.enu2px, a);
    }
    Object.assign(window as object, { __traffic: traffic, __cats: cats, __parrots: parrots, __planes: planes, __pigeons: pigeons, __carriages: carriages, __trams: trams });
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
    const label = c.name_en === "Tel-Aviv" ? "Tel Aviv-Yafo" : c.name_en ?? c.name;
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
  if (trams && showTraffic && px >= 0.14) {
    if (traffic) { trams.obstacles = traffic.centres(); traffic.obstacles = trams.points; } // trams and cars keep clear of each other
    trams.step(dt);
    if (traffic && !trafficClear && trams.points.length) { traffic.clearOf(trams.points); trafficClear = true; } // no car starts inside a tram
    trams.draw(ctx, toScreen, px, [0, 0, w, hgt]);
  }
  if (traffic && showTraffic && px >= 0.14) {
    traffic.step(dt);
    traffic.draw(ctx, toScreen, px, [0, 0, w, hgt]);
  }
  if (carriages && showTraffic && px >= 0.2) {
    carriages.step(dt);
    carriages.draw(ctx, toScreen, px, [0, 0, w, hgt]);
  }
  if (cats && showTraffic && px >= 0.6) {
    cats.step(dt);
    cats.draw(ctx, toScreen, px, [0, 0, w, hgt]);
  }
  if (showTraffic) { // sky above everything: birds, then the airliner
    if (pigeons) { pigeons.step(dt); pigeons.draw(ctx, toScreen, k / dpr, [0, 0, w, hgt]); }
    if (parrots) { parrots.step(dt); parrots.draw(ctx, toScreen, k / dpr, [0, 0, w, hgt]); }
    if (planes) { planes.step(dt); planes.draw(ctx, toScreen, k / dpr, [0, 0, w, hgt]); }
  }
  if (showBorders || k / dpr < 0.05) drawBorders(dpr); // borders appear automatically far out
  lastT = t;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

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
    const [x, y] = llhToPixel(lat, lon, region.groundH), vp = viewer.viewport; // on the ground (Tel Aviv 25 m, Kraków 235 m)
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
  // the region's own source (municipal GIS, national survey), from places.ts
  ...(region.sourceCredit ? [`<a href="${region.sourceCredit.href}"${region.sourceCredit.title ? ` title="${region.sourceCredit.title}"` : ""}>${region.sourceCredit.label}</a>`] : []),
  `<span title="© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA">Copernicus DEM</span>`,
  // the method to recreate the derived database (ODbL) and the code
  `<a href="https://github.com/krasun/isometricworld">Source</a>`,
  `Made by <a href="https://dmytrokrasun.com">Dmytro Krasun</a>`,
// each credit stays on one line; the separator rides at the end of the previous one so no line starts with "·"
].map((c, i, all) => `<span class="credit">${c}${i < all.length - 1 ? " ·" : ""}</span>`).join(" ");
