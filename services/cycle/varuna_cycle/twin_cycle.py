"""One full cycle: radar in, a run directory out (CLAUDE.md 11.11, 10.3).

This is the stage that turns everything the engines can do into something the console can draw.
It runs Sky, feeds its rain onto the city grid, runs the coupled Twin, reduces the depth field
to products, and writes the whole lot into ``data/runs/<run_id>/`` atomically.

**The order** (CLAUDE.md 11.11): decode/QC -> Sky -> Twin -> products -> publish. Flash and
Pulse are Phase 7; their stages are absent rather than faked, and ``ensemble_n`` says 1 so no
screen can imply a 50-member spread that was never computed (rule 6).

**Atomicity.** The registry writes into a temporary folder and renames it into place, so a
half-written run can never be served: a reader either sees a complete run directory or none at
all. That matters during a bake, where the console may be polling while cycles are landing.

**The rain hand-off.** Sky produces its ensemble on the 500 m radar grid; the Twin wants mm/h on
the 30 m city grid. ``varuna_sky.products.resample_to_aoi`` owns that resample and is called
here rather than inside the Twin, which keeps the Twin ignorant of Sky (its ``types.py`` says as
much). The **ensemble mean** is what the Twin runs on, because one deterministic Twin run is what
Phase 4 provides; the 20 members go to Flash in Phase 7.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from time import perf_counter
from typing import TYPE_CHECKING

import numpy as np
import structlog
from varuna_schemas.constants import IST, N_STEPS, STEP_MIN
from varuna_schemas.models.run import EngineVersions, GridSpec, RunMeta, build_run_id
from varuna_schemas.paths import bundles_dir, city_dir

if TYPE_CHECKING:  # pragma: no cover - typing only
    from varuna_twin.types import TwinResult

log = structlog.get_logger("varuna.cycle.twin")

__all__ = ["CycleResult", "run_cycle"]

SKY_VERSION = "1.0"
TWIN_VERSION = "1.0"
FLASH_VERSION = "0.0"
"""Flash has not been built yet (Phase 7). ``0.0`` says so in the run id rather than claiming a
version of an engine that did not run - the run stamp is on screen throughout the demo."""

PULSE_VERSION = "1.0"
PRODUCTS_VERSION = "1.0"

INFERRED_NOTE = (
    "Drain graph inferred from roads and terrain, not a municipal SWD model "
    "(CLAUDE.md 10.1 step 7); every pipe carries a learned blockage."
)
DETERMINISTIC_NOTE = (
    "One deterministic Twin run, so p10 = p50 = p90 and every exceedance is 0 or 1. "
    "The 50-member street ensemble arrives with Flash-lite in Phase 7."
)


@dataclass(frozen=True, slots=True)
class CycleResult:
    """What one cycle produced, for the caller that has to report it."""

    run_id: str
    run_dir: Path
    stage_ms: dict[str, int]
    mass_balance_err: float
    peak_depth_cm: float
    wet_segments: int
    surcharging_nodes: int
    backflow_edges: int
    notes: tuple[str, ...]


def _sky_rain_on_city(bundle: str, cycle_ts: datetime | None, city: str, n_steps: int):
    """Run Sky for this cycle and return its **ensemble-mean** rain on the 30 m city grid, mm/h.

    The mean, as CLAUDE.md 11.11 specifies, and the reason is a water balance. A pixelwise
    quantile is not a rainfall field: at a given pixel and lead time the 20 STEPS members
    disagree about *where* the convective cell is, so the median there can be near zero while
    every member is carrying a downpour a kilometre away. Measured on the 2 July storm, the p50
    field delivers 13 mm over three hours against the truth field's 100 mm at the chronic spots;
    the Twin ran on it and gave Hindmata 4 cm.

    The mean is the only reduction here that conserves volume - the expected total is the total
    of the expectations - so the city receives the water the ensemble actually forecasts. It
    smooths the peak, which is a real cost and is why the ensemble goes to Flash-lite whole in
    Phase 7; the run's notes say the spread was discarded.
    """
    from varuna_sky.products import load_aoi_grid, resample_to_aoi

    from varuna_cycle.sky_cycle import run_bundle_cycle

    cycle = run_bundle_cycle(bundle, cycle_ts)
    aoi = load_aoi_grid(city)
    field = np.asarray(cycle.products.mean, dtype=np.float64)  # (steps, y, x) on the Sky grid
    steps = min(int(field.shape[0]), int(n_steps))
    cube = np.stack([resample_to_aoi(field[k], cycle.products.grid, aoi) for k in range(steps)])
    # resample_to_aoi fills outside the radar domain with nan; the Twin reads that as no rain
    # (hydrology logs and zeroes non-finite rain), but zeroing here keeps the mass-balance
    # accounting reading a real number rather than nan.
    cube = np.where(np.isfinite(cube), cube, 0.0)
    return cube, cycle


def run_cycle(
    bundle: str = "MUM-2019-07-02",
    cycle_ts: datetime | None = None,
    *,
    city: str = "mumbai",
    n_steps: int = N_STEPS,
    mode: str = "baked",
    overwrite: bool = False,
) -> CycleResult:
    """Run one cycle end to end and write its run directory.

    Args:
        bundle: replay bundle the radar and gauges come from.
        cycle_ts: the instant to forecast from; defaults to the bundle's first computable cycle.
        city: which built city to run on.
        n_steps: forecast steps of ``STEP_MIN`` minutes each (36 = 3 hours).
        mode: ``baked`` when pre-computing, ``live`` when the operator pressed Compute live.
        overwrite: replace an existing run directory of the same id.
    """
    from varuna_products.alerts import (
        STREET_POINTS,
        build_alerts,
        street_series,
        write_alerts,
    )
    from varuna_products.depth import (
        depth_bounds,
        segment_cell_index,
        segment_forecast,
        segment_names,
        segment_points,
        write_depth_rasters,
        write_wet_segments,
    )
    from varuna_products.hotspots import rank_hotspots
    from varuna_products.pumps import build_pump_plan, write_pump_plan
    from varuna_products.surcharge import surcharge_product, write_surcharge
    from varuna_pulse.cycle import run_pulse
    from varuna_pulse.health import write_drain_health
    from varuna_twin.city import load_network, load_terrain, load_tide
    from varuna_twin.runner import run_twin
    from varuna_twin.types import TwinInputs

    from varuna_cycle.registry import RunRegistry

    stage_ms: dict[str, int] = {}
    started = perf_counter()

    # ---- Sky ----------------------------------------------------------------------------
    mark = perf_counter()
    rain_cube, sky = _sky_rain_on_city(bundle, cycle_ts, city, n_steps)
    cycle_ts = sky.cycle_ts
    n_steps = int(rain_cube.shape[0])
    stage_ms["sky"] = round((perf_counter() - mark) * 1000.0)

    # ---- Twin ---------------------------------------------------------------------------
    mark = perf_counter()
    terrain = load_terrain(city)
    network = load_network(city)
    tide = load_tide(bundle)
    twin: TwinResult = run_twin(
        TwinInputs(
            terrain=terrain,
            network=network,
            rain_mm_h=rain_cube,
            t0=cycle_ts,
            step_min=STEP_MIN,
            tide=tide,
        )
    )
    stage_ms["twin"] = round((perf_counter() - mark) * 1000.0)
    stage_ms.update({f"twin_{k}": v for k, v in twin.stage_ms.items()})

    # ---- Products -----------------------------------------------------------------------
    mark = perf_counter()
    index = segment_cell_index(city_dir(city), terrain.transform, terrain.shape, terrain.crs)
    frame, depth_cm = segment_forecast(twin.depth_m, twin.times, index, run_id="pending")
    run_id = build_run_id(city, cycle_ts, SKY_VERSION, TWIN_VERSION, FLASH_VERSION, mode)
    hotspots = rank_hotspots(
        twin.depth_m, twin.times, city_dir(city), terrain.transform, terrain.crs, run_id, index
    )
    # Alerts are about named places, so the per-segment series are collapsed onto street names
    # first (`street_series`); a segment id in an alert headline is no use to a ward officer.
    names = segment_names(city_dir(city))
    points = segment_points(city_dir(city))
    street_depths = street_series(
        {sid: list(depth_cm[:, k]) for k, sid in enumerate(index[0])}, names, points
    )
    alerts = build_alerts(hotspots, run_id, cycle_ts, twin.times, mode, streets=street_depths)
    pump_plan = build_pump_plan(
        hotspots, city_dir(city), run_id, STEP_MIN, street_depths, dict(STREET_POINTS)
    )
    surcharge = surcharge_product(
        twin.q_surcharge, twin.edge_flow, network, terrain.transform, terrain.crs, run_id
    )
    stage_ms["products"] = round((perf_counter() - mark) * 1000.0)

    # ---- Pulse ---------------------------------------------------------------------------
    # After the Twin, because assimilation is about what the city showed while this cycle's
    # water was on the ground; before publishing, because the drain map is part of the run.
    mark = perf_counter()
    try:
        pulse = run_pulse(
            network,
            city_dir(city),
            bundles_dir() / bundle,
            cycle_ts,
            transform=terrain.transform,
            crs=terrain.crs,
            run_id=run_id,
        )
    except Exception as error:
        # Degraded, not broken (CLAUDE.md 11.11): the depth forecast is complete and useful
        # without an assimilation, and the run says which feed was missing rather than
        # publishing a drain map nothing computed.
        log.warning("cycle.pulse_failed", run_id=run_id, error=str(error))
        pulse = None
    stage_ms["pulse"] = round((perf_counter() - mark) * 1000.0)
    frame["run_id"] = run_id

    notes = [
        INFERRED_NOTE,
        DETERMINISTIC_NOTE,
        *(pulse.notes if pulse is not None else ("Pulse did not run this cycle.",)),
        *twin.notes,
        *(getattr(sky, "notes", None) or ()),
    ]
    if tide is not None and "illustrative" in tide.source.lower():
        notes.append(f"Tide series is {tide.source}, not a published tide table (rule 7).")

    bounds = depth_bounds(terrain.transform, terrain.shape, terrain.crs)
    meta = RunMeta(
        run_id=run_id,
        city=city,
        cycle_ts=cycle_ts,
        radar_frame_ts=sky.products.times[0] if sky.products.times else None,
        versions=EngineVersions(
            sky=SKY_VERSION,
            twin=TWIN_VERSION,
            flash=FLASH_VERSION,
            pulse=PULSE_VERSION,
            products=PRODUCTS_VERSION,
        ),
        mode=mode,
        ensemble_n=1,
        stage_ms=stage_ms,
        mass_balance_err=float(twin.mass_balance.error_fraction),
        bundle=bundle,
        created_at=datetime.now(tz=IST),
        grid=GridSpec(
            dx_m=terrain.res_m,
            nx=terrain.n_cols,
            ny=terrain.n_rows,
            crs=terrain.crs,
            bounds=bounds["wgs84"],
            transform=terrain.transform,
        ),
        step_min=STEP_MIN,
        n_steps=n_steps,
        notes=notes,
        # The storm, one number per step. What-if scales this to answer "what if it rains 30 %
        # harder", and without it stored the endpoint can only answer questions about pipes.
        rain_aoi_mm_h=[round(float(v), 3) for v in rain_cube.mean(axis=(1, 2))],
    )

    def _write(tmp: Path) -> None:
        write_depth_rasters(tmp, twin.depth_m, terrain.transform, terrain.crs, stat="p50")
        frame.to_parquet(tmp / "segment_forecast.parquet", index=False)
        write_wet_segments(tmp, depth_cm, index[0], twin.times, run_id)
        (tmp / "hotspots.json").write_text(json.dumps(hotspots, indent=2) + "\n", encoding="utf-8")
        write_surcharge(tmp, surcharge)
        write_alerts(tmp, alerts)
        if pulse is not None:
            write_drain_health(tmp, pulse.health)
            (tmp / "observations.json").write_text(
                json.dumps(
                    {
                        "run_id": run_id,
                        "n_traffic": pulse.n_traffic,
                        "n_reports": pulse.n_reports,
                        "n_assimilated": pulse.n_assimilated,
                        "n_edges_updated": pulse.n_edges_updated,
                        "observations": pulse.observations,
                        "notes": list(pulse.notes),
                    },
                    separators=(",", ":"),
                ),
                encoding="utf-8",
            )
        write_pump_plan(tmp, pump_plan)
        q_node = twin.q_surcharge
        (tmp / "node_summary.json").write_text(
            json.dumps(
                {
                    "n_nodes": int(network.n_nodes),
                    "surcharging_by_step": [int((s > 0).sum()) for s in q_node],
                    "backflow_by_step": [int((f < 0).sum()) for f in twin.edge_flow],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    registry = RunRegistry()
    run_dir = registry.write_run_dir(run_id, _write, meta=meta, overwrite=overwrite)
    stage_ms["total"] = round((perf_counter() - started) * 1000.0)

    result = CycleResult(
        run_id=run_id,
        run_dir=run_dir,
        stage_ms=stage_ms,
        mass_balance_err=float(twin.mass_balance.error_fraction),
        peak_depth_cm=round(float(np.nanmax(twin.depth_m)) * 100.0, 1),
        wet_segments=int((depth_cm.max(axis=0) > 5.0).sum()) if depth_cm.size else 0,
        surcharging_nodes=int((twin.q_surcharge[-1] > 0).sum()),
        backflow_edges=int((twin.edge_flow[-1] < 0).sum()),
        notes=tuple(notes),
    )
    log.info(
        "cycle.published",
        run_id=run_id,
        total_ms=stage_ms["total"],
        peak_cm=result.peak_depth_cm,
        wet_segments=result.wet_segments,
        mass_balance=round(result.mass_balance_err, 6),
    )
    return result
