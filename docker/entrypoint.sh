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
  else
    log "city build failed; the API keeps serving 404s that name the command"
    return 1
  fi
}

if [ "${BUILD_ON_BOOT}" = "1" ]; then
  build_city &
fi

log "starting the API on :${PORT}"
exec uv run uvicorn varuna_api.main:app --host 0.0.0.0 --port "${PORT}" --proxy-headers
