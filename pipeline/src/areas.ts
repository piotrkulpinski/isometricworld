import { CAMERA, activeRegion, llhToPixel, useRegion } from "./camera.ts";
import { outlinePixels } from "./outline.ts";
import { REGIONS } from "./places.ts";

/** A rendered patch of a region (see places.ts); all pipeline steps work per area. */
export interface Area {
  title: string;
  region: string;
  /** south, west, north, east (WGS84) */
  bbox: [number, number, number, number];
  /** a level of a salt mine (mine.ts, minedata.ts): drawn as a cutaway under the town, exported as its own layer */
  mine?: string;
}

/** The Wieliczka salt mine's levels (mine.ts): the mine's outline (OSM) with a margin, one area per level. */
const MINE_BBOX: [number, number, number, number] = [49.9735, 20.0255, 49.988, 20.0905];
const MINE_LEVELS = ["I", "IIw", "IIn", "III", "IV", "V", "VI", "VII", "VIII", "IX"];

export const AREAS: Record<string, Area> = {
  /** Jaffa → Yarkon Park → Ramat Gan, including the sea off the coast. */
  "tlv-core": {
    title: "Tel Aviv-Yafo · Ramat Gan",
    region: "israel-center",
    bbox: [32.035, 34.735, 32.108, 34.835],
  },
  /** Small test patch around Rothschild Blvd. */
  rothschild: {
    title: "Rothschild Blvd",
    region: "israel-center",
    bbox: [32.0605, 34.7705, 32.0675, 34.7795],
  },
  /** Stuttgart test patch: Schlossplatz, Königstraße, Altes Schloss, Hauptbahnhof's south end (~1 km). */
  schlossplatz: {
    title: "Schlossplatz",
    region: "stuttgart",
    bbox: [48.774, 9.173, 48.783, 9.1865],
  },
  /** The Kessel from Heslach to the Neckar, with Bad Cannstatt. */
  "stuttgart-core": {
    title: "Stuttgart · Kessel · Bad Cannstatt",
    region: "stuttgart",
    bbox: [48.755, 9.145, 48.81, 9.235],
  },
  // The rest of the city limits (+ EDDS) around the core, in boxes of ~150 km² (LoD2 + crowns in memory).
  // Neighbours overlap by ≥ 1 km so the inner seams stay opaque; places.ts `outline` trims them to the city.
  /** Weilimdorf, Feuerbach, Zuffenhausen (west half). */
  "stuttgart-north-west": { title: "Weilimdorf · Feuerbach · Zuffenhausen", region: "stuttgart", bbox: [48.798, 9.035, 48.87, 9.185] },
  /** Zuffenhausen (east), Stammheim, Mühlhausen, Münster. */
  "stuttgart-north-east": { title: "Stammheim · Mühlhausen · Münster", region: "stuttgart", bbox: [48.798, 9.17, 48.87, 9.32] },
  /** Botnang, Rotwildpark. */
  "stuttgart-west": { title: "Botnang", region: "stuttgart", bbox: [48.755, 9.035, 48.81, 9.16] },
  /** Untertürkheim, Wangen, Hedelfingen, Obertürkheim. */
  "stuttgart-east": { title: "Untertürkheim · Hedelfingen", region: "stuttgart", bbox: [48.755, 9.22, 48.81, 9.32] },
  /** Vaihingen, Möhringen. */
  "stuttgart-south-west": { title: "Vaihingen · Möhringen", region: "stuttgart", bbox: [48.668, 9.035, 48.767, 9.185] },
  /** Degerloch, Sillenbuch, Birkach, Plieningen, Stuttgart Airport (EDDS) and the Messe. */
  "stuttgart-south-east": { title: "Degerloch · Plieningen · Stuttgart Airport", region: "stuttgart", bbox: [48.668, 9.17, 48.767, 9.32] },
  // The towns around the city (region outline): a ring of areas around the ones above.
  "metro-north-west": { title: "Ditzingen · Korntal-Münchingen · Kornwestheim", region: "stuttgart", bbox: [48.865, 9.03, 48.935, 9.185] },
  "metro-north-east": { title: "Ludwigsburg · Remseck am Neckar", region: "stuttgart", bbox: [48.865, 9.17, 48.935, 9.33] },
  // the eastern and western strips are split in two: a 17 km tall area's terrain mesh (>20 M vertices) crashes the render page
  "metro-east-north": { title: "Waiblingen", region: "stuttgart", bbox: [48.855, 9.315, 48.935, 9.445] },
  "metro-east-north-2": { title: "Fellbach", region: "stuttgart", bbox: [48.78, 9.315, 48.86, 9.445] },
  "metro-east-south": { title: "Esslingen am Neckar", region: "stuttgart", bbox: [48.70, 9.315, 48.785, 9.445] },
  "metro-east-south-2": { title: "Ostfildern", region: "stuttgart", bbox: [48.62, 9.315, 48.705, 9.445] },
  "metro-south-west": { title: "Leinfelden-Echterdingen (west) · Böblingen (east)", region: "stuttgart", bbox: [48.62, 9.03, 48.673, 9.185] },
  "metro-south-east": { title: "Filderstadt · Leinfelden-Echterdingen", region: "stuttgart", bbox: [48.62, 9.17, 48.673, 9.33] },
  "metro-west-north": { title: "Ditzingen (west)", region: "stuttgart", bbox: [48.85, 8.9, 48.935, 9.04] },
  "metro-west-north-2": { title: "Leonberg · Gerlingen", region: "stuttgart", bbox: [48.77, 8.9, 48.855, 9.04] },
  "metro-west-south": { title: "Sindelfingen", region: "stuttgart", bbox: [48.70, 8.9, 48.775, 9.04] },
  "metro-west-south-2": { title: "Böblingen", region: "stuttgart", bbox: [48.62, 8.9, 48.705, 9.04] },
  /** Zagreb test patch: Trg bana Jelačića, Dolac, Kaptol and the Cathedral, Gornji grad, Zrinjevac (~1.1 × 1.4 km). */
  jelacic: { title: "Trg bana Jelačića · Gornji grad", region: "zagreb", bbox: [45.808, 15.966, 45.818, 15.984] },
  // The city in boxes of ≤ ~60 km², overlapping ≥ 1 km; places.ts `outline` trims them to the 17 districts.
  /** Donji and Gornji grad, Trnje, Trešnjevka sjever, Maksimir park, Glavni kolodvor. */
  "zagreb-core": { title: "Donji grad · Gornji grad · Trnje", region: "zagreb", bbox: [45.785, 15.935, 45.830, 16.030] },
  /** The Sava and its bridges, Novi Zagreb istok and zapad, Bundek, Arena. */
  "zagreb-south": { title: "Novi Zagreb · Sava", region: "zagreb", bbox: [45.745, 15.915, 45.795, 16.055] },
  /** Črnomerec, Stenjevec, Podsused–Vrapče, Jarun, Trešnjevka jug. */
  "zagreb-west": { title: "Črnomerec · Stenjevec · Jarun", region: "zagreb", bbox: [45.770, 15.840, 45.840, 15.945] },
  /** Maksimir, Peščenica–Žitnjak, Donja and Gornja Dubrava. */
  "zagreb-east": { title: "Maksimir · Dubrava · Peščenica", region: "zagreb", bbox: [45.770, 16.020, 45.845, 16.110] },
  /** Sesvete. */
  "zagreb-sesvete": { title: "Sesvete", region: "zagreb", bbox: [45.795, 16.100, 45.870, 16.190] },
  /** Podsljeme foothills: Šestine, Gračani, Markuševec (the ridge of Medvednica stays out). */
  "zagreb-north": { title: "Podsljeme", region: "zagreb", bbox: [45.825, 15.900, 45.865, 16.060] },
  /** Brezovica. */
  "zagreb-southwest": { title: "Brezovica", region: "zagreb", bbox: [45.700, 15.860, 45.775, 15.975] },
  /** Zagreb Airport (LDZA, in Velika Gorica): the runway the airliners land on. */
  "zagreb-airport": { title: "Zagreb Airport", region: "zagreb", bbox: [45.715, 16.035, 45.762, 16.100] },
  // The rest of the city inside the outline (found with a tile-coverage check): rural Brezovica, the edges.
  /** Brezovica's villages and fields, west (Kupinečki Kraljevec, Lučko's south). */
  "zagreb-brezovica-west": { title: "Brezovica (west)", region: "zagreb", bbox: [45.612, 15.770, 45.742, 15.875] },
  /** Brezovica, east (Odranski Obrež, Hrvatski Leskovac). */
  "zagreb-brezovica-east": { title: "Brezovica (east)", region: "zagreb", bbox: [45.612, 15.865, 45.742, 15.980] },
  /** Odra and Hrelić, south of Novi Zagreb. */
  "zagreb-odra": { title: "Odra · Hrelić", region: "zagreb", bbox: [45.700, 15.970, 45.750, 16.035] },
  /** Podsused, Gornje Vrapče and the hills above them, down to the Sava. */
  "zagreb-northwest": { title: "Podsused · Gornje Vrapče", region: "zagreb", bbox: [45.758, 15.815, 45.874, 15.910] },
  /** The strip under the outline's cut across Medvednica (45.87°). */
  "zagreb-ridge": { title: "Medvednica slopes", region: "zagreb", bbox: [45.858, 15.895, 45.874, 16.065] },
  /** Gornja Dubrava's and Sesvete's hills (Markuševec, Kašina's south). */
  "zagreb-northeast": { title: "Gornja Dubrava · Sesvete hills", region: "zagreb", bbox: [45.835, 16.050, 45.874, 16.170] },
  /** Sesvete, east (Dumovec, Soblinec, Glavnica). */
  "zagreb-sesvete-east": { title: "Sesvete (east)", region: "zagreb", bbox: [45.770, 16.160, 45.874, 16.245] },
  /** Between Žitnjak, the Sava and the airport (Kosnica, Ivanja Reka). */
  "zagreb-southeast": { title: "Žitnjak · Ivanja Reka", region: "zagreb", bbox: [45.755, 16.040, 45.800, 16.170] },
  /** Wieliczka test patch: Rynek Górny, Zamek Żupny, the Regis, Daniłowicza and Kinga shafts, the graduation
   *  tower, the Rynek-Kopalnia station, St Clement's and St Sebastian's (~1.2 × 1.4 km). */
  "wieliczka-rynek": { title: "Wieliczka · Rynek Górny · Kopalnia", region: "wieliczka", bbox: [49.977, 20.049, 49.988, 20.068] },
  /** The whole town (OSM relation 2751961: 49.971–50.005 N, 20.003–20.089 E) and a ~650 m ring around it, so
   *  the faded map edge (up to ~640 m wide) falls on the villages and Kraków, not on the town; north to past
   *  the A4 (50.000–50.018 N). */
  "wieliczka-town": { title: "Wieliczka", region: "wieliczka", bbox: [49.965, 19.994, 50.024, 20.098] },
  /** Kraków test patch: the Barbican and Rynek Główny south past Wawel to the Vistula's far bank (~2.2 × 2.6 km), so
   *  Wawel stays clear of the faded map edge. */
  "krakow-test": { title: "Kraków · Old Town and Wawel", region: "wieliczka", bbox: [50.0445, 19.9195, 50.0675, 19.9505] },
  // The whole of Kraków (OSM relation 449696: 49.967–50.126 N, 19.792–20.217 E) in a grid of 5 × 3 boxes of ~50 km²
  // (≈ 7.1 × 7.2 km), overlapping ~1 km; places.ts `outline` trims them to the city (and the gmina Wieliczka).
  "krakow-south-1": { title: "Kraków · Tyniec", region: "wieliczka", bbox: [49.962, 19.785, 50.027, 19.885] },
  "krakow-south-2": { title: "Kraków · Łagiewniki · Kurdwanów", region: "wieliczka", bbox: [49.962, 19.870, 50.027, 19.970] },
  "krakow-south-3": { title: "Kraków · Prokocim · Bieżanów", region: "wieliczka", bbox: [49.962, 19.955, 50.027, 20.055] },
  "krakow-south-4": { title: "Kraków · Rybitwy · Przewóz", region: "wieliczka", bbox: [49.962, 20.040, 50.027, 20.140] },
  "krakow-south-5": { title: "Kraków · Branice (south)", region: "wieliczka", bbox: [49.962, 20.125, 50.027, 20.225] },
  "krakow-mid-1": { title: "Kraków · Zwierzyniec · Bielany · Las Wolski", region: "wieliczka", bbox: [50.017, 19.785, 50.082, 19.885] },
  "krakow-mid-2": { title: "Kraków · Old Town · Kazimierz · Podgórze", region: "wieliczka", bbox: [50.017, 19.870, 50.082, 19.970] },
  "krakow-mid-3": { title: "Kraków · Grzegórzki · Czyżyny · Płaszów", region: "wieliczka", bbox: [50.017, 19.955, 50.082, 20.055] },
  "krakow-mid-4": { title: "Kraków · Nowa Huta", region: "wieliczka", bbox: [50.017, 20.040, 50.082, 20.140] },
  "krakow-mid-5": { title: "Kraków · Branice · Kościelniki", region: "wieliczka", bbox: [50.017, 20.125, 50.082, 20.225] },
  "krakow-north-1": { title: "Kraków · Bronowice · Mydlniki", region: "wieliczka", bbox: [50.072, 19.785, 50.137, 19.885] },
  "krakow-north-2": { title: "Kraków · Krowodrza · Prądnik Biały", region: "wieliczka", bbox: [50.072, 19.870, 50.137, 19.970] },
  "krakow-north-3": { title: "Kraków · Prądnik Czerwony · Mistrzejowice", region: "wieliczka", bbox: [50.072, 19.955, 50.137, 20.055] },
  "krakow-north-4": { title: "Kraków · Bieńczyce · Wzgórza Krzesławickie", region: "wieliczka", bbox: [50.072, 20.040, 50.137, 20.140] },
  "krakow-north-5": { title: "Kraków · Grębałów · Wadów", region: "wieliczka", bbox: [50.072, 20.125, 50.137, 20.225] },
  ...Object.fromEntries(MINE_LEVELS.map((id) => [`wieliczka-mine-${id}`, { title: `Salt mine · level ${id}`, region: "wieliczka", bbox: MINE_BBOX, mine: id }])),
  /** the first level on Hondius's 1645 plan (mine.ts build1645) */
  "wieliczka-mine-1645": { title: "Salt mine · level I in 1645", region: "wieliczka", bbox: MINE_BBOX, mine: "1645" },
};

