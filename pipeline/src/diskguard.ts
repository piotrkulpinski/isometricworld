/**
 * Free-space guard for long runs (paint, export): a whole city's painting once filled the internal disk in a day.
 * Checks the system data volume (macOS /System/Volumes/Data: home, ~/.codex, temp files), the data folder's volume
 * and CODEX_HOME's. MIN_FREE_GIB overrides the 15 GiB floor.
 */
import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA } from "./paths.ts";

export const MIN_FREE_GIB = Number(process.env.MIN_FREE_GIB) || 15;
const VOLUMES = [...new Set(["/System/Volumes/Data", DATA, process.env.CODEX_HOME || join(homedir(), ".codex"), process.env.TMPDIR || "/tmp"])];

const freeGiB = (path: string) => { const s = statfsSync(path); return (s.bavail * s.bsize) / 2 ** 30; };

/** A message naming the first volume below the floor, else null. */
export function lowDisk(): string | null {
  for (const v of VOLUMES) {
    if (!existsSync(v)) continue;
    const free = freeGiB(v);
    if (free < MIN_FREE_GIB) return `only ${free.toFixed(1)} GiB free on the volume of ${v} (floor ${MIN_FREE_GIB} GiB, MIN_FREE_GIB)`;
  }
  return null;
}

/** lowDisk(), checked at most every `everyMs` (statfs is cheap, but export calls this per tile). */
let lastCheck = 0, lastResult: string | null = null;
export function lowDiskThrottled(everyMs = 10_000) {
  if (Date.now() - lastCheck >= everyMs) { lastCheck = Date.now(); lastResult = lowDisk(); }
  return lastResult;
}
