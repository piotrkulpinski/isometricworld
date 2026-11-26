/**
 * Painted landmarks, the overview way: ONE coherent painting of a whole landmark (Codex image edit), reviewed, then cut
 * out along its own painted outline with a chroma key. Fixes what window-by-window painting can't: each window invents
 * its own fair (five Ferris wheels, hard seams), and LoD2 massing gets painted literally (a stadium as an office ring).
 *
 *   --tag <tag> (every command): an experiment: --base paint reads paint-<tag>/, key records into cutouts-<tag>.json
 *       (then cutout.ts --tag, export --paint-tag), so nothing reaches the area's real paint/ or cutouts.json.
 *   npm -w pipeline exec tsx src/landmark.ts <area> <name> overview --frame x,y,w,h [--base paint|render] [--aerial [--aerial-source lgl|city]]
 *       [--style reference-simple.png] [--ref data/raw/photos/<dir>/<file>]…
 *       → landmark-<name>/art.png: frame (global art px, 3:2 or 2:3) painted at 1536×1024 (1024×1536) from pipeline/landmarks/<name>/overview.txt.
 *         --base paint: edit the area's existing painting (outside the landmark stays pixel-identical); render: paint the
 *         3D render. --aerial adds the draped orthophoto (true shape; aerial.ts --source, city is sharper). --ref: open-licence photos (PD/CC0/CC BY only).
 *   … <area> <name> edit <prompt.txt> [--box x0,y0,x1,y1]
 *       → Codex edits art.png. Codex redraws the WHOLE image (it dropped a footbridge once), so --box pastes only that
 *         box (art px of the 1536×1024 image, 8 px feather) into art.png. The previous art is kept as art-<n>.png.
 *   … <area> <name> key
 *       → Codex repaints everything but the landmark flat magenta (pipeline/landmarks/<name>/key.txt; gpt-image has no
 *         transparency), mask.png = not magenta, holes filled; with --base paint at native scale also every pixel the
 *         overview changed (it cleans up around the landmark too). Records the cutout in <area>/cutouts.json.
 *
 * Native scale (frame 1536×1024): cutout.ts uses art.png directly (key.art). Larger frames (the Wasen: 3600×2400) are a
 * guide: paint the windows with paint.ts --guide landmark-<name>/art.png --guide-frame x,y,w,h, then cutout.ts uses them.
 * Then: npm -w pipeline exec tsx src/cutout.ts <area> && npm run export -- … (export keeps traffic off key masks).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import sharp, { type OverlayOptions } from "sharp";
import { openArea } from "./areas.ts";
import { CAMERA } from "./camera.ts";
import { codex } from "./codex.ts";
import { readHeights, seaH } from "./heights.ts";
import { DERIVED, PIPELINE, readJson } from "./paths.ts";
import { register } from "./register.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    frame: { type: "string" }, base: { type: "string", default: "paint" }, aerial: { type: "boolean", default: false }, "aerial-source": { type: "string", default: "lgl" },
    style: { type: "string", default: "reference.png" }, ref: { type: "string", multiple: true, default: [] }, box: { type: "string" },
    tag: { type: "string" },
  },
});
const [areaName, name, cmd, promptArg] = positionals;
if (!areaName || !name || !["overview", "edit", "key"].includes(cmd)) throw new Error("usage: landmark.ts <area> <name> overview|edit|key …");
openArea(areaName);
const T = CAMERA.tile;
const base = join(DERIVED, areaName), dir = join(base, `landmark-${name}`), prompts = join(PIPELINE, "landmarks", name);
const metaFile = join(dir, "landmark.json");
interface Meta { frame: [number, number, number, number]; base: "paint" | "render"; aerial: boolean; refs: string[] }
// the image model paints 1536×1024 or 1024×1536: a portrait frame (2:3) for tall landmarks (the Wilhelma)
const frameWH = args.frame ? args.frame.split(",").slice(2).map(Number) : existsSync(metaFile) ? readJson<Meta>(metaFile).frame.slice(2) : [3, 2];
const PORTRAIT = frameWH[1] > frameWH[0], OW = PORTRAIT ? 1024 : 1536, OH = PORTRAIT ? 1536 : 1024;
const art = join(dir, "art.png");
const output = (file: string) => `Output: one ${OW}x${OH} ${PORTRAIT ? "portrait" : "landscape"} image, same framing and scale as image 1, no text, no border, no vignette. \
When done, copy the final PNG to ${file} and reply only with that path.\n`;

/** Codex run in dir; the result file must appear (else the log tail is thrown) */
async function run(images: string[], prompt: string, result: string) {
  const t0 = Date.now();
  await codex(dir, images, prompt);
  if (!existsSync(result)) throw new Error(`no ${basename(result)}:\n` + readFileSync(join(dir, "codex.log"), "utf8").slice(-2000));
  return (Date.now() - t0) / 1000;
}
/** keep the current art as art-<n>.png before replacing it */
function keepArt() {
  if (!existsSync(art)) return;
  let n = 1;
  while (existsSync(join(dir, `art-${n}.png`))) n++;
  copyFileSync(art, join(dir, `art-${n}.png`));
}
const fill = (f: string) => sharp(f).resize(OW, OH, { fit: "fill", kernel: "lanczos3" }).removeAlpha();

