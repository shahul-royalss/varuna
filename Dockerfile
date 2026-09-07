# VARUNA API image (Railway). See docs/DEPLOY.md and ADR-0014.
#
# The console is a separate Vercel deployment; this image is only the FastAPI service
# and the engines it calls. It carries the scientific stack (numba, GDAL through rasterio,
# geopandas, pysteps, zarr), so it is large by nature - about 1.5 GB. That is the cost of
# running real physics rather than a mock.

FROM python:3.12-slim-bookworm AS base

# GDAL/PROJ come from the rasterio and pyproj wheels, so only the C runtime bits and curl
# (for the healthcheck) are needed here. git is required by uv for any VCS dependency.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git libexpat1 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.12.8 /uv /uvx /usr/local/bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Dependency layer: copy only what resolves the lock, so a code change does not re-resolve
# the whole scientific stack (which takes minutes).
COPY pyproject.toml uv.lock .python-version ./
COPY packages/schemas/pyproject.toml packages/schemas/
COPY services/api/pyproject.toml services/api/
COPY services/city/pyproject.toml services/city/
COPY services/cycle/pyproject.toml services/cycle/
COPY services/flash/pyproject.toml services/flash/
COPY services/products/pyproject.toml services/products/
COPY services/pulse/pyproject.toml services/pulse/
COPY services/replay/pyproject.toml services/replay/
COPY services/route/pyproject.toml services/route/
COPY services/sky/pyproject.toml services/sky/
COPY services/twin/pyproject.toml services/twin/
COPY services/verify/pyproject.toml services/verify/
COPY tools/ tools/
RUN uv sync --frozen --no-dev --no-install-workspace

# Source layer.
COPY packages/ packages/
COPY services/ services/
COPY Makefile ./
RUN uv sync --frozen --no-dev

# Static city layers and replay bundles are generated, not committed (see .gitignore), so the
# image ships without them and the entrypoint builds them into the mounted volume on first
# boot. Every layer endpoint answers 404 with "Run make city CITY=<city>" until it has, which
# is the honest state rather than a crash.
ENV VARUNA_DATA_DIR=/data \
    VARUNA_CITY_DIR=/data/city \
    VARUNA_BUNDLES_DIR=/data/bundles \
    VARUNA_MODE=replay \
    VARUNA_CITY=mumbai \
    PORT=8000

COPY docker/entrypoint.sh /usr/local/bin/varuna-entrypoint
RUN chmod +x /usr/local/bin/varuna-entrypoint

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["varuna-entrypoint"]
