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
