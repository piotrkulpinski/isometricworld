/** Sea level and the renderer's height pass (one 256² PNG per render tile). */
import sharp from "sharp";
import { activeRegion } from "./camera.ts";
import { REGIONS } from "./places.ts";

/** Ellipsoid height of mean sea level in the active region (its geoid undulation, EGM2008). */
export const seaH = () => REGIONS[activeRegion()].geoid;

/** Decode a height PNG (ellipsoid height in cm + 10000, R<<8|G; alpha 0 = nothing rendered). */
export async function readHeights(file: string) {
  const buf = await sharp(file).ensureAlpha().raw().toBuffer();
  const n = buf.length / 4, h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = buf[i * 4 + 3] ? (buf[i * 4] * 256 + buf[i * 4 + 1]) / 100 - 100 : NaN;
  return h;
}
