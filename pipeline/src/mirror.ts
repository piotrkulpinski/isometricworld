/**
 * Copy a region as it is published somewhere else into the export cache, so `npm run publish` seeds another
 * bucket with all of it (an empty bucket needs every tile, not only an export's changes).
 *
 *   npm run mirror -- wieliczka --from https://tiles.isometriccity.com [--reuse data/web]
 *
 * Reads <from>/regions/<region>/state.json (every tile's content hash) and downloads each tile, preview and data
 * file it names into WEB_CACHE/regions/<region>/, checking each against its hash. The state becomes the cache's
 * pending state (WEB_CACHE/<region>.state.json), which publish uploads as the new bucket's state.json.
 * `--reuse <cache>` clones files with the same hash from another local cache instead of downloading them.
 * Reads nothing from data/derived and writes only under WEB_CACHE: point WEB_CACHE (and WEB_STATE, for the
 * state publish records) at folders of their own for the other bucket.
 */
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DATA, WEB_CACHE } from "./paths.ts";
import { REGIONS } from "./places.ts";

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const region = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const from = opt("--from")?.replace(/\/+$/, "");
if (!region || !REGIONS[region] || !from) throw new Error("usage: npm run mirror -- <region> --from <origin> [--reuse <cache dir>]");
if (resolve(WEB_CACHE) === resolve(DATA, "web")) throw new Error("set WEB_CACHE to a folder of its own (never data/web, the export cache of the main bucket)");
const reuse = opt("--reuse") ? join(resolve(opt("--reuse")!), "regions", region) : undefined;

type State = { layers: Record<string, { hashes: Record<string, string> }>; data: Record<string, string>; base?: string };
const base = `${from}/regions/${region}`, out = join(WEB_CACHE, "regions", region);
const hash = (b: Buffer) => createHash("sha1").update(b).digest("hex").slice(0, 10); // as export.ts
async function get(url: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt >= 6) throw new Error(`${url}: ${(e as Error).message}`);
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt));
    }
  }
}

const stateText = (await get(`${base}/state.json?t=${Date.now()}`)).toString("utf8");
const state = JSON.parse(stateText) as State;
const worldRaw = await get(`${base}/data/world.json?t=${Date.now()}`);
const format = (JSON.parse(worldRaw.toString("utf8")) as { format?: string }).format ?? "avif";

// every file the state names: [path under regions/<region>/, content hash]
const files: Array<[string, string]> = [];
for (const [layer, { hashes }] of Object.entries(state.layers)) {
  for (const [key, h] of Object.entries(hashes)) {
    if (layer === "height") { const [x, y] = key.split("_"); files.push([`tiles/height/${x}/${y}.webp`, h]); continue; }
    const [z, xy] = key.split("/"), [x, y] = xy.split("_");
    files.push([`tiles/${layer}/${z}/${x}/${y}.${format}`, h]);
  }
}
for (const [name, h] of Object.entries(state.data)) {
  if (name === "world.json") continue; // last, below
  files.push([name.startsWith("preview/") ? `${name}.${h}.avif` : `data/${name}.${h}.json`, h]);
}
console.log(`${region}: ${files.length} files from ${base} → ${out}${reuse ? ` (reusing ${reuse})` : ""}`);

let done = 0, fetched = 0, reused = 0, kept = 0, bytes = 0;
const t0 = Date.now();
const queue = [...files];
await Promise.all(Array.from({ length: 16 }, async () => {
  for (let f = queue.shift(); f; f = queue.shift()) {
    const [rel, h] = f, dst = join(out, rel);
    if (existsSync(dst) && hash(readFileSync(dst)) === h) kept++;
    else {
      mkdirSync(dirname(dst), { recursive: true });
      const src = reuse && join(reuse, rel);
      if (src && existsSync(src) && hash(readFileSync(src)) === h) { copyFileSync(src, dst, constants.COPYFILE_FICLONE); reused++; }
      else {
        const b = await get(`${base}/${rel}${rel.startsWith("tiles/") ? `?v=${h}` : ""}`);
        if (hash(b) !== h) throw new Error(`${rel}: content hash ${hash(b)}, the state says ${h}`);
        writeFileSync(dst, b); fetched++; bytes += b.length;
      }
    }
    if (++done % 500 === 0) process.stdout.write(`\r  ${done}/${files.length} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}));
mkdirSync(join(out, "data"), { recursive: true });
writeFileSync(join(out, "data", "world.json"), worldRaw);
// the pending state: what publish uploads as state.json and then records in WEB_STATE
delete state.base;
writeFileSync(join(WEB_CACHE, `${region}.state.json`), JSON.stringify(state));
console.log(`\r  ${files.length} files: ${fetched} downloaded (${(bytes / 1e6).toFixed(1)} MB), ${reused} reused, ${kept} already here, in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`  state → ${join(WEB_CACHE, `${region}.state.json`)}; publish with the same WEB_CACHE and WEB_STATE`);
