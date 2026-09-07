"""Synthetic drain-graph inference (CLAUDE.md 10.1 step 7, blueprint 7.1, task P1.8).

Mumbai has no public storm-drain GIS for the central AOI, so VARUNA generates one. This module
is the generator, and it is the module the jury asks about, so it says out loud what it is doing:

    Roads are the skeleton (drains follow roads in almost every Indian city). Inlets go in every
    40 m along the centreline and at every intersection, plus at the terrain's own pits and at
    the chronic-spot register. Trunks run along the OSM waterways - the nullahs and the Mithi.
    Edges are oriented by a shortest-path tree rooted at the outfalls with an uphill penalty, so
    water heads downhill towards the nearest sea, creek or nullah. Contributing area is
    accumulated down that tree; the rational method turns it into a design flow and Manning at
    full flow turns that into a standard pipe size. Every pipe then gets a *wide* Beta prior on
    its blockage fraction beta, because nobody knows the real state of these drains - which is
    exactly the number VARUNA-Pulse learns from each flood.

Every node and edge carries ``confidence = "inferred"``. Nothing in this file is a measurement.

Public API:

* :func:`build_drain_graph` - roads + terrain + water -> ``(nodes, edges)`` GeoDataFrames.
* :func:`export_drain_graph` - the Flash graph tables: ``nodes.parquet``, ``edges.parquet``,
  ``inlet_links.parquet``.
* :func:`inlet_links_table` - the 1D-2D coupling table on its own (CLAUDE.md 11.5).
"""

from __future__ import annotations

import itertools
import time
from pathlib import Path
from typing import Any, Final

import geopandas as gpd
import networkx as nx
import numpy as np
import pandas as pd
import structlog
from numpy.typing import NDArray
from pyproj import Transformer
from rasterio.transform import rowcol, xy
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point

from varuna_city.sizing import (
    KAPPA_PRIOR_MEAN,
    MANNING_N_CONCRETE,
    ConduitSize,
    beta_prior,
    beta_sd,
    kappa_prior,
    land_use_class,
    size_conduit,
)

log = structlog.get_logger(__name__)

WGS84: Final[str] = "EPSG:4326"

#: Nodes closer than this share an identity, so segments meeting at a junction share a manhole.
SNAP_M: Final[float] = 5.0
#: Trunk nodes along a nullah or river, every this many metres.
TRUNK_SPACING_M: Final[float] = 100.0
#: A road inlet within this distance of a trunk node discharges into it.
TRUNK_CONNECT_M: Final[float] = 60.0
#: A depression bottom or chronic spot within this distance reuses an existing inlet.
ATTACH_M: Final[float] = 80.0
#: A config tidal outfall is snapped to the network node within this distance.
TIDAL_SNAP_M: Final[float] = 400.0
#: Metres of pipe each metre of "wrong way" elevation costs in the routing tree.
UPHILL_PENALTY: Final[float] = 50.0

#: Manhole plan area, m2 (node storage in the 1D solver, CLAUDE.md 11.4).
MANHOLE_AREA_M2: Final[float] = 1.5
#: Trunk chambers are bigger.
TRUNK_CHAMBER_AREA_M2: Final[float] = 6.0

#: Invert depth below ground: 1.5 m for street drains, 3.0 m for trunks (blueprint 7.1).
INVERT_DEPTH_M: Final[float] = 1.5
TRUNK_INVERT_DEPTH_M: Final[float] = 3.0

#: Inlet geometry by type: (opening length m, clear open area m2).
INLET_GEOMETRY: Final[dict[str, tuple[float, float]]] = {
    "kerb": (1.20, 0.10),
    "grate": (0.60, 0.18),
    "combination": (1.80, 0.28),
}

#: ESA WorldCover class -> imperviousness, used when a raw class raster is handed in.
WORLDCOVER_IMPERVIOUSNESS: Final[dict[int, float]] = {
    10: 0.10,  # tree cover
    20: 0.15,  # shrubland
    30: 0.20,  # grassland
    40: 0.25,  # cropland
    50: 0.90,  # built-up
    60: 0.30,  # bare / sparse vegetation
    70: 0.10,  # snow and ice
    80: 1.00,  # permanent water
    90: 0.60,  # herbaceous wetland
    95: 0.60,  # mangroves
    100: 0.20,  # moss and lichen
}

_CONFIDENCE: Final[str] = "inferred"


