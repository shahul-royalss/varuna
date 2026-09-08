# Architecture decision records

Five lines each: context, decision, alternatives, consequence, date. Newest at the bottom.

## ADR-0001 Repository lives at `C:\dev\varuna`, not inside OneDrive

- Context: the spec folder is `C:\Users\shahu\OneDrive\Documents\for sih`. The first `uv sync` there failed with "Access is denied" on a rename inside `.venv`; GNU make and several tools mishandle spaces in paths; OneDrive syncing `node_modules` and `.next` is a known source of EBUSY failures.
- Decision: build in `C:\dev\varuna` (short path, no spaces, outside OneDrive). A pointer README is left in the OneDrive folder.
- Alternatives: relocate only `.venv` via `UV_PROJECT_ENVIRONMENT` (fragile; `node_modules` and `.next` would still be in OneDrive); a directory junction (OneDrive does not sync through junctions reliably).
- Consequence: contributors clone or copy to a non-synced path; the repo is a normal git repository and can be pushed anywhere.
- Date: 2026-09-04

## ADR-0002 Python 3.12 via a uv-managed interpreter; `system-certs = true`

- Context: the machine has Python 3.14 (too new for numba and pysteps wheels) and uv's bundled TLS roots rejected GitHub and PyPI certificates on this network ("invalid peer certificate: UnknownIssuer").
- Decision: `requires-python = ">=3.12,<3.13"`, `.python-version = 3.12`, `[tool.uv] system-certs = true` so uv uses the Windows certificate store.
- Alternatives: pin 3.13 (numba and pysteps lag); set `UV_SYSTEM_CERTS` per shell (forgettable).
- Consequence: `uv sync` works from a clean clone; Python 3.12.14 is downloaded automatically by uv.
- Date: 2026-09-04

## ADR-0003 uv workspace with one package per service

- Context: the spec wants every engine as a Python package under `services/` with its own tests, CLI and `run()`.
- Decision: the root `pyproject.toml` is a uv workspace; members are `packages/schemas` and `services/*`; import names are `varuna_<service>`; the root package `varuna` (in `tools/varuna_cli`) provides the `varuna` CLI and depends on every member.
- Alternatives: a single monolithic package (blurs service boundaries); separate virtualenvs per service (slow, duplicated science stack).
- Consequence: `uv sync` installs everything editable; `uv run varuna <task>` mirrors every `make` target so Windows users without GNU make are not blocked.
- Date: 2026-09-04

## ADR-0004 GNU make from winget (ezwinports) plus a Python task runner

- Context: `make` was not installed; Chocolatey needs admin rights.
- Decision: install `ezwinports.make` via winget at user scope; implement every target in `tools/varuna_cli` so `make <target>` is a thin wrapper around `uv run varuna <target>`.
- Alternatives: `just`; npm scripts only; PowerShell scripts.
- Consequence: `make demo` works in any new terminal; `uv run varuna demo` is the identical fallback.
- Date: 2026-09-04

## ADR-0005 Run artifacts are files; PostGIS is P1

- Context: spec section 4.2.
- Decision: `data/runs/<run_id>/` holds GeoParquet, GeoJSON, PNG, Zarr and JSON served by FastAPI; an in-process asyncio bus replaces Redis and Redpanda with the same topic names.
- Alternatives: PostGIS and Timescale from day one (infrastructure on stage); SQLite.
- Consequence: zero infrastructure on stage, byte-reproducible bakes, trivial offline packaging; the PostGIS sink mirrors the blueprint schema later.
- Date: 2026-09-04

## ADR-0006 Network access goes through the Windows trust store; GDAL never reads remote files

