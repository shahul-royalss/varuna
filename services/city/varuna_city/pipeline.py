"""City-in-a-box driver (CLAUDE.md P1.1-P1.12, 10.1) - ``make city CITY=mumbai``.

:func:`run_city` walks the eleven steps of section 10.1 in dependency order. Every step

* declares the files it writes and the files it reads, so a step whose outputs are newer
  than its inputs is **cached**: it loads its products back off disk instead of recomputing
  them, and a second ``make city`` is seconds rather than minutes;
* validates what it produced and records the numbers ``REPORT.md`` prints;
* records its wall time into ``stage_ms``, exactly like an engine cycle; and
* publishes ``onboard.progress`` on the in-process bus, so the Phase 9 wizard streams the
  same pipeline the terminal runs.

Order matters and is not the order of the spec's numbered list: the hotspot register is
built before the DEM is conditioned (chronic underpasses must survive as sinks), the drain
graph is built before the surface units (a unit is the watershed draining to an inlet), and
the units are linked back onto the drain nodes before the graph tables are exported.

Nothing here downloads: rasters come from ``city/cache/`` and OSM from the warm OSMnx cache
(ADR-0006). A step that cannot run says why and the pipeline keeps going, so an incomplete
city still produces a report that names what is missing.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import structlog
from varuna_schemas.models.city import CityConfig
from varuna_schemas.paths import city_config_path, city_dir, docs_dir

from varuna_city.config import CityGrid, city_grid, load_city_config

log = structlog.get_logger("varuna.city.pipeline")

PROGRESS_TOPIC = "onboard.progress"
"""Bus topic the onboarding wizard subscribes to (CLAUDE.md 11.11)."""

DEFAULT_SEED = 2019
"""Every random draw in the city build comes from this seed (CLAUDE.md 0.8)."""


class StepFailed(RuntimeError):
    """A step ran and its validation check said the output is not usable."""


@dataclass(slots=True)
class StepResult:
    """What one step did: ``cached``, ``ok``, ``skipped`` or ``failed``."""

    name: str
    title: str
    status: str
    ms: float = 0.0
    detail: str | None = None
    outputs: list[str] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "step": self.name,
            "title": self.title,
            "status": self.status,
            "ms": round(self.ms, 1),
            "detail": self.detail,
            "outputs": self.outputs,
            "stats": self.stats,
        }


@dataclass(slots=True)
class CityResult:
    """The whole run: every step, the timings, and the numbers the report prints."""

    city: str
    out_dir: Path
    grid: dict[str, Any]
    seed: int = DEFAULT_SEED
    steps: list[StepResult] = field(default_factory=list)
    stage_ms: dict[str, float] = field(default_factory=dict)
    stats: dict[str, Any] = field(default_factory=dict)
    started_at: str = ""

    @property
    def total_ms(self) -> float:
        return sum(self.stage_ms.values())

    @property
    def ok(self) -> bool:
        return not any(s.status == "failed" for s in self.steps)

    def step(self, name: str) -> StepResult | None:
        return next((s for s in self.steps if s.name == name), None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "city": self.city,
            "out_dir": str(self.out_dir),
            "grid": self.grid,
            "seed": self.seed,
            "ok": self.ok,
            "started_at": self.started_at,
            "total_ms": round(self.total_ms, 1),
            "stage_ms": {k: round(v, 1) for k, v in self.stage_ms.items()},
            "steps": [s.to_dict() for s in self.steps],
            "stats": self.stats,
        }


@dataclass
class Ctx:
    """Everything the steps hand to each other, in memory for one run."""

    config: CityConfig
    grid: CityGrid
    out_dir: Path
    force: bool = False
    seed: int = DEFAULT_SEED
    stats: dict[str, Any] = field(default_factory=dict)
    artifacts: dict[str, Any] = field(default_factory=dict)

    def get(self, name: str) -> Any:
        return self.artifacts.get(name)

    def put(self, name: str, value: Any) -> None:
        self.artifacts[name] = value

    def path(self, name: str) -> Path:
        return self.out_dir / name


# ---------------------------------------------------------------------------------------
# small IO helpers (kept here so the steps read like the spec's numbered list)
# ---------------------------------------------------------------------------------------


def _read_raster(path: Path) -> Any:
    """One band as float64 with nodata as NaN."""
    import rasterio

    with rasterio.open(path) as src:
        band = src.read(1, masked=True)
    return np.ma.filled(band.astype("float64"), np.nan)


def _read_mask(path: Path) -> Any:
    import rasterio

    with rasterio.open(path) as src:
        return src.read(1).astype(bool)


def _write_mask(mask: Any, grid: CityGrid, path: Path) -> Path:
    from varuna_city.rasters import write_grid_raster

    return write_grid_raster(np.asarray(mask, dtype="uint8"), grid, path, dtype="uint8", nodata=255)


def _read_gpkg_layer(path: Path, layer: str) -> Any:
    """One GeoPackage layer, or ``None`` when the layer is not in the file."""
    import geopandas as gpd
    import pyogrio

    if not path.is_file():
        return None
    try:
        names = {str(name) for name, _ in pyogrio.list_layers(path)}
    except Exception as exc:
        log.warning("pipeline.gpkg_unreadable", path=str(path), error=str(exc))
        return None
    if layer not in names:
        return None
    return gpd.read_file(path, layer=layer)


def _json_dump(payload: Any, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=1, default=str) + "\n", encoding="utf-8", newline="\n"
    )
    return path


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _publish(payload: dict[str, Any]) -> None:
    """Best-effort ``onboard.progress`` publish; never breaks a terminal run."""
    try:
        from varuna_cycle.bus import get_bus

        get_bus().publish_threadsafe(PROGRESS_TOPIC, payload)
    except Exception as exc:  # no loop bound (plain CLI run), or cycle not installed
        log.debug("pipeline.progress_not_published", reason=str(exc))


# ---------------------------------------------------------------------------------------
# step definitions
# ---------------------------------------------------------------------------------------


@dataclass(slots=True)
class Step:
    """One pipeline step: what it writes, what it reads, how to build and how to reload."""

    name: str
    title: str
    build: Callable[[Ctx], dict[str, Any] | None]
    outputs: tuple[str, ...] = ()
    inputs: tuple[str, ...] = ()
    load: Callable[[Ctx], dict[str, Any] | None] | None = None
    external_inputs: Callable[[Ctx], Sequence[Path]] | None = None

    def output_paths(self, ctx: Ctx) -> list[Path]:
        return [ctx.path(name) for name in self.outputs]

    def input_paths(self, ctx: Ctx) -> list[Path]:
        paths = [ctx.path(name) for name in self.inputs]
        if self.external_inputs is not None:
            paths += [Path(p) for p in self.external_inputs(ctx)]
        return paths

    def fresh(self, ctx: Ctx, *, config_mtime: float) -> bool:
        """True when every output exists and is newer than every input and the config."""
        if ctx.force or self.load is None or not self.outputs:
            return False
        outs = self.output_paths(ctx)
        if not all(p.exists() for p in outs):
            return False
        newest_input = max(
            [config_mtime, *[_mtime(p) for p in self.input_paths(ctx) if p.exists()]] or [0.0]
        )
        return min(_mtime(p) for p in outs) >= newest_input


# ---- step 0: the open-data cache --------------------------------------------------------


def _step_cache(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.cache import verify_cache

    rows = verify_cache(ctx.config, strict=True)
    return {"tiles": len(rows), "bad": sum(1 for r in rows if not r.ok)}


# ---- step 1: DEM ------------------------------------------------------------------------


def _step_dem(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.rasters import build_dem, hillshade_png

    result = build_dem(ctx.config, out_dir=ctx.out_dir)
    ctx.put("dem", result.dem)
    hillshade_png(result.dem, ctx.path("hillshade.png"), res=ctx.grid.res)
    return {
        "shape": [ctx.grid.height, ctx.grid.width],
        "cells": ctx.grid.height * ctx.grid.width,
        "min_m": round(result.min_m, 2),
        "max_m": round(result.max_m, 2),
        "mean_m": round(result.mean_m, 2),
        "nodata_cells": result.nodata_cells,
    }


def _load_dem(ctx: Ctx) -> dict[str, Any]:
    dem = _read_raster(ctx.path("dem.tif"))
    ctx.put("dem", dem)
    finite = dem[np.isfinite(dem)]
    return {
        "shape": list(dem.shape),
        "cells": int(dem.size),
        "min_m": round(float(finite.min()), 2) if finite.size else None,
        "max_m": round(float(finite.max()), 2) if finite.size else None,
        "mean_m": round(float(finite.mean()), 2) if finite.size else None,
        "nodata_cells": int(dem.size - finite.size),
    }


# ---- step 2: OSM ------------------------------------------------------------------------

_OSM_LAYERS = (
    "roads",
    "buildings",
    "waterways",
    "culverts",
    "stations",
    "hospitals",
    "fire_stations",
    "shelters",
)


def _step_osm(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.osm import fetch_osm

    layers = fetch_osm(ctx.config, out_dir=ctx.out_dir)
    for name in _OSM_LAYERS:
        ctx.put(f"osm.{name}", getattr(layers, name, None))
    ctx.put("osm.assets", layers.assets())
    return _osm_stats(ctx)


def _load_osm(ctx: Ctx) -> dict[str, Any]:
    import geopandas as gpd
    import pandas as pd

    path = ctx.path("osm.gpkg")
    for name in _OSM_LAYERS:
        ctx.put(f"osm.{name}", _read_gpkg_layer(path, name))
    frames = []
    for name in ("hospitals", "fire_stations", "stations", "shelters"):
        layer = ctx.get(f"osm.{name}")
        if layer is None or layer.empty:
            continue
        part = layer[["geometry"]].copy()
        part["asset_kind"] = name
        part["name"] = layer["name"] if "name" in layer.columns else None
        part["osmid"] = layer["osmid"] if "osmid" in layer.columns else None
        frames.append(part)
    if frames:
        assets = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=ctx.grid.crs)
        assets["geometry"] = assets.geometry.representative_point()
    else:
        assets = None
    ctx.put("osm.assets", assets)
    return _osm_stats(ctx)


def _osm_stats(ctx: Ctx) -> dict[str, Any]:
    """Feature counts per OSM layer (a GeoDataFrame is never truthy, so count explicitly)."""
    out: dict[str, Any] = {}
    for name in _OSM_LAYERS:
        layer = ctx.get(f"osm.{name}")
        out[name] = 0 if layer is None else len(layer)
    return out


# ---- step 3: land cover -----------------------------------------------------------------


def _step_landcover(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.landcover import build_landcover

    result = build_landcover(
        ctx.config,
        grid=ctx.grid,
        buildings=ctx.get("osm.buildings"),
        roads=ctx.get("osm.roads"),
        out_dir=ctx.out_dir,
    )
    ctx.put("landcover", result.classes)
    ctx.put("imperviousness", result.imperviousness)
    ctx.put("cn", result.cn)
    _json_dump(result.stats, ctx.path("landcover.json"))
    return result.stats


def _load_landcover(ctx: Ctx) -> dict[str, Any]:
    classes = _read_raster(ctx.path("landcover.tif"))
    imperviousness = _read_raster(ctx.path("imperviousness.tif"))
    cn = _read_raster(ctx.path("cn.tif"))
    ctx.put("landcover", np.nan_to_num(classes).astype("int16"))
    ctx.put("imperviousness", imperviousness)
    ctx.put("cn", cn)
    cached = ctx.path("landcover.json")
    if cached.is_file():
        return json.loads(cached.read_text(encoding="utf-8"))
    return {
        "cells": int(classes.size),
        "imperviousness_mean": round(float(np.nanmean(imperviousness)), 4),
        "imperviousness_p90": round(float(np.nanpercentile(imperviousness, 90)), 4),
        "cn_mean": round(float(np.nanmean(cn)), 2),
    }


# ---- step 4: hotspot register -----------------------------------------------------------


def _step_hotspots(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.hotspots import build_hotspots, read_hotspots

    path = build_hotspots(
        ctx.config.id, bbox=ctx.config.bbox.as_tuple(), out_dir=ctx.out_dir
    )
    return _load_hotspots(ctx, path=path, read=read_hotspots)


def _load_hotspots(ctx: Ctx, *, path: Path | None = None, read: Any = None) -> dict[str, Any]:
    from varuna_city.hotspots import read_hotspots

    reader = read or read_hotspots
    gdf = reader(path or ctx.path("hotspots.geojson"), crs=ctx.grid.crs)
    ctx.put("hotspots", gdf)
    sourced = int(gdf["sourced"].sum()) if "sourced" in gdf.columns and len(gdf) else 0
    sinks = int(gdf["is_sink"].sum()) if "is_sink" in gdf.columns and len(gdf) else 0
    return {"hotspots": len(gdf), "sourced": sourced, "sinks": sinks}


# ---- step 5: assets ---------------------------------------------------------------------


def _step_assets(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.assets import build_assets

    build_assets(
        ctx.config.id,
        osm_assets=ctx.get("osm.assets"),
        out_dir=ctx.out_dir,
        bbox=ctx.config.bbox.as_tuple(),
    )
    return _load_assets(ctx)


def _load_assets(ctx: Ctx) -> dict[str, Any]:
    import geopandas as gpd

    gdf = gpd.read_file(ctx.path("assets.geojson"))
    ctx.put("assets", gdf.to_crs(ctx.grid.crs) if gdf.crs is not None else gdf)
    kinds = gdf["kind"].value_counts().to_dict() if "kind" in gdf.columns else {}
    return {
        "assets": len(gdf),
        "synthetic": int(gdf["synthetic"].sum()) if "synthetic" in gdf.columns else 0,
        "with_source_url": int(gdf["source_url"].notna().sum())
        if "source_url" in gdf.columns
        else 0,
        "kinds": {str(k): int(v) for k, v in kinds.items()},
    }


# ---- step 6: hydro-conditioning ---------------------------------------------------------


def _sink_points(ctx: Ctx) -> Any:
    """Underpasses and subways that must stay pits: OSM tunnels plus register sinks."""
    import geopandas as gpd
    import pandas as pd

    frames = []
    roads = ctx.get("osm.roads")
    if roads is not None and len(roads) and "tunnel" in roads.columns:
        tunnels = roads[roads["tunnel"].notna() & (roads["tunnel"].astype(str) != "no")]
        if len(tunnels):
            frames.append(gpd.GeoDataFrame(geometry=tunnels.geometry.representative_point(), crs=roads.crs))
    hotspots = ctx.get("hotspots")
    if hotspots is not None and len(hotspots) and "is_sink" in hotspots.columns:
        sinks = hotspots[hotspots["is_sink"].astype(bool)]
        if len(sinks):
            frames.append(gpd.GeoDataFrame(geometry=sinks.geometry, crs=sinks.crs))
    if not frames:
        return None
    return gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=frames[0].crs)


def _lines_only(gdf: Any) -> Any:
    """Keep the (Multi)LineStrings of a layer.

    OSM tags ``bridge``/``tunnel`` on a handful of areas too; the culvert breacher walks a
    way's coordinates, and a polygon has no coordinate sequence to walk.
    """
    if gdf is None or not len(gdf):
        return gdf
    return gdf[gdf.geom_type.isin(["LineString", "MultiLineString"])]


def _step_condition(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.condition import condition_dem
    from varuna_city.rasters import write_grid_raster

    culverts = _lines_only(ctx.get("osm.culverts"))
    bridges = None
    if culverts is not None and len(culverts) and "bridge" in culverts.columns:
        bridges = culverts[culverts["bridge"].notna()]
        culverts = culverts[culverts["bridge"].isna()]
    result = condition_dem(
        ctx.get("dem"),
        ctx.grid.transform,
        ctx.grid.crs,
        buildings=ctx.get("osm.buildings"),
        roads=ctx.get("osm.roads"),
        culverts=culverts,
        bridges=bridges,
        sinks=_sink_points(ctx),
        seed=ctx.seed,
        building_burn_m=float(ctx.config.building_burn_m),
        road_carve_m=float(ctx.config.road_carve_m),
        min_pit_area_m2=float(ctx.config.depression_min_area_m2),
    )
    write_grid_raster(result.dem, ctx.grid, ctx.path("dem_conditioned.tif"))
    _write_mask(result.buildings_mask, ctx.grid, ctx.path("buildings_mask.tif"))
    _write_mask(result.roads_mask, ctx.grid, ctx.path("roads_mask.tif"))
    ctx.put("conditioned", result.dem)
    ctx.put("buildings_mask", result.buildings_mask)
    ctx.put("roads_mask", result.roads_mask)
    changes = {k: (float(v) if isinstance(v, np.floating) else v) for k, v in result.changes.items()}
    _json_dump(changes, ctx.path("condition.json"))
    return changes


def _load_condition(ctx: Ctx) -> dict[str, Any]:
    ctx.put("conditioned", _read_raster(ctx.path("dem_conditioned.tif")))
    ctx.put("buildings_mask", _read_mask(ctx.path("buildings_mask.tif")))
    ctx.put("roads_mask", _read_mask(ctx.path("roads_mask.tif")))
    path = ctx.path("condition.json")
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


# ---- step 7: roughness ------------------------------------------------------------------


def _step_roughness(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.rasters import write_grid_raster
    from varuna_city.roughness import manning_n

    result = manning_n(
        ctx.get("landcover"),
        ctx.get("buildings_mask"),
        ctx.get("roads_mask"),
        shape=ctx.grid.shape,
    )
    write_grid_raster(result.n, ctx.grid, ctx.path("roughness.tif"))
    _write_mask(result.blocked, ctx.grid, ctx.path("blocked.tif"))
    ctx.put("roughness", result.n)
    ctx.put("blocked", result.blocked)
    return {"cells_by_surface": result.counts, "blocked_cells": int(result.blocked.sum())}


def _load_roughness(ctx: Ctx) -> dict[str, Any]:
    n = _read_raster(ctx.path("roughness.tif"))
    blocked = _read_mask(ctx.path("blocked.tif"))
    ctx.put("roughness", n)
    ctx.put("blocked", blocked)
    return {"blocked_cells": int(blocked.sum()), "n_mean": round(float(np.nanmean(n)), 4)}


# ---- step 8: depressions ----------------------------------------------------------------


def _step_depressions(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.depressions import find_depressions, label_pits
    from varuna_city.rasters import write_grid_raster

    conditioned = ctx.get("conditioned")
    gdf = find_depressions(
        conditioned,
        ctx.grid.transform,
        ctx.grid.crs,
        float(ctx.config.depression_min_area_m2),
    )
    gdf, in_water = _drop_water_depressions(gdf, ctx.get("landcover"))
    _, depth = label_pits(conditioned)
    # pyflwdir's depression fill is bit-reproducible inside one process but not between
    # them (it differs by up to 2e-6 m, a numba dispatch artefact). Rounding to a tenth of a
    # millimetre - four orders of magnitude below anything the solver cares about - makes the
    # raster the same file on every run.
    depth = np.round(np.asarray(depth, dtype=float), 4)
    write_grid_raster(depth, ctx.grid, ctx.path("depression_depth.tif"))
    # GeoParquet, not GeoJSON: the GeoJSON driver rewrites to WGS84 at seven decimals, and a
    # centimetre of drift in a pit bottom is enough to move a drain node onto another cell,
    # which would make two runs of the same pipeline disagree.
    gdf.to_parquet(ctx.path("depressions.parquet"), index=False)
    ctx.put("depressions", gdf)
    ctx.put("depression_depth", depth)
    stats = _depression_stats(gdf, depth)
    stats["dropped_in_permanent_water"] = in_water
    _json_dump(stats, ctx.path("depressions.json"))
    return stats


def _drop_water_depressions(gdf: Any, landcover: Any) -> tuple[Any, int]:
    """Drop pits whose bottom cell is permanent water (the bay, the creek, a lake).

    Those are the sea and the Mithi, not a street that floods; keeping them would hang drain
    nodes off open water and inflate the ponded volume the report prints.
    """
    from varuna_city.landcover import WATER_CLASS

    if landcover is None or not len(gdf) or "bottom_row" not in gdf.columns:
        return gdf, 0
    codes = np.asarray(landcover)
    rows = np.asarray(gdf["bottom_row"], dtype=int)
    cols = np.asarray(gdf["bottom_col"], dtype=int)
    in_water = codes[rows, cols] == WATER_CLASS
    if not in_water.any():
        return gdf, 0
    kept = gdf.loc[~in_water].reset_index(drop=True)
    kept["rank"] = np.arange(1, len(kept) + 1, dtype=int)
    log.info("depressions.water_dropped", dropped=int(in_water.sum()), kept=len(kept))
    return kept, int(in_water.sum())


def _load_depressions(ctx: Ctx) -> dict[str, Any]:
    import geopandas as gpd

    gdf = gpd.read_parquet(ctx.path("depressions.parquet"))
    if gdf.crs is not None and str(gdf.crs) != str(ctx.grid.crs):
        gdf = gdf.to_crs(ctx.grid.crs)
    depth = _read_raster(ctx.path("depression_depth.tif"))
    ctx.put("depressions", gdf)
    ctx.put("depression_depth", depth)
    cached = ctx.path("depressions.json")
    if cached.is_file():
        return json.loads(cached.read_text(encoding="utf-8"))
    return _depression_stats(gdf, depth)


def _depression_stats(gdf: Any, depth: Any) -> dict[str, Any]:
    if not len(gdf):
        return {"depressions": 0}
    depths = np.asarray(gdf["depth_m"], dtype=float)
    areas = np.asarray(gdf["area_m2"], dtype=float)
    return {
        "depressions": len(gdf),
        "depth_m": {
            "min": round(float(depths.min()), 3),
            "median": round(float(np.median(depths)), 3),
            "p90": round(float(np.percentile(depths, 90)), 3),
            "max": round(float(depths.max()), 3),
        },
        "area_m2": {
            "min": round(float(areas.min()), 1),
            "median": round(float(np.median(areas)), 1),
            "p90": round(float(np.percentile(areas, 90)), 1),
            "max": round(float(areas.max()), 1),
        },
        "total_volume_m3": round(float(np.asarray(gdf["volume_m3"], dtype=float).sum()), 1),
        "ponded_cells": int(np.count_nonzero(np.nan_to_num(depth) > 0.01)),
    }


# ---- step 9: road segments --------------------------------------------------------------


def _step_segments(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.segments import build_segments

    segments = build_segments(
        ctx.get("osm.roads"),
        ctx.get("conditioned"),
        ctx.grid.transform,
        ctx.get("osm.buildings"),
        ctx.get("osm.assets"),
        crs=ctx.grid.crs,
    )
    segments.to_parquet(ctx.path("segments.parquet"), index=False)
    ctx.put("segments", segments)
    return _segment_stats(segments)


def _load_segments(ctx: Ctx) -> dict[str, Any]:
    import geopandas as gpd

    segments = gpd.read_parquet(ctx.path("segments.parquet"))
    ctx.put("segments", segments)
    return _segment_stats(segments)


def _segment_stats(segments: Any) -> dict[str, Any]:
    if not len(segments):
        return {"segments": 0}
    lengths = np.asarray(segments["length_m"], dtype=float)
    classes = segments["class"].value_counts().to_dict()
    return {
        "segments": len(segments),
        "length_km": round(float(lengths.sum()) / 1000.0, 2),
        "median_length_m": round(float(np.median(lengths)), 1),
        "classes": {str(k): int(v) for k, v in classes.items()},
        "with_ward": int(segments["ward"].notna().sum()) if "ward" in segments.columns else 0,
        "mean_exposure": round(float(np.mean(segments["exposure_weight"])), 4),
    }


# ---- step 10: drain graph ---------------------------------------------------------------


def _step_drains(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.drains import build_drain_graph, check_connectivity

    nodes, edges = build_drain_graph(
        ctx.get("segments"),
        ctx.get("conditioned"),
        ctx.grid.transform,
        ctx.get("osm.waterways"),
        ctx.get("depressions"),
        ctx.get("hotspots"),
        ctx.get("imperviousness"),
        config=ctx.config,
        seed=ctx.seed,
    )
    nodes.to_parquet(ctx.path("drain_nodes.parquet"), index=False)
    edges.to_parquet(ctx.path("drain_edges.parquet"), index=False)
    ctx.put("drain_nodes", nodes)
    ctx.put("drain_edges", edges)
    stats = _drain_stats(nodes, edges, check_connectivity(nodes, edges))
    _json_dump(stats, ctx.path("drains.json"))
    return stats


def _load_drains(ctx: Ctx) -> dict[str, Any]:
    import geopandas as gpd

    from varuna_city.drains import check_connectivity

    nodes = gpd.read_parquet(ctx.path("drain_nodes.parquet"))
    edges = gpd.read_parquet(ctx.path("drain_edges.parquet"))
    ctx.put("drain_nodes", nodes)
    ctx.put("drain_edges", edges)
    return _drain_stats(nodes, edges, check_connectivity(nodes, edges))


def size_label(row: Any) -> str:
    """A pipe's size as the report prints it: ``600 mm`` or ``box 1500 x 900 mm``."""
    if str(row.get("shape", "circular")) == "box":
        width = float(row.get("width_m") or 0.0) * 1000.0
        height = float(row.get("height_m") or 0.0) * 1000.0
        return f"box {width:.0f} x {height:.0f} mm"
    return f"{float(row.get('diameter_m') or 0.0) * 1000.0:.0f} mm"