# --------------------------------------------------------------------------------------------
# input normalisation
# --------------------------------------------------------------------------------------------


def _imperviousness_array(
    landcover: NDArray[Any] | None, shape: tuple[int, int]
) -> NDArray[np.float64]:
    """Accept either an imperviousness raster (0-1) or raw WorldCover class codes."""
    if landcover is None:
        return np.full(shape, 0.85, dtype=np.float64)
    arr = np.asarray(landcover)
    if arr.shape != shape:
        msg = f"landcover shape {arr.shape} does not match the DEM {shape}"
        raise ValueError(msg)
    if np.issubdtype(arr.dtype, np.floating) and float(np.nanmax(arr)) <= 1.0 + 1e-9:
        return np.nan_to_num(arr.astype(np.float64), nan=0.85)
    out = np.full(shape, 0.85, dtype=np.float64)
    for code, imperv in WORLDCOVER_IMPERVIOUSNESS.items():
        out[arr == code] = imperv
    return out


def _lines(gdf: gpd.GeoDataFrame | None, crs: str) -> gpd.GeoDataFrame:
    """Line features reprojected into the city CRS; an empty frame when there are none."""
    if gdf is None or len(gdf) == 0:
        return gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs=crs)
    out = gdf.copy()
    if out.crs is not None and str(out.crs) != str(crs):
        out = out.to_crs(crs)
    elif out.crs is None:
        out = out.set_crs(crs, allow_override=True)
    return out


def _road_class(row: Any) -> str | None:
    """The OSM highway class of a segment, whatever the upstream column is called."""
    for key in ("road_class", "highway", "class", "fclass"):
        value = row.get(key) if hasattr(row, "get") else None
        if value is None or (isinstance(value, float) and np.isnan(value)):
            continue
        if isinstance(value, list | tuple):
            value = value[0] if value else None
        if value:
            return str(value)
    return None


def _segment_id(row: Any, index: int, code: str) -> str:
    for key in ("segment_id", "id", "osmid"):
        value = row.get(key) if hasattr(row, "get") else None
        if value is None or (isinstance(value, float) and np.isnan(value)):
            continue
        return str(value)
    return f"{code}-SEG-{index:06d}"


def _sample_line(line: LineString, spacing: float) -> list[tuple[float, float]]:
    """Points along a line: both ends plus every ``spacing`` metres in between."""
    length = float(line.length)
    if length <= 0.0:
        point = line.coords[0]
        return [(float(point[0]), float(point[1]))]
    n = max(1, int(np.ceil(length / spacing)))
    step = length / n
    pts: list[tuple[float, float]] = []
    for k in range(n + 1):
        point = line.interpolate(min(length, k * step))
        pts.append((float(point.x), float(point.y)))
    return pts


def _iter_line_parts(geom: Any) -> list[LineString]:
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if geom.geom_type == "MultiLineString":
        return list(geom.geoms)
    return []


# --------------------------------------------------------------------------------------------
# node placement
# --------------------------------------------------------------------------------------------


class _NodeStore:
    """Snapped node table. Two points within ``SNAP_M`` are the same manhole."""

    def __init__(self, code: str, snap_m: float = SNAP_M) -> None:
        self.code = code
        self.snap = snap_m
        self.keys: dict[tuple[int, int], int] = {}
        self.rows: list[dict[str, Any]] = []

    def add(self, x: float, y: float, **fields: Any) -> int:
        key = (round(x / self.snap), round(y / self.snap))
        existing = self.keys.get(key)
        if existing is not None:
            row = self.rows[existing]
            for name, value in fields.items():
                if value is not None and row.get(name) in (None, "", False):
                    row[name] = value
            return existing
        index = len(self.rows)
        self.keys[key] = index
        row: dict[str, Any] = {
            "node_id": f"{self.code}-N{index:06d}",
            "x": float(x),
            "y": float(y),
            "kind": "inlet",
            "segment_id": None,
            "road_class": None,
        }
        row.update({k: v for k, v in fields.items() if v is not None})
        self.rows.append(row)
        return index

    @property
    def xy(self) -> NDArray[np.float64]:
        if not self.rows:
            return np.zeros((0, 2), dtype=np.float64)
        return np.asarray([[r["x"], r["y"]] for r in self.rows], dtype=np.float64)