- Context: Norton "Web/Mail Shield" re-signs every TLS connection on the demo laptop. Python `requests` (certifi) and GDAL's bundled curl fail verification ("unable to get local issuer certificate", "schannel: the certificate chain is incomplete"); `urllib` with the Windows store and Node work. Verified 2026-09-04 with `openssl s_client` (issuer "Norton Web/Mail Shield Root").
- Decision: every HTTP download in the Python services goes through `varuna_schemas.net` which calls `truststore.inject_into_ssl()` once (OS trust store on Windows, macOS and Linux) and streams to `city/cache/` with resume and size checks. Rasters are always read from the local cache; `vsicurl` is not used. `GDAL_HTTP_UNSAFESSL` is never set.
- Alternatives: export the Norton root into a PEM bundle and set `CURL_CA_BUNDLE` (machine-specific, fragile); disable certificate checks (unsafe); ask the user to disable Norton scanning (out of our hands on stage).
- Consequence: the pipeline works on this laptop and on a clean Linux CI runner unchanged; first-run downloads are explicit, cached and inspectable; the offline package ships the cache.
- Date: 2026-09-04

## ADR-0007 The demo replays 2 July 2019 at 06:40 IST, not 15:40

- Context: the curated ground truth (29 sourced pins inside the area of interest, `docs/research/ground_truth_MUM-2019-07-02.md`) shows the Mumbai cloudburst peaked overnight on 1-2 July and the civic reports cluster between 08:07 and 14:28 IST on 2 July; by 17:22 IST the municipal corporation said waterlogging had receded. The spec's demo script opened at 15:40 IST, after the event, where no pin would land.
- Decision: the replay window becomes 05:40 to 09:40 IST on 2 July 2019 with the cycle opening at 06:40 IST. Thirteen sourced pins then land inside the forecast window at lead times of 87 to 150 minutes, so every pin arrives between one and a half and two and a half hours after VARUNA flags the street.
- Alternatives: open at 08:00 (fourteen pins, but some land only 7 minutes ahead, which demonstrates nowcasting the present rather than forecasting); keep 15:40 and accept that no pin lands (breaks rule 7 and the 2:40 beat of the demo); switch to another Mumbai event (unnecessary, this one yields 29 pins against a minimum of 10).
- Consequence: the demo script times in section 15 shift by nine hours; the storm designer calibrates to the 05:40-09:40 window, which sits inside the one primary-sourced total (Santacruz 375.2 mm for the 24 hours ending 08:30 IST on 2 July, IMD); the "three hours early" claim is now evidenced rather than asserted. Depth MAE cannot be scored for this event because no cached source states a depth in centimetres, so `/verify` reports occurrence, place and timing only, and says why.
- Date: 2026-09-06

## ADR-0008 The city build is a chain of cache-and-reload steps, in dependency order

- Context: `make city` runs eleven steps of CLAUDE.md 10.1 over 168,606 cells and 34,539 road edges; a full build is minutes, and Phase 2 onwards will re-run it constantly while iterating on one step.
- Decision: every step in `varuna_city.pipeline` declares the files it writes and the files it reads, and carries both a `build` and a `load`; when its outputs are newer than its inputs it *reloads* its products from `city/<city>/` instead of recomputing them. Steps run in dependency order, not the spec's numbering: hotspots before conditioning (chronic underpasses must survive as sinks), drains before units (a unit is the watershed draining to an inlet), and the units are joined back onto the drain nodes so `inlet_links.parquet` names real units.
- Alternatives: recompute everything every time (a 5-minute inner loop); a build system such as doit or snakemake (another dependency and another language on stage); hand-rolled `if path.exists()` checks inside each module (the staleness rule then lives in twelve places).
- Consequence: a cold build of Mumbai from the open-data cache is 2 minutes 43 seconds and a warm re-run is 15 seconds; `--only <step>` rebuilds one step and lets the rest load; every step's numbers land in `pipeline.json` and in `REPORT.md` whether it ran or reloaded.
- Date: 2026-09-07

## ADR-0009 At 30 m the spurious-pit rule cannot fire, and that is reported rather than tuned