def _size_order(label: str) -> tuple[bool, float]:
    """Circular pipes by diameter first, then the box drains by width."""
    digits = "".join(c if c.isdigit() else " " for c in label).split()
    return (label.startswith("box"), float(digits[0]) if digits else 0.0)


def _drain_stats(nodes: Any, edges: Any, connectivity: dict[str, Any]) -> dict[str, Any]:
    histogram: dict[str, int] = {}
    if len(edges):
        labels = [size_label(row) for _, row in edges.iterrows()]
        for label in sorted(set(labels), key=_size_order):
            histogram[label] = labels.count(label)
    tidal = int(nodes["tidal"].sum()) if "tidal" in nodes.columns else 0
    return {
        "nodes": len(nodes),
        "edges": len(edges),
        "outfalls": int(nodes["is_outfall"].sum()) if "is_outfall" in nodes.columns else 0,
        "tidal_outfalls": tidal,
        "trunk_edges": int(edges["is_trunk"].sum()) if "is_trunk" in edges.columns else 0,
        "box_drains": int((edges["shape"] == "box").sum()) if "shape" in edges.columns else 0,
        "pipe_length_km": round(float(np.asarray(edges["length_m"], dtype=float).sum()) / 1000.0, 2),
        "diameter_histogram": histogram,
        "connectivity": float(connectivity.get("connectivity", 0.0)),
        "max_hops_to_outfall": int(connectivity.get("max_hops_to_outfall", 0)),
        "inferred": int((edges["confidence"] == "inferred").sum())
        if "confidence" in edges.columns
        else 0,
        "beta_mean": round(float(np.mean(edges["beta_mean"])), 4) if "beta_mean" in edges else None,
    }


