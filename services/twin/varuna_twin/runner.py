"""The coupled Twin run: rain cube -> depth maps end to end
(CLAUDE.md 11.3-11.5, Appendix A).

This is the top-level entry point that Phase 5's cycle orchestrator calls. It takes
everything Sky produced (a rain cube) and everything the city pipeline built (terrain,
drain graph), and returns a :class:`~varuna_twin.types.TwinResult` with depth snapshots
every 5 minutes, drain heads, surcharge discharges and edge flows.

**What it does, in order:**

For each 5-minute forecast step:

1. **Effective rain**  -  ``hydrology.effective_rain`` turns the raw rain rate from Sky into
   the net rate that reaches the surface, after depression storage and SCS-CN infiltration.

2. **Coupling loop**  -  the step is divided into ``sync_s`` intervals (5 s default). At each
   interval boundary:

   a. ``coupling.compute_exchange`` reads the surface depth and drain heads and computes
      the inlet capture and surcharge fluxes (CLAUDE.md 11.5, Appendix A);
   b. ``swe2d.run_surface`` sub-steps the 2D solver under the CFL rule for ``sync_s``,
      with the rain, capture and surcharge frozen as source terms;
   c. ``drain1d.simulate`` sub-steps the 1D solver at ``inner_dt_s`` for ``sync_s``,
      with the same capture and surcharge frozen.

   The two solvers run in series within each sync interval, not in parallel  -  the
   alternation is the coupling's consistency guarantee.

3. **Snapshot**  -  the depth field and drain state are recorded at the output time.

**Mass balance** (CLAUDE.md 11.3). The combined surface + drain volume is audited at the
end of the run: ``|V_surface + V_drain - (V_rain_in - V_boundary_out)| / V_rain_in < 0.1%``.
The surface's own audit runs every 100 CFL steps inside ``run_surface``; the drain's runs
inside ``simulate``. This final audit is the coupled one that catches exchange leaks.

**Performance** (CLAUDE.md 14). The target is a 3-hour AOI run <= 8 s on an 8-core CPU.
The 2D solver is Numba-parallel; the 1D solver is vectorised numpy. The coupling loop adds
one ``compute_exchange`` call per sync interval (~ 60 per step, 2160 per run), each of which
scatters a few thousand nodes onto the grid  -  milliseconds.

Determinism (rule 8): same ``TwinInputs``, same ``TwinResult`` bytes. The rain cube is
seeded upstream (Sky); the hydrology is pure arithmetic; the 2D solver's parallel loop
writes per-row; the 1D solver uses ``np.bincount`` in edge order.
"""

from __future__ import annotations

from datetime import timedelta
from time import perf_counter
from typing import TYPE_CHECKING

import numpy as np
import structlog

from varuna_twin import drain1d, swe2d
from varuna_twin.coupling import compute_exchange
from varuna_twin.hydrology import HydrologyState, effective_rain
from varuna_twin.types import (
    DrainState,
    MassBalance,
    TwinInputs,
    TwinResult,
)

if TYPE_CHECKING:  # pragma: no cover
    from numpy.typing import NDArray

    from varuna_twin.types import DrainNetwork

log = structlog.get_logger("varuna.twin.runner")

__all__ = [
    "run_twin",
]

MASS_BALANCE_TOLERANCE = 1e-3
"""Combined surface + drain mass balance budget: 0.1 % of total inflow."""

MASS_BALANCE_MIN_VOLUME_M3 = 10.0
"""Inflow below which the relative audit is meaningless."""


