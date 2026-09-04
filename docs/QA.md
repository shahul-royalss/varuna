# Judge Q&A with the prototype's actual numbers

Fill every `<n>` from `/verify` before the finale (task P10.9). Answers follow CLAUDE.md section 16.

## Is the physics real?
Yes: local-inertial 2D shallow water on a 30 m conditioned DEM, coupled to a head-driven 1D drain model with capacity, surcharge and backflow, with inlet capture and surcharge exchange. Mass-balance error on the demo run: `<n>` %.

## Is the radar real?
The replay radar is a storm-designer reconstruction calibrated to public gauge totals (`<n>` mm over the AOI window, source in the bundle manifest). The IMD image decoder and NetCDF reader are the ingest upgrade path.

## Where is the drain GIS?
Inferred from roads, terrain and design norms; `<n>` km of inferred pipe; every pipe carries a blockage random variable that Pulse learns.

## Sub-second forecast, how?
A reduced-order emulator calibrated to our own physics runs; held-out RMSE `<n>` cm, CSI at 30 cm `<n>`; the physics check shows the live disagreement.

## Ground truth?
`<n>` sourced pins for the event, each with a URL and a time uncertainty.

## DEM accuracy?
Pattern and timing from Copernicus GLO-30; depth MAE at pins `<n>` cm.

## How is this different from IFLOWS?
Strategic layer versus tactical layer: ward-level 6 to 72 h versus street-level 0 to 3 h with drains, learning, probabilities and routing.
