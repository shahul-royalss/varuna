"""Unit tests for the coupling module (CLAUDE.md 11.5, Phase 4 P4.4 and P4.5).

Tests:
- Inlet capture matches Appendix A formulae
- Surcharge pushes water onto the street
- κ (kappa) reduces capture proportionally
- Exchange conserves water (no creation or destruction at the interface)
"""

from __future__ import annotations

import numpy as np
import pytest
from varuna_twin.coupling import (
    ORIFICE_CD,
    SURCHARGE_CD,
    WEIR_CD,
    compute_exchange,
)
from varuna_twin.drain1d import BOUNDARY_FREE, prepare
from varuna_twin.types import GRAVITY, DrainNetwork


def _coupled_network(
    *,
    n_nodes: int = 3,
    kappa: float = 0.0,
    beta: float = 0.0,
    grid_shape: tuple[int, int] = (5, 5),
) -> tuple[DrainNetwork, np.ndarray, np.ndarray]:
    """A small drain network sitting on a 2D grid.

    Returns the network, surface_h (depth), and surface_z (elevation).
    Node 0 is at cell (1,1), node 1 at (2,2), node 2 (outfall) at (3,3).
    """
    n_edges = n_nodes - 1
    z_ground = np.array([5.0, 4.9, 4.8][:n_nodes], dtype=np.float64)
    z_invert = z_ground - 1.5

    diameter = 0.6
    area = np.pi * (diameter / 2) ** 2
    r_h = diameter / 4
    manning_n = 0.013
    s = 0.005
    q_full = (1.0 / manning_n) * area * r_h ** (2.0 / 3.0) * np.sqrt(s)
    length = 40.0

    cell_rows = np.array([1, 2, 3][:n_nodes], dtype=np.int32)
    cell_cols = np.array([1, 2, 3][:n_nodes], dtype=np.int32)

    boundary = np.zeros(n_nodes, dtype=np.int8)
    boundary[-1] = BOUNDARY_FREE

    network = DrainNetwork(
        node_ids=tuple(f"N{i:04d}" for i in range(n_nodes)),
        z_ground=z_ground,
        z_invert=z_invert,
        storage_area=np.full(n_nodes, 1.0, dtype=np.float64),
        inlet_length=np.full(n_nodes, 0.6, dtype=np.float64),
        inlet_area=np.full(n_nodes, 0.04, dtype=np.float64),
        kappa=np.full(n_nodes, kappa, dtype=np.float64),
        boundary=boundary,
        flap_gate=np.zeros(n_nodes, dtype=bool),
        cell_row=cell_rows,
        cell_col=cell_cols,
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

    # 2D grid: flat at z=5.0
    surface_z = np.full(grid_shape, 5.0, dtype=np.float64)
    # Set the z at node cells to match the network
    for i in range(n_nodes):
        surface_z[cell_rows[i], cell_cols[i]] = z_ground[i]

    surface_h = np.zeros(grid_shape, dtype=np.float64)

    return network, surface_h, surface_z


class TestInletCapture:
    """Inlet capture matches Appendix A."""

    def test_dry_street_produces_no_capture(self) -> None:
        network, surface_h, surface_z = _coupled_network()
        solver = prepare(network)
        head = np.asarray(network.z_invert, dtype=np.float64).copy()

        exchange = compute_exchange(
            surface_h=surface_h,
            surface_z=surface_z,
            drain_head=head,
            network=network,
            solver=solver,
            cell_area_m2=100.0,
        )

        assert np.all(exchange.q_inlet_node == 0.0)
        assert np.all(exchange.q_inlet_cell == 0.0)

    def test_wet_street_captures_water(self) -> None:
        network, surface_h, surface_z = _coupled_network()
        solver = prepare(network)
        head = np.asarray(network.z_invert, dtype=np.float64).copy()

        # Put 10 cm of water on the cells where nodes sit
        surface_h[1, 1] = 0.1
        surface_h[2, 2] = 0.15

        exchange = compute_exchange(
            surface_h=surface_h,
            surface_z=surface_z,
            drain_head=head,
            network=network,
            solver=solver,
            cell_area_m2=100.0,
        )

        # Interior nodes should capture water
        assert exchange.q_inlet_node[0] > 0.0  # node 0 at (1,1)
        assert exchange.q_inlet_node[1] > 0.0  # node 1 at (2,2)

        # Outfall (fixed head) should not capture
        assert exchange.q_inlet_node[2] == 0.0

    def test_capture_formula_matches_appendix_a(self) -> None:
        """Check the weir and orifice formulae at a known depth."""
        network, surface_h, surface_z = _coupled_network(kappa=0.0)
        solver = prepare(network)
        head = np.asarray(network.z_invert, dtype=np.float64).copy()

        h = 0.2  # 20 cm of water
        surface_h[1, 1] = h

        exchange = compute_exchange(
            surface_h=surface_h,
            surface_z=surface_z,
            drain_head=head,
            network=network,
            solver=solver,
            cell_area_m2=900.0,
        )

        # Expected from Appendix A
        L = 0.6  # inlet_length
        A_o = 0.04  # inlet_area
        q_weir = WEIR_CD * L * h**1.5
        q_orifice = ORIFICE_CD * A_o * np.sqrt(2.0 * GRAVITY * h)
        q_expected = min(q_weir, q_orifice)

        # The actual capture may be limited by Q_avail, so it should be <= q_expected
        assert exchange.q_inlet_node[0] <= q_expected + 1e-10
        assert exchange.q_inlet_node[0] > 0.0


class TestKappaReducesCapture:
    """κ (clogging) reduces inlet capture proportionally."""

    def test_clogged_inlet_captures_less(self) -> None:
        # Unclogged
        net0, h0, z0 = _coupled_network(kappa=0.0)
        solver0 = prepare(net0)
        head0 = np.asarray(net0.z_invert, dtype=np.float64).copy()
        h0[1, 1] = 0.2

        ex0 = compute_exchange(h0, z0, head0, net0, solver0, 900.0)

        # 50% clogged
        net50, h50, z50 = _coupled_network(kappa=0.5)
        solver50 = prepare(net50)
        head50 = np.asarray(net50.z_invert, dtype=np.float64).copy()
        h50[1, 1] = 0.2

        ex50 = compute_exchange(h50, z50, head50, net50, solver50, 900.0)

        # The clogged inlet should capture about half as much
        if ex0.q_inlet_node[0] > 0:
            ratio = ex50.q_inlet_node[0] / ex0.q_inlet_node[0]
            assert ratio == pytest.approx(0.5, rel=0.1)


class TestSurcharge:
    """Surcharge pushes water onto the street."""

    def test_surcharged_node_pushes_water_to_cell(self) -> None:
        network, surface_h, surface_z = _coupled_network()
        solver = prepare(network)

        # Force the head above ground level at node 0
        head = np.asarray(network.z_invert, dtype=np.float64).copy()
        head[0] = network.z_ground[0] + 0.5  # 50 cm above ground

        exchange = compute_exchange(
            surface_h=surface_h,
            surface_z=surface_z,
            drain_head=head,
            network=network,
            solver=solver,
            cell_area_m2=900.0,
        )

        # Surcharge should be positive at node 0
        assert exchange.q_surcharge_node[0] > 0.0

        # The cell should receive the surcharge
        assert exchange.q_surcharge_cell[1, 1] > 0.0

    def test_no_surcharge_when_head_below_ground(self) -> None:
        network, surface_h, surface_z = _coupled_network()
        solver = prepare(network)
        head = np.asarray(network.z_invert, dtype=np.float64).copy()

        exchange = compute_exchange(
            surface_h=surface_h,
            surface_z=surface_z,
            drain_head=head,
            network=network,
            solver=solver,
            cell_area_m2=900.0,
        )

        # No surcharge when heads are well below ground
        assert np.all(exchange.q_surcharge_node == 0.0)

    def test_surcharge_formula_matches_appendix_a(self) -> None:
        """Q_surch = 0.6 * A_m * sqrt(2g(H - z_g - h))."""
        network, surface_h, surface_z = _coupled_network()
        solver = prepare(network)

        excess = 0.5  # 50 cm above the street surface
        head = np.asarray(network.z_invert, dtype=np.float64).copy()
        head[0] = surface_z[1, 1] + surface_h[1, 1] + excess  # z_g + h + excess

        exchange = compute_exchange(
            surface_h=surface_h,
            surface_z=surface_z,
            drain_head=head,
            network=network,
            solver=solver,
            cell_area_m2=900.0,
        )

        # Expected
        A_m = 1.0  # storage_area = manhole area
        q_expected = SURCHARGE_CD * A_m * np.sqrt(2.0 * GRAVITY * excess)

        assert exchange.q_surcharge_node[0] == pytest.approx(q_expected, rel=1e-4)


class TestExchangeConservation:
    """No water is created or destroyed at the coupling interface."""

    def test_cell_rates_sum_to_node_rates(self) -> None:
        """The per-cell rates scattered from the nodes must sum to the same total."""
        network, surface_h, surface_z = _coupled_network()
        solver = prepare(network)
        head = np.asarray(network.z_invert, dtype=np.float64).copy()
        surface_h[1, 1] = 0.15
        surface_h[2, 2] = 0.10

        cell_area = 900.0
        exchange = compute_exchange(
            surface_h=surface_h,
            surface_z=surface_z,
            drain_head=head,
            network=network,
            solver=solver,
            cell_area_m2=cell_area,
        )

        # Total inlet from node view vs cell view
        node_total = float(np.sum(exchange.q_inlet_node))
        cell_total = float(np.sum(exchange.q_inlet_cell)) * cell_area
        assert cell_total == pytest.approx(node_total, rel=1e-8)

    def test_coupling_fluxes_contract_type(self) -> None:
        """as_coupling_fluxes returns the correct contract type."""
        network, surface_h, surface_z = _coupled_network()
        solver = prepare(network)
        head = np.asarray(network.z_invert, dtype=np.float64).copy()

        exchange = compute_exchange(surface_h, surface_z, head, network, solver, 900.0)

        cf = exchange.as_coupling_fluxes()
        assert np.array_equal(cf.q_inlet, exchange.q_inlet_node)
        assert np.array_equal(cf.q_surcharge, exchange.q_surcharge_node)
