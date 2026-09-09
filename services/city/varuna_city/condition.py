"""Hydro-conditioning of the city DEM (CLAUDE.md 10.1 step 4, task P1.5).

A raw 30 m Copernicus DEM does not know that a building blocks water, that a road is a
shallow channel, that a rail embankment has a culvert under it, or that an underpass is a
real sink rather than a data artefact. :func:`condition_dem` applies, in this order:

1. **Burn buildings** ``+5 m`` - footprints become walls the 2D solver cannot cross.
2. **Carve road centrelines** ``-0.15 m`` - one cell wide, so streets route water.
3. **Keep true sinks** - underpasses, subways and the chronic-spot register are passed in
   as points; the depressions holding them are protected from step 5 and stay pits.
4. **Breach culverts and bridges** - each way is lowered to the minimum of its two end
   cells, so an embankment carrying a road over a nullah does not dam the flow.
5. **Breach spurious pits** smaller than ``min_area_m2`` - WhiteboxTools
   ``BreachDepressionsLeastCost`` when its binary is on disk, otherwise a deterministic
   pure-Python least-cost breach that carves a descending channel from each small pit to
   the first lower cell outside it.

The function is pure: it copies its input, writes nothing, and returns the conditioned DEM
together with a ``changes`` dict that ``city/<city>/REPORT.md`` (P1.10) prints.
"""

from __future__ import annotations

import heapq
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import structlog
from numpy.typing import NDArray
from rasterio.features import rasterize
from rasterio.transform import Affine, rowcol

from varuna_city.depressions import label_pits

log = structlog.get_logger(__name__)

BUILDING_BURN_M = 5.0
"""Metres added to every building footprint cell (CLAUDE.md 10.1 step 4)."""

ROAD_CARVE_M = 0.15
"""Metres removed along every road centreline, one cell wide."""

MIN_PIT_AREA_M2 = 900.0
"""Pits smaller than this are DEM artefacts and get breached; bigger ones are kept."""

_BREACH_STEP_M = 1e-3
"""Downhill step per cell along a breached channel - enough to beat the fill tolerance."""

_MAX_SEARCH_CELLS = 20_000
"""Guard on the per-pit least-cost search so one pathological pit cannot stall a run."""

_NEIGHBOURS_8: tuple[tuple[int, int], ...] = (
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, -1),
    (0, 1),
    (1, -1),
    (1, 0),
    (1, 1),
)


@dataclass(frozen=True, slots=True)
class ConditionedDem:
    """What :func:`condition_dem` produced."""

    dem: NDArray[np.float64]
    """The conditioned elevations, same shape as the input, no-data still NaN."""
    buildings_mask: NDArray[np.bool_]
    roads_mask: NDArray[np.bool_]
    sink_mask: NDArray[np.bool_]
    changes: dict[str, Any] = field(default_factory=dict)
    stage_ms: float = 0.0


# --------------------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------------------


def _geometries(source: Any, crs: Any) -> list[Any]:
    """Shapely geometries from a GeoDataFrame, GeoSeries, iterable or ``None``.

    A GeoDataFrame/GeoSeries carrying a CRS different from ``crs`` is reprojected first, so
    callers may hand over layers straight from :mod:`varuna_city.osm`.
    """
    if source is None:
        return []
    geometry = getattr(source, "geometry", None)
    if geometry is not None:
        if len(source) == 0:
            return []
        src_crs = getattr(source, "crs", None)
        if src_crs is not None and crs is not None and str(src_crs) != str(crs):
            source = source.to_crs(crs)
            geometry = source.geometry
        return [g for g in geometry if g is not None and not g.is_empty]
    return [g for g in source if g is not None and not getattr(g, "is_empty", False)]