def run_twin(inputs: TwinInputs) -> TwinResult:
    """Run the coupled 2D+1D simulation from a rain cube to depth maps.

    This is the single function Phase 5's cycle orchestrator calls. Everything it needs
    is in ``inputs``; everything it produces is in the return value.

    Args:
        inputs: terrain, drain network, rain cube (n_steps, rows, cols) in mm/h,
                time origin, step cadence, tide series, sync and inner-step settings.

    Returns:
        A :class:`~varuna_twin.types.TwinResult` with depth snapshots, drain heads,
        surcharge, edge flows, timing and mass balance.
    """
    started = perf_counter()
    terrain = inputs.terrain
    network = inputs.network
    rain_cube = np.asarray(inputs.rain_mm_h, dtype=np.float64)
    n_steps = rain_cube.shape[0]
    step_s = float(inputs.step_min) * 60.0
    sync_s = float(inputs.sync_s)
    inner_dt_s = float(inputs.inner_dt_s)

    log.info(
        "twin.run.start",
        n_steps=n_steps,
        step_min=inputs.step_min,
        grid=terrain.shape,
        n_nodes=network.n_nodes,
        n_edges=network.n_edges,
        sync_s=sync_s,
        inner_dt_s=inner_dt_s,
    )

    # ---- Prepare the solvers ------------------------------------------------
    kernel_terrain = swe2d.prepare_terrain(terrain)
    surface = swe2d.dry_state(kernel_terrain)
    hydro_state = HydrologyState.for_terrain(terrain)
    drain_solver = drain1d.prepare(network)

    # Initial drain state: heads at the inverts (empty pipes)
    drain_state = DrainState(
        head=np.asarray(network.z_invert, dtype=np.float64).copy(),
        flow=np.zeros(network.n_edges, dtype=np.float64),
    )
    drain1d.pin_boundaries(drain_solver, drain_state.head, _tide_at(inputs, inputs.t0))

    # Sea boundary mask for the 2D solver
    sea_mask = _build_sea_mask(terrain, network)

    # Sinks (pumps/tanks)  -  not wired until Phase 7, but the interface is ready
    sinks, sink_state = drain1d.no_sinks()

    # ---- Output buffers -----------------------------------------------------
    depth_out = np.zeros((n_steps, terrain.n_rows, terrain.n_cols), dtype=np.float64)
    head_out = np.zeros((n_steps, network.n_nodes), dtype=np.float64)
    q_surcharge_out = np.zeros((n_steps, network.n_nodes), dtype=np.float64)
    edge_flow_out = np.zeros((n_steps, network.n_edges), dtype=np.float64)

    # ---- Volume tracking for the combined mass balance ----------------------
    total_rain_in_m3 = 0.0
    total_tide_in_m3 = 0.0
    total_tide_out_m3 = 0.0

    times: list = []
    notes: list[str] = []
    stage_ms: dict[str, int] = {}

    t_hydro = 0
    t_surface = 0
    t_drain = 0
    t_coupling = 0

    # ---- Main loop: one iteration per 5-minute forecast step ----------------
    for step_idx in range(n_steps):
        step_time = inputs.t0 + timedelta(minutes=(step_idx + 1) * inputs.step_min)
        times.append(step_time)

        # 1. Effective rain for this step
        t0 = perf_counter()
        rain_rate = rain_cube[step_idx]  # mm/h
        r_eff_ms = effective_rain(rain_rate, terrain, hydro_state, step_s)
        t_hydro += int((perf_counter() - t0) * 1000)

        # Track rain volume: r_eff_ms is m/s, over step_s seconds and cell_area
        total_rain_in_m3 += float(np.sum(r_eff_ms)) * step_s * kernel_terrain.cell_area_m2

        # 2. Coupling loop: divide the step into sync intervals
        n_syncs = max(round(step_s / sync_s), 1)
        actual_sync_s = step_s / n_syncs

        # Accumulate surcharge over the step for the snapshot
        step_surcharge = np.zeros(network.n_nodes, dtype=np.float64)
        step_surcharge_count = 0

        for sync_idx in range(n_syncs):
            # Time within the step for tide lookup
            sync_time = inputs.t0 + timedelta(seconds=step_idx * step_s + sync_idx * actual_sync_s)
            tide_stage = _tide_at(inputs, sync_time)

            # 2a. Compute exchange fluxes
            t0 = perf_counter()
            exchange = compute_exchange(
                surface_h=surface.h,
                surface_z=kernel_terrain.z,
                drain_head=drain_state.head,
                network=network,
                solver=drain_solver,
                cell_area_m2=kernel_terrain.cell_area_m2,
                sync_s=actual_sync_s,
            )
            t_coupling += int((perf_counter() - t0) * 1000)

            # Accumulate surcharge for snapshot
            step_surcharge += exchange.q_surcharge_node
            step_surcharge_count += 1

            # 2b. Advance the 2D surface
            t0 = perf_counter()
            surface_run = swe2d.run_surface(
                surface,
                kernel_terrain,
                actual_sync_s,
                r_eff_ms=r_eff_ms,
                q_inlet_ms=exchange.q_inlet_cell,
                q_surcharge_ms=exchange.q_surcharge_cell,
                sea_mask=sea_mask,
                tide_stage_m=tide_stage,
                max_dt_s=actual_sync_s,
            )
            t_surface += int((perf_counter() - t0) * 1000)
            total_tide_in_m3 += surface_run.volume_tide_in_m3
            total_tide_out_m3 += surface_run.volume_tide_out_m3

            # 2c. Advance the 1D drains
            t0 = perf_counter()
            drain1d.simulate(
                drain_solver,
                drain_state,
                duration_s=actual_sync_s,
                dt_s=inner_dt_s,
                q_inlet=exchange.q_inlet_node,
                q_surcharge=exchange.q_surcharge_node,
                tide_stage_m=tide_stage,
                sinks=sinks,
                sink_state=sink_state,
            )
            t_drain += int((perf_counter() - t0) * 1000)

        # 3. Snapshot
        depth_out[step_idx] = surface.h.copy()
        head_out[step_idx] = drain_state.head.copy()
        if step_surcharge_count > 0:
            q_surcharge_out[step_idx] = step_surcharge / step_surcharge_count
        edge_flow_out[step_idx] = drain_state.flow.copy()

    # ---- Stage timings -------------------------------------------------------
    elapsed_ms = round((perf_counter() - started) * 1000.0)
    stage_ms = {
        "hydrology_ms": t_hydro,
        "surface_ms": t_surface,
        "drain_ms": t_drain,
        "coupling_ms": t_coupling,
        "total_ms": elapsed_ms,
    }

    # ---- Combined mass balance -----------------------------------------------
    surface_stored = surface.volume_m3(kernel_terrain.cell_area_m2)
    drain_stored = drain1d.stored_volume_m3(drain_solver, drain_state.head)
    total_stored = surface_stored + drain_stored
    total_in = total_rain_in_m3 + total_tide_in_m3
    total_out = total_tide_out_m3

    if total_in > MASS_BALANCE_MIN_VOLUME_M3:
        error_fraction = abs(total_stored - (total_in - total_out)) / total_in
    else:
        error_fraction = 0.0

    mass_balance = MassBalance(
        volume_in_m3=total_in,
        volume_out_m3=total_out,
        volume_stored_m3=total_stored,
        error_fraction=error_fraction,
    )

    if error_fraction > MASS_BALANCE_TOLERANCE and total_in > MASS_BALANCE_MIN_VOLUME_M3:
        notes.append(
            f"Coupled mass balance error {error_fraction:.3%} exceeds the 0.1% budget "
            f"(in {total_in:.1f} m3, stored {total_stored:.1f} m3, out {total_out:.1f} m3)"
        )
        log.warning(
            "twin.run.mass_balance_warning",
            error_fraction=error_fraction,
            total_in_m3=total_in,
            total_stored_m3=total_stored,
        )

    log.info(
        "twin.run.done",
        n_steps=n_steps,
        elapsed_ms=elapsed_ms,
        mass_balance_error=round(error_fraction, 6),
        surface_stored_m3=round(surface_stored, 1),
        drain_stored_m3=round(drain_stored, 1),
        peak_depth_m=round(float(np.max(depth_out)), 3),
        **stage_ms,
    )

    return TwinResult(
        depth_m=depth_out,
        head_m=head_out,
        q_surcharge=q_surcharge_out,
        edge_flow=edge_flow_out,
        times=tuple(times),
        mass_balance=mass_balance,
        stage_ms=stage_ms,
        notes=tuple(notes),
    )


# ============================================================================ helpers


def _tide_at(inputs: TwinInputs, when) -> float | None:
    """Tide stage at a given time, or None if there is no tide series."""
    if inputs.tide is None:
        return None
    return inputs.tide.at(when)


def _build_sea_mask(
    terrain,
    network: DrainNetwork,
) -> NDArray[np.bool_] | None:
    """Build the sea boundary mask for the 2D solver from tidal outfall positions.

    Tidal outfalls sit on the edge of the domain; their 2D cells become sea boundary
    cells where the water level is imposed by the tide. If the network has no tidal
    outfalls, there is no sea boundary.
    """
    boundary = np.asarray(network.boundary)
    tidal = boundary == drain1d.BOUNDARY_TIDAL
    if not np.any(tidal):
        return None

    row = np.asarray(network.cell_row, dtype=np.intp)
    col = np.asarray(network.cell_col, dtype=np.intp)

    mask = np.zeros(terrain.shape, dtype=np.bool_)
    for i in range(network.n_nodes):
        if tidal[i] and row[i] >= 0 and col[i] >= 0:
            mask[int(row[i]), int(col[i])] = True

    if not np.any(mask):
        return None

    return mask
