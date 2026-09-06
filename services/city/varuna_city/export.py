"""City layer exports for the API, the map and Flash (CLAUDE.md P1.11, 10.1 step 11).

Three consumers, three shapes:

* **API** - GeoParquet under ``city/<city>/export/`` (full attributes, metric CRS kept in the
  file's own CRS metadata) plus GeoJSON for anything the console reads directly.
* **Map** - ``city/<city>/map/<layer>.geojson`` in WGS84, simplified with a 2 m tolerance in
  the city's metric CRS so the console can load 30k segments without a tile server.
* **Flash** - ``city/<city>/graph/{nodes,edges,inlet_links}.parquet``, the drain graph as
  plain tables (no geometry required by the emulator, but kept when it is there).

The producing modules (``segments``, ``units``, ``drains``) are written by other agents, so
this module *discovers* its inputs rather than importing them: for each layer it globs the
city folder for a file whose stem starts with the layer name. A layer that is not there yet
is reported as missing, never faked.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import geopandas as gpd
import structlog
from varuna_schemas.paths import city_dir

log = structlog.get_logger("varuna.city.export")

WGS84 = "EPSG:4326"

SIMPLIFY_TOLERANCE_M = 2.0
"""CLAUDE.md P1.11: the map GeoJSON is simplified with a 2 m tolerance."""

VECTOR_SUFFIXES: tuple[str, ...] = (".parquet", ".geojson", ".gpkg", ".fgb")
"""Read order when several files could feed a layer (parquet first: typed and fast)."""

MAP_LAYERS: tuple[str, ...] = (
    "segments",
    "drains",
    "units",
    "assets",
    "hotspots",
    "buildings",
    "depressions",
)
"""Layers the console asks for through ``GET /v1/city/{city}/layers/{name}``."""

GRAPH_TABLES: dict[str, tuple[str, ...]] = {
    "nodes": ("drain_nodes", "nodes"),
    "edges": ("drain_edges", "edges", "drains"),
    "inlet_links": ("inlet_links", "inlets"),
}
"""Flash table -> candidate file stems produced by ``drains.py``."""


@dataclass(slots=True)
class ExportResult:
    """What :func:`export_city` wrote, and what it could not find."""

    city: str
    written: dict[str, Path] = field(default_factory=dict)
    missing: list[str] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "city": self.city,
            "written": {k: str(v) for k, v in self.written.items()},
            "missing": sorted(self.missing),
            "counts": dict(self.counts),
        }


def find_layer_source(layer: str, *, out_dir: Path) -> Path | None:
    """First readable file in ``out_dir`` whose stem starts with ``layer``.

    Searches the city folder and one level of sub-folders (``export/``, ``osm/``), skipping
    the map exports so a re-run never simplifies its own simplification.
    """
    candidates: list[Path] = []
    for suffix in VECTOR_SUFFIXES:
        for path in sorted(out_dir.glob(f"*{suffix}")) + sorted(out_dir.glob(f"*/*{suffix}")):
            if "map" in path.parts[len(out_dir.parts) :]:
                continue
            stem = path.stem.lower()
            if stem == layer or stem.startswith(f"{layer}_") or stem.startswith(f"{layer}."):
                candidates.append(path)
    if not candidates:
        return None
    candidates.sort(key=lambda p: VECTOR_SUFFIXES.index(p.suffix.lower()))
    return candidates[0]


def read_layer(path: Path) -> gpd.GeoDataFrame:
    """Read a vector layer from parquet, GeoJSON, GeoPackage or FlatGeobuf."""
    if path.suffix.lower() == ".parquet":
        return gpd.read_parquet(path)
    return gpd.read_file(path)


def _to_crs(gdf: gpd.GeoDataFrame, crs: str) -> gpd.GeoDataFrame:
    if gdf.crs is None:
        return gdf.set_crs(crs, allow_override=True)
    return gdf.to_crs(crs)


def _json_safe(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Drop columns GeoJSON cannot carry (lists, dicts, timestamps become strings)."""
    out = gdf.copy()
    for column in out.columns:
        if column == out.geometry.name:
            continue
        sample = out[column].dropna()
        if not sample.empty and isinstance(sample.iloc[0], (list, dict, tuple, set)):
            out[column] = out[column].map(lambda v: json.dumps(list(v)) if v is not None else None)
    return out