- Context: CLAUDE.md 10.1 step 4 breaches depressions smaller than 900 m2 as DEM artefacts. One cell of the 30 m city grid is exactly 900 m2, so no pit on this grid is ever smaller than the threshold: the Mumbai build finds 4,004 pits and breaches none of them as spurious.
- Decision: leave the rule and the threshold as the spec states them, and print the arithmetic in `city/<city>/REPORT.md` next to the number. Buildings are still burned, roads carved and 1,041 culverts and bridges breached; every remaining pit is kept and reported, noise included.
- Alternatives: raise the threshold to a few cells (invents a filter the spec did not ask for and silently deletes real chronic dips); drop the rule (loses it for the 5 m nests); tune until the number looks busy (a fabricated result).
- Consequence: the depression map at 30 m is the pit set of the conditioned DEM as it stands; the rule starts selecting on the 5 m nests (25 m2 cells) of CLAUDE.md 3.3, and the report says so where a judge will read it. Depressions whose bottom cell is permanent water are dropped instead (58 of 4,004): they are the bay and the creek, not a street.
- Date: 2026-09-07

## ADR-0010 Lane counts take the maximum of an OpenStreetMap tag collection

- Context: `make city` was not reproducible. Two cold builds of Mumbai agreed on every geometry and identifier but disagreed on `lanes` for 4 of 21,296 road segments. OSMnx returns a collection of tag values whenever it simplifies several ways into one edge, and that collection is sometimes a `set`, whose iteration order changes with Python's per-process string hash seed; the helper took the first item it saw.
- Decision: collect every integer in the value and take the maximum. The result is order-independent, and where a simplified edge spans a widening the widest cross-section is the one that carries the traffic the exposure weight represents.
- Alternatives: take the minimum (defensible as a bottleneck, but exposure weighting is about how much traffic the street carries); sort and take the first (arbitrary); set `PYTHONHASHSEED` (hides the bug rather than fixing it, and only inside our own processes).
- Consequence: the segment table is now identical across runs. A regression test in `services/city/tests/test_segments.py` pins the behaviour for lists, sets and scalars. One source of non-reproducibility remains, float noise in `pyflwdir.fill_depressions`, recorded in `city/mumbai/REPORT.md`.
- Date: 2026-09-07

## ADR-0011 Ruff exclusions are anchored to the repository root

- Context: `uv run ruff check .` reported "All checks passed" while `uv run ruff check services/city` found 30 errors. The root configuration excluded `"city"`, and an unanchored pattern matches a directory of that name anywhere in the tree, so the entire city service was silently unlinted from the day it was written.
- Decision: anchor the data-directory exclusions as `/city`, `/data` and `/bundles` so they match only the gitignored folders at the repository root.
- Alternatives: rename the service (churn, and the spec names it `services/city`); list the service explicitly in `include` (fights the exclusion rather than fixing it).
- Consequence: the city service is linted; the 30 findings it had were fixed. Any future service under a name that collides with a data directory is covered automatically.
- Date: 2026-09-07

## ADR-0012 The demo window carries one fifth of the sourced daily rainfall total, and the storm is aimed at the pins

