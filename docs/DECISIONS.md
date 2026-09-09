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


## ADR-0015 The fallback nowcaster degrades to AR(1) rather than ring, and both nowcasters are capped in rain space

- Context: `fallback_steps` fits AR(2) per cascade level by Yule-Walker on the lag-1 and lag-2 correlations of the Lagrangian-frame history. When the motion field does not align the frames - a zero field over a history in which the storm plainly moved, which is exactly what optical flow returns when it cannot track - the lag-2 correlation collapses below `r1^2` and the fit lands on complex characteristic roots of modulus about 0.99. That is a barely damped ringing, and because the cascade is reconstructed in dBR and comes back through an exponential, six steps of it reached 10,589 mm/h from a 31 mm/h analysis. The existing guard checked stationarity, which this fit satisfies; stationary and non-oscillatory are different conditions.
- Decision: two guards, at different depths. The fit rejects complex roots - `phi1^2 + 4 phi2 < 0` - and degrades that level to AR(1) on the lag-1 correlation alone, because a collapsed lag-2 correlation means the history cannot support a second-order model, not that the rain oscillates. Separately, `motion.MAX_RAIN_MM_H` caps every nowcast cube, pySTEPS' included, at 400 mm/h in rain space.
- Alternatives: guard on the sign of `phi2` (wrong - pySTEPS' own level-1 fit on the test storm is `phi1 = 1.999, phi2 = -0.999`, a double root at 1.0, which is slow decay and exactly what a persistent large scale should do); clamp in dBR (makes the cap a statement about the transform rather than about rainfall); clamp only the output and leave the ringing (the members would be garbage under the cap, and the ensemble spread would be meaningless); refuse to nowcast when the fit is ill-conditioned (the cycle must degrade, not stall - CLAUDE.md 11.11).
- Consequence: the pathological case now fits AR(1) at `phi1` of 0.86 to 0.97 and produces 32.2 mm/h against the 31 mm/h that went in, so the guard fixes the fit rather than leaning on the cap; the cap never binds on any replay bundle and exists only so no ill-conditioned run can publish an impossible number (rule 6). `test_frames_the_motion_field_does_not_explain_still_give_physical_rain` pins both nowcasters to this, and asserts the result stays well inside the ceiling rather than merely under it.
- Date: 2026-09-09

## ADR-0016 Rain is served under `/v1/nowcast`, and a cycle computed on demand carries no run id

- Context: task P3.8 needs the console to read Sky's products - the per-member AOI hyetographs behind the time bar's spread band, and the quantiles and exceedance at a named junction behind the fan chart - out of `rain/quantiles.zarr`, which a browser cannot open. Two things were unsettled: which URL they belong at, given that CLAUDE.md 12 names `/v1/nowcast/*` for street depth and says nothing about rain; and what `run_id` should say when Phase 5 has not baked a single run yet, so the only way to get a forecast on screen is to compute one.
- Decision: `GET /v1/nowcast/rain` (the band) and `GET /v1/nowcast/rain/series` (the fan chart at a point), inside the nowcast namespace and mirroring the `segments` / `segments/{id}/series` pair the table already names. `?compute=true` runs one Sky cycle from the replay bundle through `varuna_cycle.sky_cycle` and returns it without writing anything to `data/runs`; that response carries `run_id: null` and `mode: "live"`, and the `run_id` field is nullable for exactly this case. With no run and no `compute`, the answer is a 404 naming `make bake BUNDLE=...`.
- Alternatives: a `/v1/sky/*` namespace (invents a URL shape the contract does not have, and names the engine rather than the product); minting a run id like `MUM-...-sky1.0-twin1.0-flash0.3-live` for the computed cycle (would claim Twin and Flash versions for engines that did not run, and put an identifier on screen that resolves to nothing under `GET /v1/runs/{id}`); writing the computed cycle into `data/runs` as a real run (a directory with rain and no depth, segments, alerts or mass balance is not a run, and the registry would list it as one); returning an empty series when nothing is baked (on a chart, indistinguishable from a forecast of no rain).
- Consequence: the demo path works before `make bake` exists, and the run stamp can say "live" honestly. Computed cycles are cached three deep on (bundle folder, radar-cube mtime, cycle instant), so the band and the fan chart cost one cycle between them and a rebuilt bundle never serves a stale one; the requested time is floored onto the bundle's five-minute cycle ladder and clamped to the first instant with three radar frames behind it, and the response's `valid_ts` says which cycle was actually run. A Mumbai cycle takes about 8 s on the development laptop, over the 5 s of CLAUDE.md 11.1, which is Sky's budget to meet and is visible in the `stage_ms` the response carries.
- Date: 2026-09-09

## ADR-0017 A run's honesty labels state the reason the stage reported, never a reason inferred from its output

- Context: `sky_notes()` built the Z-R label by inferring the fallback reason from `ZRParams.source`, and wrote "Marshall-Palmer: 20 usable gauge-radar pairs, fewer than the 8 an adaptive fit needs". Twenty is not fewer than eight. `varuna_sky.zr` abandons the fit for three different reasons and only one is the pair count; on the real Mumbai bundle the fit was abandoned because the gauges spanned a factor of 1.6 in rain rate, too little to fit an exponent. The sentence was false, and it was printed on the console under the run stamp - exactly where a MoES scientist would read it.
- Decision: `ZRParams` carries an optional `reason`, set by whichever fallback branch fired, and the label prints that string. A note may only restate what a stage reported about itself; it may never re-derive that reason from the stage's output.
- Alternatives: word the caption vaguely enough to be true of every branch (true but uninformative, and it hides which of three real conditions fired); log the reason and leave the console silent (rule 6 wants the label where the user is, not in a log file); pass the reason as a side channel to the pipeline (a second source of truth to drift).
- Consequence: the label now reads "Z-R is Marshall-Palmer (a=200, b=1.6): 20 gauges span only a factor of 1.6 in rain rate, too little to fit an exponent." The general rule matters more than the instance: every remaining note in `sky_notes` was re-checked against this test, and the same rule binds the Twin, Pulse and Flash labels when they are written. Found by running the real endpoint against the real bundle and reading the output, which is the only way this class of bug surfaces - it type-checks, it lints, and every test passed.
- Date: 2026-09-09

## ADR-0018 The API image installs a C toolchain, uses it, and purges it in one layer

- Context: every Railway deploy of the API image failed at the dependency layer with `error: [Errno 2] No such file or directory: 'gcc'`. pysteps publishes no Linux wheel, so uv builds it from its sdist, and its Cython extensions (`_proesmans`, `_vet`) compile with `gcc ... -fopenmp`. The Dockerfile installed only `ca-certificates curl git libexpat1`, so the image could never have built - and nothing local would show it, because a working checkout resolves pysteps from the developer's own cache. Railway's own diagnosis suggested `RAILPACK_BUILD_APT_PACKAGES=build-essential`, which fixes its auto-builder rather than the Dockerfile the repo actually ships (ADR-0014, `railway.json`).
- Decision: `apt-get install libgomp1`, then `build-essential`, then `uv sync`, then `apt-get purge --auto-remove build-essential` - all in one `RUN`. `libgomp1` goes in on its own line first so apt marks it manually installed: the compiled extension links OpenMP at runtime, and `--auto-remove` would otherwise remove it along with the compiler that pulled it in.
- Alternatives: leave `build-essential` in the image (~250 MB of compiler shipped to production for no runtime purpose); purge it in a later layer (does nothing - layers are additive, so the bytes stay); a multi-stage builder (correct in principle, but this Dockerfile is single-stage and its entrypoint, volume and healthcheck logic would all need re-threading for a saving the one-layer purge already gets); set Railway's Railpack variable (fixes one platform's auto-builder and leaves `docker build` broken everywhere else, including `make pack`).
- Consequence: the image builds. The compiler is present only inside the layer that needs it, so the shipped image is unchanged in size. The second `uv sync` on line 48 installs the workspace packages, which are pure Python and need no toolchain. If another dependency later ships without a wheel, this is the line that has to know about it.
- Date: 2026-09-09

