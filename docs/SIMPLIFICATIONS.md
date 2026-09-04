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
