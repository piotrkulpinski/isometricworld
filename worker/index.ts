/**
 * The site's Worker. Static pages are served from assets (wrangler.jsonc); /_astro/* runs here only to keep a
 * missing bundle's 404 out of browser caches (see fetch), and /p/* is a
 * first-party proxy for Pirsch Analytics (https://docs.pirsch.io/advanced/cf-workers), so the script and
 * its requests stay on our domain and the access key stays server-side.
 *
 * Secret: PIRSCH_ACCESS_KEY (Pirsch → Settings → Integration → Add Client, type "Access Key"), set with
 * `npx wrangler secret put PIRSCH_ACCESS_KEY`. Without it the proxy accepts requests and drops them.
 */

interface Env { PIRSCH_ACCESS_KEY?: string; ASSETS: { fetch(request: Request): Promise<Response> } }

const PIRSCH = "https://api.pirsch.io";
// keep these free of words ad blockers filter (pirsch, analytics, tracker, hit, event, pageview)
const SCRIPT = "/p/s.js", PAGE_VIEW = "/p/v", EVENT = "/p/e", SESSION = "/p/k";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === SCRIPT && request.method === "GET") return script();
		if (path === PAGE_VIEW && request.method === "GET") return pageView(request, env);
		if (path === EVENT && request.method === "POST") return event(request, env);
		if (path === SESSION && request.method === "POST") return session(request, env);
		if (path.startsWith("/p/")) return new Response(null, { status: 404 });
		const asset = await env.ASSETS.fetch(request); // /_astro/* bundles (and anything else outside /p/*)
		// _headers gives /_astro/* a year-long immutable Cache-Control, 404s included: a browser that asks for a new
		// bundle in the seconds before a deploy reaches its edge would keep that 404 for a year (a page with no map)
		if (asset.status === 404 && path.startsWith("/_astro/")) {
			const r = new Response(asset.body, asset);
			r.headers.set("Cache-Control", "no-store");
			return r;
		}
		return asset;
	},
};

/** pa.js, cached at the edge for an hour. */
async function script(): Promise<Response> {
	const r = await fetch(`${PIRSCH}/pa.js`, { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
	return new Response(r.body, {
		status: r.status,
		headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" },
	});
}

/** What Pirsch needs from the visitor's request (it hashes them into a daily, cookie-free fingerprint). */
function visitor(request: Request) {
	const h = request.headers;
	return {
		ip: h.get("CF-Connecting-IP"),
		user_agent: h.get("User-Agent"),
		accept_language: h.get("Accept-Language"),
		sec_ch_ua: h.get("Sec-CH-UA"),
		sec_ch_ua_mobile: h.get("Sec-CH-UA-Mobile"),
		sec_ch_ua_platform: h.get("Sec-CH-UA-Platform"),
		sec_ch_ua_platform_version: h.get("Sec-CH-UA-Platform-Version"),
		sec_ch_width: h.get("Sec-CH-Width"),
		sec_ch_viewport_width: h.get("Sec-CH-Viewport-Width"),
	};
}

/** Only count pages of this site: the reported URL must be on the host the request came to. */
function ownPage(request: Request, url: unknown): boolean {
	try { return typeof url === "string" && new URL(url).hostname === new URL(request.url).hostname; }
	catch { return false; }
}

async function forward(env: Env, endpoint: string, body: unknown): Promise<Response> {
	if (!env.PIRSCH_ACCESS_KEY) return new Response(null, { status: 202 });
	const r = await fetch(`${PIRSCH}/api/v1/${endpoint}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.PIRSCH_ACCESS_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return new Response(null, { status: r.ok ? 200 : r.status, headers: { "Cache-Control": "no-store" } });
}

/** pa.js sends page views as GET with query parameters. */
function pageView(request: Request, env: Env): Promise<Response> | Response {
	const q = new URL(request.url).searchParams;
	const url = q.get("url");
	if (!ownPage(request, url)) return new Response(null, { status: 400 });
	const tags: Record<string, string> = {};
	for (const [k, v] of q) if (k.startsWith("tag_")) tags[k.slice(4)] = v;
	return forward(env, "hit", {
		url,
		title: q.get("t"),
		referrer: q.get("ref"),
		screen_width: Number.parseInt(q.get("w") ?? "", 10) || 0,
		screen_height: Number.parseInt(q.get("h") ?? "", 10) || 0,
		...(Object.keys(tags).length ? { tags } : {}),
		...visitor(request),
	});
}

/** pa.js sends events (window.pirsch(name, …)) as a JSON beacon. */
async function event(request: Request, env: Env): Promise<Response> {
	let data: Record<string, unknown>;
	try { data = await request.json(); } catch { return new Response(null, { status: 400 }); }
	if (!ownPage(request, data.url)) return new Response(null, { status: 400 });
	delete data.identification_code;
	return forward(env, "event", { ...data, ...visitor(request) });
}

/** Session keep-alive (only sent when the snippet has data-interval-ms). */
function session(request: Request, env: Env): Promise<Response> {
	return forward(env, "session", visitor(request));
}
