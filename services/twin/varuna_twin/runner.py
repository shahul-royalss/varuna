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
   b. ``swe2d.SurfaceStepper.advance`` sub-steps the 2D solver under the CFL rule for
      ``sync_s``, with the rain, capture and surcharge frozen as source terms - the same
      arithmetic as ``swe2d.run_surface``, with its per-call setup done once per run;
   c. ``drain1d.simulate`` sub-steps the 1D solver at ``inner_dt_s`` for ``sync_s``,
      with the same capture and surcharge frozen.

   The two solvers run in series within each sync interval, not in parallel  -  the
   alternation is the coupling's consistency guarantee.

3. **Snapshot**  -  the depth field and drain state are recorded at the output time.

**Hot start** (task P4.2). ``TwinInputs.initial_state`` resumes from a :class:`TwinState`
instead of a dry city with empty pipes, and every run returns ``final_state`` at its last
output time. Six steps then a six-step resume from that state are array-equal to twelve steps
in one run. The state's fingerprint must match the city it is loaded against, and its
``valid_ts`` must equal ``t0``; either mismatch raises naming what differs. Outfall heads are
still pinned at the resume ``t0``, so a tide series that changed since the checkpoint sets the
boundary rather than the checkpoint's copy of it.

**Mass balance** (CLAUDE.md 11.3). The combined surface + drain volume is audited at the
end of the run: ``|(V_end - V_start) - (V_in - V_out)| / V_in < 0.1%``, where ``V_in`` is what
entered during this run only. ``V_start`` is zero on a cold start. Below
:data:`MASS_BALANCE_MIN_VOLUME_M3` of inflow the ratio means nothing, and the residual itself
is held to :data:`MASS_BALANCE_MIN_RESIDUAL_M3` instead.
The surface's own audit runs every 100 CFL sub-steps across the run inside the
``SurfaceStepper`` and once more at the end; the drain's runs inside ``simulate``. This final
audit is the coupled one that catches exchange leaks.

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
from varuna_twin.coupling import ExchangeBuffers, compute_exchange
from varuna_twin.hydrology import HydrologyState, effective_rain
from varuna_twin.types import (
    DrainState,
    MassBalance,
    SurfaceState,
    TwinFingerprint,
    TwinInputs,
    TwinResult,
    TwinState,
)

if TYPE_CHECKING:  # pragma: no cover
    from numpy.typing import NDArray

    from varuna_twin.types import DrainNetwork

log = structlog.get_logger("varuna.twin.runner")

__all__ = [
    "run_twin",
]

MASS_BALANCE_TOLERANCE = 1e-3
"""Combined surface + drain mass balance budget: 0.1 % of the run's own inflow."""

MASS_BALANCE_MIN_VOLUME_M3 = 10.0
"""Inflow below which the relative audit is meaningless."""

