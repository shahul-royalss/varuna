"""Hydro-conditioning tests on small synthetic DEMs (task P1.5).

Every fixture is a 10 m grid, so one cell is 100 m2 and the 900 m2 spurious-pit threshold
falls between a 4-cell pit (400 m2) and a 20-cell pit (2000 m2).
"""

from __future__ import annotations

import numpy as np
import pytest
from rasterio.transform import Affine
from shapely.geometry import LineString, Point, Polygon
from varuna_city.condition import (
    BUILDING_BURN_M,
    ROAD_CARVE_M,
    breach_culverts,
    condition_dem,
    rasterize_mask,
)
from varuna_city.depressions import find_depressions, label_pits

CRS = "EPSG:32643"
RES = 10.0


def grid_transform(height: int) -> Affine:
    """North-up 10 m transform with its origin at (0, height * 10)."""
    return Affine(RES, 0.0, 0.0, 0.0, -RES, height * RES)


def cell_center(transform: Affine, row: int, col: int) -> tuple[float, float]:
    x, y = transform * (col + 0.5, row + 0.5)
    return float(x), float(y)


def test_building_footprint_raises_its_cells_by_five_metres() -> None:
    dem = np.full((20, 20), 10.0)
    transform = grid_transform(20)
    # a 3 x 3 cell footprint at rows/cols 5..7
    x0, y0 = transform * (5, 8)
    x1, y1 = transform * (8, 5)
    footprint = Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])

    result = condition_dem(dem, transform, CRS, buildings=[footprint], use_whitebox=False)

    mask = result.buildings_mask
    assert mask.sum() == 9
    assert np.allclose(result.dem[mask], 10.0 + BUILDING_BURN_M)
    assert np.allclose(result.dem[~mask], 10.0)
    assert result.changes["cells_burned"] == 9
    assert result.changes["building_burn_m"] == BUILDING_BURN_M


def test_carved_road_lowers_a_one_cell_wide_line() -> None:
    dem = np.full((20, 20), 10.0)
    transform = grid_transform(20)
    start = cell_center(transform, 10, 2)
    end = cell_center(transform, 10, 17)
    road = LineString([start, end])

    result = condition_dem(dem, transform, CRS, roads=[road], use_whitebox=False)

    carved = result.roads_mask
    assert carved.any()
    # one cell wide: every carved cell sits on row 10
    rows = np.unique(np.nonzero(carved)[0])
    assert rows.tolist() == [10]
    assert np.allclose(result.dem[carved], 10.0 - ROAD_CARVE_M)
    assert result.changes["cells_carved"] == int(carved.sum())


def test_culvert_breaches_an_embankment_so_water_passes() -> None:
    height, width = 20, 20
    transform = grid_transform(height)
    # ground falling west to east, with a 5 m embankment across column 10
    dem = np.tile(np.linspace(12.0, 8.0, width), (height, 1)).astype(float)
    dem[:, 10] += 5.0

    row = 10
    upstream = cell_center(transform, row, 8)
    downstream = cell_center(transform, row, 12)
    culvert = LineString([upstream, downstream])

    before = dem[row, 10]
    breached, stats = breach_culverts(dem, transform, [culvert])

    assert stats["culvert_ways_breached"] == 1
    assert stats["culvert_cells_breached"] >= 1
    # the embankment cell is now no higher than the lower of the two end cells
    assert breached[row, 10] < before
    assert breached[row, 10] <= min(dem[row, 8], dem[row, 12]) + 1e-9
    # water can pass: a monotone non-increasing path exists across the embankment
    profile = breached[row, 8:13]
    assert profile.max() <= dem[row, 8] + 1e-9
    # the rest of the embankment is untouched
    assert np.isclose(breached[0, 10], dem[0, 10])


def _dem_with_two_pits() -> tuple[np.ndarray, Affine]:
    """A plateau with a 4-cell (400 m2) pit and a 20-cell (2000 m2) pit."""
    height, width = 30, 30
    dem = np.full((height, width), 10.0)
    dem[0, :] = 6.0  # a drainable edge so both pits have somewhere to spill to
    dem[5:7, 5:7] = 8.0  # 4 cells  -> 400 m2  (spurious)
    dem[20:24, 20:25] = 7.0  # 20 cells -> 2000 m2 (kept)
    return dem, grid_transform(height)