# ---- step 11: surface units (and the unit link back onto the drain nodes) ---------------


def _step_units(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.units import build_surface_units, units_to_parquet

    nodes = ctx.get("drain_nodes")
    inlets = nodes[nodes["kind"] != "trunk"] if nodes is not None and len(nodes) else nodes
    units = build_surface_units(
        ctx.get("conditioned"),
        ctx.grid.transform,
        inlets,
        ctx.get("segments"),
        crs=ctx.grid.crs,
        imperviousness=ctx.get("imperviousness"),
        cn=ctx.get("cn"),
        manning_n=ctx.get("roughness"),
        depression_depth=ctx.get("depression_depth"),
    )
    units_to_parquet(units, ctx.path("units.parquet"))
    ctx.put("units", units)
    stats = _unit_stats(units)
    stats.update(_link_units_to_nodes(ctx, units))
    return stats


def _load_units(ctx: Ctx) -> dict[str, Any]:
    import geopandas as gpd

    units = gpd.read_parquet(ctx.path("units.parquet"))
    ctx.put("units", units)
    stats = _unit_stats(units)
    nodes = ctx.get("drain_nodes")
    if nodes is not None and "surface_unit_id" in nodes.columns:
        known = set(units["unit_id"])
        stats["nodes_linked_to_units"] = int(
            sum(1 for value in nodes["surface_unit_id"] if value in known)
        )
    return stats


def _unit_stats(units: Any) -> dict[str, Any]:
    if not len(units):
        return {"units": 0}
    areas = np.asarray(units.geometry.area, dtype=float)
    return {
        "units": len(units),
        "method": str(units["method"].iloc[0]) if "method" in units.columns else "unknown",
        "area_m2": {
            "min": round(float(areas.min()), 1),
            "median": round(float(np.median(areas)), 1),
            "mean": round(float(areas.mean()), 1),
            "max": round(float(areas.max()), 1),
        },
        "within_cap": int(np.count_nonzero((areas >= 5000.0) & (areas <= 20000.0))),
        "below_cap": int(np.count_nonzero(areas < 5000.0)),
        "above_cap": int(np.count_nonzero(areas > 20000.0)),
        "total_area_km2": round(float(areas.sum()) / 1e6, 3),
    }


def _link_units_to_nodes(ctx: Ctx, units: Any) -> dict[str, Any]:
    """Replace the drain nodes' provisional ``surface_unit_id`` with the real unit it sits in.

    ``drains.py`` names a node's unit after its street before the units exist; once the
    watersheds are built, the inlet's own unit is the polygon that contains it. Flash reads
    ``inlet_links.parquet``, so the two tables must agree.
    """
    import geopandas as gpd

    nodes = ctx.get("drain_nodes")
    if nodes is None or not len(nodes) or units is None or not len(units):
        return {"nodes_linked_to_units": 0}
    joined = gpd.sjoin(
        nodes[["node_id", "geometry"]],
        units[["unit_id", "geometry"]],
        how="left",
        predicate="within",
    )
    joined = joined[~joined.index.duplicated(keep="first")]
    linked = joined["unit_id"].reindex(nodes.index)
    nodes = nodes.copy()
    nodes["surface_unit_id"] = [None if v is None or v != v else str(v) for v in linked]
    nodes.to_parquet(ctx.path("drain_nodes.parquet"), index=False)
    ctx.put("drain_nodes", nodes)
    return {"nodes_linked_to_units": int(nodes["surface_unit_id"].notna().sum())}


# ---- step 12: exports -------------------------------------------------------------------


def _step_export(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.export import export_city

    result = export_city(
        ctx.config.id,
        metric_crs=ctx.grid.crs,
        out_dir=ctx.out_dir,
        layers=None,
        frames=_export_frames(ctx),
    )
    return result.to_dict()


def _load_export(ctx: Ctx) -> dict[str, Any]:
    """The manifest of the last export; the files themselves are what the API serves."""
    return json.loads(ctx.path("export/MANIFEST.json").read_text(encoding="utf-8"))


def _export_frames(ctx: Ctx) -> dict[str, Any]:
    """In-memory layers the export step prefers over re-reading the city folder."""
    frames = {
        "segments": ctx.get("segments"),
        "drains": ctx.get("drain_edges"),
        "drain_nodes": ctx.get("drain_nodes"),
        "units": ctx.get("units"),
        "hotspots": ctx.get("hotspots"),
        "assets": ctx.get("assets"),
        "depressions": ctx.get("depressions"),
        "buildings": ctx.get("osm.buildings"),
    }
    return {k: v for k, v in frames.items() if v is not None and len(v)}


# ---- step 13: validation report ---------------------------------------------------------


def _load_report(ctx: Ctx) -> dict[str, Any]:
    return {"report": str(ctx.path("REPORT.md"))}


def _step_report(ctx: Ctx) -> dict[str, Any]:
    from varuna_city.report import write_report

    path = write_report(ctx.config, ctx.grid, ctx.out_dir, stats=ctx.stats, artifacts=ctx.artifacts)
    return {"report": str(path)}


# ---------------------------------------------------------------------------------------
# the step list, in dependency order
# ---------------------------------------------------------------------------------------


def _research_paths(ctx: Ctx) -> Sequence[Path]:
    return [docs_dir() / "research" / f"hotspots_{ctx.config.id}.draft.geojson"]


def _infra_paths(ctx: Ctx) -> Sequence[Path]:
    from varuna_city.assets import infra_path

    return [infra_path(ctx.config.id)]


def _cache_paths(ctx: Ctx) -> Sequence[Path]:
    from varuna_city.cache import cached_tile

    paths: list[Path] = []
    for name in ctx.config.dem_tiles:
        paths.append(cached_tile("dem", name))
    return paths


STEPS: tuple[Step, ...] = (
    Step("cache", "Verify the open-data cache", _step_cache),
    Step(
        "dem",
        "Mosaic the Copernicus DEM onto the city grid",
        _step_dem,
        outputs=("dem.tif", "hillshade.png"),
        load=_load_dem,
        external_inputs=_cache_paths,
    ),
    Step(
        "osm",
        "Extract roads, buildings, waterways and assets from OSM",
        _step_osm,
        outputs=("osm.gpkg",),
        load=_load_osm,
    ),
    Step(
        "landcover",
        "Imperviousness and curve number from ESA WorldCover",
        _step_landcover,
        outputs=("landcover.tif", "imperviousness.tif", "cn.tif", "landcover.json"),
        inputs=("dem.tif", "osm.gpkg"),
        load=_load_landcover,
    ),
    Step(
        "hotspots",
        "Chronic waterlogging register (sourced)",
        _step_hotspots,
        outputs=("hotspots.geojson",),
        load=_load_hotspots,
        external_inputs=_research_paths,
    ),
    Step(
        "assets",
        "Hospitals, fire stations, pumping stations, tanks and pumps",
        _step_assets,
        outputs=("assets.geojson",),
        inputs=("osm.gpkg",),
        load=_load_assets,
        external_inputs=_infra_paths,
    ),
    Step(
        "condition",
        "Hydro-condition the DEM (burn, carve, breach)",
        _step_condition,
        outputs=(
            "dem_conditioned.tif",
            "buildings_mask.tif",
            "roads_mask.tif",
            "condition.json",
        ),
        inputs=("dem.tif", "osm.gpkg", "hotspots.geojson"),
        load=_load_condition,
    ),
    Step(
        "roughness",
        "Manning roughness raster and the blocked-cell mask",
        _step_roughness,
        outputs=("roughness.tif", "blocked.tif"),
        inputs=("landcover.tif", "buildings_mask.tif", "roads_mask.tif"),
        load=_load_roughness,
    ),
    Step(
        "depressions",
        "Depression map and hotspot candidates",
        _step_depressions,
        outputs=("depressions.parquet", "depression_depth.tif", "depressions.json"),
        inputs=("dem_conditioned.tif", "landcover.tif"),
        load=_load_depressions,
    ),
    Step(
        "segments",
        "Road segments split at intersections",
        _step_segments,
        outputs=("segments.parquet",),
        inputs=("osm.gpkg", "dem_conditioned.tif", "assets.geojson"),
        load=_load_segments,
    ),
    Step(
        "drains",
        "Synthetic drain graph (inferred)",
        _step_drains,
        outputs=("drain_nodes.parquet", "drain_edges.parquet", "drains.json"),
        inputs=(
            "segments.parquet",
            "dem_conditioned.tif",
            "depressions.parquet",
            "hotspots.geojson",
            "imperviousness.tif",
        ),
        load=_load_drains,
    ),
    Step(
        "units",
        "Surface units draining to each inlet",
        _step_units,
        outputs=("units.parquet",),
        inputs=(
            "dem_conditioned.tif",
            "segments.parquet",
            "drain_edges.parquet",
            "cn.tif",
            "roughness.tif",
            "depression_depth.tif",
        ),
        load=_load_units,
    ),
    Step(
        "export",
        "GeoParquet, map GeoJSON and the Flash graph tables",
        _step_export,
        outputs=(
            "export/MANIFEST.json",
            "export/segments.parquet",
            "map/segments.geojson",
            "map/drains.geojson",
            "graph/nodes.parquet",
            "graph/edges.parquet",
            "graph/inlet_links.parquet",
        ),
        inputs=(
            "segments.parquet",
            "drain_edges.parquet",
            "units.parquet",
            "hotspots.geojson",
            "assets.geojson",
            "depressions.parquet",
            "osm.gpkg",
        ),
        load=_load_export,
    ),
    Step(
        "report",
        "Validation report and maps",
        _step_report,
        outputs=("REPORT.md", "report.json", "maps/terrain.png"),
        inputs=("export/MANIFEST.json",),
        load=_load_report,
    ),
)


# ---------------------------------------------------------------------------------------
# the driver
# ---------------------------------------------------------------------------------------


def run_city(
    city: str = "mumbai",
    *,
    cache_only: bool = False,
    force: bool = False,
    out_dir: Path | None = None,
    only: Iterable[str] | None = None,
    seed: int = DEFAULT_SEED,
) -> CityResult:
    """Run the city-in-a-box pipeline and return every step's status, timing and numbers.

    Args:
        city: city slug with a config under ``services/city/configs/``.
        cache_only: stop after the cache check (``make city CITY=chennai ARGS=--cache-only``).
        force: ignore cached step outputs and recompute everything.
        out_dir: city folder (default ``city/<city>/``).
        only: run just these step names; the steps before them load from cache.
        seed: seed for every random draw in the build (default 2019).
    """
    config = load_city_config(city)
    grid = city_grid(config)
    target = Path(out_dir) if out_dir is not None else city_dir(config.id)
    target.mkdir(parents=True, exist_ok=True)
    ctx = Ctx(config=config, grid=grid, out_dir=target, force=force, seed=seed)
    config_mtime = _mtime(city_config_path(config.id))
    result = CityResult(
        city=config.id,
        out_dir=target,
        grid=grid.to_dict(),
        seed=seed,
        started_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    )
    wanted = set(only) if only is not None else None
    steps = STEPS[:1] if cache_only else STEPS
    log.info("city.start", city=config.id, steps=len(steps), out_dir=str(target), force=force)
    _publish({"city": config.id, "event": "started", "steps": [s.name for s in steps]})

    for index, step in enumerate(steps):
        _publish(
            {
                "city": config.id,
                "event": "step_started",
                "step": step.name,
                "title": step.title,
                "index": index,
                "total": len(steps),
            }
        )
        outcome = _run_step(step, ctx, config_mtime=config_mtime, wanted=wanted)
        result.steps.append(outcome)
        result.stage_ms[step.name] = outcome.ms
        if outcome.stats:
            ctx.stats[step.name] = outcome.stats
        _publish(
            {
                "city": config.id,
                "event": "step_finished",
                "step": step.name,
                "status": outcome.status,
                "ms": round(outcome.ms, 1),
                "detail": outcome.detail,
                "index": index,
                "total": len(steps),
            }
        )
        log.info(
            "city.step",
            city=config.id,
            step=step.name,
            status=outcome.status,
            ms=round(outcome.ms, 1),
            detail=outcome.detail,
        )

    result.stats = ctx.stats
    _write_summary(result, target / "pipeline.json", partial=cache_only or wanted is not None)
    _publish({"city": config.id, "event": "finished", "ok": result.ok, "ms": result.total_ms})
    log.info("city.done", city=config.id, ok=result.ok, total_ms=round(result.total_ms, 1))
    return result


def _write_summary(result: CityResult, path: Path, *, partial: bool) -> Path:
    """Write ``pipeline.json``; a partial run (``--only``, ``--cache-only``) merges into it.

    A one-step run must not erase the record of the build that made the other twelve.
    """
    payload = result.to_dict()
    if partial and path.is_file():
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = {}
        if previous.get("city") == payload["city"]:
            steps = {s["step"]: s for s in previous.get("steps", [])}
            steps.update({s["step"]: s for s in payload["steps"]})
            order = [s.name for s in STEPS]
            payload["steps"] = sorted(
                steps.values(),
                key=lambda s: order.index(s["step"]) if s["step"] in order else len(order),
            )
            payload["stage_ms"] = {**previous.get("stage_ms", {}), **payload["stage_ms"]}
            payload["stats"] = {**previous.get("stats", {}), **payload["stats"]}
            payload["total_ms"] = round(sum(payload["stage_ms"].values()), 1)
            payload["partial_run"] = True
    return _json_dump(payload, path)


def _run_step(
    step: Step, ctx: Ctx, *, config_mtime: float, wanted: set[str] | None
) -> StepResult:
    forced_step = wanted is not None and step.name in wanted
    if wanted is not None and not forced_step and step.load is None:
        return StepResult(step.name, step.title, "skipped", 0.0, "not in --only")
    started = time.perf_counter()
    use_cache = not forced_step and step.fresh(ctx, config_mtime=config_mtime)
    action = step.load if use_cache else step.build
    if action is None:
        return StepResult(step.name, step.title, "skipped", 0.0, "no builder")
    try:
        stats = action(ctx) or {}
    except Exception as exc:
        ms = (time.perf_counter() - started) * 1000.0
        log.warning("city.step_failed", step=step.name, error=str(exc), exc_info=True)
        return StepResult(step.name, step.title, "failed", ms, f"{type(exc).__name__}: {exc}")
    ms = (time.perf_counter() - started) * 1000.0
    missing = [str(p) for p in step.output_paths(ctx) if not p.exists()]
    if missing:
        return StepResult(
            step.name, step.title, "failed", ms, f"declared output missing: {missing[0]}"
        )
    return StepResult(
        step.name,
        step.title,
        "cached" if use_cache else "ok",
        ms,
        "loaded from the city folder" if use_cache else None,
        [str(p) for p in step.output_paths(ctx)],
        stats,
    )


def timing_table(result: CityResult) -> str:
    """The per-step timing table ``varuna city`` prints (plain text, no rich needed)."""
    width = max((len(s.name) for s in result.steps), default=4)
    lines = [f"{'step'.ljust(width)}  status   {'seconds':>8}  detail"]
    for step in result.steps:
        detail = step.detail or ", ".join(f"{k}={v}" for k, v in list(step.stats.items())[:3])
        lines.append(
            f"{step.name.ljust(width)}  {step.status.ljust(7)}  {step.ms / 1000.0:8.2f}  "
            f"{(detail or '')[:80]}"
        )
    lines.append(f"{'total'.ljust(width)}  {'':7}  {result.total_ms / 1000.0:8.2f}")
    return "\n".join(lines)


__all__ = [
    "DEFAULT_SEED",
    "PROGRESS_TOPIC",
    "STEPS",
    "CityResult",
    "Ctx",
    "Step",
    "StepFailed",
    "StepResult",
    "run_city",
    "size_label",
    "timing_table",
]