def _place_nodes(
    segments: gpd.GeoDataFrame,
    waterways: gpd.GeoDataFrame,
    depressions: gpd.GeoDataFrame | None,
    hotspots: gpd.GeoDataFrame | None,
    *,
    code: str,
    spacing: float,
) -> tuple[_NodeStore, list[tuple[int, int, float]], list[list[int]]]:
    """Nodes and the undirected links between them.

    Returns the store, the link list ``(u, v, length_m)`` and the list of trunk chains.
    """
    store = _NodeStore(code)
    links: list[tuple[int, int, float]] = []

    # 1. inlets along road centrelines, and an inlet wherever segments meet
    for position, (_, row) in enumerate(segments.iterrows()):
        seg_id = _segment_id(row, position, code)
        road_class = _road_class(row)
        for part in _iter_line_parts(row.geometry):
            pts = _sample_line(part, spacing)
            previous: int | None = None
            for x, y in pts:
                idx = store.add(x, y, segment_id=seg_id, road_class=road_class)
                if previous is not None and previous != idx:
                    dx = store.rows[idx]["x"] - store.rows[previous]["x"]
                    dy = store.rows[idx]["y"] - store.rows[previous]["y"]
                    links.append((previous, idx, float(np.hypot(dx, dy))))
                previous = idx

    # 2. trunk chains along the nullahs, canals and the river
    trunk_chains: list[list[int]] = []
    for _, row in waterways.iterrows():
        for part in _iter_line_parts(row.geometry):
            if part.length < TRUNK_SPACING_M:
                continue
            chain: list[int] = []
            for x, y in _sample_line(part, TRUNK_SPACING_M):
                idx = store.add(x, y, kind="trunk")
                store.rows[idx]["kind"] = "trunk"
                if not chain or chain[-1] != idx:
                    chain.append(idx)
            for a, b in itertools.pairwise(chain):
                dx = store.rows[b]["x"] - store.rows[a]["x"]
                dy = store.rows[b]["y"] - store.rows[a]["y"]
                links.append((a, b, float(np.hypot(dx, dy))))
            if len(chain) >= 2:
                trunk_chains.append(chain)

    # 3. depression bottoms and the chronic-spot register
    for gdf, kind in ((depressions, "depression"), (hotspots, "hotspot")):
        if gdf is None or len(gdf) == 0:
            continue
        road_xy = store.xy
        tree = cKDTree(road_xy) if len(road_xy) else None
        for _, row in gdf.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            point = geom if geom.geom_type == "Point" else geom.centroid
            x, y = float(point.x), float(point.y)
            if tree is not None:
                distance, near = tree.query([x, y])
                if float(distance) <= ATTACH_M:
                    store.rows[int(near)]["kind"] = kind
                    continue
            idx = store.add(x, y, kind=kind)
            if tree is not None and len(road_xy):
                _, near = tree.query([x, y])
                near = int(near)
                if near != idx:
                    dx = store.rows[idx]["x"] - store.rows[near]["x"]
                    dy = store.rows[idx]["y"] - store.rows[near]["y"]
                    links.append((near, idx, float(np.hypot(dx, dy))))

    return store, links, trunk_chains


def _connect_roads_to_trunks(
    store: _NodeStore, trunk_chains: list[list[int]], links: list[tuple[int, int, float]]
) -> None:
    """Every road inlet near a nullah discharges into it (blueprint 7.1: outfalls and trunks)."""
    trunk_ids = sorted({i for chain in trunk_chains for i in chain})
    if not trunk_ids:
        return
    trunk_xy = np.asarray([[store.rows[i]["x"], store.rows[i]["y"]] for i in trunk_ids])
    tree = cKDTree(trunk_xy)
    for idx, row in enumerate(store.rows):
        if row["kind"] == "trunk":
            continue
        distance, near = tree.query([row["x"], row["y"]])
        if float(distance) <= TRUNK_CONNECT_M:
            links.append((idx, trunk_ids[int(near)], float(distance) or SNAP_M))


# --------------------------------------------------------------------------------------------
# terrain sampling
# --------------------------------------------------------------------------------------------


def _sample_dem(
    dem: NDArray[Any], transform: Any, xs: NDArray[np.float64], ys: NDArray[np.float64]
) -> tuple[NDArray[np.float64], NDArray[np.int64], NDArray[np.int64]]:
    """Ground elevation at each node plus the grid cell it couples to."""
    height, width = dem.shape
    rows, cols = rowcol(transform, xs, ys)
    rows = np.clip(np.asarray(rows, dtype=np.int64), 0, height - 1)
    cols = np.clip(np.asarray(cols, dtype=np.int64), 0, width - 1)
    z = np.asarray(dem, dtype=np.float64)[rows, cols]
    if not np.all(np.isfinite(z)):
        finite = np.isfinite(z)
        fill = float(np.nanmedian(np.asarray(dem, dtype=np.float64))) if finite.any() else 0.0
        z = np.where(finite, z, fill)
    return z, rows, cols