MASS_BALANCE_MIN_RESIDUAL_M3 = MASS_BALANCE_TOLERANCE * MASS_BALANCE_MIN_VOLUME_M3
"""The absolute residual allowed when the inflow is below :data:`MASS_BALANCE_MIN_VOLUME_M3`.

Derived, not chosen: it is the largest residual the relative budget tolerates at the smallest
inflow it audits, so the two checks meet at the threshold instead of leaving a gap in which a
hot-started run with no new rain - large storage, nothing entering - could lose water unseen."""


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

    initial = inputs.initial_state
    log.info(
        "twin.run.start",
        n_steps=n_steps,
        step_min=inputs.step_min,
        grid=terrain.shape,
        n_nodes=network.n_nodes,
        n_edges=network.n_edges,
        sync_s=sync_s,
        inner_dt_s=inner_dt_s,
        start="cold" if initial is None else "hot",
    )

    # The identity a checkpoint of this run carries, and the one a resumed state must match.
    fingerprint = TwinFingerprint.of(terrain, network, inputs.provenance)

    # ---- Prepare the solvers ------------------------------------------------
    kernel_terrain = swe2d.prepare_terrain(terrain)
    if initial is not None:
        _check_resumable(initial, inputs, fingerprint, kernel_terrain.shape)
    surface = (
        swe2d.dry_state(kernel_terrain)
        if initial is None
        else SurfaceState(
            h=_owned(initial.h),
            qx=_owned(initial.qx),
            qy=_owned(initial.qy),
        )
    )
    # Sized from the *kernel's* grid, which is the one the exchange scatters onto. Sizing it
    # from `terrain.z` instead wrote past the end of the buffer - `prepare_terrain` can pad -
    # and Numba does not bounds-check, so it was an access violation rather than an IndexError.
    exchange_buffers = ExchangeBuffers.allocate(network.n_nodes, kernel_terrain.z.shape)
    hydro_state = HydrologyState.for_terrain(terrain)
    if initial is not None:
        # `retention_s_mm` stays the one just derived from this city's `cn.tif`; only the two
        # event accumulators are memory.
        hydro_state.depression_remaining_mm = _owned(initial.depression_remaining_mm)
        hydro_state.cumulative_rain_mm = _owned(initial.cumulative_rain_mm)
    drain_solver = drain1d.prepare(network)

    # Initial drain state: heads at the inverts (empty pipes), or the checkpoint's.
    if initial is None:
        drain_state = DrainState(
            head=np.asarray(network.z_invert, dtype=np.float64).copy(),
            flow=np.zeros(network.n_edges, dtype=np.float64),
        )
    else:
        drain_state = DrainState(
            head=_owned(initial.drain_head),
            flow=_owned(initial.drain_flow),
        )
    # Pinned on a resume too: the outfall heads belong to the boundary series this run was given,
    # not to the one the checkpoint was written under. The drain kernel pins them again at every
    # inner step, and the coupling takes nothing at a fixed-head node, so on an unchanged series
    # this changes no number - the resume-identity test covers a rising tide.
    drain1d.pin_boundaries(drain_solver, drain_state.head, _tide_at(inputs, inputs.t0))

    # Sea boundary mask for the 2D solver
    sea_mask = _build_sea_mask(terrain, network)

    # `_tide_at` needs to know whether the domain has a sea at all, so it can hold it at mean sea
    # level when the bundle has no tide series rather than leaving the solver without a level.
    has_sea = sea_mask is not None and bool(sea_mask.any())

    # Built once: the sea-cell index, the kernel workspace and the run-long mass ledger. Doing
    # that inside every one of the 2,160 surface calls cost more than the kernels (P4.6).
    surface_stepper = swe2d.SurfaceStepper(surface, kernel_terrain, sea_mask=sea_mask)

    # Sinks (pumps/tanks)  -  not wired until Phase 7, but the interface is ready
    sinks, sink_state = drain1d.no_sinks()
    if initial is not None:
        filled = np.array(initial.sink_filled_m3, dtype=np.float64, order="C")
        if filled.shape != sink_state.filled_m3.shape:
            raise ValueError(
                f"initial_state carries {filled.shape[0] if filled.ndim else 0} pump or tank "
                f"volumes but this run has {sinks.n_units} units; a checkpoint written under a "
                "different pump plan cannot be resumed"
            )
        sink_state.filled_m3 = filled

    # Water already in the city when the run starts: zero on a cold start. Taken after the
    # boundary pin, though `stored_volume_m3` leaves fixed-head nodes out either way.
    stored_start = surface.volume_m3(kernel_terrain.cell_area_m2) + drain1d.stored_volume_m3(
        drain_solver, drain_state.head
    )

    # ---- Output buffers -----------------------------------------------------
    depth_out = np.zeros((n_steps, terrain.n_rows, terrain.n_cols), dtype=np.float64)
    head_out = np.zeros((n_steps, network.n_nodes), dtype=np.float64)
    q_surcharge_out = np.zeros((n_steps, network.n_nodes), dtype=np.float64)
    edge_flow_out = np.zeros((n_steps, network.n_edges), dtype=np.float64)

    # ---- Volume tracking for the combined mass balance ----------------------
    total_rain_in_m3 = 0.0
    total_tide_in_m3 = 0.0
    total_tide_out_m3 = 0.0
    total_outfall_m3 = 0.0
    """Net volume the drain network discharged at its outfalls, positive out to sea.

    Without this the audit does not close: water that falls on a street, is captured by an
    inlet and leaves through a pipe simply disappears from it. The error that hides was small
    while the Twin ran on a rain field that barely wetted the city, and grew with the water."""

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

        # The rain raster is validated here, once per 5-minute step, not once per sync.
        t0 = perf_counter()
        surface_stepper.set_rain(r_eff_ms)
        t_surface += int((perf_counter() - t0) * 1000)

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
            tide_stage = _tide_at(inputs, sync_time, has_sea=has_sea)

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
                # The result is read and applied before the next sync computes another, so one
                # set of buffers serves the whole run rather than four allocations per sync.
                out=exchange_buffers,
            )
            t_coupling += int((perf_counter() - t0) * 1000)

            # Accumulate surcharge for snapshot
            step_surcharge += exchange.q_surcharge_node
            step_surcharge_count += 1

            # 2b. Advance the 2D surface
            t0 = perf_counter()
            surface_run = surface_stepper.advance(
                actual_sync_s,
                q_inlet_ms=exchange.q_inlet_cell,
                q_surcharge_ms=exchange.q_surcharge_cell,
                tide_stage_m=tide_stage,
                max_dt_s=actual_sync_s,
            )
            t_surface += int((perf_counter() - t0) * 1000)
            total_tide_in_m3 += surface_run.volume_tide_in_m3
            total_tide_out_m3 += surface_run.volume_tide_out_m3

            # 2c. Advance the 1D drains
            t0 = perf_counter()
            drain_run = drain1d.simulate(
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
            total_outfall_m3 += drain_run.boundary_m3
            t_drain += int((perf_counter() - t0) * 1000)

        # 3. Snapshot
        depth_out[step_idx] = surface.h.copy()
        head_out[step_idx] = drain_state.head.copy()
        if step_surcharge_count > 0:
            q_surcharge_out[step_idx] = step_surcharge / step_surcharge_count
        edge_flow_out[step_idx] = drain_state.flow.copy()

    # The surface's closing audit: the window since its last 100-sub-step check, and the run.
    t0 = perf_counter()
    surface_stepper.finish()
    t_surface += int((perf_counter() - t0) * 1000)

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
    # The sea appears on both sides of the ledger: it floods low coastal cells on the surface,
    # and at a tide-locked outfall it pushes water back up the trunk - which is a negative
    # `boundary_m3` and therefore an inflow.
    total_in = total_rain_in_m3 + total_tide_in_m3 + max(-total_outfall_m3, 0.0)
    total_out = total_tide_out_m3 + max(total_outfall_m3, 0.0)

    # The change in storage against what crossed the boundary, over the run's own inflow. The
    # water a hot start carries in is subtracted from the stored side, never added to the
    # denominator: see `MassBalance.error_fraction` for why.
    residual = (total_stored - stored_start) - (total_in - total_out)
    residual_limit: float | None = None
    if total_in > MASS_BALANCE_MIN_VOLUME_M3:
        error_fraction = abs(residual) / total_in
    else:
        error_fraction = 0.0
        residual_limit = MASS_BALANCE_MIN_RESIDUAL_M3

    mass_balance = MassBalance(
        volume_in_m3=total_in,
        volume_out_m3=total_out,
        volume_stored_m3=total_stored,
        error_fraction=error_fraction,
        volume_stored_start_m3=stored_start,
        residual_m3=residual,
        residual_limit_m3=residual_limit,
    )

    if inputs.tide is None and has_sea:
        notes.append(
            "No tide series in this bundle, so the sea was held at mean sea level (0.0 m). "
            "The tide-lock behaviour a real event shows is absent by assumption, not by result."
        )

    carried = "" if initial is None else f", stored at start {stored_start:.1f} m3"
    if error_fraction > MASS_BALANCE_TOLERANCE and total_in > MASS_BALANCE_MIN_VOLUME_M3:
        notes.append(
            f"Coupled mass balance error {error_fraction:.3%} exceeds the 0.1% budget "
            f"(in {total_in:.1f} m3, stored {total_stored:.1f} m3, out {total_out:.1f} m3"
            f"{carried})"
        )
        log.warning(
            "twin.run.mass_balance_warning",
            error_fraction=error_fraction,
            total_in_m3=total_in,
            total_stored_m3=total_stored,
            stored_start_m3=stored_start,
        )
    elif residual_limit is not None and abs(residual) > residual_limit:
        notes.append(
            f"Coupled mass balance residual {residual:+.3f} m3 exceeds the "
            f"{residual_limit:.3f} m3 limit that applies while inflow is below "
            f"{MASS_BALANCE_MIN_VOLUME_M3:.0f} m3 (in {total_in:.3f} m3, stored "
            f"{total_stored:.1f} m3, out {total_out:.3f} m3{carried})"
        )
        log.warning(
            "twin.run.mass_balance_warning",
            residual_m3=residual,
            residual_limit_m3=residual_limit,
            total_in_m3=total_in,
            stored_start_m3=stored_start,
        )

    final_state = TwinState(
        valid_ts=inputs.t0 + timedelta(minutes=n_steps * inputs.step_min),
        h=_frozen(surface.h),
        qx=_frozen(surface.qx),
        qy=_frozen(surface.qy),
        drain_head=_frozen(drain_state.head),
        drain_flow=_frozen(drain_state.flow),
        sink_filled_m3=_frozen(sink_state.filled_m3),
        depression_remaining_mm=_frozen(hydro_state.depression_remaining_mm),
        cumulative_rain_mm=_frozen(hydro_state.cumulative_rain_mm),
        fingerprint=fingerprint,
    )

    log.info(
        "twin.run.done",
        n_steps=n_steps,
        elapsed_ms=elapsed_ms,
        mass_balance_error=round(error_fraction, 6),
        surface_stored_m3=round(surface_stored, 1),
        drain_stored_m3=round(drain_stored, 1),
        outfall_m3=round(total_outfall_m3, 1),
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
        final_state=final_state,
        stage_ms=stage_ms,
        notes=tuple(notes),
    )


# ============================================================================ helpers


def _check_resumable(
    state: TwinState,
    inputs: TwinInputs,
    expected: TwinFingerprint,
    grid_shape: tuple[int, int],
) -> None:
    """Refuse a state that does not belong to this city, this instant or these array sizes.

    Raises:
        ValueError: naming every difference, so a rebuilt city reads as a rebuilt city rather
            than as a shape error three calls deep in a kernel.
    """
    differences = list(state.fingerprint.differences(expected))
    if state.valid_ts != inputs.t0:
        differences.append(
            f"valid_ts: checkpoint {state.valid_ts.isoformat()}, "
            f"this run starts {inputs.t0.isoformat()}"
        )
    if differences:
        raise ValueError("initial_state cannot be resumed on this run: " + "; ".join(differences))
    # The fingerprint vouches for the sizes; a hand-built state could still disagree with it.
    sizes = {
        "h": grid_shape,
        "qx": grid_shape,
        "qy": grid_shape,
        "depression_remaining_mm": grid_shape,
        "cumulative_rain_mm": grid_shape,
        "drain_head": (inputs.network.n_nodes,),
        "drain_flow": (inputs.network.n_edges,),
    }
    for name, shape in sizes.items():
        array = np.asarray(getattr(state, name))
        if array.shape != shape:
            raise ValueError(
                f"initial_state.{name} has shape {array.shape}, expected {shape} for this run"
            )
        if not np.all(np.isfinite(array)):
            raise ValueError(f"initial_state.{name} contains non-finite values")
    if bool(np.any(np.asarray(state.h) < 0.0)):
        raise ValueError(
            "initial_state.h has negative depths; a surface cannot hold less than none"
        )


def _owned(array: NDArray[np.floating]) -> NDArray[np.float64]:
    """A private, writable, C-contiguous float64 copy, so a resume never mutates its checkpoint."""
    return np.array(array, dtype=np.float64, order="C", copy=True)


def _frozen(array: NDArray[np.floating]) -> NDArray[np.float64]:
    """A read-only float64 copy for :class:`TwinState`, detached from the solver's buffers."""
    out = np.array(array, dtype=np.float64, order="C", copy=True)
    out.flags.writeable = False
    return out


MEAN_SEA_LEVEL_M = 0.0
"""Where the sea is held when a bundle carries no tide series.

A design storm has no tide table - `CHN-IDF-25yr` is a synthetic hyetograph, not a day - but a
coastal city still has sea cells, and the 2D solver has to be told what level they sit at. Refusing
to run was the previous behaviour and it made a first forecast for a newly onboarded coastal city
impossible. Mean sea level is the neutral assumption, it is what a design storm is normally
evaluated against, and the run's notes say it was assumed rather than measured (rule 6)."""


def _tide_at(inputs: TwinInputs, when, *, has_sea: bool = False) -> float | None:
    """Tide stage at a given time.

    Falls back to mean sea level when there is no series but the domain has sea cells: see
    :data:`MEAN_SEA_LEVEL_M`. Without sea cells it stays None and no boundary is applied.
    """
    if inputs.tide is None:
        return MEAN_SEA_LEVEL_M if has_sea else None
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
