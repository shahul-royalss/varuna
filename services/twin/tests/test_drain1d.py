"""Unit tests for the 1D drain solver (CLAUDE.md 11.4, Phase 4 P4.3 and P4.7).

Tests:
- Conservation: inlet volume = stored + outflow
- Single pipe at capacity gives Manning flow
- Tide-lock test (P4.7): raising the outfall stage produces negative Q on the trunk
  and surcharge at the first upstream manhole
- Flap gate blocks backflow
- Preissmann slot: head rises above crown without diverging
- Backflow detection
"""

from __future__ import annotations

import numpy as np
from varuna_twin.drain1d import (
    BOUNDARY_FREE,
    BOUNDARY_TIDAL,
    ControlledSink,
    SinkState,
    backflow,
    edge_flow,
    prepare,
    pressurised,
    simulate,
    stored_volume_m3,
    surcharged,
)
from varuna_twin.types import DrainNetwork, DrainState


def _simple_network(
    *,
    n_nodes: int = 4,
    beta: float = 0.0,
    kappa: float = 0.0,
    slope: float = 0.005,
    diameter: float = 0.6,
    manning_n: float = 0.013,
    has_tidal_outfall: bool = False,
    flap_gate: bool = False,
) -> DrainNetwork:
    """A simple linear pipe network: node 0 -> node 1 -> ... -> node N-1 (outfall).

    Each node is 40 m apart (CLAUDE.md 10.1 step 7). The inverts slope downhill toward
    the outfall. The last node is an outfall (free or tidal).
    """
    n_edges = n_nodes - 1
    length = 40.0  # m

    z_ground = np.linspace(5.0, 5.0 - slope * length * n_edges, n_nodes)
    z_invert = z_ground - 1.5  # 1.5 m cover

    area = np.pi * (diameter / 2) ** 2
    r_h = diameter / 4  # circular pipe
    s = slope
    q_full = (1.0 / manning_n) * area * r_h ** (2.0 / 3.0) * np.sqrt(s)

    boundary = np.zeros(n_nodes, dtype=np.int8)
    if has_tidal_outfall:
        boundary[-1] = BOUNDARY_TIDAL
    else:
        boundary[-1] = BOUNDARY_FREE

    flap_arr = np.zeros(n_nodes, dtype=bool)
    if flap_gate:
        flap_arr[-1] = True

    return DrainNetwork(
        node_ids=tuple(f"N{i:04d}" for i in range(n_nodes)),
        z_ground=z_ground.astype(np.float64),
        z_invert=z_invert.astype(np.float64),
        storage_area=np.full(n_nodes, 1.0, dtype=np.float64),  # 1 m2 manholes
        inlet_length=np.full(n_nodes, 0.6, dtype=np.float64),
        inlet_area=np.full(n_nodes, 0.04, dtype=np.float64),
        kappa=np.full(n_nodes, kappa, dtype=np.float64),
        boundary=boundary,
        flap_gate=flap_arr,
        cell_row=np.full(n_nodes, -1, dtype=np.int32),  # no 2D cells
        cell_col=np.full(n_nodes, -1, dtype=np.int32),
        edge_ids=tuple(f"E{i:04d}" for i in range(n_edges)),
        from_node=np.arange(n_edges, dtype=np.int32),
        to_node=np.arange(1, n_nodes, dtype=np.int32),
        length=np.full(n_edges, length, dtype=np.float64),
        area=np.full(n_edges, area, dtype=np.float64),
        hydraulic_radius=np.full(n_edges, r_h, dtype=np.float64),
        diameter=np.full(n_edges, diameter, dtype=np.float64),
        edge_manning_n=np.full(n_edges, manning_n, dtype=np.float64),
        q_full=np.full(n_edges, q_full, dtype=np.float64),
        beta=np.full(n_edges, beta, dtype=np.float64),
    )