# --------------------------------------------------------------------------------------------
# outfalls and routing
# --------------------------------------------------------------------------------------------


def _mark_outfalls(
    store: _NodeStore,
    trunk_chains: list[list[int]],
    z: NDArray[np.float64],
    config: Any,
) -> list[int]:
    """Outfalls: the downstream end of each trunk, plus the config's tidal boundary points."""
    outfalls: list[int] = []
    for chain in trunk_chains:
        end = chain[-1] if z[chain[-1]] <= z[chain[0]] else chain[0]
        row = store.rows[end]
        row["kind"] = "outfall"
        row["boundary_type"] = "river"
        row["flap_gate"] = False
        row["tidal"] = False
        outfalls.append(end)

    tidal = list(getattr(config, "tidal_outfalls", []) or [])
    if tidal:
        node_xy = store.xy
        tree = cKDTree(node_xy)
        transformer = Transformer.from_crs(WGS84, config.crs_string, always_xy=True)
        for spec in tidal:
            x, y = transformer.transform(float(spec.lon), float(spec.lat))
            distance, near = tree.query([x, y])
            if float(distance) > TIDAL_SNAP_M:
                log.warning(
                    "drains.tidal_outfall_far",
                    outfall=getattr(spec, "id", "?"),
                    distance_m=round(float(distance), 1),
                )
            near = int(near)
            row = store.rows[near]
            row["kind"] = "outfall"
            row["boundary_type"] = "tide"
            row["flap_gate"] = bool(getattr(spec, "flap_gate", False))
            row["tidal"] = True
            row["outfall_id"] = getattr(spec, "id", None)
            if near not in outfalls:
                outfalls.append(near)

    if not outfalls:
        # No water features and no configured boundary: the lowest node becomes a free outfall.
        near = int(np.argmin(z))
        row = store.rows[near]
        row["kind"] = "outfall"
        row["boundary_type"] = "free"
        row["flap_gate"] = False
        row["tidal"] = False
        outfalls.append(near)
    return sorted(set(outfalls))


_SUPER_SOURCE: Final[str] = "__sea__"


def _route_tree(
    graph: nx.Graph, outfalls: list[int], z: NDArray[np.float64]
) -> tuple[dict[int, int], dict[int, float]]:
    """Shortest-path tree rooted at the outfalls with an uphill penalty.

    The search runs outward from a virtual sea node, so every step goes *upstream*; a step that
    would head downhill while going upstream is penalised by :data:`UPHILL_PENALTY` metres of
    pipe per metre of elevation. The predecessor of a node is therefore its downstream node.
    """
    work = graph.copy()
    work.add_node(_SUPER_SOURCE)
    for node in outfalls:
        work.add_edge(_SUPER_SOURCE, node, length=0.0)

    def weight(u: Any, v: Any, data: dict[str, Any]) -> float:
        base = float(data.get("length", 0.0))
        if u == _SUPER_SOURCE or v == _SUPER_SOURCE:
            return 0.0
        drop = max(0.0, float(z[u]) - float(z[v]))
        return base + UPHILL_PENALTY * drop

    preds, dist = nx.dijkstra_predecessor_and_distance(work, _SUPER_SOURCE, weight=weight)
    downstream: dict[int, int] = {}
    distance: dict[int, float] = {}
    for node, parents in preds.items():
        if node == _SUPER_SOURCE:
            continue
        distance[int(node)] = float(dist[node])
        if parents and parents[0] != _SUPER_SOURCE:
            downstream[int(node)] = int(parents[0])
    return downstream, distance


