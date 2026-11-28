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
SITE_LIVE_DATA=true
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

The `krakow` region went live on 2026-11-27: 68,267 files (1,784.5 MB) uploaded and checked in 1,744 s, then the
one-page site was deployed as Worker version `a292fa53-c4bc-4dfe-a824-2d1696d14f6d`. Before it, the `wieliczka`
region was live from 2026-11-26 (73,641 files, Worker version `7773c405-e9da-4307-a755-9e0de4ad37d8`).

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

### Cached 404s for new bundles

`web/public/_headers` gives `/_astro/*` a year-long `immutable` Cache-Control, and Cloudflare applies it to 404s
too. A deploy that changes the page script renames its bundle. A browser that loads the page in the few seconds
before the new bundle reaches its Cloudflare edge gets a 404 for it and keeps that 404 for a year. That browser then
shows only the opening preview, with no map and no footer, until its cache is cleared. It happened to a test browser
right after the 2026-11-27 deploy. Upstream (isometriccity.com) has the same window on every deploy.

The fix (prepared 2026-11-27, not deployed yet): `wrangler.jsonc` runs the Worker first for `/_astro/*` too, and
`worker/index.ts` returns a 404 there with `Cache-Control: no-store`. Bundles that exist keep the immutable header.
It costs one Worker invocation per bundle request.

## Daily upload

Piotr approved one standing job: once a day, upload what changed in the `krakow` region to `isometrickrakow-tiles`
under `regions/krakow/`. It never deploys the Worker: site changes still need his yes.

`scripts/daily-publish-isometrickrakow.sh` exports `krakow` into `WEB_CACHE` (`data/web-isometrickrakow`) against
`WEB_STATE` (`data/web-state-isometrickrakow`), publishes the changed files (`world.json` last), then checks that
`https://tiles.isometrickrakow.com/regions/krakow/data/world.json` answers 200. It sets the bucket, origin, account,
cache and state itself, so the checkout's `.env` does not matter. It reads the Cloudflare token with `op read`
(60 s limit) when the upload starts and passes it only to that one command. It holds a lock
(`data/.daily-publish-isometrickrakow.lock`), so two runs never overlap, and it skips the day when the data disk has
less than 15 GiB free. Logs: `data/logs/daily-publish/<date>.log`. A failure writes a `FAILED:` line there and
posts to Slack `#notifications` through the Mini's `@pawelek` bot. `--dry-run` exports and reports what a publish
would upload without uploading.

The LaunchAgent `com.kulpinski.isometrickrakow-daily-publish` (`scripts/launchd/`) runs it at 04:00 every day
(the Mini's clock is Europe/Warsaw). It runs the script from the main checkout, `~/Sites/isometricworld`, not from a
T3 worktree, because the Mini's cleanup job removes `node_modules` from idle worktrees. It runs the script through
`ssh localhost`: macOS privacy settings keep GUI LaunchAgents (`zsh` and `bash` alike) out of `/Volumes/Storage`,
where `data/` lives, while an SSH session may write there. The first run, 2026-11-28 04:00, ran the script directly
and failed on that (`operation not permitted` on the log), so it uploaded nothing. The script now reports an
unwritable data disk or a lock it cannot create as a failure (exit 1, Slack alert), and a lock older than 6 hours as
stale, instead of logging "skipped".

```sh
# install (or reinstall after editing the plist)
cp scripts/launchd/com.kulpinski.isometrickrakow-daily-publish.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kulpinski.isometrickrakow-daily-publish.plist

# pause (stays installed, skips its runs) and resume
launchctl disable gui/$(id -u)/com.kulpinski.isometrickrakow-daily-publish
launchctl enable gui/$(id -u)/com.kulpinski.isometrickrakow-daily-publish

# run now, and check
launchctl kickstart gui/$(id -u)/com.kulpinski.isometrickrakow-daily-publish
launchctl print gui/$(id -u)/com.kulpinski.isometrickrakow-daily-publish | grep -E 'state|last exit'
tail -20 ~/Sites/isometricworld/data/logs/daily-publish/$(date +%F).log

# remove
launchctl bootout gui/$(id -u)/com.kulpinski.isometrickrakow-daily-publish
rm ~/Library/LaunchAgents/com.kulpinski.isometrickrakow-daily-publish.plist
```

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