if (cmd === "overview") {
  const frame = args.frame?.split(",").map(Number) as Meta["frame"];
  if (frame?.length !== 4 || Math.abs(frame[2] / frame[3] - OW / OH) > 0.01) throw new Error("--frame x,y,w,h (global art px, 3:2 or 2:3)");
  if (args.base !== "paint" && args.base !== "render") throw new Error("--base paint|render");
  mkdirSync(dir, { recursive: true });
  const [x0, y0, w, h] = frame, scale = OW / w;
  const tx0 = Math.floor(x0 / T), ty0 = Math.floor(y0 / T);
  async function mosaic(load: (tx: number, ty: number) => Promise<Buffer | null>, file: string) {
    const comps: OverlayOptions[] = [];
    for (let ty = ty0; ty <= Math.floor((y0 + h - 1) / T); ty++)
      for (let tx = tx0; tx <= Math.floor((x0 + w - 1) / T); tx++) {
        const buf = await load(tx, ty);
        if (buf) comps.push({ input: buf, left: tx * T - x0 + T, top: ty * T - y0 + T });
      }
    const big = await sharp({ create: { width: w + 2 * T, height: h + 2 * T, channels: 3, background: "#000" }, limitInputPixels: false })
      .composite(comps).png().toBuffer();
    const crop = await sharp(big, { limitInputPixels: false }).extract({ left: T, top: T, width: w, height: h }).png().toBuffer();
    await sharp(crop).resize(OW, OH, { kernel: "lanczos3" }).png().toFile(join(dir, file));
  }
  const tile = (...dirs: string[]) => async (tx: number, ty: number) => {
    for (const d of dirs) {
      const f = join(base, d, `${tx}_${ty}.png`);
      if (existsSync(f)) return sharp(f).resize(T, T).removeAlpha().png().toBuffer();
    }
    return null;
  };
  // ground level: low percentile of the frame's heights (as paint.ts windowGround)
  const hs: number[] = [];
  for (let ty = ty0; ty <= Math.floor((y0 + h - 1) / T); ty++)
    for (let tx = tx0; tx <= Math.floor((x0 + w - 1) / T); tx++) {
      const f = join(base, "height", `${tx}_${ty}.png`);
      if (existsSync(f)) for (const v of await readHeights(f)) if (!Number.isNaN(v) && v > seaH() - 0.5) hs.push(v);
    }
  hs.sort((a, b) => a - b);
  const ground = hs[Math.floor(hs.length * 0.05)];
  await mosaic(args.base === "paint" ? tile(args.tag ? `paint-${args.tag}` : "paint", "render") : tile("render"), "input.png");
  await mosaic(async (tx, ty) => {
    const f = join(base, "height", `${tx}_${ty}.png`);
    if (!existsSync(f)) return null;
    const v = await readHeights(f), g = Buffer.alloc(v.length), n = Math.round(Math.sqrt(v.length));
    for (let i = 0; i < v.length; i++) g[i] = Number.isNaN(v[i]) ? 0 : Math.max(0, Math.min(255, Math.sqrt(Math.max(0, v[i] - ground) / 60) * 255));
    return sharp(g, { raw: { width: n, height: n, channels: 1 } }).resize(T, T, { kernel: "cubic" }).toColourspace("srgb").png().toBuffer();
  }, "height.png");
  const images = ["input.png", "height.png", "style.png"];
  copyFileSync(join(PIPELINE, "style", args.style!), join(dir, "style.png"));
  if (args.aerial) { await mosaic(tile(`aerial-${args["aerial-source"]}`), "aerial.png"); images.push("aerial.png"); }
  for (const [k, f] of args.ref!.entries()) {
    await sharp(f).resize(1024, 1024, { fit: "inside" }).png().toFile(join(dir, `ref${k + 1}.png`));
    images.push(`ref${k + 1}.png`);
  }
  const meta: Meta = { frame, base: args.base, aerial: args.aerial!, refs: args.ref! };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));

  const m = Math.round(w * CAMERA.mpp), ppm = (scale / CAMERA.mpp).toFixed(1);
  const what = args.base === "paint"
    ? "the hand-painted isometric map of this place, the image you EDIT"
    : "an orthographic render of a simple 3D model of this place built from map data, the image you PAINT";
  const lines = [
    `1. input.png: ${what} (orthographic camera tilted 45° down, no perspective, ~${m} m across, ${ppm} px per metre).`,
    "2. height.png: height map from the SAME camera, pixel-aligned with image 1. Black = ground, brighter = taller.",
    "3. style.png: the STYLE REFERENCE.",
    ...(args.aerial ? [`4. aerial.png: the real aerial photo from the SAME camera, pixel-aligned with image 1. Grey blocks are gaps, ignore them. Use it for the TRUE shape and size of things.`] : []),
    ...args.ref!.map((_, k) => `${images.indexOf(`ref${k + 1}.png`) + 1}. ref${k + 1}.png: a photo of the landmark. Use it ONLY for what the landmark looks like, redrawn in the style of image 3; it says nothing about position or size, and never copy its photographic look.`),
  ];
  const prompt = `Use your image generation tool. ${images.length} images are attached:\n${lines.join("\n")}\n\n${readFileSync(join(prompts, "overview.txt"), "utf8").trim()}\n\n${output(join(dir, "out.png"))}`;
  writeFileSync(join(dir, "prompt.txt"), prompt);
  keepArt();
  const s = await run(images, prompt, join(dir, "out.png"));
  await fill(join(dir, "out.png")).png().toFile(art);
  const r = await register(join(dir, "input.png"), art);
  console.log(`overview: ${s.toFixed(0)}s match=${r.score.toFixed(2)} shift=(${r.dx},${r.dy}) scale=${r.scale.toFixed(2)} → ${art}`);
}