def rasterize_mask(
    geometries: Any,
    transform: Affine,
    shape: tuple[int, int],
    *,
    crs: Any = None,
    all_touched: bool = False,
) -> NDArray[np.bool_]:
    """Boolean mask of the cells covered by ``geometries``.

    ``all_touched=False`` keeps a line one cell wide, which is what the road carving and the
    culvert breaching want.
    """
    geoms = _geometries(geometries, crs)
    if not geoms:
        return np.zeros(shape, dtype=bool)
    burned = rasterize(
        ((g, 1) for g in geoms),
        out_shape=shape,
        transform=transform,
        fill=0,
        all_touched=all_touched,
        dtype="uint8",
    )
    return burned.astype(bool)


def _point_cells(
    points: Any,
    transform: Affine,
    shape: tuple[int, int],
    *,
    crs: Any = None,
) -> list[tuple[int, int]]:
    """``(row, col)`` of every point that falls inside the grid."""
    cells: list[tuple[int, int]] = []
    height, width = shape
    for geom in _geometries(points, crs):
        rep = geom if geom.geom_type == "Point" else geom.representative_point()
        row, col = rowcol(transform, rep.x, rep.y)
        row, col = int(row), int(col)
        if 0 <= row < height and 0 <= col < width:
            cells.append((row, col))
    return cells


# --------------------------------------------------------------------------------------
# the individual conditioning steps
# --------------------------------------------------------------------------------------


def burn_buildings(
    dem: NDArray[np.float64],
    mask: NDArray[np.bool_],
    *,
    height_m: float = BUILDING_BURN_M,
) -> NDArray[np.float64]:
    """Raise building cells by ``height_m`` (in place on a copy of ``dem``)."""
    out = np.array(dem, dtype=np.float64, copy=True)
    out[mask] += height_m
    return out


def carve_roads(
    dem: NDArray[np.float64],
    mask: NDArray[np.bool_],
    *,
    depth_m: float = ROAD_CARVE_M,
) -> NDArray[np.float64]:
    """Lower road-centreline cells by ``depth_m``."""
    out = np.array(dem, dtype=np.float64, copy=True)
    out[mask] -= depth_m
    return out


def breach_culverts(
    dem: NDArray[np.float64],
    transform: Affine,
    ways: Any,
    *,
    crs: Any = None,
) -> tuple[NDArray[np.float64], dict[str, int]]:
    """Lower each culvert/bridge way to the minimum elevation of its two end cells.

    An OSM ``tunnel=culvert`` or ``bridge=yes`` way crosses an embankment that the DEM sees
    as a solid dam. Carving the way down to its lower end lets the flow through without
    inventing a channel anywhere else.
    """
    out = np.array(dem, dtype=np.float64, copy=True)
    height, width = out.shape
    geoms = _geometries(ways, crs)
    breached_ways = 0
    breached_cells = 0

    for geom in geoms:
        parts = list(geom.geoms) if geom.geom_type.startswith("Multi") else [geom]
        for part in parts:
            coords = list(getattr(part, "coords", []))
            if len(coords) < 2:
                continue
            ends: list[float] = []
            for x, y in (coords[0], coords[-1]):
                row, col = rowcol(transform, x, y)
                row, col = int(row), int(col)
                if 0 <= row < height and 0 <= col < width and np.isfinite(out[row, col]):
                    ends.append(float(out[row, col]))
            if not ends:
                continue
            target = min(ends)
            line_mask = rasterize_mask([part], transform, out.shape, crs=None, all_touched=False)
            if not line_mask.any():
                continue
            affected = line_mask & np.isfinite(out) & (out > target)
            breached_cells += int(affected.sum())
            out[affected] = target
            breached_ways += 1

    return out, {"culvert_ways_breached": breached_ways, "culvert_cells_breached": breached_cells}


# --------------------------------------------------------------------------------------
# spurious-pit breaching
# --------------------------------------------------------------------------------------


def _whitebox_exe() -> Path | None:
    """Path to the WhiteboxTools binary if it is already on disk, else ``None``.

    We never let the ``whitebox`` package download it: the demo laptop runs offline and TLS
    is intercepted here (ADR-0006).
    """
    try:
        import whitebox
    except Exception:  # pragma: no cover - whitebox is installed in this workspace
        return None
    base = Path(whitebox.__file__).parent / "WBT"
    for name in ("whitebox_tools.exe", "whitebox_tools"):
        exe = base / name
        if exe.is_file():
            return exe
    return None


