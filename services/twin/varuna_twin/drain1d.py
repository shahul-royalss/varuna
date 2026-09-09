"""The 1D drain solver: "diffusive-wave-lite" on the inferred pipe graph
(CLAUDE.md 11.4, Appendix A).

This is the sewer half of VARUNA-Twin. The street half (``swe2d``) routes water across the
30 m grid; this routes it *through* the pipes, and ``coupling`` is the only thing that moves
water between the two. Nothing here reaches for a surface cell: the inlet capture and the
surcharge discharge arrive as per-node arrays computed by CLAUDE.md 11.5, and this module
tells the caller how much of each it was actually able to apply.

**What it solves.** A head per node and a flow per edge, stepped explicitly at
``TwinInputs.inner_dt_s`` (1 s). The constitutive law is Appendix A exactly::

    A_eff  = (1 - beta) * A * fill,   fill = clip(min(H_up - z_inv_up, D) / D, 0, 1)
    Q_full = (1/n) * (1 - beta) * A * R_h^(2/3) * sqrt(S)
    Q      = sign(dH) * min(Q_full, (1/n) * A_eff * R_h^(2/3) * sqrt(|dH| / L))
    dH/dt  = (sum Q_in + Q_inlet - sum Q_out - Q_surch) / A_s

One formula covers both regimes, which is why there is no separate pressurised branch. For a
part-full pipe running normally, ``H = z_inv + depth`` at each end, so equal depths give
``dH/L = S`` and the friction term collapses to Manning's normal flow; when both ends rise
above the crown the pipe is full, ``fill`` saturates at 1, and the same ``|dH|/L`` is the
pressure gradient of a closed conduit. :func:`pressurised` reports which edges are in the
second regime for the console, but the solver does not need to know.

**Backflow is not an edge case.** ``Q`` carries the sign of ``H_from - H_to``, so a rising
sea at a tide-locked outfall drives ``Q < 0`` on the trunk and pushes the first upstream
manhole into surcharge. That negative number is what the console draws as a reversed-flow
edge (CLAUDE.md 6.2, 7.2) and what the demo shows at the 1:40 beat (CLAUDE.md 15). A flap
gate (``network.flap_gate``) is the counter-measure: it lets water leave the network at an
outfall and never lets it back in.

**Simplifications, stated once.** ``R_h`` is the full-bore hydraulic radius at every fill,
because that is what Appendix A writes; a part-full circular pipe's true ``R_h`` peaks near
0.8 D and falls to zero at both ends, so this model over-conveys a nearly empty pipe and
under-conveys one at 0.8 D. ``Q_full`` is likewise capped at the design capacity the city
pipeline sized the pipe for rather than recomputed from the inverts, because the city
pipeline enforced a 0.3 % minimum slope that the inverts alone would not reproduce
(CLAUDE.md 10.1 step 7). Both are the "-lite" in diffusive-wave-lite; PySWMM dynamic wave is
the P1 upgrade behind the same interface (CLAUDE.md P4.9).

**Conservation.** Volume, not head, is the integrated quantity. Storage per node is a
piecewise-linear curve - the manhole area below the crown, the manhole plus a Preissmann slot
above it (:data:`SLOT_CELERITY_M_S`) - so the slot cannot leak volume the way a changing
``A_s`` in ``dH/dt`` would. Every flow this module reduces (flap gate, stability limiter,
node-supply scaling) is reduced on *both* ends of its edge, so the reduction moves no water.
:func:`stored_volume_m3` is the audit quantity, and it is not the same as
``DrainState.volume_m3``: the latter is the slot-free approximation on the contract type,
which under-reports by the slot volume once nodes pressurise. Use this one for a balance.

Determinism (rule 8): no randomness, no parallel reductions. ``np.bincount`` sums edges into
nodes in edge order, so two runs of the same inputs produce byte-identical arrays.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np
import structlog

from varuna_twin.types import GRAVITY, DrainNetwork, DrainState, MassBalance

if TYPE_CHECKING:  # pragma: no cover - keeps numpy off the runtime type surface
    from numpy.typing import NDArray

log = structlog.get_logger("varuna.twin.drain1d")

__all__ = [
    "BOUNDARY_FREE",
    "BOUNDARY_INTERIOR",
    "BOUNDARY_TIDAL",
    "MIN_FLOW_DEPTH_M",
    "MIN_HEAD_GRADIENT_M",
    "MIN_STORAGE_AREA_M2",
    "SLOT_CELERITY_M_S",
    "ControlledSink",
    "DrainRunReport",
    "DrainSolver",
    "DrainStepReport",
    "SinkState",
    "backflow",
    "edge_flow",
    "head_from_volume",
    "no_sinks",
    "pin_boundaries",
    "prepare",
    "pressurised",
    "simulate",
    "sink_draw",
    "step",
    "storage_area",
    "stored_volume_m3",
    "surcharged",
    "volume_from_head",
]

# ------------------------------------------------------------------------ boundaries
BOUNDARY_INTERIOR = 0
"""``DrainNetwork.boundary`` code for a node that only exchanges with the graph."""

BOUNDARY_TIDAL = 1
"""``DrainNetwork.boundary`` code for an outfall held at the sea stage."""

BOUNDARY_FREE = 2
"""``DrainNetwork.boundary`` code for an outfall discharging freely at its invert."""

# ---------------------------------------------------------------------- numerical floors
MIN_FLOW_DEPTH_M = 1.0e-3
"""Upstream water depth below which an edge carries nothing, in metres.

