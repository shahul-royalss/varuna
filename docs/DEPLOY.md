# Deploying VARUNA

> **The finale does not depend on any of this.** CLAUDE.md rule 15 and section 5 are explicit: the
> demo runs from the laptop, offline, from baked runs. `make pack` is the artifact that matters on
> stage. Everything below exists so mentors, the jury and the idea submission can open a link
> before the event, and so continuous integration has somewhere to run. If the venue has no
> network, nothing here is missed.

## The split, and why

| Piece | Where | Why |
|---|---|---|
| Console and landing (`apps/command`) | **Vercel** | It is a Next.js App Router app; Vercel is its native target and the spec names it. Static pages prerender, so the site is useful even when the API is asleep. |
| API and engines (`services/*`) | **Railway** | The API is a long-lived Python process carrying numba, GDAL through rasterio, geopandas, pysteps and zarr, holding a WebSocket open and writing run artifacts to a disk. Railway runs an arbitrary container with a persistent volume, which is what that needs. |
| PostGIS and Timescale sink | **Supabase, later** | Not yet built. Spec section 4.2 makes the file store the P0 decision and the database sink a P1 upgrade. |

### Why not Supabase for the backend

Supabase is Postgres with PostgREST, auth, object storage and Deno edge functions. It is an
excellent database platform and a poor host for this particular service, because VARUNA's backend
is not a database with a thin API over it. It is a scientific compute process:

- The Twin solver is a Numba-compiled shallow-water kernel that runs for seconds per cycle. Deno
  edge functions cannot run it, and neither can a Postgres function.
- The engines need GDAL, PROJ, numba, pysteps and zarr. Those install into a container, not into a
  managed Postgres.
- `WS /v1/live` (spec section 11.11) needs a process that stays up between requests.
- Spec section 4.2 already decided the P0 store: run products are **files** under
  `data/runs/<run_id>/`, chosen for "zero infrastructure on stage, byte-reproducible bakes,
  trivial offline packaging". A database is not required to serve them, and adding one would work
  against the offline packaging the finale depends on.

Supabase becomes the right tool the moment we build the P1 sink in `services/api/sinks/postgis.py`,
which mirrors the blueprint's section 9.1 tables. At that point it hosts PostGIS and TimescaleDB
and the pitch can show the schema. Until then it would be an empty dependency.

## Vercel (console)

Root directory `apps/command`. The repository is a pnpm workspace, so the install must run from
the repository root; `vercel.json` sets that up. Environment:

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | the Railway URL | Without it the client falls back to `http://localhost:8000`, and every screen shows its honest "The VARUNA API is unreachable" state rather than breaking. |
| `NEXT_PUBLIC_SITE_URL` | the Vercel URL | Resolves the Open Graph image. |

## Railway (API)

Deploy from the `Dockerfile` at the repository root. Attach a volume mounted at `/data`.

| Variable | Value |
|---|---|
| `PORT` | set by Railway |
| `VARUNA_DATA_DIR` | `/data` |
| `VARUNA_CITY_DIR` | `/data/city` |
| `VARUNA_BUNDLES_DIR` | `/data/bundles` |
| `VARUNA_CITY` | `mumbai` |
| `VARUNA_MODE` | `replay` |
| `VARUNA_BUILD_ON_BOOT` | `1` on the first deploy, then `0` |
| `CORS_ORIGINS` | the Vercel URL |

### The data question

`city/` and `data/runs/` are generated and gitignored, so the image ships without them. On first
boot the entrypoint downloads the public terrain and land-cover tiles and runs the city pipeline
into the volume, which takes a few minutes and about 400 MB. After that it is skipped.

If the build fails the API still starts and every layer endpoint answers 404 with the command that
fixes it. That is deliberate: a visitor seeing an honest "not built yet" is better served than one
seeing a container that will not boot.

### What the deployed API can serve today

The eight city layers, the run registry, the cycle status and the live socket. Forecast endpoints
answer 501 with the phase that implements them, because no run has been baked yet — Phase 5 does
that. The deployed console therefore shows the real Mumbai terrain, roads, assets, hotspots and the
inferred drain graph, with honest empty states where the forecast will go.

## Cost and shape

The API image is roughly 1.5 GB and the service is small but always on; Railway's starter credit
covers a demo-scale deployment but not a busy one. Vercel's hobby tier covers the console. Neither
is on the critical path for the finale.