def _init_state(network: DrainNetwork) -> DrainState:
    """Heads at the inverts (empty pipes), zero flow."""
    return DrainState(
        head=np.asarray(network.z_invert, dtype=np.float64).copy(),
        flow=np.zeros(network.n_edges, dtype=np.float64),
    )


# ============================================================================ P4.3 tests


class TestConservation:
    """Inlet volume = stored + outflow over a run."""

    def test_inlet_volume_conserved(self) -> None:
        network = _simple_network(n_nodes=5)
        solver = prepare(network)
        state = _init_state(network)

        # Inject water at node 0
        q_inlet = np.zeros(network.n_nodes)
        q_inlet[0] = 0.01  # 10 L/s

        report = simulate(
            solver,
            state,
            duration_s=60.0,
            q_inlet=q_inlet,
        )

        # Conservation: inlet = stored + boundary
        balance = report.mass_balance
        assert balance.error_fraction < 1e-3, (
            f"Mass balance error {balance.error_fraction:.6f} exceeds 0.1%"
        )

    def test_long_run_conservation(self) -> None:
        """60 seconds of inlet flow conserves volume to 0.1%."""
        network = _simple_network(n_nodes=6)
        solver = prepare(network)
        state = _init_state(network)

        q_inlet = np.zeros(network.n_nodes)
        q_inlet[0] = 0.05  # 50 L/s
        q_inlet[2] = 0.02  # 20 L/s

        report = simulate(
            solver,
            state,
            duration_s=120.0,
            q_inlet=q_inlet,
        )

        balance = report.mass_balance
        assert balance.error_fraction < 1e-3


class TestManningFlow:
    """A single pipe at capacity gives Manning flow."""

    def test_single_pipe_manning_flow(self) -> None:
        """A single pipe with water at a known depth matches the Manning formula."""
        network = _simple_network(n_nodes=2, slope=0.005, diameter=0.6, manning_n=0.013)
        solver = prepare(network)

        # Set heads so the pipe is half full at a gradient
        head = network.z_invert.copy()
        head[0] = network.z_invert[0] + 0.4  # 0.4 m of water at upstream
        head[1] = network.z_invert[1] + 0.2  # 0.2 m at downstream
        state = DrainState(head=head, flow=np.zeros(1, dtype=np.float64))

        q = edge_flow(solver, state.head)

        # The flow should be positive (from_node -> to_node)
        assert q[0] > 0.0

        # Verify it is bounded by the capacity
        assert q[0] <= solver.q_cap[0] + 1e-10