A design choice, taken to match the 2D solver's ``h_f < 1 mm`` cut-off (CLAUDE.md 11.3) so
the two halves of Twin agree on when a millimetre of water stops being water. Without it the
fill fraction chatters between zero and a few microns on a drying pipe and the step count
climbs for no physical reason."""

MIN_HEAD_GRADIENT_M = 1.0e-6
"""Head difference below which an edge is quiescent, in metres.

A design choice. ``sqrt(|dH|/L)`` has an infinite derivative at ``dH = 0``, so two nodes that
have equalised to within a micron would otherwise trade denormal flows forever. A micron of
head is four orders of magnitude below the millimetre the rest of the model resolves."""

MIN_STORAGE_AREA_M2 = 0.25
"""Smallest manhole plan area the solver will integrate with, in m2.

A design choice: a 0.5 m square chamber. ``dH/dt = Q/A_s`` divides by this, so a node that
arrived with zero or negative storage area would produce an infinite head rather than a
diagnosable one. :func:`prepare` clamps and logs the count instead of failing, because the
graph is inferred (CLAUDE.md 10.1 step 7) and one bad node must not stop a cycle."""

SLOT_CELERITY_M_S = 10.0
"""Pressure-wave celerity the Preissmann slot is sized for, in m/s.

A numerical choice, not spec. CLAUDE.md 11.4 asks for "a Preissmann slot width when
surcharged so heads stay bounded" and leaves the width open. The classical slot width is
``T = g A / c^2``, the width whose free surface reproduces a wave celerity ``c`` in a pipe of
area ``A``; the real water-hammer celerity in a buried concrete sewer is around 1000 m/s,
which an explicit 1 s step could never resolve (it would need ``dt <= L/c``, tens of
milliseconds on a 40 m pipe).