## ADR-0019 A pit no larger than one grid cell is a DEM artefact, and the threshold says so inclusively

- Context: `breach_spurious_pits` skipped any depression with `area >= min_area_m2`, and CLAUDE.md 10.1 step 4 sets that threshold at 900 m2. A single cell of the 30 m Mumbai grid is exactly 900 m2, so `>=` was true for every depression the DEM could contain: the run's own stats read `pits_before: 4004, pits_spurious: 0, pits_breached: 0`, and 4,004 of them were reported as "protected" - a number plausible enough that nobody looked. 2,418 single-cell pits survived conditioning, 47 % of Mumbai's depressions, median 0.39 m deep. In a 3-hour run each one filled past 60 cm, so the console drew its deepest water on hillsides at 15 to 21 m elevation while Hindmata, King's Circle and Sion Circle - sitting in real 3 to 5 m depressions, with drain inlets that worked - peaked below 8 cm. The hotspot rail is what surfaced it: 86 segments over 30 cm and not one chronic spot among them.
- Decision: breach when `area <= min_area_m2`. The threshold means "a pit no bigger than one cell", which is a statement about the resolution limit rather than about hydrology. `protect` - underpasses, subways, the chronic-spot register - still overrides area, which is what keeps the one-cell sinks that are real, Andheri and Milan subways among them. The kept-because-large and kept-because-protected counts are now separate stats, since conflating them is what hid this.
- Alternatives: set the threshold to 901 m2 (fixes Mumbai and silently breaks any city on a grid finer than 30 m, where one cell is far below either number); breach every pit under two cells (a threshold in cells, not area, so it stops meaning the same thing between the 30 m grid and the 5 m nests of P4.8); leave it and lower the depth ramp's floor (would hide the symptom and keep publishing 60 cm of standing water on a hilltop, which is exactly what rule 6 exists to prevent); treat unbreached pits as sinks with an outflow (invents drainage the DEM does not evidence).
- Consequence: the city must be rebuilt and every baked run re-baked, since the conditioned DEM feeds the drain graph, the surface units and the depressions-versus-register validation. Two tests at the real 30 m resolution pin the boundary in both directions - a bare one-cell pit is breached, a registered one is kept - because the existing pit tests were written on a 10 m fixture where one cell is 100 m2 and the off-by-one cannot bite. The general lesson is in the stats: a counter that merges two reasons cannot report that one of them never fires.
- Date: 2026-09-10