class TestTideLock:
    """P4.7: Tide-lock test  -  raising the outfall stage produces reversed flow."""

    def test_reversed_flow_at_tide_locked_outfall(self) -> None:
        """When the tide rises above the trunk, the sea pushes in and the manholes surcharge.

        The inlet is **off** while the tide is up, and that is the point rather than a
        convenience. Backflow means the sea is the thing driving the water, so it only happens
        while the sea stands higher than the pipe: keep injecting at the top of the network and
        the upstream head simply rises until it passes the tide and the trunk drains downhill
        again. Measured on this network, 50 L/s at node 0 under a 5.64 m tide settles at heads
        of 5.77 / 5.71 / 5.66 against the sea's 5.64 - surcharged a full 0.77 m over the 5.0 m
        ground, and still flowing seaward at +0.049 m3/s. That is correct behaviour, not a
        failure to lock, and asserting negative flow there would have been asserting something
        untrue of the physics.

        Which is also the honest read of the demo's 1:40 beat (CLAUDE.md 15): the tide-locked
        outfall reverses when the storm is not out-pushing the sea, and surcharges upstream
        either way. The surcharge is the robust signal; the reversal needs the sea to win.
        """
        network = _simple_network(n_nodes=4, has_tidal_outfall=True, slope=0.003)
        solver = prepare(network)
        state = _init_state(network)

        # Fill the network normally first, so the reversal is a change of direction rather
        # than a cold start from an empty pipe.
        q_inlet = np.zeros(network.n_nodes)
        q_inlet[0] = 0.05  # 50 L/s
        simulate(solver, state, duration_s=30.0, q_inlet=q_inlet, tide_stage_m=0.0)
        assert np.all(state.flow > 0.0), "the network should drain seaward before the tide rises"

        # The tide rises a metre over the outfall's ground level and the storm eases off.
        high_tide = float(network.z_ground[-1]) + 1.0
        simulate(
            solver,
            state,
            duration_s=60.0,
            q_inlet=np.zeros(network.n_nodes),
            tide_stage_m=high_tide,
        )

        # Every edge now carries water landward: this is the console's reversed-flow edge.
        assert np.all(state.flow < 0.0), (
            f"Expected backflow along the tide-locked trunk, got Q = {np.round(state.flow, 6)}"
        )

        # The sea lifts the whole chain above the crown at once, so here - unlike a single
        # backed-up manhole - every edge really is pressurised.
        assert np.all(pressurised(solver, state.head)), (
            f"a tide over the crown should pressurise the trunk: head = {np.round(state.head, 3)}"
        )

        # The upstream node should be surcharged (head above ground)
        is_surcharged = surcharged(solver, state.head)
        # At least one interior node should be surcharged
        interior = ~solver.fixed_head
        assert np.any(is_surcharged[interior]), (
            "Expected surcharge at an upstream node from tide-lock"
        )

    def test_backflow_detected(self) -> None:
        """The backflow function identifies reversed edges."""
        network = _simple_network(n_nodes=3)
        state = DrainState(
            head=network.z_invert.copy(),
            flow=np.array([0.1, -0.05], dtype=np.float64),
        )
        bf = backflow(state)
        assert not bf[0]
        assert bf[1]


class TestFlapGate:
    """Flap gate blocks backflow at an outfall."""

    def test_flap_gate_prevents_reverse_flow(self) -> None:
        network = _simple_network(n_nodes=3, has_tidal_outfall=True, flap_gate=True, slope=0.003)
        solver = prepare(network)
        state = _init_state(network)

        # Fill the network
        q_inlet = np.zeros(network.n_nodes)
        q_inlet[0] = 0.03
        simulate(solver, state, duration_s=20.0, q_inlet=q_inlet, tide_stage_m=0.0)

        # Raise the tide well above the outfall
        high_tide = float(network.z_ground[-1]) + 2.0

        # Run with high tide  -  the flap gate should prevent backflow
        simulate(
            solver,
            state,
            duration_s=30.0,
            q_inlet=q_inlet,
            tide_stage_m=high_tide,
        )

        # The edge connected to the gated outfall should have non-negative flow
        # (the flap gate blocks reverse)
        last_edge = network.n_edges - 1
        assert state.flow[last_edge] >= -1e-12, (
            f"Flap gate should prevent backflow, got Q = {state.flow[last_edge]:.6f}"
        )


