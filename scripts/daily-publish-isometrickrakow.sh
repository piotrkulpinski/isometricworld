#!/bin/zsh
# Daily upload of the krakow region to isometrickrakow.com (docs/hosting-isometrickrakow.md, "Daily upload").
#
#   scripts/daily-publish-isometrickrakow.sh            # export krakow, publish the changed files, check world.json
#   scripts/daily-publish-isometrickrakow.sh --dry-run  # export only: report what a publish would upload
#
# Uploads only to the R2 bucket isometrickrakow-tiles under regions/krakow/ (publish.ts, world.json last). It never
# deploys the Worker. The Cloudflare token is read from 1Password with `op read` when the upload starts and is
# passed only in the environment of that one command, never written to disk.
# One run at a time (a lock directory); skipped cleanly when the data disk has less than 15 GiB free.
set -u
setopt pipe_fail

REPO=${0:A:h:h}
DATA=${ISOMETRICKRAKOW_DATA:-$HOME/Sites/isometricworld/data}
LOGDIR=$DATA/logs/daily-publish
LOG=$LOGDIR/$(date +%F).log
LOCK=$DATA/.daily-publish-isometrickrakow.lock
TOKEN_REF='op://Agents/5larchv3bkb57bvk3syvrbjuky/credential' # Cloudflare API Token (Workers deploy)
ACCOUNT=f6459ac25378c8bf184c4104889d9272
CHECK=https://tiles.isometrickrakow.com/regions/krakow/data/world.json
DRY=0; [[ ${1:-} == --dry-run ]] && DRY=1

export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export OP_SERVICE_ACCOUNT_TOKEN=${OP_SERVICE_ACCOUNT_TOKEN:-$(cat $HOME/.config/op/agent-token 2>/dev/null)}
# the site's bucket and its own cache and state; nothing else is read from .env for these
export DATA_DIR=$DATA TILES_ORIGIN=https://tiles.isometrickrakow.com TILES_BUCKET=isometrickrakow-tiles \
  CLOUDFLARE_ACCOUNT_ID=$ACCOUNT WEB_CACHE=$DATA/web-isometrickrakow WEB_STATE=$DATA/web-state-isometrickrakow

mkdir -p $LOGDIR
exec >>$LOG 2>&1
log() { print -r -- "$(date '+%F %T') $*"; }

alert() { # failure line in the log, and a post to #notifications when the Mini's Slack token is there
  log "FAILED: $1"
  local env=$HOME/.credentials/agent-jobs.env slack=$HOME/Sites/agent-config/ops/lib/slack.mjs
  [[ -r $env && -r $slack ]] && (set -a; source $env; set +a
    node $slack notifications --text "isometrickrakow.com daily upload failed: $1 (log: $LOG)" >/dev/null) || true
}

# `op read` with a 60 s limit: it can hang (inside a LaunchAgent on the Mini, for one); SIGALRM ends it (exit 142)
op_read() { perl -e 'alarm 60; exec @ARGV' op read "$TOKEN_REF"; }

if ! mkdir $LOCK 2>/dev/null; then log "skipped: another run holds $LOCK"; exit 0; fi
trap 'rmdir $LOCK 2>/dev/null' EXIT

free=$(df -g $DATA | awk 'NR==2 {print $4}')
if (( free < 15 )); then log "skipped: only ${free} GiB free on $DATA (needs 15)"; exit 0; fi

log "start (repo $REPO, dry run $DRY, ${free} GiB free)"
cd $REPO || { alert "no repo at $REPO"; exit 1; }

if ! npm run export -- krakow; then alert "export failed"; exit 1; fi

pending=$WEB_CACHE/regions/krakow
if [[ ! -d $pending ]]; then log "nothing to publish: export changed no files"; log "done"; exit 0; fi
summary=$(find $pending -type f \( -name '*.avif' -o -name '*.webp' -o -name '*.json' \) -print0 | xargs -0 stat -f %z | awk '{s+=$1; n++} END {printf "%d files, %.1f MB", n, s/1e6}')
log "pending: $summary"
if (( DRY )); then log "dry run: not published"; log "done"; exit 0; fi

token=$(op_read) || { alert "op read of the Cloudflare token failed or timed out (exit $?)"; exit 1; }
[[ -n $token ]] || { alert "op read returned an empty token"; exit 1; }
key_id=$(curl -s -H "Authorization: Bearer $token" https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/tokens/verify | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["id"])' 2>/dev/null)
[[ -n $key_id ]] || { alert "Cloudflare token did not verify"; exit 1; }
secret=$(print -rn -- $token | shasum -a 256 | cut -d' ' -f1)
unset token

if ! R2_ACCESS_KEY_ID=$key_id R2_SECRET_ACCESS_KEY=$secret npm run publish -- krakow --yes; then
  unset secret; alert "publish failed ($summary pending)"; exit 1
fi
unset secret

code=$(curl -s -o /dev/null -w '%{http_code}' "$CHECK?t=$(date +%s)")
if [[ $code != 200 ]]; then alert "$CHECK answered $code after publish"; exit 1; fi
log "published $summary; $CHECK 200"
log "done"
