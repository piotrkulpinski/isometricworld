// @ts-check
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { HOSTING } from '../pipeline/src/hosting.ts';
import { CITIES } from '../pipeline/src/places.ts';
import { siteCities, siteConfig } from '../pipeline/src/site.ts';

// hosting settings (TILES_ORIGIN, SITE_DOMAIN) live in the repo-root .env, never in git
const ENV = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(ENV)) process.loadEnvFile(ENV);
// what this site is (name, home city, regions, makers): pipeline/src/site.ts, from SITE_* in .env
const SITE = siteConfig();

/**
 * Map data is not in web/public. In dev, /regions/* is served from the export cache
 * (data/web/regions: what `npm run export` built and `npm run publish` has not uploaded yet), and
 * everything else is proxied from production (R2), same-origin, so any dev port works without CORS.
 * The built site loads R2 directly.
 */
// WEB_CACHE (as for the pipeline's export): serve another export cache, e.g. a preview built with export --paint-tag
const CACHE = process.env.WEB_CACHE ? process.env.WEB_CACHE.replace(/\/*$/, '/') : fileURLToPath(new URL('../data/web/', import.meta.url));
const TYPES = { avif: 'image/avif', webp: 'image/webp', json: 'application/json' };

/** @returns {import('vite').Plugin} */
const regionsOverlay = () => ({
	name: 'regions-overlay',
	configureServer(server) {
		server.middlewares.use('/regions/', (req, res) => {
			const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
			const file = CACHE + 'regions' + path;
			if (!path.includes('..') && existsSync(file) && statSync(file).isFile()) {
				res.setHeader('Content-Type', TYPES[/** @type {'avif'|'webp'|'json'} */ (file.split('.').pop())] ?? 'application/octet-stream');
				res.setHeader('Cache-Control', 'no-store');
				res.setHeader('X-Source', 'local-cache');
				createReadStream(file).pipe(res);
				return;
			}
			fetch(`${HOSTING.origin}/regions${req.url}`).then(async (r) => {
				res.statusCode = r.status;
				for (const h of ['content-type', 'cache-control', 'etag']) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
				res.setHeader('X-Source', 'r2');
				res.end(Buffer.from(await r.arrayBuffer()));
			}).catch((e) => { res.statusCode = 502; res.end(String(e)); });
		});
	},
});

/**
 * Real 301s for capitalised city links (/Tel-Aviv-Yafo → /tel-aviv-yafo): writes dist/_redirects,
 * which Cloudflare static assets apply before anything else. Matching is case-sensitive, so each city
 * gets its Title-Case and title-based spellings; anything else still falls back to 404.html's script.
 * (Not Astro's `redirects`: /Tel-Aviv-Yafo.html and /tel-aviv-yafo.html collide on macOS.)
 */
/** @returns {import('astro').AstroIntegration} */
const cityRedirects = () => ({
	name: 'city-redirects',
	hooks: {
		'astro:build:done': ({ dir }) => {
			const lines = [];
			for (const slug of siteCities(SITE)) {
				const city = CITIES[slug];
				const titleCase = slug.replace(/(^|-)([a-z])/g, (_, s, c) => s + c.toUpperCase());
				const fromTitle = city.title.trim().replace(/\s+/g, '-');
				for (const from of new Set([titleCase, fromTitle, slug.toUpperCase()])) {
					if (from !== slug && /^[\w-]+$/.test(from)) lines.push(`/${from} /${slug} 301`);
				}
			}
			writeFileSync(new URL('_redirects', dir), lines.join('\n') + '\n');
		},
	},
});

/**
 * The running dev server's URL in data/dev-server.json (removed when it stops): the test and film scripts
 * (pipeline/src/paths.ts siteUrl) open it when given no URL and SITE_URL is empty, whatever port Astro picked.
 */
const DEV_SERVER = fileURLToPath(new URL('../data/dev-server.json', import.meta.url));
/** @returns {import('astro').AstroIntegration} */
const devServerUrl = () => ({
	name: 'dev-server-url',
	hooks: {
		'astro:server:start': ({ address }) => {
			mkdirSync(fileURLToPath(new URL('../data/', import.meta.url)), { recursive: true });
			writeFileSync(DEV_SERVER, JSON.stringify({ url: `http://localhost:${address.port}/`, pid: process.pid }));
		},
		'astro:server:done': () => rmSync(DEV_SERVER, { force: true }),
	},
});

// https://astro.build/config
export default defineConfig({
	integrations: [cityRedirects(), devServerUrl()],
	site: process.env.SITE_DOMAIN ? `https://${process.env.SITE_DOMAIN}` : undefined,
	vite: {
		// the browser has no process.env: bake the tile origin into the viewer
		define: { __TILES_ORIGIN__: JSON.stringify(HOSTING.origin), __WEB_CACHE__: JSON.stringify(CACHE), __SITE__: JSON.stringify(SITE) },
		// pre-bundle the viewer so the dev server never serves a stale dependency
		optimizeDeps: { include: ['openseadragon'] },
		plugins: [regionsOverlay()],
	},
});
