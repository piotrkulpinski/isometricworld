/**
 * Regions and cities of Isometric World. Pure data, shared by the pipeline and the web viewer.
 *
 * A REGION is one flat map: one orthographic camera in a local East-North-Up frame at its origin,
 * one tile pyramid (web/public/regions/<id>/). A flat map is accurate to ~1° of building lean at
 * 100 km from its origin, so a region can hold all cities within ~150 km and you scroll between them.
 * Far-apart cities get their own region (joined later by a world overview).
 *
 * A CITY is a named view into a region: /<city-slug> opens the region centred on it.
 */

import type { StyleName } from "./styles.ts";

export interface Region {
  title: string;
  /**
   * A region drawn on another region's grid (`gridOf`: same origin, heading and heights, so that region's areas,
   * renders and paintings serve it unchanged). REGION=<this id> on any CLI gives it the grid region's areas whose
   * names match the regex `areas` (areas.ts): Kraków's city map out of the Wieliczka region's Kraków areas.
   */
  gridOf?: string;
  areas?: string;
  /** ENU origin. Fixed forever once tiles exist: changing it moves every tile of the region. */
  origin: { lat: number; lon: number; h: number };
  /** Compass bearing the camera looks toward (pick it diagonal to the main street grid). */
  headingDeg: number;
  /** OSM country (name:en of the admin_level=2 area) and municipality names (admin_level=8) for the border overlay. */
  country: string;
  municipalities: string[];
  /** admin_level values of the border overlay's municipalities (default ["8"]; a city-county like Stuttgart is 6). */
  adminLevels?: string[];
  /**
   * Where `boundaries` reads the borders: Overpass (default), or the region's `osmExtract`. The extract only
   * holds what Geofabrik cut: use it when every municipality lies well inside it (Croatia for Zagreb).
   */
  boundariesFrom?: "overpass" | "extract";
  /**
   * Airliners on final approach drawn over the map (optional): runway threshold, true heading,
   * threshold ellipsoid height (default 0) and the stretch drawn in metres before the threshold
   * (default 22000 → 7000; negative = past it, on the runway), and optionally braking after touchdown (m/s²;
   * default none: the plane rolls on at approach speed). web/src/scripts/sky.ts.
   */
  airport?: {
    lat: number; lon: number; runwayHeadingDeg: number; h?: number; from?: number; to?: number; brake?: number;
    /**
     * Ground traffic (web/src/scripts/airport.ts): bbox [s, w, n, e] of the OSM taxi network that export
     * writes to data/airport.<hash>.json, and the stand refs jets park at (regex). Then airliners land, taxi
     * to a stand, push back and take off from the threshold end of the same runway instead of fading out.
     */
    ground?: { bbox: [number, number, number, number]; stands: string };
  };
  /**
   * Local rolling stock for the animated trains (export.ts exportTrains, web/src/scripts/trains.ts). Unset: route=tram
   * lines run as Stadtbahn (kind 0) in Stuttgart's SSB and DB looks. "zet": route=tram lines are street trams
   * (kind 4: ZET TMK 2200 and ČKD T4 sets at city speeds), mainline trains in HŽPP colours, and the funiculars
   * (railway=funicular, no route relation) shuttle their cars (kind 5). `night`: refs of night-only lines, left
   * out (the map shows the day); `interval`: minutes between trams of a line (default `tramInterval`).
   * `mainline`: where route relations are single trains rather than lines (HŽPP: "Vlak 983"), refs matching `line`
   * are lines running every `every` min, the others single trains `single` min apart (a few a day: rarely seen).
   */
  rail?: {
    stock: "zet" | "mpk"; tramInterval: number; interval?: Record<string, number>; night?: string[];
    mainline?: { line: string; every: number; single: number };
  };
  /** Squares the pigeon flocks wheel over (web/src/scripts/sky.ts Pigeons), lat/lon; Tel Aviv has its parakeets instead. */
  pigeons?: Array<[number, number]>;
  /**
   * Viewer effects (web/src/scripts): fly, a biplane to fly over the map (fly.ts; a button and F take off and
   * land); clouds, their shadows drifting over the map (clouds.ts); search, a box finding streets and places by
   * name (search.ts; export.ts writes the index).
   */
  effects?: { fly?: boolean; clouds?: boolean; search?: boolean };
  /**
   * Life on the map (web/src/scripts). `vehicles: "detailed"`: cars drawn as body and cabin with windows and
   * lights (hatchbacks, saloons, SUVs, vans), buses with their window band, shadows cast like the render's
   * (traffic.ts). `coaches`: a tourist site's coach parks, each a row of parked coaches as measured on the
   * orthophoto (its centre, the coaches' heading and the row's direction in compass °, how many, metres
   * apart); coaches drive to and from them on the roads. `pigeons`: squares with a flock pecking on the paving
   * and taking off now and then (pigeons.ts; the region's `pigeons` are flocks wheeling in the air instead).
   * `foreground` (styled look): the render also writes what stands higher than a car (crowns, walls and roofs
   * above ~2.5 m), exported as the "fg" tile layer and drawn back over the vehicles (foreground.ts), so they
   * pass under trees and behind houses, partly covered, instead of fading out there.
   */
  life?: {
    vehicles?: "detailed";
    foreground?: boolean;
    coaches?: Array<{ name: string; at: [number, number]; heading: number; row: number; count: number; step: number }>;
    pigeons?: Array<{ name: string; at: [number, number]; r: number; count: number }>;
    /** horse-drawn carriages walking round a closed loop of [lat, lon] (carriages.ts: Kraków's dorożki round Rynek Główny) */
    carriages?: { loop: Array<[number, number]>; count: number };
  };
  /** Small airfield with light aircraft taking off, flying its routes and landing (optional). web/src/scripts/sky.ts. */
  airfield?: Airfield;
  /** Rotating rooftop signs, drawn in 3D over the map (web/src/scripts/sky.ts `Signs`). */
  signs?: RoofSign[];
  /** Credit lines (video mode and footer). */
  credits: string[];
  /** Geoid undulation at the origin (EGM2008, m): sea level as ellipsoid height. */
  geoidM: number;
  /** Typical ground ellipsoid height (m): area outlines and the first guess before the terrain is known. */
  groundH: number;
  /**
   * Ellipsoid height (m) the height pass counts from: it stores 0…655 m above `heightBase - 100`
   * (cm, 16 bit), so a hilly region shifts it to keep its valleys and towers in range. Default 0.
   */
  heightBase?: number;
  /**
   * Where buildings, trees and terrain come from beyond OSM (data only; how they are drawn is `look`):
   *   "tlv"  Tel Aviv-Yafo municipal GIS (buildings + canopy), Copernicus GLO-30 terrain
   *   "lgl"  LGL Baden-Württemberg open data: LoD2 buildings, nDOM1 tree crowns, DGM1 terrain
   *   "zg3d" City of Zagreb ZG3D 2022 LoD2 buildings (zg3d.ts), OSM trees, Copernicus GLO-30 terrain
   *   "gugik" GUGiK (Poland) open data: LoD2 + LoD1 2024 buildings with their BDOT10k function, the buildings
   *          they lack from BDOT10k and OSM outlines (roofs fitted to the NMPT: fitroof.ts), tree crowns from
   *          NMPT − NMT, NMT terrain (gugik.ts; the powiats in `teryt`)
   *   unset  OSM buildings and trees, Copernicus GLO-30 terrain
   */
  sources?: "tlv" | "lgl" | "zg3d" | "gugik";
  /** sources "gugik": TERYT codes of the powiats (counties) whose buildings the areas need, e.g. ["1219"]. */
  teryt?: string[];
  /**
   * How the map is drawn:
   *   "painted"  (default) the render is only the input: every window is repainted by the image model (paint.ts)
   *   "styled"   the renderer draws the finished look itself (STYLED in page/renderer.ts): LoD2 roofs and
   *              facades, hillshade, outlines, OSM roof/facade colours, landmarks, tunnel portals, bridge models
   * Only the styled look draws LoD2 meshes, so a region with LoD2 buildings ("lgl") needs "styled".
   */
  look?: "painted" | "styled";
  /** look "styled": the preset in styles.ts (shadows, palettes…; default "stuttgart"). */
  style?: StyleName;
  /** OSM from this Geofabrik .osm.pbf extract (osmlocal.ts) instead of the Overpass API. */
  osmExtract?: string;
  /**
   * Shape of the map (outline.ts): the union of OSM boundary relations (from `osmExtract`) plus extra
   * boxes [s, w, n, e]. Only tiles inside are fetched and rendered, and the map edge fades along its
   * outer border (not along borders between the relations). Default: the areas' bboxes.
   */
  outline?: {
    relations: number[];
    add?: Array<[number, number, number, number]>;
    /** Box [s, w, n, e] the relations are cut to (a mountain beyond the height pass's range stays out). */
    clip?: [number, number, number, number];
    /**
     * Keep only what lies west of this line, [lat, lon] points ordered south to north (a road: Kraków's S7 eastern
     * bypass); beyond its ends it runs on due north and due south. The outline's cut edge follows the line.
     */
    westOf?: Array<[number, number]>;
  };
}

