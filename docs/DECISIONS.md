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

## ADR-0008 Lane counts take the maximum of an OpenStreetMap tag collection

- Context: `make city` was not reproducible. Two cold builds of Mumbai agreed on every geometry and identifier but disagreed on `lanes` for 4 of 21,296 road segments. OSMnx returns a collection of tag values whenever it simplifies several ways into one edge, and that collection is sometimes a `set`, whose iteration order changes with Python's per-process string hash seed; the helper took the first item it saw.
- Decision: collect every integer in the value and take the maximum. The result is order-independent, and where a simplified edge spans a widening the widest cross-section is the one that carries the traffic the exposure weight represents.
- Alternatives: take the minimum (defensible as a bottleneck, but exposure weighting is about how much traffic the street carries); sort and take the first (arbitrary); set `PYTHONHASHSEED` (hides the bug rather than fixing it, and only inside our own processes).
- Consequence: the segment table is now identical across runs. A regression test in `services/city/tests/test_segments.py` pins the behaviour for lists, sets and scalars. One source of non-reproducibility remains, float noise in `pyflwdir.fill_depressions`, recorded in `city/mumbai/REPORT.md`.
- Date: 2026-09-07

## ADR-0009 Ruff exclusions are anchored to the repository root

- Context: `uv run ruff check .` reported "All checks passed" while `uv run ruff check services/city` found 30 errors. The root configuration excluded `"city"`, and an unanchored pattern matches a directory of that name anywhere in the tree, so the entire city service was silently unlinted from the day it was written.
- Decision: anchor the data-directory exclusions as `/city`, `/data` and `/bundles` so they match only the gitignored folders at the repository root.
- Alternatives: rename the service (churn, and the spec names it `services/city`); list the service explicitly in `include` (fights the exclusion rather than fixing it).
- Consequence: the city service is linted; the 30 findings it had were fixed. Any future service under a name that collides with a data directory is covered automatically.
- Date: 2026-09-07