- Context: the only IMD-primary rainfall number for the event is 375.2 mm at Santacruz for the 24 hours ending 08:30 IST on 2 July 2019, read off IMD Mumbai's own chart. No hourly or three-hourly hyetograph exists for any Mumbai station over the replay window, and the nearest sub-daily anchor (Skymet's 63 mm in the 6 hours to 05:30 IST on 1 July, the night before the event night) ends a day and four hours before the window opens. Something has to set the depth of the storm the console shows, and whatever sets it is an inference.
- Decision: the storm designer is calibrated to 20 % of the daily total, 0.20 x 375.2 = 75.0 mm of area-mean accumulation over MUM-CENTRAL for 05:40-09:40 IST, and its eight cells are aimed at the three latitudinal clusters of the 29 sourced ground-truth pins in proportion to the pins in each. `manifest.calibration` carries every number and `manifest.calibration_basis` carries the arithmetic and the sources, so a judge can argue with the share rather than with a black box.
- Alternatives: the uniform share (16.7 %, 62.5 mm), which ignores that the flooding started at 08:07 and worsened until 14:28; extrapolation of the Skymet rate from the night before (11.2 %, 42.0 mm), which the same record contradicts; the heaviest documented burst rate (183 mm/3 h, which would put 244 mm in the window, 65 % of the day, leaving no room for the overnight cloudburst the total is dominated by); or stating no accumulation at all, which would leave the demo with no storm.
- Consequence: the achieved accumulation is 75.0 mm, 0.0 % from target and inside the stated 5 % tolerance, with cell peaks of 44 to 83 mm/h (inside the designer's 40-120 mm/h range) and accumulation over the pins running 1.16 times the area mean. The number must never be spoken as a measurement; the manifest, the bundle card and `/replay` all say "inferred, not measured", and the same 20 % share is what would be revised first if IMD's RMC Mumbai daily weather reports for 1-3 July 2019 were obtained.
- Date: 2026-09-07

## ADR-0013 The replay clock lives in the API, and each pass publishes a bundle event once

- Context: the console, the replay page, the mode banner and every other tab must agree on one simulated instant, and P2.7 needs play, pause, seek and speed to mean the same thing everywhere. A clock in the browser would drift from the one the cycle orchestrator triggers off, and two open tabs would disagree.
- Decision: `varuna_replay.clock.ReplayClock` is the only clock. The API process holds exactly one (`varuna_api.replay.ReplayController`), the routes under `/v1/replay` drive it, and every change is published on `replay.clock`, which the WebSocket relays; the console's store follows those events instead of running a timer. Simulated time is computed from a monotonic anchor (`anchor_sim + (monotonic() - anchor_mono) * speed`), never accumulated, so it cannot drift. Each stream event and each cycle fires at most once per pass: seeking backwards rewinds the clock without re-publishing, and `rewind()` is what clears the fired sets. Pressing Play at 06:40 of a window that opens at 05:40 triggers the 06:40 cycle only, not the twelve behind it.
- Alternatives: a clock per browser tab (drifts, and the tabs disagree); re-publishing everything a backwards seek passes (would re-trigger cycles the spec says must fire once, and would swap the map a dozen times); accumulating deltas per tick (drifts by the poll error, several seconds over a four-hour replay at 30x).
- Consequence: three additions to the contract, all backward compatible: `ReplayClock.note` carries what the clock wants the operator to read ("No baked run for 06:45 IST. Run make bake ..."), `ReplayBundleSummary.built` and `missing_members` say whether a folder is more than a manifest, and `POST /v1/replay/bundle` points the clock at another bundle, which is what a card on `/replay` does. Baked mode publishes the pre-computed run for each cycle; until Phase 5 bakes any, it publishes nothing and the note says which make target fixes that. Large streams (radar frames, traffic snapshots) travel on the bus as a pointer to the bundle member plus a count, small ones (gauges, tide, reports) inline, because the bus is an event bus and Sky and Pulse read the cubes from disk.
- Date: 2026-09-07
## ADR-0014 The console deploys to Vercel and the API to Railway; Supabase is reserved for the P1 sink

- Context: the repository needed a public home and a shareable deployment. The choice offered was Railway or Supabase for the backend. VARUNA's backend is not a database with an API over it: it is a Python process carrying numba, GDAL, geopandas, pysteps and zarr, running a shallow-water solver for seconds per cycle, holding `WS /v1/live` open, and writing run artifacts to disk. Spec section 4.2 already fixed the P0 store as files under `data/runs/`, chosen for zero infrastructure on stage and offline packaging.
- Decision: Vercel hosts `apps/command`; Railway runs the API from a Dockerfile with a volume at `/data`; Supabase is reserved for the P1 PostGIS and Timescale sink in `services/api/sinks/postgis.py`, which mirrors the blueprint's section 9.1 tables.
- Alternatives: Supabase as the backend (its Deno edge functions cannot run a Numba kernel and its managed Postgres cannot host GDAL, so the engines would have nowhere to live); a virtual machine (more control, more to maintain, and nothing here needs it); no deployment at all (the finale does not need one, but mentors and the idea submission do).
- Consequence: `Dockerfile`, `docker/entrypoint.sh`, `railway.json`, `vercel.json` and `docs/DEPLOY.md` exist. Generated city layers are not committed, so the entrypoint builds them into the volume on first boot and the API starts either way, answering 404 with the command that fixes it. The deployment is a convenience: rule 15 and section 5 keep the finale offline on the laptop from `make pack`.
- Date: 2026-09-07