if (cmd === "edit") {
  if (!promptArg || !existsSync(art)) throw new Error("usage: landmark.ts <area> <name> edit <prompt.txt> [--box x0,y0,x1,y1] (after overview)");
  copyFileSync(art, join(dir, "image.png"));
  const prompt = `Use your image generation tool to EDIT the attached image image.png (${OW}x${OH}).\n${readFileSync(promptArg, "utf8").trim()}\n${output(join(dir, "edit.png"))}`;
  const s = await run(["image.png"], prompt, join(dir, "edit.png"));
  const edited = await fill(join(dir, "edit.png")).raw().toBuffer();
  keepArt();
  if (!args.box) await sharp(edited, { raw: { width: OW, height: OH, channels: 3 } }).png().toFile(art);
  else {
    const [bx0, by0, bx1, by1] = args.box.split(",").map(Number), F = 8;
    const px = await sharp(join(dir, "image.png")).removeAlpha().raw().toBuffer();
    for (let y = Math.max(0, by0); y < Math.min(OH, by1); y++)
      for (let x = Math.max(0, bx0); x < Math.min(OW, bx1); x++) {
        const a = Math.min(1, (x - bx0 + 0.5) / F, (bx1 - x - 0.5) / F, (y - by0 + 0.5) / F, (by1 - y - 0.5) / F), i = (y * OW + x) * 3;
        for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] * (1 - a) + edited[i + c] * a);
      }
    await sharp(px, { raw: { width: OW, height: OH, channels: 3 } }).png().toFile(art);
  }
  console.log(`edit: ${s.toFixed(0)}s → ${art}${args.box ? ` (box ${args.box} only)` : ""}`);
}

