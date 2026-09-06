"""Chronic waterlogging register (CLAUDE.md P1.9, 10.1 step 9).

The register is curated research, not model output: every point carries the public source
that names it as a waterlogging spot. Points without a source are kept (the pipeline may
still use them as depression candidates) with ``sourced = false``; the UI must never label
those chronic. The register is read from ``docs/research/hotspots_<city>.draft.geojson``
(built by the research agent from the cached Nominatim/Overpass/news pages under
``docs/research/_raw/``) and written to ``city/<city>/hotspots.geojson``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import structlog
from varuna_schemas.paths import city_dir, docs_dir

log = structlog.get_logger("varuna.city.hotspots")

MIN_SOURCED_POINTS = 10
"""CLAUDE.md P1.9: at least ten verified, sourced points inside the AOI."""


class RegisterNotFoundError(FileNotFoundError):
    """No research draft for this city."""


def register_source_path(city: str) -> Path:
    """``docs/research/hotspots_<city>.draft.geojson``."""
    return docs_dir() / "research" / f"hotspots_{city}.draft.geojson"


def _slug(name: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return cleaned[:48] or "hotspot"


def _in_bbox(lon: float, lat: float, bbox: tuple[float, float, float, float] | None) -> bool:
    if bbox is None:
        return True
    minlon, minlat, maxlon, maxlat = bbox
    return minlon <= lon <= maxlon and minlat <= lat <= maxlat


def _normalise(feature: dict[str, Any], code: str, index: int) -> dict[str, Any]:
    """One draft feature -> one register feature with the P1.9 property set."""
    props = dict(feature.get("properties") or {})
    lon, lat = (float(c) for c in feature["geometry"]["coordinates"][:2])
    sources = list(props.get("sources") or [])
    source_url = next((s.get("source_url") for s in sources if s.get("source_url")), None)
    sourced = bool(props.get("sourced")) and source_url is not None
    name = str(props.get("name") or f"Hotspot {index + 1}")
    ward = props.get("ward")
    if isinstance(ward, str) and "unverified" in ward:
        ward = ward.split("(")[0].strip() or None
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "hotspot_id": f"{code}-HS-{index + 1:02d}",
            "name": name,
            "slug": _slug(name),
            "lon": lon,
            "lat": lat,
            "is_sink": bool(props.get("is_sink", False)),
            "ward": ward,
            "sourced": sourced,
            "source_url": source_url,
            "coord_verified": bool(props.get("coord_verified", False)),
            "source_count": len(sources),
            "sources": sources,
            "osm": props.get("osm"),
            "confidence": "sourced" if sourced else "candidate",
        },
    }


def load_register(
    city: str = "mumbai",
    *,
    source: Path | None = None,
    bbox: tuple[float, float, float, float] | None = None,
    require_verified_coord: bool = True,
) -> list[dict[str, Any]]:
    """Read the research draft and return normalised GeoJSON features, sourced ones first.

    ``bbox`` is ``(minlon, minlat, maxlon, maxlat)`` in WGS84; points outside it are dropped.
    """
    path = source or register_source_path(city)
    if not path.is_file():
        msg = (
            f"No hotspot register for {city}: expected {path}. Run the research step or "
            "point load_register(source=...) at a curated GeoJSON."
        )
        raise RegisterNotFoundError(msg)
    raw = json.loads(path.read_text(encoding="utf-8"))
    code = str((raw.get("metadata") or {}).get("aoi", city))[:3].upper() or "CIT"
    features: list[dict[str, Any]] = []
    for i, feature in enumerate(raw.get("features") or []):
        if feature.get("geometry", {}).get("type") != "Point":
            continue
        item = _normalise(feature, code, i)
        props = item["properties"]
        if not _in_bbox(props["lon"], props["lat"], bbox):
            continue
        if require_verified_coord and not props["coord_verified"]:
            log.info("hotspots.skip_unverified_coord", name=props["name"])
            continue
        features.append(item)
    features.sort(key=lambda f: (not f["properties"]["sourced"], f["properties"]["name"]))
    return features


def sourced_count(features: list[dict[str, Any]]) -> int:
    """How many features may be shown as chronic in the UI."""
    return sum(1 for f in features if f["properties"]["sourced"])


def build_hotspots(
    city: str = "mumbai",
    *,
    bbox: tuple[float, float, float, float] | None = None,
    out_dir: Path | None = None,
    source: Path | None = None,
) -> Path:
    """Write ``city/<city>/hotspots.geojson`` and return its path."""
    features = load_register(city, source=source, bbox=bbox)
    n_sourced = sourced_count(features)
    if n_sourced < MIN_SOURCED_POINTS:
        log.warning(
            "hotspots.below_target",
            city=city,
            sourced=n_sourced,
            target=MIN_SOURCED_POINTS,
            hint="CLAUDE.md P1.9 wants at least ten sourced points inside the AOI",
        )
    collection = {
        "type": "FeatureCollection",
        "name": f"{city}_hotspots",
        "metadata": {
            "city": city,
            "task": "P1.9",
            "count": len(features),
            "sourced": n_sourced,
            "source_file": str((source or register_source_path(city)).name),
            "honesty": (
                "Points with sourced=false are depression candidates, not chronic spots; "
                "the UI must not label them chronic."
            ),
        },
        "features": features,
    }
    target = (out_dir or city_dir(city)) / "hotspots.geojson"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(collection, indent=1) + "\n", encoding="utf-8", newline="\n")
    log.info("hotspots.written", path=str(target), count=len(features), sourced=n_sourced)
    return target


__all__ = [
    "MIN_SOURCED_POINTS",
    "RegisterNotFoundError",
    "build_hotspots",
    "load_register",
    "register_source_path",
    "sourced_count",
]