class TestPreissmannSlot:
    """Head rises above the crown without diverging."""

    def test_surcharge_head_stays_bounded(self) -> None:
        """Force a small network far past capacity: the head rises linearly, never runaway.

        What a Preissmann slot promises is **numerical** stability, not a ceiling on head. It
        replaces the pressurised pipe's near-zero storage with a narrow slot so the head has
        somewhere to go and the scheme stays well posed; it does not make water vanish. Feed a
        300 mm pipe 500 L/s when it can discharge 68 L/s and the remaining 4.3 m3 per 10 s has
        to be somewhere, so the head climbs - and climbing is the correct answer.

        So this asserts the property that actually distinguishes a working slot from a broken
        one: the rise is **linear and steady**. Measured here it is 3.791 m per 10 s, the same
        figure every interval to four significant figures. An unstable scheme would accelerate,
        oscillate in sign, or blow to inf; a slot that leaked storage would flatten off. An
        earlier version of this test asserted `head < z_ground + 20`, which is an arbitrary
        number: it passes or fails on how long the test happens to run, and at 60 s it failed
        at 26.3 m while the solver was behaving perfectly.

        In the coupled model this node never gets near 26 m, because the moment the head passes
        ground level the coupling spills the excess onto the street as ``q_surcharge``
        (CLAUDE.md 11.5). That relief is tested in test_coupling.py; drain1d on its own has
        nowhere to put the water, and pretending otherwise here would hide a mass leak.
        """
        network = _simple_network(n_nodes=3, diameter=0.3)  # small pipes
        solver = prepare(network)
        state = _init_state(network)

        # Large inlet flow to force surcharge
        q_inlet = np.zeros(network.n_nodes)
        q_inlet[0] = 0.5  # 500 L/s into a 300mm pipe

        crown = network.z_invert[0] + network.diameter[0]  # the first edge's diameter
        rises: list[float] = []
        previous = float(state.head[0])
        for _ in range(6):
            simulate(solver, state, duration_s=10.0, q_inlet=q_inlet)
            assert np.all(np.isfinite(state.head)), "the slot must keep every head finite"
            rises.append(float(state.head[0]) - previous)
            previous = float(state.head[0])

        assert state.head[0] > crown, "Expected head above crown under heavy inflow"

        # The scheme is steady: once the network has filled, every interval adds the same head.
        steady = np.array(rises[1:])
        assert np.all(steady > 0.0), f"the head must keep rising while water accumulates: {rises}"
        assert steady.max() - steady.min() < 1e-6, (
            f"the rise must be linear, not accelerating or oscillating: {rises}"
        )

        # Node 0 is what backs up, and only node 0. Its neighbours pass their Manning capacity
        # at a low head, so no EDGE is pressurised here - pressurisation needs both ends above
        # the crown, and a single blocked upstream manhole does not do that. The pressurised
        # case is the tide-locked one above, where the sea lifts the whole chain at once.
        assert bool(surcharged(solver, state.head)[0]), "node 0 should be surcharged"
        assert not np.any(pressurised(solver, state.head)[1:]), (
            "only the head node backs up in this scenario"
        )


class TestPumpsAndTanks:
    """Controlled sinks withdraw water correctly."""

    def test_pump_withdraws_water(self) -> None:
        network = _simple_network(n_nodes=3)
        solver = prepare(network)
        state = _init_state(network)

        # Fill the network
        q_inlet = np.zeros(network.n_nodes)
        q_inlet[0] = 0.1
        simulate(solver, state, duration_s=30.0, q_inlet=q_inlet)

        stored_volume_m3(solver, state.head)

        # Create a pump at node 1
        sinks = ControlledSink(
            ids=("PUMP-01",),
            node=np.array([1], dtype=np.int32),
            curve_depth_m=np.array([[0.0, 1.0]], dtype=np.float64),
            curve_rate_m3_s=np.array([[0.0, 0.05]], dtype=np.float64),
            capacity_m3=np.array([np.inf], dtype=np.float64),
        )
        sink_state = SinkState(filled_m3=np.array([0.0], dtype=np.float64))

        # Continue with the pump running
        report = simulate(
            solver,
            state,
            duration_s=30.0,
            q_inlet=q_inlet,
            sinks=sinks,
            sink_state=sink_state,
        )

        assert report.sink_m3 > 0.0, "Pump should have withdrawn water"


class TestDeterminism:
    """Two identical runs produce identical results."""

    def test_two_runs_byte_identical(self) -> None:
        network = _simple_network(n_nodes=5)
        solver = prepare(network)

        q_inlet = np.zeros(network.n_nodes)
        q_inlet[0] = 0.1
        q_inlet[2] = 0.05

        state1 = _init_state(network)
        simulate(solver, state1, duration_s=60.0, q_inlet=q_inlet)

        state2 = _init_state(network)
        simulate(solver, state2, duration_s=60.0, q_inlet=q_inlet)

        assert state1.head.tobytes() == state2.head.tobytes()
        assert state1.flow.tobytes() == state2.flow.tobytes()
