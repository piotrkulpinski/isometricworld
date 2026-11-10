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
  /** Airliners on final approach drawn over the map (optional). */
  airport?: { lat: number; lon: number; runwayHeadingDeg: number };
  /** Credit lines (video mode and footer). */
  credits: string[];
  /** Geoid undulation at the origin (EGM2008, m): orthometric height + this = ellipsoid height. Also sea level. */
  geoid: number;
  /** Typical ground ellipsoid height (m): area outlines, and the band the scene bins objects in. */
  groundH: number;
  /** Building source beside OSM: Tel Aviv-Yafo municipal GIS, or GUGiK LoD1 3D models for a Polish powiat (TERYT). */
  buildings?: { kind: "tel-aviv" } | { kind: "gugik-lod1"; teryt: string[] };
  /** Tree palette the renderer colour-codes crowns with (see page/renderer.ts and style/trees*.png). */
  flora: "mediterranean" | "central-european";
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
    credits: [
      "Map data © OpenStreetMap contributors · Buildings: GUGiK (geoportal.gov.pl), CC BY 4.0",
      "Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI",
    ],
    geoid: 39.8,
    groundH: 235, // Vistula ~198 m, Rynek ~219 m, Wawel ~228 m above sea level, + geoid
    buildings: { kind: "gugik-lod1", teryt: ["1261"] }, // powiat m. Kraków
    flora: "central-european",
  },
};

export const CITIES: Record<string, City> = {
  "tel-aviv-yafo": { title: "Tel Aviv-Yafo", region: "israel-center", center: [32.0745, 34.7810], widthM: 5200 },
  krakow: { title: "Kraków", region: "poland-south", center: [50.0585, 19.9365], widthM: 1600 },
};

export const DEFAULT_CITY = "tel-aviv-yafo";
