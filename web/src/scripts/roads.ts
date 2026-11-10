import type { Road } from "./traffic.ts";

/** roads.<hash>.json as written by encodeRoads (pipeline/src/export.ts): columnar, delta-coded. */
interface Encoded { v: 2; c: number[]; o: number[]; l: number[]; w: number[]; a: number[]; b: number[]; n: number[]; s: number[]; vis: number[] }

/** Roads in the viewer's shape (one object per way, s = [e, n, u, visible] × samples); the old
 *  roads.json (already that shape) passes through. */
export function decodeRoads(data: Encoded | Road[]): Road[] {
  if (Array.isArray(data)) return data;
  const roads: Road[] = [];
  let p = 0, q = 0; // read positions in s and vis
  for (let i = 0; i < data.n.length; i++) {
    const n = data.n[i], s = new Array<number>(n * 4);
    let e = 0, no = 0, u = 0;
    for (let k = 0; k < n; k++, p += 3) {
      e += data.s[p]; no += data.s[p + 1]; u += data.s[p + 2];
      s[k * 4] = e / 10; s[k * 4 + 1] = no / 10; s[k * 4 + 2] = u / 10;
    }
    const runs = data.vis[q++];
    for (let r = 0, k = 0; r < runs; r++) {
      const len = data.vis[q++], vis = r % 2 === 0 ? 1 : 0;
      for (let j = 0; j < len; j++, k++) s[k * 4 + 3] = vis;
    }
    roads.push({ c: data.c[i], o: data.o[i], l: data.l[i], w: data.w[i], a: data.a[i], b: data.b[i], s });
  }
  return roads;
}

/**
 * Nearest road sample to an ENU point (within `maxM` metres): its height `u` and whether it is
 * visible from the camera, for things that stand on the ground next to the roads (pigeons,
 * carriages). Null when no road is that close.
 */
export function groundLookup(roads: Road[], maxM = 40) {
  const cell = maxM, grid = new Map<string, number[]>(); // flat [e, n, u, vis] per cell
  for (const r of roads) for (let i = 0; i < r.s.length; i += 4) {
    const key = `${Math.floor(r.s[i] / cell)},${Math.floor(r.s[i + 1] / cell)}`;
    let g = grid.get(key);
    if (!g) grid.set(key, (g = []));
    g.push(r.s[i], r.s[i + 1], r.s[i + 2], r.s[i + 3]);
  }
  return (e: number, n: number): { u: number; vis: boolean; d: number } | null => {
    const cx = Math.floor(e / cell), cy = Math.floor(n / cell);
    let best: { u: number; vis: boolean; d: number } | null = null;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const g = grid.get(`${cx + dx},${cy + dy}`);
      if (g) for (let k = 0; k < g.length; k += 4) {
        const d = Math.hypot(g[k] - e, g[k + 1] - n);
        if (d <= maxM && (!best || d < best.d)) best = { u: g[k + 2], vis: g[k + 3] > 0, d };
      }
    }
    return best;
  };
}
