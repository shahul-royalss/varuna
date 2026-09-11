"""The coupling: water moves between the street and the pipe
(CLAUDE.md 11.5, Appendix A).

This module is the only place water crosses from the 2D surface (``swe2d``) into the 1D
drain graph (``drain1d``) and back. Neither solver reaches for the other: the surface
receives per-cell rates of capture and surcharge in m/s (added to depth by ``_update_depth``
in ``swe2d``), and the drains receive per-node volumes of inlet flow and surcharge withdrawal
in m3/s (added to heads by ``step`` in ``drain1d``). This module computes both, and runs the
two solvers in alternating sync intervals.

**The three exchange formulae** (Appendix A, verbatim):

* Inlet capture:
  ``Q_inlet = (1 - kappa) * min(Q_weir, Q_orifice, Q_avail)``
  ``Q_weir = 1.66 * L * h^{3/2}``
  ``Q_orifice = 0.6 * A_o * sqrt(2 g h)``
  with ``Q_avail`` = remaining node capacity given ``H_j``.

* Surcharge when ``H_j > z_g + h``:
  ``Q_surch = 0.6 * A_m * sqrt(2 g (H_j - z_g - h))``

* Reversed surcharge when ``h + z_g > H_j`` and the node is surcharged: the manhole
  acts as a drain, pulling the street water down. In the prototype, this second direction
  is handled by the same formula with the sign reversed.

**Sync interval** (CLAUDE.md 11.5): the exchange fluxes are computed once and frozen for
``sync_s`` (5 s default), then both solvers sub-step independently within that interval.
The 2D solver sub-steps under the CFL rule; the 1D solver runs at ``inner_dt_s`` (1 s).
This is explicit, cheap, and honest about its coupling error - which is small at 5 s
because the capture rates change slowly compared to the wave.

**Flux limiter** (CLAUDE.md 11.5): no cell or node goes negative from the exchange.
Capture is limited to the water on the cell and the remaining capacity of the node.
Surcharge is limited to the volume above ground in the node.

Determinism (rule 8): no randomness, fixed traversal order, float64 throughout.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np
import structlog

from varuna_twin.types import GRAVITY, CouplingFluxes, DrainNetwork

if TYPE_CHECKING:  # pragma: no cover
    from numpy.typing import NDArray

    from varuna_twin.drain1d import DrainSolver

log = structlog.get_logger("varuna.twin.coupling")

__all__ = [
    "ORIFICE_CD",
    "SURCHARGE_CD",
    "WEIR_CD",
    "compute_exchange",
    "coupling_to_drain_rates",
    "coupling_to_surface_rates",
]

# ------------------------------------------------------------------ coefficients from Appendix A
WEIR_CD = 1.66
"""Weir coefficient for the inlet grate, in m^{0.5}/s (Appendix A)."""

ORIFICE_CD = 0.6
"""Orifice discharge coefficient for the inlet opening (Appendix A)."""

SURCHARGE_CD = 0.6
"""Discharge coefficient for the surcharge manhole (Appendix A)."""


# ============================================================================ exchange computation
@dataclass(frozen=True, slots=True)
class ExchangeResult:
    """What crosses between the street and the pipe this sync interval.

    Both arrays are per node in m3/s and non-negative. The sign convention follows
    :class:`~varuna_twin.types.CouplingFluxes`: capture is street->pipe, surcharge is
    pipe->street. They are separate rather than signed so the product layer can report
    them independently - which is what the drain X-ray and the surcharge markers show.

    ``q_inlet_cell`` and ``q_surcharge_cell`` are the same fluxes converted to per-cell
    m/s rates for the 2D solver: the surface sees capture as a *sink* and surcharge as a
    *source*. The conversion scatters each node's flux onto the single 2D cell it sits on,
    divided by the cell area to get a rate. Multiple nodes on the same cell are summed.
    """

    # per-node, m3/s
    q_inlet_node: NDArray[np.floating]
    """Street -> pipe through the inlets, m3/s per node."""

    q_surcharge_node: NDArray[np.floating]
    """Pipe -> street through the manholes, m3/s per node."""

    # per-cell, m/s (for the 2D solver)
    q_inlet_cell: NDArray[np.floating]
    """Street -> pipe as a rate on the 2D grid, m/s (a surface sink)."""

    q_surcharge_cell: NDArray[np.floating]
    """Pipe -> street as a rate on the 2D grid, m/s (a surface source)."""

    def as_coupling_fluxes(self) -> CouplingFluxes:
        """The contract-type view."""
        return CouplingFluxes(
            q_inlet=self.q_inlet_node,
            q_surcharge=self.q_surcharge_node,
        )


DRY_STREET_M = 1.0e-4
"""Depth below which a street is dry enough that no inlet captures from it.

