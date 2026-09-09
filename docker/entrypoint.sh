#!/usr/bin/env bash
# VARUNA API entrypoint (Railway). See docs/DEPLOY.md.
#
# City layers and replay bundles are generated artifacts, not committed, so on a fresh volume
# this builds them once and then keeps them. The build runs in the background: the API starts
# at once so the platform health check on /healthz passes, and the layer endpoints answer 404
# naming the command to run until the files land, which is the honest state. The router looks
# the files up per request, so nothing needs a restart when the build finishes. If a build
# step fails the API stays up and the 404s stay honest; a redeploy retries from the cache.
set -uo pipefail

CITY="${VARUNA_CITY:-mumbai}"
PORT="${PORT:-8000}"
BUILD_ON_BOOT="${VARUNA_BUILD_ON_BOOT:-1}"
CITY_DIR="${VARUNA_CITY_DIR:-/data/city}"

log() { printf '{"event":"entrypoint","msg":"%s","ts":"%s"}\n' "$1" "$(date -Is)"; }

build_city() {
  if [ -f "${CITY_DIR}/${CITY}/map/segments.geojson" ]; then
    log "city ${CITY} already built, skipping"
    return 0
  fi
  log "building city ${CITY} into ${CITY_DIR} in the background (first boot; a few minutes)"
  # The open data is public and fetched through the OS trust store (ADR-0006). Both steps
  # are resumable, so a restart mid-way continues from what the volume already holds.
  uv run python tools/prefetch_city_cache.py --city "${CITY}" \
    || log "prefetch failed; the city build will report what is missing"
  if uv run varuna city --city "${CITY}"; then
    log "city ${CITY} built; layer endpoints are live"
    drop_download_cache
  else
    log "city build failed; the API keeps serving 404s that name the command"
    return 1
  fi
}

# The download cache is 339 MB of Copernicus and WorldCover tiles against a 500 MB volume that
# also has to hold the 116 MB the build produces - 94 % full, and a volume that fills mid-build
# leaves a half-written city. The cache only exists so a *rebuild* need not re-download, and
# once segments.geojson is on disk build_city skips the rebuild entirely, so after a success it
# is dead weight. It is dropped only on success: a boot that failed part-way still finds the
# cache where it left it and resumes, which is what makes the build restartable.
#
# The cost is honest - if the city ever has to be rebuilt from scratch, it re-downloads. That is
# rare, it is a few minutes, and it beats a build that dies at 94 % full. A volume larger than
# 500 MB (Railway ties volume size to the plan) would make this unnecessary.
drop_download_cache() {
  cache="${CITY_DIR}/cache"
  [ -d "${cache}" ] || return 0
  freed="$(du -sh "${cache}" 2>/dev/null | cut -f1)"
  rm -rf "${cache}" && log "dropped the ${freed:-?} download cache; the built city is what persists"
}

if [ "${BUILD_ON_BOOT}" = "1" ]; then
  build_city &
fi

log "starting the API on :${PORT}"
exec uv run uvicorn varuna_api.main:app --host 0.0.0.0 --port "${PORT}" --proxy-headers