10 m/s is chosen so that the Courant condition ``dt <= L/c`` holds at ``dt = 1 s`` for the
shortest pipes the city pipeline produces - inlets are placed every 40 m (CLAUDE.md 10.1
step 7), giving ``dt <= 4 s`` - while the slot stays small enough to be honest about storage:
on a 600 mm pipe the slot is 28 mm wide, so a metre of surcharge head adds about 10 % of the
pipe's own volume. The consequence is stated rather than hidden: pressure waves in VARUNA's
sewer travel two orders of magnitude slower than in a real one, which is invisible at the
5-minute cadence the products are published on and would matter to a water-hammer study."""


# ============================================================================ pumps, tanks
@dataclass(frozen=True, slots=True)
class ControlledSink:
    """Pumps and holding tanks as controlled sinks on the graph (CLAUDE.md 11.4).

    A unit draws water out of one node at a rate read off its capacity curve, and stops when
    it has taken :attr:`capacity_m3`. That single shape covers both cases the prototype
    needs: a mobile pump discharging to a nallah is a unit with infinite capacity, and the
    Hindmata holding tanks are units with a finite one (CLAUDE.md 3.3).

    Curves are per unit and interpolated on the water depth above the node invert, clamped to
    the end points - a pump that has not reached its start level appears as a leading
    ``(depth, 0.0)`` point, which is how a wet-well start/stop control is expressed here.
    """

    ids: tuple[str, ...]
    node: NDArray[np.int32]
    """Index of the node each unit draws from."""

    curve_depth_m: NDArray[np.floating]
    """``(n_units, n_points)`` depths above the node invert, increasing along axis 1."""

    curve_rate_m3_s: NDArray[np.floating]
    """``(n_units, n_points)`` withdrawal rate in m3/s at each depth."""

    capacity_m3: NDArray[np.floating]
    """Total volume each unit may take; ``np.inf`` for a pump that discharges away."""

    @property
    def n_units(self) -> int:
        return len(self.ids)


@dataclass(slots=True)
class SinkState:
    """How much each unit has taken so far, in m3. Persists across steps."""

    filled_m3: NDArray[np.floating]


def no_sinks() -> tuple[ControlledSink, SinkState]:
    """An empty pump/tank set, for a network that has none."""
    empty_i = np.zeros(0, dtype=np.int32)
    empty_f = np.zeros(0, dtype=np.float64)
    sinks = ControlledSink(
        ids=(),
        node=empty_i,
        curve_depth_m=np.zeros((0, 2), dtype=np.float64),
        curve_rate_m3_s=np.zeros((0, 2), dtype=np.float64),
        capacity_m3=empty_f,
    )
    return sinks, SinkState(filled_m3=empty_f.copy())


def sink_draw(
    sinks: ControlledSink,
    sink_state: SinkState,
    solver: DrainSolver,
    head: NDArray[np.floating],
    dt_s: float,
) -> NDArray[np.floating]:
    """Withdrawal rate per **node** in m3/s, before the supply check.

    The loop is over units, not nodes: the prototype's inventory is twelve mobile pumps and a
    pair of holding tanks (CLAUDE.md 3.3), so a Python loop over units costs nothing next to
    the per-edge work, and each unit gets its own ``np.interp`` on its own curve.
    """
    draw = np.zeros(solver.n_nodes, dtype=np.float64)
    if sinks.n_units == 0:
        return draw
    depth = head[sinks.node] - solver.network.z_invert[sinks.node]
    remaining = sinks.capacity_m3 - sink_state.filled_m3
    for u in range(sinks.n_units):
        if remaining[u] <= 0.0:
            continue
        rate = float(np.interp(depth[u], sinks.curve_depth_m[u], sinks.curve_rate_m3_s[u]))
        if rate <= 0.0:
            continue
        # A tank in its last second takes only what is left of its capacity.
        rate = min(rate, float(remaining[u]) / dt_s)
        draw[sinks.node[u]] += rate
    return draw


# ============================================================================ preparation
@dataclass(frozen=True, slots=True)
class DrainSolver:
    """A network with everything that does not change between steps computed once.

    Rebuild it whenever ``beta`` changes - VARUNA-Pulse rewrites the posterior once per cycle
    (CLAUDE.md 11.6), and :attr:`conveyance` and :attr:`q_cap` both carry ``(1 - beta)``.
    """

    network: DrainNetwork

    conveyance: NDArray[np.floating]
    """``(1/n) * (1 - beta) * A * R_h^(2/3)`` per edge: the friction term at full fill."""

    q_cap: NDArray[np.floating]
    """``(1 - beta) * q_full`` per edge: the Manning design capacity after blockage."""

    inv_diameter: NDArray[np.floating]
    """``1/D`` per edge, for the fill fraction."""

    storage_base: NDArray[np.floating]
    """Manhole plan area per node in m2, clamped to :data:`MIN_STORAGE_AREA_M2`."""

    slot_area: NDArray[np.floating]
    """Preissmann slot plan area per node in m2, active above the crown."""

    crown_depth: NDArray[np.floating]
    """Depth above the node invert at which its shallowest pipe fills; ``inf`` if it has none."""

    fixed_head: NDArray[np.bool_]
    """True at outfalls, whose head is imposed rather than integrated."""

    @property
    def n_nodes(self) -> int:
        return self.network.n_nodes

    @property
    def n_edges(self) -> int:
        return self.network.n_edges


def prepare(network: DrainNetwork) -> DrainSolver:
    """Precompute the per-edge conveyance and per-node storage curve of ``network``."""
    n_nodes = network.n_nodes
    from_node = np.asarray(network.from_node, dtype=np.intp)
    to_node = np.asarray(network.to_node, dtype=np.intp)
    area = np.asarray(network.area, dtype=np.float64)
    length = np.maximum(np.asarray(network.length, dtype=np.float64), MIN_HEAD_GRADIENT_M)
    diameter = np.asarray(network.diameter, dtype=np.float64)
    manning_n = np.asarray(network.edge_manning_n, dtype=np.float64)
    beta = np.clip(np.asarray(network.beta, dtype=np.float64), 0.0, 1.0)
    r_h = np.asarray(network.hydraulic_radius, dtype=np.float64)

    conveyance = (1.0 - beta) * area * np.cbrt(np.square(r_h)) / manning_n
    q_cap = (1.0 - beta) * np.maximum(np.asarray(network.q_full, dtype=np.float64), 0.0)

    storage_base = np.asarray(network.storage_area, dtype=np.float64).copy()
    thin = storage_base < MIN_STORAGE_AREA_M2
    if bool(thin.any()):
        log.warning(
            "drain1d.storage_area_clamped",
            n_nodes=int(thin.sum()),
            floor_m2=MIN_STORAGE_AREA_M2,
        )
        storage_base[thin] = MIN_STORAGE_AREA_M2

    # Preissmann slot: half of each pipe's slot volume is stored at each of its ends.
    slot_width = GRAVITY * area / (SLOT_CELERITY_M_S * SLOT_CELERITY_M_S)
    half = 0.5 * length * slot_width
    slot_area = np.bincount(from_node, weights=half, minlength=n_nodes) + np.bincount(
        to_node, weights=half, minlength=n_nodes
    )

    # The slot turns on when the *shallowest* pipe at a node fills, which is the first moment
    # the node loses part of its free surface and the stiffest point of the step.
    crown_depth = np.full(n_nodes, np.inf, dtype=np.float64)
    np.minimum.at(crown_depth, from_node, diameter)
    np.minimum.at(crown_depth, to_node, diameter)
    slot_area[np.isinf(crown_depth)] = 0.0

    boundary = np.asarray(network.boundary)
    fixed_head = boundary != BOUNDARY_INTERIOR

    log.info(
        "drain1d.prepared",
        n_nodes=n_nodes,
        n_edges=network.n_edges,
        n_tidal=int((boundary == BOUNDARY_TIDAL).sum()),
        n_free=int((boundary == BOUNDARY_FREE).sum()),
        n_flap=int(np.asarray(network.flap_gate).sum()),
    )
    return DrainSolver(
        network=network,
        conveyance=conveyance,
        q_cap=q_cap,
        inv_diameter=1.0 / np.maximum(diameter, MIN_FLOW_DEPTH_M),
        storage_base=storage_base,
        slot_area=slot_area,
        crown_depth=crown_depth,
        fixed_head=fixed_head,
    )


# ============================================================================ storage curve
def storage_area(solver: DrainSolver, head: NDArray[np.floating]) -> NDArray[np.floating]:
    """Plan area governing ``dH/dt`` at each node, in m2.

    The manhole area below the crown; the manhole plus the Preissmann slot above it.
    """
    depth = head - solver.network.z_invert
    return np.where(
        depth > solver.crown_depth, solver.storage_base + solver.slot_area, solver.storage_base
    )


def volume_from_head(solver: DrainSolver, head: NDArray[np.floating]) -> NDArray[np.floating]:
    """Water stored at each node in m3, on the piecewise-linear storage curve."""
    depth = np.maximum(head - solver.network.z_invert, 0.0)
    below = np.minimum(depth, solver.crown_depth)
    above = np.maximum(depth - solver.crown_depth, 0.0)
    return solver.storage_base * below + (solver.storage_base + solver.slot_area) * above


def head_from_volume(solver: DrainSolver, volume: NDArray[np.floating]) -> NDArray[np.floating]:
    """Invert :func:`volume_from_head`. Negative volumes clamp to the invert."""
    v = np.maximum(volume, 0.0)
    v_crown = solver.storage_base * solver.crown_depth  # inf where the node has no pipes
    depth = np.where(
        v <= v_crown,
        v / solver.storage_base,
        solver.crown_depth + (v - v_crown) / (solver.storage_base + solver.slot_area),
    )
    return solver.network.z_invert + depth


def stored_volume_m3(solver: DrainSolver, head: NDArray[np.floating]) -> float:
    """Total water in the network's manholes and slots, in m3.

    The audit quantity for the mass balance. It exceeds ``DrainState.volume_m3`` by the
    Preissmann slot volume once nodes pressurise; the contract type carries the slot-free
    approximation because it does not know the solver's storage curve.
    """
    interior = ~solver.fixed_head
    return float(np.sum(volume_from_head(solver, head)[interior]))


# ============================================================================ boundaries
def pin_boundaries(
    solver: DrainSolver,
    head: NDArray[np.floating],
    tide_stage_m: float | NDArray[np.floating] | None,
) -> None:
    """Impose the outfall heads in place (CLAUDE.md 11.4).

    A free outfall sits at its invert. A tidal outfall sits at the sea stage, or at its invert
    when the sea is below it - the sea cannot pull the water table below the pipe. Pass
    ``tide_stage_m`` as a scalar for one sea level, or as a per-node array when outfalls sit
    on different creeks.
    """
    boundary = np.asarray(solver.network.boundary)
    z_invert = solver.network.z_invert

    free = boundary == BOUNDARY_FREE
    head[free] = z_invert[free]

    tidal = boundary == BOUNDARY_TIDAL
    if not bool(tidal.any()):
        return
    if tide_stage_m is None:
        head[tidal] = z_invert[tidal]
        return
    stage = np.asarray(tide_stage_m, dtype=np.float64)
    stage_at = stage[tidal] if stage.ndim else np.full(int(tidal.sum()), float(stage))
    head[tidal] = np.maximum(stage_at, z_invert[tidal])


# ============================================================================ constitutive law
def edge_flow(solver: DrainSolver, head: NDArray[np.floating]) -> NDArray[np.floating]:
    """Appendix A's pipe flow in m3/s, positive ``from_node -> to_node``.

    The pure constitutive law: no flap gates, no stability limiter, no supply check. Those
    belong to :func:`step`, which has the time step they need. Negative entries are backflow.
    """
    net = solver.network
    a = np.asarray(net.from_node, dtype=np.intp)
    b = np.asarray(net.to_node, dtype=np.intp)
    z_inv = net.z_invert

    dh = head[a] - head[b]
    forward = dh >= 0.0

    # The fill fraction is read at the upstream end, whichever end that currently is.
    up_head = np.where(forward, head[a], head[b])
    up_invert = np.where(forward, z_inv[a], z_inv[b])
    fill_depth = up_head - up_invert
    fill = np.clip(fill_depth * solver.inv_diameter, 0.0, 1.0)

    slope = np.abs(dh) / np.maximum(np.asarray(net.length, dtype=np.float64), MIN_HEAD_GRADIENT_M)
    friction = solver.conveyance * fill * np.sqrt(slope)

    q = np.where(forward, 1.0, -1.0) * np.minimum(solver.q_cap, friction)
    q[np.abs(dh) < MIN_HEAD_GRADIENT_M] = 0.0
    q[fill_depth < MIN_FLOW_DEPTH_M] = 0.0
    return q


def pressurised(solver: DrainSolver, head: NDArray[np.floating]) -> NDArray[np.bool_]:
    """Edges whose **both** ends stand above the pipe crown (CLAUDE.md 11.4)."""
    net = solver.network
    a = np.asarray(net.from_node, dtype=np.intp)
    b = np.asarray(net.to_node, dtype=np.intp)
    d = np.asarray(net.diameter, dtype=np.float64)
    return (head[a] >= net.z_invert[a] + d) & (head[b] >= net.z_invert[b] + d)


def surcharged(solver: DrainSolver, head: NDArray[np.floating]) -> NDArray[np.bool_]:
    """Nodes whose head stands above ground level - the surcharge condition of CLAUDE.md 11.5.

    Whether water actually reaches the street is the coupling's call, because it also knows
    the depth already lying on the cell. This is the pipe-side half of the test, and it is
    what the console's surcharge markers key off.
    """
    return np.asarray(head > solver.network.z_ground, dtype=np.bool_)


def backflow(state: DrainState) -> NDArray[np.bool_]:
    """Edges currently running ``to_node -> from_node``: the console's reversed-flow edges."""
    return np.asarray(state.flow < 0.0, dtype=np.bool_)