def _breach_whitebox(dem: NDArray[np.float64], transform: Affine) -> NDArray[np.float64] | None:
    """Run ``BreachDepressionsLeastCost`` on a temporary GeoTIFF; ``None`` if unavailable."""
    if _whitebox_exe() is None:
        log.info("condition.whitebox_unavailable", reason="binary not downloaded")
        return None
    try:
        import rasterio
        from whitebox import WhiteboxTools

        with tempfile.TemporaryDirectory(prefix="varuna-wbt-") as tmp:
            tmp_dir = Path(tmp)
            src = tmp_dir / "dem.tif"
            dst = tmp_dir / "breached.tif"
            nodata = -9999.0
            data = np.where(np.isfinite(dem), dem, nodata).astype("float32")
            profile = {
                "driver": "GTiff",
                "height": dem.shape[0],
                "width": dem.shape[1],
                "count": 1,
                "dtype": "float32",
                "transform": transform,
                "nodata": nodata,
            }
            with rasterio.open(src, "w", **profile) as handle:
                handle.write(data, 1)
            wbt = WhiteboxTools()
            wbt.verbose = False
            wbt.set_working_dir(str(tmp_dir))
            wbt.breach_depressions_least_cost(str(src), str(dst), dist=100, fill=True)
            with rasterio.open(dst) as handle:
                out = handle.read(1).astype(np.float64)
        return np.where(np.isfinite(dem), np.fmin(out, dem), np.nan)
    except Exception as exc:  # pragma: no cover - only when WBT misbehaves on the laptop
        log.warning("condition.whitebox_failed", error=str(exc))
        return None


def _breach_pit_python(
    dem: NDArray[np.float64],
    pit_cells: set[tuple[int, int]],
    bottom: tuple[int, int],
    neighbours: tuple[tuple[int, int], ...],
) -> int:
    """Carve a least-cost channel from one pit to the first lower cell outside it.

    Dijkstra with "cost = highest ground crossed so far": the cheapest path is the lowest
    saddle out of the pit, which is exactly what a least-cost breach digs through. Returns
    the number of cells lowered (0 when no outlet was found).
    """
    height, width = dem.shape
    z_bottom = float(dem[bottom])
    best: dict[tuple[int, int], float] = {bottom: 0.0}
    parent: dict[tuple[int, int], tuple[int, int]] = {}
    heap: list[tuple[float, int, tuple[int, int]]] = [(0.0, 0, bottom)]
    counter = 1
    visited = 0
    outlet: tuple[int, int] | None = None

    while heap:
        cost, _, cell = heapq.heappop(heap)
        if cost > best.get(cell, np.inf):
            continue
        visited += 1
        if visited > _MAX_SEARCH_CELLS:
            break
        if cell not in pit_cells and dem[cell] < z_bottom - _BREACH_STEP_M:
            outlet = cell
            break
        row, col = cell
        for d_row, d_col in neighbours:
            nb = (row + d_row, col + d_col)
            if not (0 <= nb[0] < height and 0 <= nb[1] < width):
                continue
            z_nb = dem[nb]
            if not np.isfinite(z_nb):
                continue
            nb_cost = max(cost, float(z_nb) - z_bottom)
            if nb_cost < best.get(nb, np.inf):
                best[nb] = nb_cost
                parent[nb] = cell
                heapq.heappush(heap, (nb_cost, counter, nb))
                counter += 1

    if outlet is None:
        return 0

    path: list[tuple[int, int]] = []
    node = outlet
    while node != bottom:
        path.append(node)
        node = parent[node]
    path.reverse()

    lowered = 0
    for step, cell in enumerate(path, start=1):
        target = z_bottom - step * _BREACH_STEP_M
        if dem[cell] > target:
            dem[cell] = target
            lowered += 1
    return lowered