if (cmd === "key") {
  if (!existsSync(art) || !existsSync(metaFile)) throw new Error("key: run overview first");
  const meta: Meta = readJson(metaFile);
  copyFileSync(art, join(dir, "image.png"));
  const prompt = `Use your image generation tool to EDIT the attached image image.png (${OW}x${OH}). Make a cut-out on a chroma-key background.
${readFileSync(join(prompts, "key.txt"), "utf8").trim()}
- The magenta #FF00FF must be perfectly flat (no shading, texture, shadows, gradients or outlines) and meet the kept objects with a sharp edge. Do not move, redraw or restyle anything that is kept.
${output(join(dir, "key.png"))}`;
  const s = await run(["image.png"], prompt, join(dir, "key.png"));
  const k = await fill(join(dir, "key.png")).raw().toBuffer(), a = await sharp(art).removeAlpha().raw().toBuffer();
  let m = Buffer.alloc(OW * OH), drift = 0, kept = 0;
  for (let i = 0; i < OW * OH; i++) {
    const p = i * 3;
    if (k[p] > 200 && k[p + 1] < 70 && k[p + 2] > 200) continue;
    m[i] = 255; kept++;
    drift += Math.abs(k[p] - a[p]) + Math.abs(k[p + 1] - a[p + 1]) + Math.abs(k[p + 2] - a[p + 2]);
  }
  m = await sharp(m, { raw: { width: OW, height: OH, channels: 1 } }).median(5).extractChannel(0).raw().toBuffer();
  // fill holes: everything magenta that the border cannot reach is part of the landmark (an open roof, a courtyard)
  const out = Buffer.alloc(OW * OH, 255), stack: number[] = [];
  for (let x = 0; x < OW; x++) stack.push(x, (OH - 1) * OW + x);
  for (let y = 0; y < OH; y++) stack.push(y * OW, y * OW + OW - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (out[i] === 0 || m[i] > 127) continue;
    out[i] = 0;
    const x = i % OW;
    if (x > 0) stack.push(i - 1);
    if (x < OW - 1) stack.push(i + 1);
    if (i >= OW) stack.push(i - OW);
    if (i < OW * (OH - 1)) stack.push(i + OW);
  }
  const native = meta.frame[2] === OW && meta.frame[3] === OH;
  if (meta.base === "paint" && native) { // the overview also cleaned up around the landmark (old roof bits, holes): keep that too
    const inp = await sharp(join(dir, "input.png")).removeAlpha().raw().toBuffer();
    let d = Buffer.alloc(OW * OH);
    for (let i = 0; i < OW * OH; i++) { const p = i * 3; d[i] = Math.abs(a[p] - inp[p]) + Math.abs(a[p + 1] - inp[p + 1]) + Math.abs(a[p + 2] - inp[p + 2]) > 45 ? 255 : 0; }
    d = await sharp(d, { raw: { width: OW, height: OH, channels: 1 } }).median(5).blur(4).threshold(20).extractChannel(0).raw().toBuffer();
    for (let i = 0; i < OW * OH; i++) out[i] = Math.max(out[i], d[i]);
  }
  await sharp(out, { raw: { width: OW, height: OH, channels: 1 } }).png().toFile(join(dir, "mask.png"));
  let n = 0;
  for (const v of out) if (v) n++;
  console.log(`key: ${s.toFixed(0)}s, kept pixels drift ${(drift / Math.max(1, kept) / 3).toFixed(1)} (0 = untouched), mask ${(n / out.length * 100).toFixed(1)}% of the frame`);
  const listFile = join(base, args.tag ? `cutouts-${args.tag}.json` : "cutouts.json"), list: any[] = existsSync(listFile) ? readJson(listFile) : [];
  const key = { mask: `landmark-${name}/mask.png`, frame: meta.frame, grow: 5, feather: 4, ...(native ? { art: `landmark-${name}/art.png` } : {}) };
  const old = list.find((c) => c.name === name);
  if (old) old.key = key; else list.push({ name, key });
  writeFileSync(listFile + ".tmp", JSON.stringify(list, null, 2) + "\n");
  renameSync(listFile + ".tmp", listFile);
  console.log(native
    ? `  recorded in ${listFile}; next: npm -w pipeline exec tsx src/cutout.ts ${areaName}`
    : `  recorded in ${listFile}; paint the windows: npm run paint -- ${areaName} --tag cutout-${name} --guide ${art} --guide-frame ${meta.frame.join(",")} --window "i,j;…", add "windows" to the entry, then cutout.ts`);
}
