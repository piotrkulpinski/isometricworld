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

export interface Region {
  title: string;
  /** ENU origin. Fixed forever once tiles exist: changing it moves every tile of the region. */
  origin: { lat: number; lon: number; h: number };
  /** Compass bearing the camera looks toward (pick it diagonal to the main street grid). */
  headingDeg: number;
  /** OSM country (name:en of the admin_level=2 area) and municipality names (admin_level=8) for the border overlay. */
  country: string;
  municipalities: string[];
  /** Airliners on final approach drawn over the map (optional): runway threshold, landing heading and
   *  the threshold's ellipsoid height in metres (default 0). Planes come in from the opposite side. */
  airport?: { lat: number; lon: number; runwayHeadingDeg: number; h?: number };
  /** Credit lines (video mode and footer). */
  credits: string[];
  /** The region's own data source as a footer link, beside OpenStreetMap and Copernicus. */
  sourceCredit?: { label: string; href: string; title?: string };
  /** Local life the viewer animates on top of the map (web/src/scripts): see Fauna. */
  fauna: Fauna[];
  /** Geoid undulation at the origin (EGM2008, m): orthometric height + this = ellipsoid height. Also sea level. */
  geoid: number;
  /** Typical ground ellipsoid height (m): area outlines, and the band the scene bins objects in. */
  groundH: number;
  /** Building source beside OSM: Tel Aviv-Yafo municipal GIS, or GUGiK LoD2 + LoD1 3D models for Polish powiats (TERYT). */
  buildings?: { kind: "tel-aviv" } | { kind: "gugik"; teryt: string[] };
  /** Tree palette the renderer colour-codes crowns with (see page/renderer.ts and style/trees*.png). */
  flora: "mediterranean" | "central-european";
}

/** A spot on the map in WGS84 degrees with a radius in metres. */
export interface Spot { lat: number; lon: number; r: number }

/**
 * Animated local touches, per region:
 *   cats        street cats on the pavements (cats.ts)
 *   parakeets   flocks of rose-ringed parakeets over the streets (sky.ts Parrots)
 *   pigeons     flocks that sit on open squares and now and then fly to another (sky.ts Pigeons)
 *   carriages   horse-drawn carriages driving round a closed loop of [lat, lon] (carriages.ts)
 */
export type Fauna =
  | { kind: "cats" }
  | { kind: "parakeets" }
  | { kind: "pigeons"; plazas: Spot[] }
  | { kind: "carriages"; loop: Array<[number, number]>; count: number };

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
    sourceCredit: { label: "Tel Aviv-Yafo Municipality", href: "https://opendatasource.tel-aviv.gov.il/" },
    fauna: [{ kind: "cats" }, { kind: "parakeets" }],
    geoid: 19.1,
    groundH: 25,
    buildings: { kind: "tel-aviv" },
    flora: "mediterranean",
  },
  "poland-south": {
    title: "Poland · South",
    origin: { lat: 50.0617, lon: 19.9373, h: 0 }, // Rynek Główny, Kraków
    headingDeg: 340, // 20° west of north: diagonal to the Old Town grid (~25°), Wawel in front
    country: "Poland",
    municipalities: ["Kraków"],
    // Kraków Airport (Balice), runway 25 threshold (east end, OSM); landings come in from the east over
    // northern Kraków. Elevation ~237 m above sea level + geoid.
    airport: { lat: 50.0801982, lon: 19.8026141, runwayHeadingDeg: 258, h: 277 },
    credits: [
      "Map data © OpenStreetMap contributors · Buildings: GUGiK (geoportal.gov.pl), CC BY 4.0",
      "Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI",
    ],
    sourceCredit: {
      label: "GUGiK",
      href: "https://www.geoportal.gov.pl/",
      title: "Opracowano na podstawie materiałów państwowego zasobu geodezyjnego i kartograficznego, CC BY 4.0",
    },
    fauna: [
      {
        kind: "pigeons",
        plazas: [
          { lat: 50.06215, lon: 19.93715, r: 16 }, // Rynek Główny, north of the Cloth Hall
          { lat: 50.06165, lon: 19.93825, r: 18 }, // Rynek Główny, Mickiewicz monument
          { lat: 50.06185, lon: 19.93640, r: 16 }, // Rynek Główny, west side
          { lat: 50.06105, lon: 19.93715, r: 14 }, // Rynek Główny, by St Adalbert's
          { lat: 50.06100, lon: 19.94030, r: 12 }, // Mały Rynek
          { lat: 50.05900, lon: 19.93725, r: 9 },  // Plac Wszystkich Świętych
        ],
      },
      {
        kind: "carriages",
        count: 4,
        // the living street round Rynek Główny (OSM ways 234875262 + 1173052547), south corner first
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
    ],
    geoid: 39.8,
    groundH: 235, // Vistula ~198 m, Rynek ~219 m, Wawel ~228 m above sea level, + geoid
    buildings: { kind: "gugik", teryt: ["1261"] }, // powiat m. Kraków
    flora: "central-european",
  },
};

export const CITIES: Record<string, City> = {
  "tel-aviv-yafo": { title: "Tel Aviv-Yafo", region: "israel-center", center: [32.0745, 34.7810], widthM: 5200 },
  krakow: { title: "Kraków", region: "poland-south", center: [50.0585, 19.9365], widthM: 1600 },
};

export const DEFAULT_CITY = "tel-aviv-yafo";
