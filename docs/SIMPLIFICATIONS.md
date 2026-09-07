# Simplifications versus the blueprint

Every simplification of the blueprint (`docs/VARUNA_SIH2026_Blueprint.pdf`) that the prototype makes.
Where a user can see the effect, the UI carries the matching honesty label.

| Area | Blueprint | Prototype | UI label | Upgrade path |
|---|---|---|---|---|
| Radar input | Raw IMD DWR volumes or decoded PNGs | Storm-designer reconstruction calibrated to public gauge totals | "Reconstructed replay" | `services/sky/decode_imd.py` (P1), NetCDF reader |
| Drain graph | Municipal SWD GIS or SWMM model | Inferred from roads, DEM and design norms (blueprint section 7.1) | "Inferred drain graph" | SWMM `.inp` import |
| 1D hydraulics | Dynamic wave (SWMM5 via PySWMM) | Head-driven Manning "diffusive-wave-lite" with surcharge, backflow and a Preissmann slot | listed on `/verify` limitations | PySWMM adapter behind the same `Drain1D` interface (P1) |
| 2D solver | GPU local-inertial at 10 m plus 5 m nests | CPU Numba local-inertial at 30 m; nests P1 | run stamp shows the grid | Numba-CUDA or Rust kernels |
| Surrogate | GNN (MeshGraphNets family) | Reduced-order emulator (Nash cascade per surface unit plus drain1d) calibrated to Twin runs | "Reduced-order emulator calibrated to VARUNA-Twin" | PyTorch Geometric surrogate behind `FlashModel` (P1) |
| Gauge merge | MFB plus kriging with external drift | MFB plus inverse-distance residuals | none visible | pykrige KED (P1) |
| NWP blend | Exponential-decay blend with NCUM or GFS | Disabled (no NWP in P0), labelled | "no NWP blend" on `/verify` | config switch |
| Traffic feed | Mappls or TomTom | Synthetic baseline plus anomalies plus 3 % confounders | "Synthetic traffic" | provider adapter (P2) |
| Citizen reports | App or WhatsApp with CV depth | Synthetic stream plus real sourced ground-truth pins | "synthetic" flag per report | CV depth (V10) |
| Pump inventory | Municipal fleet | 12 synthetic pumps at plausible depots | "Synthetic pump inventory" | municipal list |
| Pump optimiser | MILP (OR-Tools) | Greedy by capacity | none visible | OR-Tools MILP (P1) |
| Routing | Rust Axum with contraction hierarchies | Python time-dependent Dijkstra (networkx) | none visible | Rust service, same contract (P2) |
| Alerts | CAP into Sachet, real WhatsApp | CAP 1.2 XML (status Exercise on replay) plus an on-screen phone mock | "Exercise" status, phone mock | Twilio or WhatsApp Cloud keys |
| Storage | PostGIS, Timescale, MinIO, Redis | Files under `data/runs/` plus an in-process asyncio bus | none visible | `sinks/postgis.py` (P1) |
| DEM | LiDAR in the pilot | Copernicus GLO-30 | limitations text | drone LiDAR |
| Spurious-pit breaching | Priority-flood breaching of pits below 900 m2 | The rule is applied as written, but one 30 m cell is exactly 900 m2, so no pit qualifies and none is breached (buildings, roads and culverts still are) | `city/<city>/REPORT.md` states the arithmetic | 5 m nests (P1), where a cell is 25 m2 |
| City map layers | Vector tiles | Simplified WGS84 GeoJSON per layer (2 m tolerance, trimmed properties, gzip on the wire: 18 MB of drains becomes 1.3 MB) | none visible | PMTiles basemap and tiled layers (P1) |
| Chronic register coordinates | Every point surveyed | 27 of 28 points geocoded against OSM or Nominatim; the one that could not be pinned (Khar subway) is kept because it is sourced, and carries `coord_verified: false` | `coord_verified` on the feature | field survey |
| Replay window accumulation | Gauge hyetograph for the event window | Inferred, not measured: no hourly or three-hourly hyetograph exists for any Mumbai station over 05:40-09:40 IST on 2 July 2019, so the storm designer is scaled from the IMD Santacruz 24-hour total (375.2 mm to 08:30) with the 183 mm/3 h and 63 mm/6 h anchors as context. `calibrate()` reports what it achieved and `manifest.calibration_basis` states the reasoning verbatim | "Reconstructed replay"; the basis text on `/replay` | IMD RMC Mumbai daily weather report archive, or a MoES data request |
| Design storms | 25-year intensity from a fitted IDF curve | Chicago hyetograph built from the drainage-norm design intensity in the city config (25 mm/h legacy, 50 mm/h upgraded), with stated shape parameters. No published IDF curve for Mumbai or Chennai could be sourced (`docs/research/data_sources.md` section 6), and no depth-duration ratio was invented; "25yr" in the bundle id is a name, not a fitted return period | `design_storm.basis` on every design-storm screen | CPHEEO Manual on Storm Water Drainage Systems (2019) IDF tables, IMD's short-duration IDF atlas, or a published Gumbel/GEV fit |