/** [lat, lon] or [lat, lon, metres above the field (default `agl`)] */
type Fix = [number, number] | [number, number, number];

/**
 * A small airfield (Echo-class planes and ultralights), one runway direction. A flight is one of:
 *   departure  take off, `out`, one of `exits` (fades out)
 *   arrival    one of `entries` (fades in), `in`, land
 *   circuit    take off, `out`, `circuit`, `in`, land
 */
/** A three-pointed star in a ring on a mast, turning about the vertical (the Bonatzbau tower's). */
export interface RoofSign {
  /** foot of the mast: roof centre, ellipsoid height (m) */
  lat: number; lon: number; h: number;
  diameterM: number; mastM: number; rpm: number;
}

export interface Airfield {
  /** threshold of the landing/take-off direction and the far runway end: [lat, lon, ellipsoid h] */
  runway: [[number, number, number], [number, number, number]];
  /** height of the route legs above the threshold (m) */
  agl: number;
  out: Fix[]; exits: Fix[][]; circuit: Fix[]; in: Fix[]; entries: Fix[][];
}

export interface City {
  title: string;
  region: string;
  /** Opening view: centre and on-screen width in metres. */
  center: [number, number];
  widthM: number;
}

export const REGIONS: Record<string, Region> = {
  "israel-center": {
    title: "Israel · Center",
    origin: { lat: 32.0778, lon: 34.774, h: 0 }, // Dizengoff Square
    headingDeg: 340, // 20° west of north: diagonal to Tel Aviv's grid, sea on the left
    country: "Israel",
    municipalities: [
      "תל־אביב–יפו", // maqaf + en dash, as in OSM relation 1382494
      "רמת גן",
      "גבעתיים",
      "בני ברק",
      "חולון",
      "בת ים",
      "הרצליה",
      "רמת השרון",
      "פתח תקווה",
      "קריית אונו",
      "אור יהודה",
      "גבעת שמואל",
    ],
    airport: { lat: 32.0055, lon: 34.8854, runwayHeadingDeg: 117 }, // Ben Gurion, runway 12
    credits: [
      "Map data © OpenStreetMap contributors · Tel Aviv-Yafo Municipality",
      "Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI",
    ],
    geoidM: 19.1,
    groundH: 25,
    sources: "tlv",
  },
  stuttgart: {
    title: "Stuttgart",
    origin: { lat: 48.7784, lon: 9.18, h: 0 }, // Schlossplatz
    headingDeg: 257, // looks WSW from the Neckar side, where the Kessel opens; main grid (Königstraße, 212°) at 45°
    country: "Germany",
    municipalities: [
      "Stuttgart", "Fellbach", "Kernen im Remstal", "Esslingen am Neckar", "Ostfildern", "Neuhausen auf den Fildern",
      "Filderstadt", "Leinfelden-Echterdingen", "Sindelfingen", "Leonberg", "Gerlingen", "Ditzingen",
      "Korntal-Münchingen", "Kornwestheim", "Remseck am Neckar", "Waiblingen", "Ludwigsburg", "Böblingen",
    ],
    adminLevels: ["6", "8"], // Stuttgart is a city-county (admin_level 6), its neighbours are 8
    // pigeon flocks (web/src/scripts/sky.ts Pigeons): Schlossplatz, Marktplatz, Karlsplatz (OSM place=square
    // centroids) and Bad Cannstatt's Wilhelmsplatz (a junction in OSM: at the Wassersäule fountain)
    pigeons: [[48.7784, 9.17978], [48.7752, 9.17843], [48.77663, 9.1811], [48.80345, 9.21697]],
    credits: [
      "Map data © OpenStreetMap contributors · Datenquelle: LGL, www.lgl-bw.de, dl-de/by-2-0 (verändert)",
      "Buildings: LGL LoD2 · Terrain: LGL DGM1, Copernicus DEM © DLR, Airbus DS · Trees: LGL nDOM1",
      "Luftbilder: Landeshauptstadt Stuttgart, Stadtmessungsamt, CC BY 4.0 (verändert) · Centre painted with AI",
      // reference photos of the painted landmarks (ATTRIBUTION.md): the CC BY authors are named
      "Landmarks painted after Wikimedia Commons photos by J. Herzog, A. Praefcke, F. König, Enslin et al. (CC BY; verändert)",
    ],
    // Stuttgart Airport (EDDS) runway 25: threshold and true heading from OSM (way 164016757, node 10710079299),
    // threshold ground 359.9 m NHN from LGL DGM1 (+ geoid 48.4). Planes come in from the east over the faded
    // edge, cross the threshold at 30 m and roll out on the runway (the outline's airport box).
    // Ground traffic: exits, taxiways and the stands of apron north (9–75; 1–8 and 100+ are GA, US and cargo).
    airport: {
      lat: 48.6940216, lon: 9.2438069, runwayHeadingDeg: 254, h: 408.3, from: 6000, to: -2500,
      ground: { bbox: [48.676, 9.17, 48.702, 9.252], stands: "^(9|[1-9]\\d)A?$" },
    },
    // Pattonville (EDTQ) runway 28: ends from OSM (way 100261665), ground from LGL DGM1 (273.1 / 282.1 m NHN)
    // + geoid 48.4. No standard circuit (noise abatement): departures fly 305° to the reporting point
    // AUTOKINO and on to WASSERTURM, arrivals come via OEFFINGEN on 305°; the circuit is the unofficial
    // loop WASSERTURM → A81/B27 junction → BUND-Teich → OEFFINGEN around Ludwigsburg.
    airfield: {
      runway: [[48.8635017, 9.2291335, 321.5], [48.8649051, 9.2202219, 330.5]],
      agl: 300,
      out: [[48.8750, 9.1900, 200], [48.8717, 9.1383]], // AUTOKINO 48°52.5' 9°11.4', WASSERTURM 48°52.3' 9°08.3'
      exits: [[[48.8897, 9.0741, 450]], [[48.8528, 9.1260, 450]]], // west, south
      circuit: [[48.9029, 9.1549], [48.9200, 9.1567], [48.9279, 9.2323], [48.9233, 9.2767], [48.8836, 9.2933], [48.8612, 9.2842]], // A81/B27 48°55.2' 9°09.4', BUND-Teich 48°55.4' 9°16.6'
      in: [[48.8483, 9.2683, 250]], // OEFFINGEN 48°50.9' 9°16.1'
      entries: [[[48.8498, 9.3218, 400]], [[48.8350, 9.2840, 400]]], // from the east, from the south
    },
    // the star on the Hauptbahnhof's Bonatzbau tower (since 1952; taken down in 2021 for Stuttgart 21, due back on
    // the restored tower): tower roof centre and height from LGL LoD2 (56 m tower, roof 346.4 m ellipsoid);
    // ~5 m across in reality, drawn 8 m so it reads on the map; turning slowly
    signs: [{ lat: 48.783379, lon: 9.182763, h: 346.4, diameterM: 8, mastM: 1.5, rpm: 6 }],
    osmExtract: "https://download.geofabrik.de/europe/germany/baden-wuerttemberg/stuttgart-regbez-latest.osm.pbf",
    geoidM: 48.4, // EGM2008 at Schlossplatz (GeographicLib GeoidEval: 48.373 m)
    groundH: 300, // Kessel floor ~245 m NHN + geoid
    heightBase: 250, // valley ~250 m, Fernsehturm top ~750 m ellipsoid: 150…805 m fits
    sources: "lgl",
    look: "styled",
    // Stuttgart (OSM relation 62375, Stadtkreis) and the towns around it (admin_level 8): Fellbach, Waiblingen,
    // Remseck am Neckar, Ludwigsburg, Kornwestheim, Korntal-Münchingen, Gerlingen, Ditzingen, Böblingen,
    // Sindelfingen, Leonberg, Esslingen am Neckar, Ostfildern, Filderstadt, Leinfelden-Echterdingen;
    // plus a box over Stuttgart Airport (EDDS) and the Messe, which straddle the borders
    outline: {
      relations: [62375, 401692, 401697, 405291, 405292, 405293, 405811, 405812, 405817, 722090, 722092, 722150, 2792882, 2793022, 2796535, 2796536],
      add: [[48.672, 9.17, 48.712, 9.262]],
    },
  },
  zagreb: {
    title: "Zagreb",
    origin: { lat: 45.81316, lon: 15.97722, h: 0 }, // Trg bana Jelačića
    // NNW: the Lower Town grid runs ~357° (measured on ZG3D footprints), so 330° shows two façades of every
    // block; Gornji grad and Medvednica rise behind the centre, the Sava lies in front
    headingDeg: 330,
    country: "Croatia",
    // the 17 city districts of Grad Zagreb (OSM admin_level 9, names as tagged)
    municipalities: [
      "Gradska četvrt Donji grad", "Gradska četvrt Gornji grad - Medveščak", "Gradska četvrt Trnje",
      "Gradska četvrt Maksimir", "Gradska četvrt Peščenica - Žitnjak", "Gradska četvrt Novi Zagreb - istok",
      "Gradska četvrt Novi Zagreb - zapad", "Gradska četvrt Trešnjevka - sjever", "Gradska četvrt Trešnjevka - jug",
      "Gradska četvrt Črnomerec", "Gradska četvrt Gornja Dubrava", "Gradska četvrt Donja Dubrava",
      "Gradska četvrt Stenjevec", "Gradska četvrt Podsused - Vrapče", "Gradska četvrt Podsljeme",
      "Gradska četvrt Sesvete", "Gradska četvrt Brezovica",
    ],
    adminLevels: ["9"],
    // Zagreb Airport (LDZA) runway 04: south-west threshold and true heading from OSM way 172330757; h = the
    // rendered terrain there (Copernicus, 142.9 m in the region's ENU frame). Planes come in from the south-west
    // over the faded edge, cross the threshold at 30 m, touch down ~570 m on and brake on the 3.25 km runway.
    airport: { lat: 45.7318639, lon: 16.0519638, runwayHeadingDeg: 46.8, h: 152, from: 6000, to: -2300, brake: 2.2 },
    // Jelačić, Zrinjevac, Kaptol (cathedral), Markov trg, Cvjetni trg, Tomislavov trg
    pigeons: [[45.8131, 15.9772], [45.8098, 15.9781], [45.8146, 15.9798], [45.8163, 15.9737], [45.8114, 15.9735], [45.8051, 15.9787]],
    // ZET: 15 day tram lines (1–9, 11–15, 17), most every 6–10 min on weekdays, 1, 8 and 15 less often (here 7.5
    // and 15 min: whole multiples of each other, so trains.ts can time the lines against each other); 31–34 run
    // only at night
    // HŽPP numbers its lines with two digits (80 Savski Marof–Dugo Selo…), its trains with three or more
    rail: {
      stock: "zet", tramInterval: 7.5, interval: { "1": 15, "8": 15, "15": 15 }, night: ["31", "32", "33", "34"],
      mainline: { line: "^\\d{1,2}$", every: 30, single: 240 },
    },
    credits: [
      // Otvorena dozvola: name the source and the date of its last change (data.zagreb.hr: 7 May 2025), mark changes
      "Map data © OpenStreetMap contributors · Buildings: Grad Zagreb, ZG3D 2022, data.zagreb.hr, 7. 5. 2025. (Otvorena dozvola, izmijenjeno)",
      "Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI",
    ],
    osmExtract: "https://download.geofabrik.de/europe/croatia-latest.osm.pbf",
    boundariesFrom: "extract",
    geoidM: 46.06, // EGM2008 at Trg bana Jelačića (PROJ cs2cs EPSG:4326+3855 -> 4979: 46.057 m)
    groundH: 166, // Lower Town ~120 m a.s.l. + geoid
    heightBase: 200, // Sava ~105 m a.s.l. (151 m ellipsoid) … foothills + towers below ~700 m a.s.l.: 100…755 m fits
    sources: "zg3d",
    // the 17 city districts (OSM admin_level 9, see municipalities) plus a box over Zagreb Airport (Velika Gorica)
    outline: {
      relations: [3173898, 2639024, 2630157, 2365257, 3173936, 3173894, 3173887, 2630379, 2629785, 3174289, 3178488, 3173945, 2631458, 3174275, 3178498, 3173895, 3173886],
      add: [[45.722, 16.040, 45.775, 16.095]], // reaches the city boundary north of the runway
      // Medvednica rises to 1033 m (Sljeme): beyond the height pass's 655 m span above the Sava. South of
      // 45.87° the ground stays below ~605 m, so the map ends there, across the forested slopes.
      clip: [45.5, 15.5, 45.87, 16.5],
    },
  },
  wieliczka: {
    title: "Wieliczka",
    origin: { lat: 49.98236, lon: 20.06018, h: 0 }, // Rynek Górny (centre of its OSM pedestrian area)
    headingDeg: 330, // looks NNW: north near the top, 30° to the old town's N–S / E–W streets; the A4 and Kraków at the back
    country: "Poland",
    municipalities: ["Wieliczka", "Kraków"],
    credits: [
      "Map data © OpenStreetMap contributors · Opracowano na podstawie materiałów państwowego zasobu geodezyjnego i kartograficznego (GUGiK)",
      "Buildings: GUGiK 3D models, BDOT10k, OSM · Roofs: GUGiK orthophoto · Terrain: GUGiK NMT, Copernicus DEM © DLR, Airbus DS · Trees: GUGiK NMPT · Painted with AI",
      "Salt mine: W. Hondius 1645 (public domain), facts from M.P. 1994/424 and open publications",
    ],
    osmExtract: "https://download.geofabrik.de/europe/poland/malopolskie-latest.osm.pbf",
    geoidM: 39.6, // EGM2008 at Rynek Górny (GeographicLib GeoidEval: 39.574 m)
    groundH: 300, // the town lies ~210–390 m above sea level, + geoid
    heightBase: 250, // valley ~250 m, hills ~430 m ellipsoid, buildings well below 805 m
    sources: "gugik",
    teryt: ["1219", "1261"], // powiat wielicki; Kraków (across the A4, in the ring around the town)
    look: "styled",
    style: "poland",
    // MPK Kraków's trams and the trains of Koleje Małopolskie and PKP (trains.ts mpkConsist); lines 62, 64 and 69
    // run at night only; SKA, S and K lines are the agglomeration and regional lines, the rest single trains
    rail: { stock: "mpk", tramInterval: 10, night: ["62", "64", "69"], mainline: { line: "^(SKA|S|K)\\d", every: 30, single: 240 } },
    effects: { fly: true, clouds: true, search: true },
    life: {
      vehicles: "detailed",
      foreground: true,
      // the salt mine's coach parks by Szyb Daniłowicza, the rows as parked on the 2025 orthophoto
      coaches: [
        { name: "parking autokarowy, ul. Daniłowicza", at: [49.98425, 20.054817], heading: 0.8, row: 76, count: 7, step: 4.3 },
        { name: "Parking 1 Wieliczka", at: [49.98483, 20.053309], heading: 138.3, row: 180.8, count: 4, step: 6 },
      ],
      pigeons: [
        { name: "Rynek Górny", at: [49.982359, 20.060181], r: 18, count: 26 }, // the paved square, 54 × 52 m
        // Kraków's Rynek Główny, round the Cloth Hall
        { name: "Rynek Główny, Mickiewicz monument", at: [50.06165, 19.93825], r: 18, count: 22 },
        { name: "Rynek Główny, north of the Cloth Hall", at: [50.06215, 19.93715], r: 16, count: 16 },
        { name: "Rynek Główny, west side", at: [50.06185, 19.9364], r: 16, count: 14 },
        { name: "Rynek Główny, by St Adalbert's", at: [50.06105, 19.93715], r: 14, count: 12 },
      ],
      // Kraków's dorożki: the living street round Rynek Główny (OSM ways 234875262 + 1173052547), south corner first
      carriages: {
        count: 4,
        loop: [
          [50.060428, 19.937656], [50.060471, 19.937666], [50.06051, 19.937681], [50.060552, 19.937707],
          [50.060647, 19.937783], [50.06076, 19.937874], [50.060805, 19.93791], [50.060941, 19.938022],
          [50.061093, 19.938147], [50.061293, 19.938313], [50.061456, 19.938439], [50.061615, 19.938551],
          [50.062013, 19.938882], [50.062323, 19.937974], [50.062684, 19.936909], [50.062013, 19.936319],
          [50.0614, 19.935769], [50.061084, 19.936708], [50.060976, 19.937009], [50.060928, 19.937125],
          [50.060889, 19.937205], [50.060857, 19.937261], [50.060828, 19.937305], [50.060762, 19.937405],
          [50.060696, 19.937487], [50.060648, 19.937529], [50.0606, 19.937569], [50.06056, 19.937596],
          [50.060513, 19.937624], [50.06047, 19.937641],
        ],
      },
    },
    // gmina Wieliczka (OSM relation 2662713, admin_level 7: the town and its villages) and Kraków (449696,
    // north of the A4), cut further by the areas: the town (relation 2751961) and the A4 stay clear of the
    // faded edge, the villages and Kraków's edge around them fade out
    outline: { relations: [2662713, 449696] },
  },
};

