/**
 * Road widths from OSM tags, shared by the ground drawing (ground.ts) and the traffic export
 * (export.ts) so simulated cars drive exactly on the asphalt that was drawn.
 */

/** default carriageway width (m), has pavements */
export const ROAD: Record<string, [number, boolean]> = {
  motorway: [11, false], trunk: [10, false], primary: [13, true], secondary: [10, true], tertiary: [8, true],
  motorway_link: [5, false], trunk_link: [5, false], primary_link: [5, true], secondary_link: [5, true], tertiary_link: [5, true],
  unclassified: [6.5, true], residential: [6.5, true], living_street: [5, true], service: [4, false], road: [6, true],
  busway: [7, true], track: [3, false], raceway: [8, false],
};

export const isOneway = (t: Record<string, string>) =>
  t.oneway === "yes" || t.oneway === "-1" || t.junction === "roundabout" || t.highway === "motorway";

/** Carriageway width (m) of a drivable OSM way, or 0 if it isn't one. */
export function roadWidth(t: Record<string, string>): number {
  const road = ROAD[t.highway];
  if (!road) return 0;
  const lanes = Number(t.lanes) || 0;
  const w = Number(String(t.width).replace(",", "."));
  return w > 1 && w < 60 ? w : lanes ? lanes * 3.3 : road[0] * (isOneway(t) && road[0] > 7 ? 0.6 : 1);
}

/** Lanes in the way's direction(s): total for one-way, per direction otherwise. */
export function roadLanes(t: Record<string, string>): number {
  const w = roadWidth(t), n = Number(t.lanes) || Math.max(1, Math.round(w / 3.3));
  return isOneway(t) ? Math.max(1, n) : Math.max(1, Math.floor(n / 2));
}

/** Paved in stone (setts, cobbles, slabs): drawn without asphalt or lane markings. */
export const isStone = (t: Record<string, string>) =>
  ["sett", "cobblestone", "unhewn_cobblestone", "paving_stones", "stone", "granite"].includes(t.surface);

/**
 * Closed to ordinary cars: an explicit motor access ban, or a living street paved in stone (the
 * old-town squares and lanes, such as the street round Kraków's Rynek Główny). Simulated cars skip
 * these ways, and the ground draws them as paving.
 */
export function isCarFree(t: Record<string, string>) {
  const access = t.motor_vehicle ?? t.motorcar ?? t.vehicle ?? t.access;
  return ["no", "private", "permissive", "agricultural", "forestry"].includes(access) || (t.highway === "living_street" && isStone(t));
}