def test_small_pit_is_breached_and_large_pit_is_kept() -> None:
    dem, transform = _dem_with_two_pits()
    labels, _depth = label_pits(dem, use_pyflwdir=False)
    assert labels.max() == 2, "fixture should start with exactly two pits"

    result = condition_dem(dem, transform, CRS, min_pit_area_m2=900.0, use_whitebox=False)

    after, _ = label_pits(result.dem, use_pyflwdir=False)
    remaining = {
        (int(r), int(c))
        for r, c in zip(*np.nonzero(after > 0), strict=True)  # type: ignore[arg-type]
    }
    assert not any(5 <= r < 7 and 5 <= c < 7 for r, c in remaining), "400 m2 pit should be gone"
    assert any(20 <= r < 24 and 20 <= c < 25 for r, c in remaining), "2000 m2 pit should remain"
    assert result.changes["pits_before"] == 2
    assert result.changes["pits_spurious"] == 1
    assert result.changes["pits_breached"] == 1
    assert result.changes["breach_method"] == "python_least_cost"
    # the big pit's floor is untouched
    assert np.isclose(result.dem[21, 21], 7.0)


def test_a_sink_point_protects_its_small_pit() -> None:
    dem, transform = _dem_with_two_pits()
    sink = Point(*cell_center(transform, 5, 5))

    result = condition_dem(
        dem, transform, CRS, sinks=[sink], min_pit_area_m2=900.0, use_whitebox=False
    )

    after, _ = label_pits(result.dem, use_pyflwdir=False)
    assert after[5, 5] > 0, "an underpass passed in as a sink must stay a pit"
    assert result.changes["sinks_protected"] == 1
    assert result.changes["pits_spurious"] == 0


def test_conditioning_is_deterministic_for_a_seed() -> None:
    """Determinism (CLAUDE.md rule 8) is about the products, not about the wall clock.

    ``changes["stage_ms"]`` is how long the run took, so it differs between two runs of the
    same input (the first pays for Numba/pyflwdir warm-up). Everything else must match
    exactly, and the timing is only required to be a sane non-negative number.
    """
    dem, transform = _dem_with_two_pits()
    first = condition_dem(dem, transform, CRS, seed=2019, use_whitebox=False)
    second = condition_dem(dem, transform, CRS, seed=2019, use_whitebox=False)
    assert np.array_equal(first.dem, second.dem)

    def products(changes: dict[str, object]) -> dict[str, object]:
        return {k: v for k, v in changes.items() if k != "stage_ms"}

    assert products(first.changes) == products(second.changes)
    for result in (first, second):
        assert isinstance(result.changes["stage_ms"], float)
        assert result.changes["stage_ms"] >= 0.0


def test_full_step_order_burn_then_carve_then_breach() -> None:
    dem, transform = _dem_with_two_pits()
    x0, y0 = transform * (12, 13)
    x1, y1 = transform * (14, 11)
    building = Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
    road = LineString([cell_center(transform, 15, 2), cell_center(transform, 15, 27)])

    result = condition_dem(
        dem,
        transform,
        CRS,
        buildings=[building],
        roads=[road],
        min_pit_area_m2=900.0,
        use_whitebox=False,
    )

    assert np.isclose(result.dem[12, 12], 10.0 + BUILDING_BURN_M)
    assert np.isclose(result.dem[15, 15], 10.0 - ROAD_CARVE_M)
    assert result.stage_ms >= 0.0
    assert result.changes["stage_ms"] == result.stage_ms


def test_rasterize_mask_handles_empty_and_reprojected_input() -> None:
    transform = grid_transform(10)
    assert rasterize_mask(None, transform, (10, 10)).sum() == 0
    assert rasterize_mask([], transform, (10, 10)).sum() == 0


def test_no_vector_input_leaves_the_dem_alone_apart_from_spurious_pits() -> None:
    dem = np.full((15, 15), 10.0)
    dem[0, :] = 6.0
    transform = grid_transform(15)
    result = condition_dem(dem, transform, CRS, use_whitebox=False)
    assert np.array_equal(result.dem, dem)
    assert result.changes["pits_before"] == 0


@pytest.mark.parametrize("use_pyflwdir", [True, False])
def test_conditioned_dem_feeds_find_depressions(use_pyflwdir: bool) -> None:
    dem, transform = _dem_with_two_pits()
    result = condition_dem(
        dem, transform, CRS, min_pit_area_m2=900.0, use_whitebox=False, use_pyflwdir=use_pyflwdir
    )
    pits = find_depressions(
        result.dem, transform, CRS, min_area_m2=900.0, use_pyflwdir=use_pyflwdir
    )
    assert len(pits) == 1
    assert pits.iloc[0]["area_m2"] == pytest.approx(2000.0)