# ============================================================================ one step
@dataclass(frozen=True, slots=True)
class DrainStepReport:
    """What one inner step actually moved, in m3.

    The *applied* arrays exist because a step can be supply-limited: a node cannot give away
    more water than it holds, so the surcharge and sink withdrawals the caller asked for may
    be scaled down. CLAUDE.md 11.5 makes the coupling own the surcharge formula; it also has
    to know what got through, or the two halves of Twin would disagree about the volume.
    """

    inlet_m3: float
    """Street to pipe through the inlets."""

    surcharge_m3: float
    """Pipe to street through the manholes, as applied."""

    sink_m3: float
    """Taken out by pumps and tanks, as applied."""

    boundary_m3: float
    """Net volume leaving through the outfalls. Negative means the sea pushed water in."""

    stored_m3: float
    """Water in the interior nodes after the step."""

    limited_edges: int
    """Edges the stability limiter held back this step."""

    applied_surcharge: NDArray[np.floating]
    applied_sink: NDArray[np.floating]


def step(
    solver: DrainSolver,
    state: DrainState,
    *,
    dt_s: float = 1.0,
    q_inlet: NDArray[np.floating] | None = None,
    q_surcharge: NDArray[np.floating] | None = None,
    tide_stage_m: float | NDArray[np.floating] | None = None,
    sinks: ControlledSink | None = None,
    sink_state: SinkState | None = None,
) -> DrainStepReport:
    """Advance the drain state by ``dt_s`` seconds, in place.

    ``q_inlet`` and ``q_surcharge`` are per-node m3/s and non-negative, exactly as
    :class:`~varuna_twin.types.CouplingFluxes` carries them; CLAUDE.md 11.5 computes them, not
    this module. They are held constant over the call, which is what the coupling's frozen
    sync interval means.

    Three reductions can bite, in this order, and each is applied to *both* ends of its edge
    so that no water is created or destroyed:

    1. **flap gates** at outfalls, which forbid flow out of the gated node into the network;
    2. the **stability limiter**, which caps an exchange at the flow that would just level the
       two heads in one step, so an explicit step can never overshoot into oscillation;
    3. the **supply check**, which scales every outflow from a node - pipes, surcharge and
       sinks alike - when they would together take more than the node holds.
    """
    net = solver.network
    head = state.head
    a = np.asarray(net.from_node, dtype=np.intp)
    b = np.asarray(net.to_node, dtype=np.intp)
    n_nodes = solver.n_nodes

    inlet = np.zeros(n_nodes) if q_inlet is None else np.asarray(q_inlet, dtype=np.float64)
    surch = np.zeros(n_nodes) if q_surcharge is None else np.asarray(q_surcharge, dtype=np.float64)

    pin_boundaries(solver, head, tide_stage_m)
    q = edge_flow(solver, head)

    # 1. Flap gates. Honoured at outfalls only: the field documents itself as an outfall
    #    device, and applying it to an interior node would trap water there permanently.
    gated = np.asarray(net.flap_gate, dtype=bool) & solver.fixed_head
    if bool(gated.any()):
        q = np.where(gated[b], np.maximum(q, 0.0), q)
        q = np.where(gated[a], np.minimum(q, 0.0), q)

    # 2. Stability limiter. A fixed-head node is an infinite reservoir, so it contributes
    #    nothing to the head that has to be shared.
    area_now = storage_area(solver, head)
    inv_area = np.where(solver.fixed_head, 0.0, 1.0 / area_now)
    share = inv_area[a] + inv_area[b]
    dh = np.abs(head[a] - head[b])
    with np.errstate(divide="ignore"):
        q_limit = np.where(share > 0.0, dh / (dt_s * np.where(share > 0.0, share, 1.0)), np.inf)
    limited = np.abs(q) > q_limit
    q = np.clip(q, -q_limit, q_limit)

    # 3. Supply check. Everything a node gives away this step, against what it holds.
    draw = (
        np.zeros(n_nodes)
        if sinks is None or sink_state is None
        else sink_draw(sinks, sink_state, solver, head, dt_s)
    )
    q_out = np.bincount(a, weights=np.maximum(q, 0.0), minlength=n_nodes) + np.bincount(
        b, weights=np.maximum(-q, 0.0), minlength=n_nodes
    )
    demand = dt_s * (q_out + surch + draw)
    supply = volume_from_head(solver, head)
    with np.errstate(divide="ignore", invalid="ignore"):
        scale = np.where(demand > supply, np.where(demand > 0.0, supply / demand, 1.0), 1.0)
    scale[solver.fixed_head] = 1.0  # an outfall is never short of water

    source = np.where(q >= 0.0, scale[a], scale[b])
    q = q * source
    applied_surch = surch * scale
    applied_draw = draw * scale

    # Node balance on volume, so the storage curve cannot leak.
    net_edge = np.bincount(b, weights=q, minlength=n_nodes) - np.bincount(
        a, weights=q, minlength=n_nodes
    )
    volume = volume_from_head(solver, head) + dt_s * (
        net_edge + inlet - applied_surch - applied_draw
    )
    new_head = head_from_volume(solver, volume)
    head[:] = np.where(solver.fixed_head, head, new_head)
    pin_boundaries(solver, head, tide_stage_m)
    state.flow[:] = q

    if sinks is not None and sink_state is not None and sinks.n_units > 0:
        sink_state.filled_m3 += dt_s * applied_draw[sinks.node]

    return DrainStepReport(
        inlet_m3=float(dt_s * inlet[~solver.fixed_head].sum()),
        surcharge_m3=float(dt_s * applied_surch[~solver.fixed_head].sum()),
        sink_m3=float(dt_s * applied_draw.sum()),
        boundary_m3=float(dt_s * net_edge[solver.fixed_head].sum()),
        stored_m3=stored_volume_m3(solver, head),
        limited_edges=int(limited.sum()),
        applied_surcharge=applied_surch,
        applied_sink=applied_draw,
    )


