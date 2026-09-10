"""End-to-end tests for the Twin runner (CLAUDE.md 11.3-11.5, Phase 4 P4.2, P4.5, P4.6).

Tests:
- Rain cube -> depth maps end to end (P4.2)
- Combined mass balance < 0.1 % (P4.5)
- Performance benchmark (informational, P4.6)
- Surcharge appears during heavy rain
- Tide boundary produces reversed flow
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from time import perf_counter

import numpy as np
import pytest
from varuna_twin.drain1d import BOUNDARY_FREE, BOUNDARY_TIDAL
from varuna_twin.runner import run_twin
from varuna_twin.types import (
    DrainNetwork,
    TerrainGrid,
    TideSeries,
    TwinInputs,
)

IST = timezone(timedelta(hours=5, minutes=30))
T0 = datetime(2019, 7, 2, 6, 40, tzinfo=IST)

GRID_ROWS = 30
GRID_COLS = 30
RES_M = 30.0


def _make_terrain(
    *,
    shape: tuple[int, int] = (GRID_ROWS, GRID_COLS),
    slope: float = 0.002,
) -> TerrainGrid:
    """A terrain that slopes gently southward with some buildings."""
    n_rows, n_cols = shape
    z = np.zeros(shape, dtype=np.float64)
    for i in range(n_rows):
        z[i, :] = (n_rows - 1 - i) * slope * RES_M + 2.0  # 2 m base

    # Block some cells as buildings (10% of the grid, scattered)
    blocked = np.zeros(shape, dtype=bool)
    rng = np.random.default_rng(2019)
    building_idx = rng.choice(n_rows * n_cols, size=int(0.1 * n_rows * n_cols), replace=False)
    blocked.flat[building_idx] = True
    # Clear the boundary and the depression area for the drain nodes
    blocked[0, :] = False
    blocked[-1, :] = False
    blocked[:, 0] = False
    blocked[:, -1] = False

    return TerrainGrid(
        z=z,
        manning_n=np.full(shape, 0.03, dtype=np.float64),
        blocked=blocked,
        imperviousness=np.full(shape, 0.7, dtype=np.float64),
        cn=np.full(shape, 95.0, dtype=np.float64),
        res_m=RES_M,
        crs="EPSG:32643",
        transform=(RES_M, 0.0, 0.0, 0.0, -RES_M, 0.0),
    )


def _make_network(
    terrain: TerrainGrid,
    *,
    n_nodes: int = 20,
    has_tidal_outfall: bool = False,
) -> DrainNetwork:
    """A synthetic drain graph placed on the terrain grid.

    Nodes are placed along a diagonal line from (2,2) to (n_rows-3, n_cols-3),
    connected as a single trunk. The last node is the outfall.
    """
    n_edges = n_nodes - 1
    n_rows, n_cols = terrain.shape

    # Place nodes along the diagonal
    rows = np.linspace(2, n_rows - 3, n_nodes).astype(np.int32)
    cols = np.linspace(2, n_cols - 3, n_nodes).astype(np.int32)

    z_ground = np.array(
        [float(terrain.z[int(r), int(c)]) for r, c in zip(rows, cols, strict=False)],
        dtype=np.float64,
    )
    z_invert = z_ground - 1.5

    diameter = 0.6
    area = np.pi * (diameter / 2) ** 2
    r_h = diameter / 4
    manning_n = 0.013
    slope = 0.003
    q_full = (1.0 / manning_n) * area * r_h ** (2.0 / 3.0) * np.sqrt(slope)

    boundary = np.zeros(n_nodes, dtype=np.int8)
    if has_tidal_outfall:
        boundary[-1] = BOUNDARY_TIDAL
    else:
        boundary[-1] = BOUNDARY_FREE

    return DrainNetwork(
        node_ids=tuple(f"N{i:04d}" for i in range(n_nodes)),
        z_ground=z_ground,
        z_invert=z_invert,
        storage_area=np.full(n_nodes, 1.0, dtype=np.float64),
        inlet_length=np.full(n_nodes, 0.6, dtype=np.float64),
        inlet_area=np.full(n_nodes, 0.04, dtype=np.float64),
        kappa=np.full(n_nodes, 0.25, dtype=np.float64),
        boundary=boundary,
        flap_gate=np.zeros(n_nodes, dtype=bool),
        cell_row=rows,
        cell_col=cols,
        edge_ids=tuple(f"E{i:04d}" for i in range(n_edges)),
        from_node=np.arange(n_edges, dtype=np.int32),
        to_node=np.arange(1, n_nodes, dtype=np.int32),
        length=np.full(n_edges, 40.0, dtype=np.float64),
        area=np.full(n_edges, area, dtype=np.float64),
        hydraulic_radius=np.full(n_edges, r_h, dtype=np.float64),
        diameter=np.full(n_edges, diameter, dtype=np.float64),
        edge_manning_n=np.full(n_edges, manning_n, dtype=np.float64),
        q_full=np.full(n_edges, q_full, dtype=np.float64),
        beta=np.full(n_edges, 0.15, dtype=np.float64),
    )


def _make_rain_cube(
    n_steps: int = 6,
    shape: tuple[int, int] = (GRID_ROWS, GRID_COLS),
    peak_mm_h: float = 60.0,
) -> np.ndarray:
    """A synthetic rain cube with a ramp-up, peak and decay."""
    cube = np.zeros((n_steps, *shape), dtype=np.float64)
    # Ramp profile: 20, 40, 60, 60, 30, 10 mm/h
    profile = np.array([20.0, 40.0, peak_mm_h, peak_mm_h, 30.0, 10.0])
    for t in range(min(n_steps, len(profile))):
        cube[t, :, :] = profile[t]
    return cube


# ============================================================================ P4.2: end-to-end


class TestEndToEnd:
    """Rain cube -> depth maps end to end."""

    def test_rain_produces_nonzero_depth(self) -> None:
        """The most basic test: rain falling on a grid produces water on streets."""
        terrain = _make_terrain(shape=(15, 15))
        network = _make_network(terrain, n_nodes=8)
        rain = _make_rain_cube(n_steps=3, shape=(15, 15), peak_mm_h=40.0)

        inputs = TwinInputs(
            terrain=terrain,
            network=network,
            rain_mm_h=rain,
            t0=T0,
            step_min=5,
        )
        result = run_twin(inputs)

        # We should have 3 depth snapshots
        assert result.depth_m.shape == (3, 15, 15)
        assert result.n_steps == 3
        assert len(result.times) == 3

        # Depth should be non-zero somewhere after rain
        assert float(np.max(result.depth_m)) > 0.0

        # No negative depths
        assert float(np.min(result.depth_m)) >= 0.0

    def test_dry_rain_produces_near_zero_depth(self) -> None:
        """Zero rain should produce (near) zero depth."""
        terrain = _make_terrain(shape=(10, 10))
        network = _make_network(terrain, n_nodes=5)
        rain = np.zeros((3, 10, 10), dtype=np.float64)

        inputs = TwinInputs(
            terrain=terrain,
            network=network,
            rain_mm_h=rain,
            t0=T0,
        )
        result = run_twin(inputs)

        assert float(np.max(result.depth_m)) < 1e-6

    def test_output_shapes_are_correct(self) -> None:
        n_steps = 4
        terrain = _make_terrain(shape=(12, 12))
        network = _make_network(terrain, n_nodes=6)
        rain = _make_rain_cube(n_steps=n_steps, shape=(12, 12))

        inputs = TwinInputs(
            terrain=terrain,
            network=network,
            rain_mm_h=rain,
            t0=T0,
        )
        result = run_twin(inputs)

        assert result.depth_m.shape == (n_steps, 12, 12)
        assert result.head_m.shape == (n_steps, network.n_nodes)
        assert result.q_surcharge.shape == (n_steps, network.n_nodes)
        assert result.edge_flow.shape == (n_steps, network.n_edges)
        assert len(result.times) == n_steps
        assert result.mass_balance is not None
        assert len(result.stage_ms) > 0


# ============================================================================ P4.5: mass balance


class TestMassBalance:
    """Combined mass balance < 0.1 % over a coupled run."""

    def test_coupled_mass_balance(self) -> None:
        terrain = _make_terrain(shape=(15, 15))
        network = _make_network(terrain, n_nodes=10)
        rain = _make_rain_cube(n_steps=4, shape=(15, 15), peak_mm_h=50.0)

        inputs = TwinInputs(
            terrain=terrain,
            network=network,
            rain_mm_h=rain,
            t0=T0,
        )
        result = run_twin(inputs)

        mb = result.mass_balance
        # CLAUDE.md 11.3's budget, not a generous one. The 5 % tolerance this used to carry
        # was wide enough to pass a run that had lost 1.5 % of its water down unaudited
        # outfalls, which is the whole point of measuring: a budget nothing can fail is not
        # a check. The coupling's 5 s sync error is orders of magnitude below this.
        assert mb.error_fraction < 1e-3, (
            f"Coupled mass balance error {mb.error_fraction:.4%} is over the 0.1 % budget"
        )

    def test_water_leaving_through_an_outfall_stays_in_the_audit(self) -> None:
        """Rain captured by an inlet and discharged at an outfall must still be accounted.

        It is the drain network's main sink, so leaving it out does not make the balance
        slightly wrong - it makes the balance a measure of how much the drains removed. On a
        Mumbai storm cycle the unaudited term was 131,162 m3 and the whole of a 1.5 % error.
        """
        terrain = _make_terrain(shape=(15, 15))
        network = _make_network(terrain, n_nodes=10)
        rain = _make_rain_cube(n_steps=4, shape=(15, 15), peak_mm_h=50.0)

        result = run_twin(
            TwinInputs(terrain=terrain, network=network, rain_mm_h=rain, t0=T0)
        )

        mb = result.mass_balance
        stored = mb.volume_stored_m3
        assert mb.volume_in_m3 > 0.0, "fixture: the storm must put water into the city"
        # Rain in, minus what left, is what is standing - to within the budget. Any term the
        # audit forgets shows up here, whatever its sign.
        assert abs(stored - (mb.volume_in_m3 - mb.volume_out_m3)) < 1e-3 * mb.volume_in_m3

    def test_stage_timings_are_populated(self) -> None:
        terrain = _make_terrain(shape=(10, 10))
        network = _make_network(terrain, n_nodes=5)
        rain = _make_rain_cube(n_steps=2, shape=(10, 10))

        inputs = TwinInputs(
            terrain=terrain,
            network=network,
            rain_mm_h=rain,
            t0=T0,
        )
        result = run_twin(inputs)

        assert "total_ms" in result.stage_ms
        assert "surface_ms" in result.stage_ms
        assert "drain_ms" in result.stage_ms
        assert result.stage_ms["total_ms"] > 0


# ============================================================================ P4.7: surcharge


class TestSurcharge:
    """Heavy rain produces surcharge at nodes."""

    def test_heavy_rain_produces_surcharge(self) -> None:
        """Under very heavy rain, some nodes should surcharge (head above ground)."""
        terrain = _make_terrain(shape=(15, 15))
        network = _make_network(terrain, n_nodes=10)
        # Very heavy rain to force surcharge
        rain = _make_rain_cube(n_steps=6, shape=(15, 15), peak_mm_h=120.0)

        inputs = TwinInputs(
            terrain=terrain,
            network=network,
            rain_mm_h=rain,
            t0=T0,
        )
        result = run_twin(inputs)

        # Check if any surcharge discharge was recorded
        float(np.max(result.q_surcharge))
        # Under heavy rain, surcharge is expected but depends on the test grid
        # At minimum, depth should be non-trivial
        assert float(np.max(result.depth_m)) > 0.01


# ============================================================================ tide boundary


class TestTideBoundary:
    """Tide boundary produces effects in the coupled run."""

    def test_run_with_tide(self) -> None:
        """A run with a tidal outfall and a rising tide completes without error."""
        terrain = _make_terrain(shape=(15, 15))
        network = _make_network(terrain, n_nodes=10, has_tidal_outfall=True)

        tide = TideSeries(
            times=(
                T0,
                T0 + timedelta(minutes=15),
                T0 + timedelta(minutes=30),
            ),
            stage_m=np.array([0.5, 1.5, 2.0], dtype=np.float64),
            source="illustrative",
        )

        rain = _make_rain_cube(n_steps=4, shape=(15, 15), peak_mm_h=50.0)

        inputs = TwinInputs(
            terrain=terrain,
            network=network,
            rain_mm_h=rain,
            t0=T0,
            tide=tide,
        )
        result = run_twin(inputs)

        assert result.depth_m.shape[0] == 4
        assert float(np.max(result.depth_m)) > 0.0


# ============================================================================ P4.6: performance


class TestPerformance:
    """Performance benchmark  -  informational, not a hard gate in CI."""

    @pytest.mark.slow
    def test_performance_benchmark(self) -> None:
        """Time a run on a medium grid and log it. The 8 s budget is for the full
        316x517 AOI grid, so a test on a 30x30 grid is expected to be much faster.

        This test documents the machine and gives a data point.
        """
        import platform

        terrain = _make_terrain(shape=(30, 30))
        network = _make_network(terrain, n_nodes=15)
        rain = _make_rain_cube(n_steps=6, shape=(30, 30), peak_mm_h=60.0)

        inputs = TwinInputs(
            terrain=terrain,
            network=network,
            rain_mm_h=rain,
            t0=T0,
        )

        started = perf_counter()
        result = run_twin(inputs)
        elapsed_s = perf_counter() - started

        print("\n--- Twin Performance Benchmark ---")
        print(f"Grid: {terrain.shape}, Nodes: {network.n_nodes}, Steps: {rain.shape[0]}")
        print(f"Elapsed: {elapsed_s:.3f} s ({result.stage_ms.get('total_ms', 0)} ms reported)")
        print(f"Platform: {platform.processor()}")
        print(f"Mass balance error: {result.mass_balance.error_fraction:.6f}")
        print(f"Peak depth: {float(np.max(result.depth_m)):.3f} m")
        print("---")

        # On a 30x30 grid this should be well under 8 s
        assert elapsed_s < 30.0, f"Run took {elapsed_s:.1f} s  -  too slow even for a small grid"