def simplify_for_map(
    gdf: gpd.GeoDataFrame, *, metric_crs: str, tolerance_m: float = SIMPLIFY_TOLERANCE_M
) -> gpd.GeoDataFrame:
    """Simplify in the metric CRS, then hand back WGS84 for MapLibre."""
    metric = _to_crs(gdf, metric_crs)
    simplified = metric.copy()
    simplified.geometry = metric.geometry.simplify(tolerance_m, preserve_topology=True)
    simplified = simplified[~simplified.geometry.is_empty & simplified.geometry.notna()]
    return _to_crs(simplified, WGS84)


def write_geoparquet(gdf: gpd.GeoDataFrame, path: Path) -> Path:
    """Write a GeoParquet file (geopandas 1.x, geoarrow-compatible metadata)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_parquet(path, index=False)
    return path


def write_geojson(gdf: gpd.GeoDataFrame, path: Path) -> Path:
    """Write WGS84 GeoJSON with LF endings and a stable column order."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.loads(_json_safe(_to_crs(gdf, WGS84)).to_json(drop_id=True))
    path.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8", newline="\n")
    return path


def export_city(
    city: str = "mumbai",
    *,
    metric_crs: str = "EPSG:32643",
    out_dir: Path | None = None,
    layers: tuple[str, ...] = MAP_LAYERS,
    tolerance_m: float = SIMPLIFY_TOLERANCE_M,
) -> ExportResult:
    """Write GeoParquet, simplified map GeoJSON and the Flash graph tables.

    Args:
        city: city slug, used for the default output folder and the log lines.
        metric_crs: the city's computation CRS; simplification happens there.
        out_dir: city folder (default ``city/<city>/``).
        layers: which layers to try; a missing one is recorded, not invented.
        tolerance_m: simplification tolerance in metres for the map exports.
    """
    root = out_dir or city_dir(city)
    result = ExportResult(city=city)
    for layer in layers:
        source = find_layer_source(layer, out_dir=root)
        if source is None:
            result.missing.append(layer)
            log.info("export.layer_missing", city=city, layer=layer)
            continue
        gdf = read_layer(source)
        if gdf.empty:
            result.missing.append(layer)
            log.warning("export.layer_empty", city=city, layer=layer, source=str(source))
            continue
        result.counts[layer] = int(len(gdf))
        if source.suffix.lower() != ".parquet":
            result.written[f"export/{layer}"] = write_geoparquet(
                _to_crs(gdf, metric_crs), root / "export" / f"{layer}.parquet"
            )
        else:
            result.written[f"export/{layer}"] = source
        simplified = simplify_for_map(gdf, metric_crs=metric_crs, tolerance_m=tolerance_m)
        result.written[f"map/{layer}"] = write_geojson(simplified, root / "map" / f"{layer}.geojson")
    result.written.update(export_graph_tables(city, out_dir=root, result=result))
    manifest = root / "export" / "MANIFEST.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        json.dumps(result.to_dict(), indent=1) + "\n", encoding="utf-8", newline="\n"
    )
    log.info(
        "export.done",
        city=city,
        written=len(result.written),
        missing=result.missing,
        counts=result.counts,
    )
    return result


def export_graph_tables(
    city: str = "mumbai", *, out_dir: Path | None = None, result: ExportResult | None = None
) -> dict[str, Path]:
    """Write ``graph/{nodes,edges,inlet_links}.parquet`` for Flash (CLAUDE.md 10.1 step 11)."""
    root = out_dir or city_dir(city)
    written: dict[str, Path] = {}
    for table, stems in GRAPH_TABLES.items():
        source = next((s for stem in stems if (s := find_layer_source(stem, out_dir=root))), None)
        if source is None:
            if result is not None and f"graph/{table}" not in result.missing:
                result.missing.append(f"graph/{table}")
            continue
        gdf = read_layer(source)
        target = root / "graph" / f"{table}.parquet"
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(gdf, gpd.GeoDataFrame) and gdf.geometry.notna().any():
            gdf.to_parquet(target, index=False)
        else:
            gdf.to_parquet(target, index=False)
        written[f"graph/{table}"] = target
        if result is not None:
            result.counts[f"graph/{table}"] = int(len(gdf))
    return written


__all__ = [
    "GRAPH_TABLES",
    "MAP_LAYERS",
    "SIMPLIFY_TOLERANCE_M",
    "ExportResult",
    "export_city",
    "export_graph_tables",
    "find_layer_source",
    "read_layer",
    "simplify_for_map",
    "write_geojson",
    "write_geoparquet",
]