def _repair_orphans(
    store: _NodeStore,
    graph: nx.Graph,
    routed: set[int],
) -> list[tuple[int, int, float]]:
    """Connect every unrouted node to its nearest routed neighbour (CLAUDE.md P1.8 repair rule).

    A synthetic graph built from OSM always has stranded fragments - a service lane that never
    touches the rest of the drivable network, a pier, a gated campus road. Rather than dropping
    them (which would silently shrink the city), each is wired to the nearest node that already
    reaches an outfall, and the edge is flagged ``repaired`` so the count appears in REPORT.md.
    """
    orphans = [i for i in range(len(store.rows)) if i not in routed]
    if not orphans or not routed:
        return []
    routed_ids = sorted(routed)
    routed_xy = np.asarray([[store.rows[i]["x"], store.rows[i]["y"]] for i in routed_ids])
    tree = cKDTree(routed_xy)
    orphan_xy = np.asarray([[store.rows[i]["x"], store.rows[i]["y"]] for i in orphans])
    distances, nearest = tree.query(orphan_xy)
    added: list[tuple[int, int, float]] = []
    for orphan, distance, near in zip(orphans, distances, nearest, strict=True):
        target = routed_ids[int(near)]
        length = max(float(distance), SNAP_M)
        graph.add_edge(orphan, target, length=length, repaired=True)
        added.append((orphan, target, length))
    return added


# --------------------------------------------------------------------------------------------
# hydrology: contributing area accumulated down the tree
# --------------------------------------------------------------------------------------------


