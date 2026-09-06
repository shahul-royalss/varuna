"""P1.6 — road segments: stable ids, DEM sampling and exposure weights."""

from __future__ import annotations

import geopandas as gpd
import networkx as nx
import numpy as np
import pytest
from rasterio.transform import Affine
from shapely.geometry import Point, Polygon

from varuna_city.segments import (
    build_segments,
    classify_highway,
    edges_to_frame,
    sample_dem_along,
    segments_near,
)

CRS = "EPSG:32643"
RES = 30.0
# A small metric grid roughly where MUM-CENTRAL sits in UTM 43N.
ORIGIN_X, ORIGIN_Y = 270_000.0, 2_105_000.0
TRANSFORM = Affine(RES, 0.0, ORIGIN_X, 0.0, -RES, ORIGIN_Y)
SHAPE = (40, 40)


def _dem() -> np.ndarray:
    """A plane tilting down to the south-east, so z varies along every segment."""
    rows, cols = np.indices(SHAPE)
    return (20.0 - 0.2 * rows - 0.1 * cols).astype(np.float64)


def _graph() -> nx.MultiDiGraph:
    """Four junctions, three streets: a primary road and two residential stubs.

    Node 1 -> 2 is the "KEM Hospital" street, node 3 -> 4 is the far residential one.
    """
    graph = nx.MultiDiGraph(crs=CRS)
    coords = {
        1: (ORIGIN_X + 100.0, ORIGIN_Y - 100.0),
        2: (ORIGIN_X + 400.0, ORIGIN_Y - 100.0),
        3: (ORIGIN_X + 100.0, ORIGIN_Y - 1000.0),
        4: (ORIGIN_X + 400.0, ORIGIN_Y - 1000.0),
        5: (ORIGIN_X + 400.0, ORIGIN_Y - 400.0),
    }
    for node, (x, y) in coords.items():
        graph.add_node(node, x=x, y=y)
    graph.add_edge(1, 2, 0, osmid=1001, highway="residential", lanes="2", oneway=False)
    graph.add_edge(2, 1, 0, osmid=1001, highway="residential", lanes="2", oneway=False)
    graph.add_edge(3, 4, 0, osmid=1002, highway="residential", lanes="2", oneway=False)
    graph.add_edge(2, 5, 0, osmid=[1003, 1004], highway=["primary", "primary_link"], oneway=True)
    return graph


def _assets() -> gpd.GeoDataFrame:
    """KEM Hospital, Parel - the asset that lifts the exposure weight of its street."""
    return gpd.GeoDataFrame(
        {"asset_kind": ["hospitals"], "name": ["KEM Hospital"]},
        geometry=[Point(ORIGIN_X + 250.0, ORIGIN_Y - 150.0)],
        crs=CRS,
    )


def _buildings() -> gpd.GeoDataFrame:
    """A dense block beside the hospital street."""
    squares = [
        Polygon(
            [
                (ORIGIN_X + 120.0 + 20.0 * i, ORIGIN_Y - 130.0),
                (ORIGIN_X + 132.0 + 20.0 * i, ORIGIN_Y - 130.0),
                (ORIGIN_X + 132.0 + 20.0 * i, ORIGIN_Y - 118.0),
                (ORIGIN_X + 120.0 + 20.0 * i, ORIGIN_Y - 118.0),
            ]
        )
        for i in range(12)
    ]
    return gpd.GeoDataFrame({"building": ["yes"] * len(squares)}, geometry=squares, crs=CRS)


def test_classify_highway_handles_lists_and_unknowns() -> None:
    assert classify_highway("motorway_link") == "motorway"
    assert classify_highway(["unclassified", "service"]) == "residential"
    assert classify_highway(None) == "service"


def test_edges_to_frame_builds_geometry_from_nodes() -> None:
    edges = edges_to_frame(_graph())
    assert len(edges) == 4
    assert str(edges.crs) == CRS
    assert edges.geometry.length.min() > 0


def test_segment_ids_are_stable_across_runs() -> None:
    graph = _graph()
    first = build_segments(graph, _dem(), TRANSFORM, _buildings(), _assets())
    second = build_segments(_graph(), _dem(), TRANSFORM, _buildings(), _assets())
    assert list(first["segment_id"]) == list(second["segment_id"])
    assert first["segment_id"].is_unique
    # The two-way street collapses to one segment: 4 edges in, 3 segments out.
    assert len(first) == 3
    assert all(sid.startswith("S") for sid in first["segment_id"])


def test_z_min_never_exceeds_z_mean() -> None:
    segments = build_segments(_graph(), _dem(), TRANSFORM)
    assert segments["z_min"].notna().all()
    assert (segments["z_min"] <= segments["z_mean"] + 1e-9).all()


def test_missing_dem_leaves_elevation_null() -> None:
    segments = build_segments(_graph())
    assert segments["z_min"].isna().all()
    assert segments["length_m"].min() > 0


def test_exposure_is_higher_near_kem_hospital() -> None:
    segments = build_segments(_graph(), _dem(), TRANSFORM, _buildings(), _assets())
    by_way = segments.set_index("osm_way_id")
    near = float(by_way.loc[1001, "exposure_weight"])
    far = float(by_way.loc[1002, "exposure_weight"])
    assert near > far
    assert 0.0 <= far <= near <= 1.0


def test_class_and_ward_attributes() -> None:
    wards = gpd.GeoDataFrame(
        {"name": ["F/South"]},
        geometry=[
            Polygon(
                [
                    (ORIGIN_X, ORIGIN_Y - 600.0),
                    (ORIGIN_X + 600.0, ORIGIN_Y - 600.0),
                    (ORIGIN_X + 600.0, ORIGIN_Y),
                    (ORIGIN_X, ORIGIN_Y),
                ]
            )
        ],
        crs=CRS,
    )
    segments = build_segments(_graph(), _dem(), TRANSFORM, wards=wards)
    classes = set(segments["class"])
    assert classes == {"residential", "primary"}
    assert "F/South" in set(segments["ward"].dropna())
    assert segments["ward"].isna().any()  # the far street sits outside the ward


def test_sample_dem_along_returns_nan_outside_the_grid() -> None:
    from shapely.geometry import LineString

    far = LineString([(0.0, 0.0), (100.0, 0.0)])
    z_min, z_mean = sample_dem_along(far, _dem(), TRANSFORM)
    assert np.isnan(z_min) and np.isnan(z_mean)


def test_segments_near_respects_max_distance() -> None:
    segments = build_segments(_graph(), _dem(), TRANSFORM)
    ids = segments_near(
        segments,
        [Point(ORIGIN_X + 200.0, ORIGIN_Y - 105.0), Point(ORIGIN_X + 5000.0, ORIGIN_Y)],
        max_distance_m=60.0,
    )
    assert ids[0] is not None
    assert ids[1] is None


@pytest.mark.parametrize("empty", [gpd.GeoDataFrame(geometry=[], crs=CRS)])
def test_empty_graph_returns_empty_table(empty: gpd.GeoDataFrame) -> None:
    segments = build_segments(empty, crs=CRS)
    assert segments.empty
    assert "segment_id" in segments.columns
