# Hosting Isometric Kraków

Isometric Kraków (https://isometrickrakow.com) is the `krakow` region, the city of Kraków and nothing around it,
served from Piotr Kulpiński's own Cloudflare account. It is built on Isometric World by Dmytro Krasun
(https://isometriccity.com, https://github.com/krasun/isometricworld). The code is the same: every difference
is a setting in `.env` (`pipeline/src/site.ts`, `.env.example`).

| | |
|---|---|
| Cloudflare account | `f6459ac25378c8bf184c4104889d9272` |
| Zone | `isometrickrakow.com`, id `efef42db8d10b9207333e152b2606c1a` |
| Site | Worker `isometrickrakow`, custom domain `isometrickrakow.com`; `www` redirects to it |
| Tiles | R2 bucket `isometrickrakow-tiles`, public at `https://tiles.isometrickrakow.com` |
| Archive | R2 bucket `isometrickrakow-archive` (`ARCHIVE_BUCKET`) |
| Export cache | `~/Sites/isometricworld/data/web-isometrickrakow/` (`WEB_CACHE`) |
| Published state | `~/Sites/isometricworld/data/web-state-isometrickrakow/` (`WEB_STATE`) |

The cache and the state have folders of their own, so this bucket never mixes with `data/web/` and
`data/web-state/`, which track what is published on isometriccity.com.

## `.env`

In the checkout you publish and deploy from (no secrets in it):

```sh
TILES_ORIGIN=https://tiles.isometrickrakow.com
TILES_BUCKET=isometrickrakow-tiles
CLOUDFLARE_ACCOUNT_ID=f6459ac25378c8bf184c4104889d9272
SITE_DOMAIN=isometrickrakow.com
WORKER_NAME=isometrickrakow
SITE_NAME=Isometric Kraków
SITE_HOME=krakow
SITE_REGIONS=krakow
SITE_DESCRIPTION=Kraków as an isometric map, drawn from open data and painted with AI.
SITE_MAKERS=Made by [Piotr Kulpiński](https://kulpinski.dev)
SITE_SOURCE=https://github.com/piotrkulpinski/isometricworld
SITE_ICONS=/sites/isometric-krakow
SITE_HOME_ONLY=true
WEB_CACHE=/Users/admin/Sites/isometricworld/data/web-isometrickrakow
WEB_STATE=/Users/admin/Sites/isometricworld/data/web-state-isometrickrakow
```

With these, the site is one page: `/` is Kraków's map. `SITE_HOME_ONLY` builds no city pages, so `/krakow`,
`/wieliczka` and every other path answer 404 with the "No such place" page. The site has no path redirects (only `www` and `http` to the apex).
`?at=lat,lon,km` and `#@x,y,zoom` links work on `/`. The `krakow` region shares the Wieliczka region's camera and
grid, so `#@` links copied from the earlier site open the same view. The canonical URL, `og:url`, the social card
(`og/isometric-krakow.jpg`) and `sitemap.xml` (linked from `robots.txt`) all point at `https://isometrickrakow.com/`.
The map footer reads "Made by Piotr Kulpiński · Built on Isometric World by Dmytro Krasun (GitHub)" after the data
credits and "Painted with AI". The salt mine (its button, levels and plan credit) comes only with a region that
exports a mine, so Kraków has none.

Until 2026-11-26 the site served the `wieliczka` region (Kraków and Maciek Chmura's Wieliczka, copied from
isometriccity.com with `npm run mirror`). Its files stay in the bucket under `regions/wieliczka/` and its state in
`WEB_STATE/wieliczka.json`. No page links to them.

## Credentials

Never written to disk. Each command reads the Cloudflare token from 1Password inline:

```sh
export OP_SERVICE_ACCOUNT_TOKEN="$(cat ~/.config/op/agent-token)"   # if the shell has not loaded ~/.zshenv
TOKEN_REF='op://Agents/5larchv3bkb57bvk3syvrbjuky/credential'      # Cloudflare API Token (Workers deploy)
```

Publish is fastest through R2's S3 API (16 uploads at a time instead of ~4 files/s). An account API token with
R2 permissions doubles as an S3 key pair: the access key ID is the token's ID, the secret is the SHA-256 of the
token. If the token has no R2 permission, publish with `CLOUDFLARE_API_TOKEN` instead (same command without the
two R2 variables, about 5 hours for the first full upload).

## Export

The `krakow` region has no published state in this bucket yet, so its first export with this `.env` builds the
whole pyramid into `WEB_CACHE`. Later exports write only what changed. Export needs the region's borders
(`data/raw/boundaries/krakow.json`, local only): make them once with `REGION=krakow npm -w pipeline run boundaries -- krakow`.

```sh
DATA_DIR=/Users/admin/Sites/isometricworld/data npm run export -- krakow   # from a worktree; drop DATA_DIR in the main checkout
```

First export on 2026-11-27: 68,267 files (1.8 GB), 4,350 rendered and 411 painted tiles, no salt mine.

## Publish

The `wieliczka` region went live on 2026-11-26: 73,641 files uploaded and checked in 3,881 s, Worker version
`7773c405-e9da-4307-a755-9e0de4ad37d8`.

```sh
R2_ACCESS_KEY_ID="$(curl -s -H "Authorization: Bearer $(op read "$TOKEN_REF")" \
    https://api.cloudflare.com/client/v4/accounts/f6459ac25378c8bf184c4104889d9272/tokens/verify | jq -r .result.id)" \
R2_SECRET_ACCESS_KEY="$(op read "$TOKEN_REF" | tr -d '\n' | shasum -a 256 | cut -d' ' -f1)" \
npm run publish -- krakow
```

It prints the file count and size, asks `[y/N]`, uploads tiles and previews, then the data files, then
`state.json` and `world.json` last, checks `https://tiles.isometrickrakow.com/regions/krakow/data/world.json`,
records the state in `WEB_STATE` and empties the cache.

## Deploy

After every publish (pages bake in the published `world.json`):

```sh
CLOUDFLARE_API_TOKEN="$(op read "$TOKEN_REF")" npm run deploy
```

This builds `web/dist` and runs `wrangler deploy --domain isometrickrakow.com --name isometrickrakow` in account
`CLOUDFLARE_ACCOUNT_ID`. Wrangler creates the Worker, attaches the custom domain and its DNS record. The Worker
serves the static pages and the `/p/*` analytics proxy. Analytics stay off until a Pirsch key is set:
`CLOUDFLARE_API_TOKEN="$(op read "$TOKEN_REF")" npx wrangler secret put PIRSCH_ACCESS_KEY --name isometrickrakow`.

## One-time Cloudflare setup

All done on 2026-11-26. The Workers deploy token set the custom domain `tiles.isometrickrakow.com` on the bucket
and its CORS rule. That token has R2 and Workers access but no DNS or rulesets access on the zone (HTTP 403), so
the `www` record and the redirect ruleset (id `95cf232b08244708883de3864206e6a3`) went through Executor's
Cloudflare account. To repeat them, use a token with Zone DNS Edit and Single Redirect Edit on the zone.
"Always Use HTTPS" is on for the zone (set in the dashboard on 2026-11-26): `http://` answers 301 to `https://`
with the path and query kept.

```sh
CF=https://api.cloudflare.com/client/v4 A=f6459ac25378c8bf184c4104889d9272 Z=efef42db8d10b9207333e152b2606c1a
H="Authorization: Bearer $(op read "$TOKEN_REF")"

# tiles.isometrickrakow.com → the bucket (creates its DNS record)
curl -s -X POST "$CF/accounts/$A/r2/buckets/isometrickrakow-tiles/domains/custom" -H "$H" -H 'Content-Type: application/json' \
  -d "{\"domain\":\"tiles.isometrickrakow.com\",\"zoneId\":\"$Z\",\"enabled\":true,\"minTLS\":\"1.2\"}"

# CORS as on isometriccity.com: any origin may read (the pages fetch JSON with crossorigin; the dev server and
# local previews read it too)
curl -s -X PUT "$CF/accounts/$A/r2/buckets/isometrickrakow-tiles/cors" -H "$H" -H 'Content-Type: application/json' \
  -d '{"rules":[{"allowed":{"origins":["*"],"methods":["GET","HEAD"]},"exposeHeaders":["ETag"],"maxAgeSeconds":86400}]}'

# www.isometrickrakow.com: a proxied placeholder record and a 301 to the apex, path and query kept
curl -s -X POST "$CF/zones/$Z/dns_records" -H "$H" -H 'Content-Type: application/json' \
  -d '{"type":"AAAA","name":"www","content":"100::","proxied":true,"comment":"redirects to isometrickrakow.com"}'
curl -s -X PUT "$CF/zones/$Z/rulesets/phases/http_request_dynamic_redirect/entrypoint" -H "$H" -H 'Content-Type: application/json' \
  -d '{"rules":[{"expression":"(http.host eq \"www.isometrickrakow.com\")","action":"redirect","description":"www to apex","action_parameters":{"from_value":{"status_code":301,"target_url":{"expression":"concat(\"https://isometrickrakow.com\", http.request.uri.path)"},"preserve_query_string":true}}}]}'
```

The ruleset `PUT` replaces the zone's dynamic redirect rules, which is fine on a new zone. Check:

```sh
curl -sI https://tiles.isometrickrakow.com/regions/krakow/data/world.json -H 'Origin: https://isometrickrakow.com' | grep -i 'http/\|access-control'
curl -sI https://www.isometrickrakow.com/krakow?at=50.06,19.94,1 | grep -i 'http/\|location'
curl -sI http://isometrickrakow.com/krakow?at=50.06,19.94,1 | grep -i 'http/\|location'
curl -sI https://isometrickrakow.com/krakow | grep -i 'http/'      # 404
```

## Later updates

With this `.env`, `npm run export -- krakow` (or `--partial`) starts from this bucket's state, writes only
changed tiles, and `npm run publish -- krakow` uploads them. Then deploy. Social cards: `npm run og -- index krakow`
writes `web/public/og/isometric-krakow.jpg`
(the card of `/`) and the city cards; commit them.
