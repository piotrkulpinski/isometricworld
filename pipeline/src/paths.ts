import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PIPELINE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = join(PIPELINE, "..");
// optional local settings (.env at the repo root, never committed; see .env.example), before the paths read them
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
export const DATA = process.env.DATA_DIR || join(ROOT, "data"); // override: test runs against a scratch copy
export const RAW = join(DATA, "raw");
export const DERIVED = join(DATA, "derived");
/** Built map data waiting to be published (served by the dev server over production); emptied by publish. */
export const WEB_CACHE = process.env.WEB_CACHE || join(DATA, "web"); // override: test exports elsewhere
/** What is published per region: tile sources + content hashes (lets export rebuild only changes). */
export const WEB_STATE = process.env.WEB_STATE || join(DATA, "web-state"); // override: a second bucket keeps its own state
/** Chromium/Chrome for the renderer and the test scripts, and its launch flags (GPU backend etc.). */
export const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";
/**
 * The running site the test/film scripts open: their URL argument, else SITE_URL, else the dev server that is
 * running now (web/astro.config.mjs writes its URL to data/dev-server.json on start).
 */
export function siteUrl(arg?: string): string {
  const url = arg || process.env.SITE_URL;
  if (url) return url;
  const f = join(DATA, "dev-server.json");
  if (existsSync(f)) {
    const { url: dev, pid } = JSON.parse(readFileSync(f, "utf8")) as { url: string; pid: number };
    try { process.kill(pid, 0); return dev; } catch { /* stopped without cleaning up */ }
  }
  throw new Error("no site URL: start the dev server (npm run dev), pass its URL, or set SITE_URL in .env");
}
export const CHROME_ARGS = (process.env.CHROME_ARGS || "--enable-gpu").split(/\s+/).filter(Boolean);

export function loadEnv(): Record<string, string> {
  const file = join(ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
  return process.env as Record<string, string>;
}

export const readJson = <T = any>(p: string): T => JSON.parse(readFileSync(p, "utf8"));

/** Write a sharp image so readers never see a half-written file (other jobs read tiles while we paint). */
export async function writeAtomic(img: import("sharp").Sharp, file: string) {
  await img.toFile(`${file}.tmp`);
  (await import("node:fs")).renameSync(`${file}.tmp`, file);
}