## ADR-0020 The hotspot rail ranks by peak depth, and says so on screen

- Context: CLAUDE.md 11.8 fixes the hotspot score as `P(impassable at peak) x exposure_weight`. Phase 4 gives one deterministic Twin run, so `P` is 0 or 1 and that product collapses to a two-tier sort with the exposure weight breaking ties inside each tier. An operator scanning 28 chronic spots gets no ordering from that.
- Decision: rank by peak depth over the run's horizon, and print "ranked by peak depth" in the rail's header. `expected_impact` is still computed and carried per hotspot, so nothing downstream changes shape when Flash-lite makes `P` continuous in Phase 7 and the spec's product becomes the right key.
- Alternatives: use the spec's score anyway (a ranking that is really two buckets, presented as a ranking); rank by minutes above the car threshold (zero for most spots on a moderate cycle, so most of the rail would tie at 0); rank by exposure weight (a property of the city, not of this forecast - the same order every cycle, which is not a forecast product).
- Consequence: the rail is useful now and does not lie about what ordered it. Depth at a hotspot is sampled as the 90th percentile over a 45 m neighbourhood, the same rule and reasoning as the road segments in `varuna_products.depth`, so a junction's answer does not depend on which side of a cell boundary the register's marker fell.
- Date: 2026-09-10