def _local_catchments(
    store: _NodeStore,
    dem: NDArray[Any],
    transform: Any,
    imperviousness: NDArray[np.float64],
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Assign every DEM cell to its nearest node (a Voronoi split of the AOI).

    Returns local area (m2) and area-mean imperviousness per node. This is the ``A`` of the
    rational method before it is accumulated down the tree.
    """
    height, width = dem.shape
    cell_area = abs(transform.a) * abs(transform.e)
    rows, cols = np.meshgrid(np.arange(height), np.arange(width), indexing="ij")
    xs, ys = xy(transform, rows.ravel(), cols.ravel(), offset="center")
    cells = np.column_stack([np.asarray(xs), np.asarray(ys)])
    tree = cKDTree(store.xy)
    _, owner = tree.query(cells)
    n = len(store.rows)
    counts = np.bincount(owner, minlength=n).astype(np.float64)
    imperv_sum = np.bincount(owner, weights=imperviousness.ravel(), minlength=n)
    local_area = counts * cell_area
    mean_imperv = np.where(counts > 0, imperv_sum / np.maximum(counts, 1.0), 0.85)
    return local_area, mean_imperv


def _accumulate(
    downstream: dict[int, int],
    order: list[int],
    local_area: NDArray[np.float64],
    mean_imperv: NDArray[np.float64],
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Accumulate area and area-weighted imperviousness from the leaves down to the outfalls."""
    area = np.array(local_area, dtype=np.float64, copy=True)
    weighted = area * mean_imperv
    for node in order:  # farthest from the sea first, so children settle before parents
        parent = downstream.get(node)
        if parent is None:
            continue
        area[parent] += area[node]
        weighted[parent] += weighted[node]
    imperv = np.where(area > 0, weighted / np.maximum(area, 1e-9), mean_imperv)
    return area, np.clip(imperv, 0.0, 1.0)


# --------------------------------------------------------------------------------------------
# the build
# --------------------------------------------------------------------------------------------


def _inlet_type(road_class: str | None, kind: str, rng: np.random.Generator) -> str:
    """Kerb, grate or combination inlet. Arterials get combination inlets; lanes get kerbs."""
    if kind in {"depression", "hotspot"}:
        return "combination"
    cls = (road_class or "").lower()
    if cls in {"motorway", "trunk", "primary", "secondary", "motorway_link", "trunk_link"}:
        return "combination"
    if cls in {"tertiary", "residential", "unclassified", "living_street"}:
        return "grate" if rng.random() < 0.5 else "kerb"
    return "kerb"


def build_drain_graph(
    segments: gpd.GeoDataFrame,
    conditioned_dem: NDArray[Any],
    transform: Any,
    waterways: gpd.GeoDataFrame | None,
    depressions: gpd.GeoDataFrame | None,
    hotspots: gpd.GeoDataFrame | None,
    landcover: NDArray[Any] | None,
    *,
    config: Any,
    seed: int,
) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    """Infer a directed, sized drain network from roads, terrain and water.

    Args:
        segments: road segments (LineStrings), ideally already split at intersections.
        conditioned_dem: the hydro-conditioned DEM on the city grid, metres.
        transform: the ``rasterio`` affine of that DEM.
        waterways: OSM ``waterway=drain|canal|stream|river`` lines; trunks run along these.
        depressions: pit bottoms from :mod:`varuna_city.depressions` (Points).
        hotspots: the chronic-spot register (Points).
        landcover: imperviousness raster (0-1) or raw WorldCover class codes, DEM-shaped.
        config: the :class:`CityConfig` for this city.
        seed: every random draw comes from ``default_rng(seed)``; two runs agree byte for byte.

    Returns:
        ``(nodes, edges)`` GeoDataFrames in the city CRS. Every row carries
        ``confidence = "inferred"``; every node reaches an outfall.
    """
    t0 = time.perf_counter()
    rng = np.random.default_rng(seed)
    crs = config.crs_string
    code = config.code
    dem = np.asarray(conditioned_dem, dtype=np.float64)
    imperviousness = _imperviousness_array(landcover, dem.shape)

    segments = _lines(segments, crs)
    if len(segments) == 0:
        msg = "build_drain_graph needs at least one road segment"
        raise ValueError(msg)
    water = _lines(waterways, crs)
    depressions = _points(depressions, crs)
    hotspots = _points(hotspots, crs)

    spacing = float(getattr(config, "inlet_spacing_m", 40.0))
    min_slope = float(getattr(config, "min_drain_slope", 0.003))

    store, links, trunk_chains = _place_nodes(
        segments, water, depressions, hotspots, code=code, spacing=spacing
    )
    _connect_roads_to_trunks(store, trunk_chains, links)

    node_xy = store.xy
    z_ground, cell_rows, cell_cols = _sample_dem(dem, transform, node_xy[:, 0], node_xy[:, 1])

    graph = nx.Graph()
    graph.add_nodes_from(range(len(store.rows)))
    for u, v, length in links:
        if u == v:
            continue
        existing = graph.get_edge_data(u, v)
        if existing is None or length < existing["length"]:
            graph.add_edge(u, v, length=max(length, SNAP_M), repaired=False)

    outfalls = _mark_outfalls(store, trunk_chains, z_ground, config)
    downstream, distance = _route_tree(graph, outfalls, z_ground)
    routed = set(distance) | set(outfalls)
    repaired = _repair_orphans(store, graph, routed)
    if repaired:
        downstream, distance = _route_tree(graph, outfalls, z_ground)
        log.info("drains.orphans_repaired", count=len(repaired))

    unrouted = [i for i in range(len(store.rows)) if i not in distance]
    if unrouted:
        msg = f"{len(unrouted)} drain nodes still do not reach an outfall after repair"
        raise AssertionError(msg)

    # farthest from the sea first: children accumulate into their parent before the parent moves
    order = sorted(range(len(store.rows)), key=lambda i: (-distance[i], i))
    local_area, mean_imperv = _local_catchments(store, dem, transform, imperviousness)
    area_acc, imperv_acc = _accumulate(downstream, order, local_area, mean_imperv)

    # inverts: 1.5 m (3 m on trunks) below ground, deepened where the minimum slope demands it
    deep = np.asarray([r["kind"] in {"trunk", "outfall"} for r in store.rows], dtype=bool)
    depth = np.where(deep, TRUNK_INVERT_DEPTH_M, INVERT_DEPTH_M)
    z_invert = z_ground - depth
    for node in sorted(range(len(store.rows)), key=lambda i: (distance[i], i)):
        parent = downstream.get(node)
        if parent is None:
            continue
        length = float(graph.edges[node, parent]["length"])
        z_invert[node] = max(z_invert[node], z_invert[parent] + min_slope * length)

    intensity = config.design_intensity_mm_h
    legacy = float(getattr(intensity, "legacy", 25.0))
    upgraded = float(getattr(intensity, "upgraded", 50.0))

    node_rows: list[dict[str, Any]] = []
    for i, row in enumerate(store.rows):
        kind = row["kind"]
        is_trunk = kind in {"trunk", "outfall"}
        inlet_type = _inlet_type(row.get("road_class"), kind, rng)
        inlet_length, inlet_area = INLET_GEOMETRY[inlet_type]
        k_a, k_b = kappa_prior()
        seg_id = row.get("segment_id")
        node_rows.append(
            {
                "node_id": row["node_id"],
                "kind": kind,
                "is_outfall": kind == "outfall",
                "boundary_type": row.get("boundary_type"),
                "flap_gate": bool(row.get("flap_gate", False)),
                "tidal": bool(row.get("tidal", False)),
                "outfall_id": row.get("outfall_id"),
                "z_ground_m": round(float(z_ground[i]), 3),
                "z_invert_m": round(float(z_invert[i]), 3),
                "invert_depth_m": round(float(z_ground[i] - z_invert[i]), 3),
                "storage_area_m2": TRUNK_CHAMBER_AREA_M2 if is_trunk else MANHOLE_AREA_M2,
                "inlet_type": inlet_type,
                "inlet_length_m": inlet_length,
                "inlet_area_m2": inlet_area,
                "kappa_mean": KAPPA_PRIOR_MEAN,
                "kappa_a": k_a,
                "kappa_b": k_b,
                "kappa_sd": round(beta_sd(k_a, k_b), 4),
                "segment_id": seg_id,
                "surface_unit_id": f"{code}-SU-{seg_id}" if seg_id else None,
                "road_class": row.get("road_class"),
                "cell_row": int(cell_rows[i]),
                "cell_col": int(cell_cols[i]),
                "local_area_m2": round(float(local_area[i]), 2),
                "contributing_area_m2": round(float(area_acc[i]), 2),
                "imperviousness": round(float(imperv_acc[i]), 4),
                "downstream_node": (
                    store.rows[downstream[i]]["node_id"] if i in downstream else None
                ),
                "confidence": _CONFIDENCE,
                "geometry": Point(row["x"], row["y"]),
            }
        )

    edge_rows: list[dict[str, Any]] = []
    for i, parent in sorted(downstream.items()):
        data = graph.edges[i, parent]
        length = float(data["length"])
        slope = max(min_slope, round((z_invert[i] - z_invert[parent]) / length, 6))
        up, dn = store.rows[i], store.rows[parent]
        is_trunk = up["kind"] == "trunk" and dn["kind"] in {"trunk", "outfall"}
        road_class = up.get("road_class")
        land_use = land_use_class(road_class, imperviousness=float(imperv_acc[i]))
        design_i = upgraded if (is_trunk or land_use == "arterial") else legacy
        size: ConduitSize = size_conduit(
            area_m2=float(area_acc[i]),
            imperviousness=float(imperv_acc[i]),
            intensity_mm_h=design_i,
            slope=slope,
            is_trunk=is_trunk,
            n=MANNING_N_CONCRETE,
        )
        b_a, b_b = beta_prior("arterial" if is_trunk else land_use)
        edge_rows.append(
            {
                "edge_id": f"{code}-E{len(edge_rows):06d}",
                "from_node": up["node_id"],
                "to_node": dn["node_id"],
                "length_m": round(length, 3),
                "slope": slope,
                "z_invert_up_m": round(float(z_invert[i]), 3),
                "z_invert_dn_m": round(float(z_invert[parent]), 3),
                **size.as_dict(),
                "is_trunk": is_trunk,
                "land_use": "arterial" if is_trunk else land_use,
                "road_class": road_class,
                "design_intensity_mm_h": design_i,
                "contributing_area_m2": round(float(area_acc[i]), 2),
                "imperviousness": round(float(imperv_acc[i]), 4),
                "beta_a": b_a,
                "beta_b": b_b,
                "beta_mean": round(b_a / (b_a + b_b), 4),
                "beta_sd": round(beta_sd(b_a, b_b), 4),
                "last_desilted": None,
                "repaired": bool(data.get("repaired", False)),
                "confidence": _CONFIDENCE,
                "geometry": LineString([(up["x"], up["y"]), (dn["x"], dn["y"])]),
            }
        )

    nodes = gpd.GeoDataFrame(node_rows, geometry="geometry", crs=crs)
    edges = gpd.GeoDataFrame(edge_rows, geometry="geometry", crs=crs)
    stage_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    log.info(
        "drains.built",
        city=config.id,
        nodes=len(nodes),
        edges=len(edges),
        outfalls=int(nodes["is_outfall"].sum()),
        trunk_edges=int(edges["is_trunk"].sum()),
        repaired_edges=int(edges["repaired"].sum()),
        pipe_length_km=round(float(edges["length_m"].sum()) / 1000.0, 2),
        seed=seed,
        stage_ms=stage_ms,
    )
    nodes.attrs["stage_ms"] = stage_ms
    edges.attrs["stage_ms"] = stage_ms
    return nodes, edges


def _points(gdf: gpd.GeoDataFrame | None, crs: str) -> gpd.GeoDataFrame | None:
    if gdf is None or len(gdf) == 0:
        return None
    out = gdf.copy()
    if out.crs is not None and str(out.crs) != str(crs):
        out = out.to_crs(crs)
    elif out.crs is None:
        out = out.set_crs(crs, allow_override=True)
    return out


# --------------------------------------------------------------------------------------------
# validation and export
# --------------------------------------------------------------------------------------------


def check_connectivity(nodes: gpd.GeoDataFrame, edges: gpd.GeoDataFrame) -> dict[str, Any]:
    """Walk every node downstream and prove it reaches an outfall. Raises if one does not."""
    downstream = dict(zip(nodes["node_id"], nodes["downstream_node"], strict=True))
    outfalls = set(nodes.loc[nodes["is_outfall"], "node_id"])
    reaches: dict[str, bool] = {}
    max_hops = 0
    for start in nodes["node_id"]:
        path: list[str] = []
        node: str | None = start
        seen: set[str] = set()
        while node is not None and node not in reaches:
            if node in seen:
                msg = f"cycle in the drain tree at {node}"
                raise AssertionError(msg)
            seen.add(node)
            path.append(node)
            if node in outfalls:
                break
            node = downstream.get(node)
        ok = (node in outfalls) if node is not None else False
        if node is not None and node in reaches:
            ok = reaches[node]
        for name in path:
            reaches[name] = ok
        max_hops = max(max_hops, len(path))
    bad = [name for name, ok in reaches.items() if not ok]
    if bad:
        msg = f"{len(bad)} drain nodes do not reach an outfall (first: {bad[0]})"
        raise AssertionError(msg)
    return {
        "nodes": len(nodes),
        "edges": len(edges),
        "outfalls": len(outfalls),
        "connectivity": 1.0,
        "max_hops_to_outfall": int(max_hops),
        "pipe_length_km": round(float(edges["length_m"].sum()) / 1000.0, 3),
    }


def inlet_links_table(nodes: gpd.GeoDataFrame) -> pd.DataFrame:
    """The 1D-2D coupling table (CLAUDE.md 11.5): which grid cell feeds which manhole."""
    inlets = nodes[nodes["kind"] != "trunk"]
    return pd.DataFrame(
        {
            "node_id": inlets["node_id"].to_numpy(),
            "segment_id": inlets["segment_id"].to_numpy(),
            "surface_unit_id": inlets["surface_unit_id"].to_numpy(),
            "cell_row": inlets["cell_row"].to_numpy(),
            "cell_col": inlets["cell_col"].to_numpy(),
            "x": inlets.geometry.x.to_numpy(),
            "y": inlets.geometry.y.to_numpy(),
            "z_ground_m": inlets["z_ground_m"].to_numpy(),
            "inlet_type": inlets["inlet_type"].to_numpy(),
            "inlet_length_m": inlets["inlet_length_m"].to_numpy(),
            "inlet_area_m2": inlets["inlet_area_m2"].to_numpy(),
            "kappa_mean": inlets["kappa_mean"].to_numpy(),
            "kappa_a": inlets["kappa_a"].to_numpy(),
            "kappa_b": inlets["kappa_b"].to_numpy(),
            "contributing_area_m2": inlets["contributing_area_m2"].to_numpy(),
            "confidence": inlets["confidence"].to_numpy(),
        }
    ).reset_index(drop=True)


def export_drain_graph(
    nodes: gpd.GeoDataFrame, edges: gpd.GeoDataFrame, out_dir: Path
) -> dict[str, Path]:
    """Write the Flash graph tables (CLAUDE.md 10.1 step 11) into ``out_dir/drains/``."""
    target = Path(out_dir) / "drains"
    target.mkdir(parents=True, exist_ok=True)
    paths = {
        "nodes": target / "nodes.parquet",
        "edges": target / "edges.parquet",
        "inlet_links": target / "inlet_links.parquet",
    }
    nodes.to_parquet(paths["nodes"], index=False)
    edges.to_parquet(paths["edges"], index=False)
    inlet_links_table(nodes).to_parquet(paths["inlet_links"], index=False)
    log.info(
        "drains.exported",
        out_dir=str(target),
        nodes=len(nodes),
        edges=len(edges),
    )
    return paths


__all__ = [
    "INLET_GEOMETRY",
    "INVERT_DEPTH_M",
    "MANHOLE_AREA_M2",
    "SNAP_M",
    "TRUNK_INVERT_DEPTH_M",
    "UPHILL_PENALTY",
    "build_drain_graph",
    "check_connectivity",
    "export_drain_graph",
    "inlet_links_table",
]