/**
 * Kraków alone (isometrickrakow.com): the city of Kraków (gmina Kraków, OSM relation 449696, admin_level 8) on the
 * Wieliczka region's grid, without the town of Wieliczka and its salt mine. Run a CLI with REGION=krakow.
 */
REGIONS.krakow = {
  ...REGIONS.wieliczka,
  title: "Kraków",
  gridOf: "wieliczka",
  areas: "^krakow-",
  municipalities: ["Kraków"],
  credits: REGIONS.wieliczka.credits.slice(0, 2),
  life: {
    ...REGIONS.wieliczka.life,
    coaches: undefined, // the salt mine's coach parks
    pigeons: REGIONS.wieliczka.life!.pigeons!.filter((p) => p.name.startsWith("Rynek Główny")),
  },
  // the city boundary west of the S7 eastern bypass (Piotr, 2026-11-27): the steelworks, the fields and villages from
  // Pleszów to Kościelniki and the Przylasek Rusiecki ponds stay off the map. The line: OSM ref=S7 (motorway and
  // trunk), both carriageways averaged per 0.002° of latitude, from the A4 junction to the city's northern boundary.
  outline: {
    relations: [449696],
    westOf: [[50.016, 20.06232], [50.018, 20.06174], [50.020, 20.06190], [50.022, 20.06209], [50.024, 20.06229], [50.026, 20.06244], [50.028, 20.06271], [50.030, 20.06294], [50.032, 20.06299], [50.034, 20.06316], [50.036, 20.06352], [50.038, 20.06433], [50.040, 20.06590], [50.042, 20.06778], [50.044, 20.06922], [50.046, 20.07014], [50.048, 20.07124], [50.050, 20.07222], [50.052, 20.07337], [50.054, 20.07398], [50.056, 20.07460], [50.058, 20.07510], [50.060, 20.07509], [50.062, 20.07448], [50.064, 20.07339], [50.066, 20.07140], [50.068, 20.06842], [50.070, 20.06639], [50.072, 20.06458], [50.074, 20.06266], [50.076, 20.06196], [50.078, 20.06215], [50.080, 20.06229], [50.082, 20.06209], [50.084, 20.06208], [50.086, 20.06129], [50.088, 20.05890], [50.090, 20.05314], [50.092, 20.04211], [50.094, 20.03574], [50.096, 20.03270], [50.098, 20.03175], [50.100, 20.03199], [50.102, 20.03352], [50.104, 20.03554], [50.106, 20.03744], [50.108, 20.04053], [50.110, 20.04172], [50.112, 20.04397], [50.114, 20.04540], [50.116, 20.04585], [50.118, 20.04585], [50.120, 20.04536], [50.122, 20.04499], [50.124, 20.04473], [50.126, 20.04462], [50.128, 20.04472], [50.130, 20.04487], [50.132, 20.04535], [50.134, 20.04578], [50.136, 20.04640], [50.138, 20.04752], [50.140, 20.04788]],
  },
};

export const CITIES: Record<string, City> = {
  "tel-aviv-yafo": { title: "Tel Aviv-Yafo", region: "israel-center", center: [32.0745, 34.7810], widthM: 5200 },
  stuttgart: { title: "Stuttgart", region: "stuttgart", center: [48.7784, 9.18], widthM: 3000 },
  zagreb: { title: "Zagreb", region: "zagreb", center: [45.8131, 15.9772], widthM: 3000 },
  wieliczka: { title: "Wieliczka", region: "wieliczka", center: [49.9825, 20.0585], widthM: 2000 },
  krakow: { title: "Kraków", region: "krakow", center: [50.0585, 19.9365], widthM: 1600 },
};

export const DEFAULT_CITY = "tel-aviv-yafo";