// A region drawn on another's grid (places.ts gridOf), named by REGION=<id> or as a CLI argument (export -- krakow):
// its areas are the grid region's that match its `areas`, for this whole process (siblings, exports, archives)
const VIEW = process.env.REGION ?? process.argv.slice(2).find((a) => REGIONS[a]?.gridOf);
if (VIEW) {
  const r = REGIONS[VIEW];
  if (!r) throw new Error(`REGION=${VIEW}: unknown region`);
  if (r.gridOf) for (const [n, a] of Object.entries(AREAS)) if (a.region === r.gridOf && new RegExp(r.areas ?? "").test(n)) a.region = VIEW;
}

/** Look up an area and switch the camera to its region: call before any projection. */
export function openArea(name: string): Area {
  const area = AREAS[name];
  if (!area) throw new Error(`unknown area ${name}`);
  useRegion(area.region);
  return area;
}

/** Typical ground ellipsoid height of the active region (area outlines, first guess before the terrain). */
export const groundH = () => REGIONS[activeRegion()].groundH;

type Pt = [number, number];

/** Area outline in global art pixels (the bbox projected at ground level: a slanted quad). */
export function areaPolygon(bbox: [number, number, number, number]): Pt[] {
  const [s, w, n, e] = bbox;
  return [[s, w], [s, e], [n, e], [n, w]].map(([lat, lon]) => llhToPixel(lat, lon, groundH()));
}

export function inside([x, y]: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Render tiles whose centre lies inside the area outline (and that touch the region's outline, if it has one). */
export function areaTiles(bbox: [number, number, number, number]) {
  const poly = areaPolygon(bbox), shape = outlinePixels(), T = CAMERA.tile;
  const inShape = (tx: number, ty: number) => !shape || [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]
    .some(([a, b]) => shape.some((r) => inside([(tx + a) * T, (ty + b) * T], r)));
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const out: Array<[number, number]> = [];
  for (let ty = Math.floor(Math.min(...ys) / CAMERA.tile); ty <= Math.floor(Math.max(...ys) / CAMERA.tile); ty++)
    for (let tx = Math.floor(Math.min(...xs) / CAMERA.tile); tx <= Math.floor(Math.max(...xs) / CAMERA.tile); tx++)
      if (inside([(tx + 0.5) * CAMERA.tile, (ty + 0.5) * CAMERA.tile], poly) && inShape(tx, ty)) out.push([tx, ty]);
  return out;
}

/** Distance (art px) from a point inside an outline to its nearest edge; 0 outside. */
export function insideDistance([x, y]: Pt, poly: Pt[]) {
  if (!inside([x, y], poly)) return 0;
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0; // repeated vertex: no 0/0
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
}
