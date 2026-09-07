#!/usr/bin/env bash
# VARUNA API entrypoint (Railway). See docs/DEPLOY.md.
#
# City layers and replay bundles are generated artifacts, not committed, so on a fresh volume
# this builds them once and then starts the API. Every step is skipped when its output already
# exists, so a redeploy restarts in seconds. If a build step fails the API still starts: the
# layer endpoints answer 404 naming the command to run, which is more useful to a visitor than
# a container that will not boot.
set -uo pipefail

CITY="${VARUNA_CITY:-mumbai}"
PORT="${PORT:-8000}"
BUILD_ON_BOOT="${VARUNA_BUILD_ON_BOOT:-1}"
CITY_DIR="${VARUNA_CITY_DIR:-/data/city}"

log() { printf '{"event":"entrypoint","msg":"%s","ts":"%s"}\n' "$1" "$(date -Is)"; }

if [ "${BUILD_ON_BOOT}" = "1" ]; then
  if [ -f "${CITY_DIR}/${CITY}/map/segments.geojson" ]; then
    log "city ${CITY} already built, skipping"
  else
    log "building city ${CITY} into ${CITY_DIR} (first boot; a few minutes)"
    # The open data is public and fetched through the OS trust store (ADR-0006).
    uv run python tools/prefetch_city_cache.py --city "${CITY}" \
      || log "prefetch failed; the city build will report what is missing"
    uv run varuna city --city "${CITY}" \
      || log "city build failed; the API will serve 404s that name the command"
  fi
fi

log "starting the API on :${PORT}"
exec uv run uvicorn varuna_api.main:app --host 0.0.0.0 --port "${PORT}" --proxy-headers