def breach_spurious_pits(
    dem: NDArray[np.float64],
    transform: Affine,
    *,
    min_area_m2: float = MIN_PIT_AREA_M2,
    protect: NDArray[np.bool_] | None = None,
    use_whitebox: bool = True,
    seed: int = 0,
    use_pyflwdir: bool = True,
) -> tuple[NDArray[np.float64], dict[str, Any]]:
    """Breach every depression no larger than ``min_area_m2`` that holds no protected cell.

    Larger depressions and anything under ``protect`` (underpasses, subways, the chronic-spot
    register) are left exactly as they are - they are the flooding we are trying to predict.

    The comparison is deliberately inclusive at the threshold: at 30 m a single cell is exactly
    ``MIN_PIT_AREA_M2``, and a one-cell pit is a DEM artefact rather than a place that floods.
    ``protect`` is what keeps the real one-cell sinks - Andheri and Milan subways among them.
    """
    out = np.array(dem, dtype=np.float64, copy=True)
    cell_area = abs(transform.a) * abs(transform.e)
    labels, _ = label_pits(out, use_pyflwdir=use_pyflwdir)
    n_labels = int(labels.max())
    stats: dict[str, Any] = {
        "pits_before": 0,
        "pits_spurious": 0,
        "pits_protected": 0,
        "pits_breached": 0,
        "breach_cells": 0,
        "breach_method": "none",
        "seed": seed,
    }
    if n_labels == 0:
        return out, stats

    protect_mask = (
        np.zeros(out.shape, dtype=bool) if protect is None else np.asarray(protect, dtype=bool)
    )
    spurious: list[int] = []
    protected_labels: list[int] = []
    kept_large = 0
    kept_protected = 0
    for lab in range(1, n_labels + 1):
        cells = labels == lab
        area = float(cells.sum()) * cell_area
        # `>` and not `>=`. On a 30 m grid one cell is exactly 900 m², so `>=` kept every
        # single-cell pit - the most obviously spurious kind there is, and 47 % of all the
        # depressions in Mumbai. Each one then filled to 60 cm and over in a 3-hour run,
        # putting deep water on hillsides while the real, larger sinks drained through their
        # inlets. The threshold means "a pit no bigger than one cell is a DEM artefact".
        if area > min_area_m2:
            protected_labels.append(lab)
            kept_large += 1
            continue
        if bool((cells & protect_mask).any()):
            protected_labels.append(lab)
            kept_protected += 1
            continue
        spurious.append(lab)
    stats["pits_before"] = n_labels
    stats["pits_spurious"] = len(spurious)
    # Counted apart, because conflating them is what hid the bug above: every pit was reported
    # as "protected" and 4,004 protected pits reads perfectly plausible.
    stats["pits_large"] = kept_large
    stats["pits_protected"] = kept_protected
    if not spurious:
        return out, stats

    breached = _breach_whitebox(out, transform) if use_whitebox else None
    if breached is not None:
        keep = np.zeros(out.shape, dtype=bool)
        for lab in protected_labels:
            keep |= labels == lab
        keep |= protect_mask
        merged = np.where(keep, out, breached)
        stats["breach_method"] = "whitebox_least_cost"
        stats["breach_cells"] = int(np.count_nonzero(merged < out - 1e-9))
        stats["pits_breached"] = len(spurious)
        return merged, stats

    rng = np.random.default_rng(seed)
    order = tuple(_NEIGHBOURS_8[i] for i in rng.permutation(len(_NEIGHBOURS_8)))
    lowered_total = 0
    breached_pits = 0
    for lab in spurious:
        rows, cols = np.nonzero(labels == lab)
        cells = set(zip(rows.tolist(), cols.tolist(), strict=True))
        flat = np.where(labels == lab, out, np.inf)
        bottom_flat = int(np.argmin(flat))
        bottom = (bottom_flat // out.shape[1], bottom_flat % out.shape[1])
        lowered = _breach_pit_python(out, cells, bottom, order)
        if lowered:
            breached_pits += 1
            lowered_total += lowered
    stats["breach_method"] = "python_least_cost"
    stats["breach_cells"] = lowered_total
    stats["pits_breached"] = breached_pits
    return out, stats


# --------------------------------------------------------------------------------------
# the pipeline step
# --------------------------------------------------------------------------------------


def condition_dem(
    dem: NDArray[np.floating[Any]],
    transform: Affine,
    crs: Any,
    *,
    buildings: Any = None,
    roads: Any = None,
    culverts: Any = None,
    bridges: Any = None,
    sinks: Any = None,
    seed: int = 0,
    building_burn_m: float = BUILDING_BURN_M,
    road_carve_m: float = ROAD_CARVE_M,
    min_pit_area_m2: float = MIN_PIT_AREA_M2,
    use_whitebox: bool = True,
    use_pyflwdir: bool = True,
) -> ConditionedDem:
    """Hydro-condition a city DEM (CLAUDE.md 10.1 step 4).

    Args:
        dem: elevations on the city grid, no-data as NaN.
        transform: the grid's affine transform (metric CRS, north-up).
        crs: the grid's CRS; vector inputs carrying another CRS are reprojected to it.
        buildings: footprint polygons (GeoDataFrame/GeoSeries/iterable of geometries).
        roads: road centrelines - rasterised one cell wide.
        culverts: ``tunnel=culvert`` ways to breach.
        bridges: ``bridge=yes`` ways to breach (same treatment as culverts).
        sinks: points that must stay pits - OSM underpasses/subways plus the hotspot register.
        seed: tie-breaking seed for the pure-Python least-cost breach; two runs with the
            same seed and inputs produce byte-identical output.

    Returns:
        :class:`ConditionedDem` with the new elevations, the masks the roughness raster and
        the solver need, and a ``changes`` dict for ``REPORT.md``.
    """
    t0 = time.perf_counter()
    work = np.asarray(dem, dtype=np.float64)
    shape = (work.shape[0], work.shape[1])

    buildings_mask = rasterize_mask(buildings, transform, shape, crs=crs, all_touched=False)
    roads_mask = rasterize_mask(roads, transform, shape, crs=crs, all_touched=False)

    out = burn_buildings(work, buildings_mask, height_m=building_burn_m)
    out = carve_roads(out, roads_mask, depth_m=road_carve_m)

    culvert_geoms = _geometries(culverts, crs) + _geometries(bridges, crs)
    out, culvert_stats = breach_culverts(out, transform, culvert_geoms, crs=None)

    sink_cells = _point_cells(sinks, transform, shape, crs=crs)
    sink_mask = np.zeros(shape, dtype=bool)
    for row, col in sink_cells:
        sink_mask[row, col] = True

    out, pit_stats = breach_spurious_pits(
        out,
        transform,
        min_area_m2=min_pit_area_m2,
        protect=sink_mask,
        use_whitebox=use_whitebox,
        seed=seed,
        use_pyflwdir=use_pyflwdir,
    )

    stage_ms = round((time.perf_counter() - t0) * 1000, 1)
    changes: dict[str, Any] = {
        "cells_burned": int(buildings_mask.sum()),
        "building_burn_m": building_burn_m,
        "cells_carved": int(roads_mask.sum()),
        "road_carve_m": road_carve_m,
        "sinks_protected": len(sink_cells),
        "min_pit_area_m2": min_pit_area_m2,
        "seed": seed,
        "stage_ms": stage_ms,
        **culvert_stats,
        **pit_stats,
    }
    log.info("condition_dem.done", **changes)
    return ConditionedDem(
        dem=out,
        buildings_mask=buildings_mask,
        roads_mask=roads_mask,
        sink_mask=sink_mask,
        changes=changes,
        stage_ms=stage_ms,
    )


__all__ = [
    "BUILDING_BURN_M",
    "MIN_PIT_AREA_M2",
    "ROAD_CARVE_M",
    "ConditionedDem",
    "breach_culverts",
    "breach_spurious_pits",
    "burn_buildings",
    "carve_roads",
    "condition_dem",
    "rasterize_mask",
]