# ============================================================================ a run
@dataclass(frozen=True, slots=True)
class DrainRunReport:
    """The volume audit over a whole :func:`simulate` call, in m3."""

    n_steps: int
    inlet_m3: float
    surcharge_m3: float
    sink_m3: float
    boundary_m3: float
    stored_start_m3: float
    stored_end_m3: float
    limited_edges: int

    @property
    def mass_balance(self) -> MassBalance:
        """The CLAUDE.md 11.3 audit: stored change against net inflow, budget 0.1 %.

        Water entering the network is the inlets plus whatever the sea pushed back through
        the outfalls; water leaving is the surcharge, the sinks and the outfall discharge.
        """
        volume_in = self.inlet_m3 + max(-self.boundary_m3, 0.0)
        volume_out = self.surcharge_m3 + self.sink_m3 + max(self.boundary_m3, 0.0)
        stored = self.stored_end_m3 - self.stored_start_m3
        residual = abs(stored - (volume_in - volume_out))
        scale = max(volume_in, abs(stored), 1e-12)
        return MassBalance(
            volume_in_m3=volume_in,
            volume_out_m3=volume_out,
            volume_stored_m3=stored,
            error_fraction=residual / scale,
        )


def simulate(
    solver: DrainSolver,
    state: DrainState,
    *,
    duration_s: float,
    dt_s: float = 1.0,
    q_inlet: NDArray[np.floating] | None = None,
    q_surcharge: NDArray[np.floating] | None = None,
    tide_stage_m: float | NDArray[np.floating] | None = None,
    sinks: ControlledSink | None = None,
    sink_state: SinkState | None = None,
) -> DrainRunReport:
    """Run the drain solver over one sync interval with the forcing held constant.

    CLAUDE.md 11.5 freezes the exchange fluxes over ``sync_s`` (5 s) and CLAUDE.md 11.4 fixes
    the inner step at ``inner_dt_s`` (1 s), so a call here is normally five steps. The tide is
    frozen with them; it moves on a scale of hours.
    """
    n_steps = max(round(duration_s / dt_s), 0)
    started = stored_volume_m3(solver, state.head)
    inlet = surch = sink = boundary = 0.0
    limited = 0
    for _ in range(n_steps):
        report = step(
            solver,
            state,
            dt_s=dt_s,
            q_inlet=q_inlet,
            q_surcharge=q_surcharge,
            tide_stage_m=tide_stage_m,
            sinks=sinks,
            sink_state=sink_state,
        )
        inlet += report.inlet_m3
        surch += report.surcharge_m3
        sink += report.sink_m3
        boundary += report.boundary_m3
        limited += report.limited_edges
    return DrainRunReport(
        n_steps=n_steps,
        inlet_m3=inlet,
        surcharge_m3=surch,
        sink_m3=sink,
        boundary_m3=boundary,
        stored_start_m3=started,
        stored_end_m3=stored_volume_m3(solver, state.head),
        limited_edges=limited,
    )