Was an inline `1e-4` in the NumPy path; named here so the compiled kernel can be handed the same
number rather than a copy of it."""


@dataclass(slots=True)
class ExchangeBuffers:
    """Reusable output arrays for :func:`compute_exchange`.

    **Owned by the caller, deliberately.** A module-level cache here was the obvious way to stop
    2,160 calls allocating four arrays each - two of them the full 323 x 522 grid - and it is
    wrong: :class:`ExchangeResult` holds *references*, so two results computed from the same
    buffers are the same arrays, and the second call silently overwrites the first. A test that
    compared a clean inlet with a clogged one caught it; in the run loop it would never have
    shown, because each result is consumed before the next sync.

    So the caller passes these in when it knows the result is consumed immediately - which the
    runner does, once per sync - and omits them anywhere the result has to outlive the next call.
    """

    q_inlet: NDArray[np.floating]
    q_surcharge: NDArray[np.floating]
    q_inlet_cell: NDArray[np.floating]
    q_surcharge_cell: NDArray[np.floating]

    @classmethod
    def allocate(cls, n_nodes: int, grid_shape: tuple[int, int]) -> ExchangeBuffers:
        return cls(
            q_inlet=np.zeros(n_nodes, dtype=np.float64),
            q_surcharge=np.zeros(n_nodes, dtype=np.float64),
            q_inlet_cell=np.zeros(grid_shape, dtype=np.float64),
            q_surcharge_cell=np.zeros(grid_shape, dtype=np.float64),
        )


_NODE_CACHE: dict[int, dict[str, object]] = {}


def _node_arrays(network: DrainNetwork) -> dict[str, object]:
    """The per-node constants the kernel needs, in its dtypes, built once per network.

    **The length is checked, not just the id.** CPython reuses `id()` once an object is collected,
    so a freed network's arrays were being handed back for a different network that happened to
    land at the same address - and since the new one had more nodes, the kernel read past the end
    of `row` and `col` and scattered into whatever integer it found. Numba does not bounds-check,
    so that surfaced as a Windows access violation in an unrelated test rather than an IndexError
    at the line that caused it.
    """
    key = id(network)
    found = _NODE_CACHE.get(key)
    if found is not None and len(found["row"]) == network.n_nodes:  # type: ignore[arg-type]
        return found
    made: dict[str, object] = {
        "row": np.ascontiguousarray(network.cell_row, dtype=np.int64),
        "col": np.ascontiguousarray(network.cell_col, dtype=np.int64),
        "z_ground": np.ascontiguousarray(network.z_ground, dtype=np.float64),
        "kappa": np.clip(np.asarray(network.kappa, dtype=np.float64), 0.0, 1.0),
        "inlet_length": np.maximum(
            np.asarray(network.inlet_length, dtype=np.float64), 0.0
        ),
        "inlet_area": np.maximum(np.asarray(network.inlet_area, dtype=np.float64), 0.0),
        "storage_area": np.maximum(
            np.asarray(network.storage_area, dtype=np.float64), 0.01
        ),
    }
    _NODE_CACHE.clear()
    _NODE_CACHE[key] = made
    return made


def compute_exchange(
    surface_h: NDArray[np.floating],
    surface_z: NDArray[np.floating],
    drain_head: NDArray[np.floating],
    network: DrainNetwork,
    solver: DrainSolver,
    cell_area_m2: float,
    sync_s: float = 5.0,
    compiled: bool = True,
    out: ExchangeBuffers | None = None,
) -> ExchangeResult:
    """Compute the inlet capture and surcharge fluxes for one sync interval.

    Args:
        surface_h: depth on the 2D grid in metres ``(n_rows, n_cols)``.
        surface_z: ground elevation on the 2D grid in metres ``(n_rows, n_cols)``.
        drain_head: hydraulic head at each drain node in metres ``(n_nodes,)``.
        network: the drain graph with geometry and clogging parameters.
        solver: the prepared solver (for ``fixed_head``).
        cell_area_m2: area of one 2D cell in m2.
        sync_s: the interval these rates will be held over, in seconds. Every limiter below
            divides a *volume* the cell or the node actually has by this, so a rate can never
            move water that is not there. Passing a value that does not match the interval the
            caller then integrates over would break that guarantee, which is why it is an
            argument rather than a constant.

    Returns:
        An :class:`ExchangeResult` with per-node and per-cell rates.
    """
    n_nodes = network.n_nodes
    grid_shape = surface_h.shape

    if compiled:
        return _compute_exchange_compiled(
            surface_h, surface_z, drain_head, network, solver, cell_area_m2, sync_s, out
        )

    # Gather the 2D depth and elevation at each node's cell
    row = np.asarray(network.cell_row, dtype=np.intp)
    col = np.asarray(network.cell_col, dtype=np.intp)

    # Nodes that have no 2D cell (row == -1) cannot exchange
    has_cell = (row >= 0) & (col >= 0)

    h_at_node = np.zeros(n_nodes, dtype=np.float64)
    z_at_node = np.zeros(n_nodes, dtype=np.float64)
    h_at_node[has_cell] = np.asarray(surface_h, dtype=np.float64)[row[has_cell], col[has_cell]]
    z_at_node[has_cell] = np.asarray(surface_z, dtype=np.float64)[row[has_cell], col[has_cell]]

    head = np.asarray(drain_head, dtype=np.float64)
    z_ground = np.asarray(network.z_ground, dtype=np.float64)
    kappa = np.clip(np.asarray(network.kappa, dtype=np.float64), 0.0, 1.0)
    inlet_length = np.maximum(np.asarray(network.inlet_length, dtype=np.float64), 0.0)
    inlet_area = np.maximum(np.asarray(network.inlet_area, dtype=np.float64), 0.0)
    storage_area = np.maximum(np.asarray(network.storage_area, dtype=np.float64), 0.01)

    # ---- Inlet capture (Appendix A) ------------------------------------------
    # Q_weir = 1.66 * L * h^{3/2}
    # Q_orifice = 0.6 * A_o * sqrt(2 g h)
    # Q_inlet = (1 - kappa) * min(Q_weir, Q_orifice, Q_avail)

    h_positive = np.maximum(h_at_node, 0.0)
    q_weir = WEIR_CD * inlet_length * np.power(h_positive, 1.5)
    q_orifice = ORIFICE_CD * inlet_area * np.sqrt(2.0 * GRAVITY * h_positive)
    q_hydraulic = np.minimum(q_weir, q_orifice)

    # Q_avail: remaining capacity in the node  -  water can enter only if the head
    # is below ground level. Above ground, the node is full and surcharges instead.
    # This prevents the coupling from overfilling a node in one sync interval.
    depth_available = np.maximum(z_ground - head, 0.0)
    # Approximate available volume per second: how fast the node can accept water
    # without exceeding ground level. This is a linear estimate over the sync interval.
    # A more precise value would integrate the 1D solver, but that is what the sync
    # interval is for: the error is small when sync_s is small.
    dt = max(float(sync_s), 1e-9)
    q_avail = np.where(depth_available > 0.0, depth_available * storage_area / dt, 0.0)

    q_inlet = (1.0 - kappa) * np.minimum(q_hydraulic, q_avail)

    # No capture at outfalls (their head is imposed, not integrated)
    q_inlet[solver.fixed_head] = 0.0
    # No capture where the node has no 2D cell
    q_inlet[~has_cell] = 0.0
    # No capture when the street is dry
    q_inlet[h_positive < DRY_STREET_M] = 0.0

    # ---- Surcharge (Appendix A) -----------------------------------------------
    # Q_surch = 0.6 * A_m * sqrt(2 g (H - z_g - h)) when H > z_g + h
    # Reversed when h + z_g > H and node is surcharged (manhole drains the street)

    surface_level = z_at_node + h_at_node  # water surface on the street
    excess_head = head - surface_level  # positive when the pipe pushes up

    q_surcharge = np.zeros(n_nodes, dtype=np.float64)

    # Pipe pushes water onto the street
    pushing_up = (excess_head > 0.0) & has_cell
    if np.any(pushing_up):
        manhole_area = storage_area[pushing_up]  # A_m approximated by the manhole area
        orifice = SURCHARGE_CD * manhole_area * np.sqrt(2.0 * GRAVITY * excess_head[pushing_up])
        # The orifice equation says how fast water COULD leave the manhole, not how much is
        # there to leave. Unlimited, it invents water: a node a centimetre over the street emits
        # at that rate for the whole interval whether or not it holds the volume, and on the
        # Mumbai graph 39,801 nodes doing that once every 5 s turned 861,096 m3 of rain into
        # 196,951,114 m3 of standing water - a 228x mass gain, and peak depths of 28 m.
        #
        # The cap is the volume that would bring the node's head down to the street's water
        # surface, which is where the exchange stops by definition: below that there is no
        # excess head left to push with. The inlet side has always had its mirror of this in
        # q_avail; this is the half that was missing.
        emitted = excess_head[pushing_up] * manhole_area / dt
        q_surcharge[pushing_up] = np.minimum(orifice, emitted)

    # Street drains into the pipe (reversed surcharge)
    # This happens when the street level is above the pipe head AND the node head is
    # above the ground (surcharged state). If the node is below ground, normal inlet
    # capture handles it.
    pulling_down = (excess_head < 0.0) & (head > z_ground) & has_cell
    if np.any(pulling_down):
        # The drainage flow uses the same orifice formula with the reversed head
        reversed_excess = -excess_head[pulling_down]
        manhole_area = storage_area[pulling_down]
        # This flow enters the drain, so it's treated as additional inlet. Limited the same way
        # and for the same reason, but against the STREET: the cell cannot give the manhole more
        # water than is standing on it, or the surface goes negative and the deficit reappears
        # downstream as invented water.
        orifice = SURCHARGE_CD * manhole_area * np.sqrt(2.0 * GRAVITY * reversed_excess)
        on_street = h_at_node[pulling_down] * cell_area_m2 / dt
        q_inlet[pulling_down] += np.minimum(orifice, on_street)

    # No surcharge at outfalls
    q_surcharge[solver.fixed_head] = 0.0
    q_surcharge[~has_cell] = 0.0

    # ---- Scatter onto the 2D grid --------------------------------------------
    q_inlet_cell = np.zeros(grid_shape, dtype=np.float64)
    q_surcharge_cell = np.zeros(grid_shape, dtype=np.float64)

    # Scatter node fluxes onto cells: m3/s / cell_area = m/s.
    #
    # `np.add.at` rather than `cell[rows, cols] += values`, because several nodes share a cell -
    # inlets sit every 40 m along a road and the grid is 30 m, so a cell routinely carries two or
    # three - and fancy-index assignment applies each repeated index only ONCE, silently dropping
    # every duplicate's contribution. `np.add.at` is the unbuffered form that accumulates them.
    #
    # It replaces a Python loop over all 50,110 nodes. That loop ran once per sync, 60 times per
    # 5-minute step, which is three million interpreted iterations per step and was the single
    # largest cost in the coupled run at 4.5 s of the 7.9 s each step took.
    rate_factor = 1.0 / cell_area_m2
    active = has_cell & ~solver.fixed_head
    rows_active = row[active]
    cols_active = col[active]
    np.add.at(q_inlet_cell, (rows_active, cols_active), q_inlet[active] * rate_factor)
    np.add.at(q_surcharge_cell, (rows_active, cols_active), q_surcharge[active] * rate_factor)

    return ExchangeResult(
        q_inlet_node=q_inlet,
        q_surcharge_node=q_surcharge,
        q_inlet_cell=q_inlet_cell,
        q_surcharge_cell=q_surcharge_cell,
    )


def coupling_to_surface_rates(
    exchange: ExchangeResult,
) -> tuple[NDArray[np.floating], NDArray[np.floating]]:
    """Extract the rates the 2D solver needs: ``(q_inlet_ms, q_surcharge_ms)``."""
    return exchange.q_inlet_cell, exchange.q_surcharge_cell


def coupling_to_drain_rates(
    exchange: ExchangeResult,
) -> tuple[NDArray[np.floating], NDArray[np.floating]]:
    """Extract the rates the 1D solver needs: ``(q_inlet, q_surcharge)`` per node in m3/s."""
    return exchange.q_inlet_node, exchange.q_surcharge_node


def _compute_exchange_compiled(
    surface_h: NDArray[np.floating],
    surface_z: NDArray[np.floating],
    drain_head: NDArray[np.floating],
    network: DrainNetwork,
    solver: DrainSolver,
    cell_area_m2: float,
    sync_s: float,
    out: ExchangeBuffers | None,
) -> ExchangeResult:
    """:func:`compute_exchange` through the compiled kernel (task P4.6)."""
    from varuna_twin.coupling_kernel import exchange_kernel

    nodes = _node_arrays(network)
    # Fresh buffers unless the caller supplied its own; see `ExchangeBuffers`.
    buffers = out or ExchangeBuffers.allocate(network.n_nodes, surface_h.shape)

    exchange_kernel(
        nodes["row"],
        nodes["col"],
        nodes["z_ground"],
        nodes["kappa"],
        nodes["inlet_length"],
        nodes["inlet_area"],
        nodes["storage_area"],
        np.ascontiguousarray(solver.fixed_head),
        np.ascontiguousarray(surface_h, dtype=np.float64),
        np.ascontiguousarray(surface_z, dtype=np.float64),
        np.ascontiguousarray(drain_head, dtype=np.float64),
        float(cell_area_m2),
        max(float(sync_s), 1e-9),
        GRAVITY,
        WEIR_CD,
        ORIFICE_CD,
        SURCHARGE_CD,
        DRY_STREET_M,
        buffers.q_inlet,
        buffers.q_surcharge,
        buffers.q_inlet_cell,
        buffers.q_surcharge_cell,
    )
    return ExchangeResult(
        q_inlet_node=buffers.q_inlet,
        q_surcharge_node=buffers.q_surcharge,
        q_inlet_cell=buffers.q_inlet_cell,
        q_surcharge_cell=buffers.q_surcharge_cell,
    )
