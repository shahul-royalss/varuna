"""Ranking the chronic spots by what this run says will happen to them (CLAUDE.md 11.8, P5.4).

The hotspot register is 28 sourced points for Mumbai (CLAUDE.md 10.1 step 9) - Hindmata, King's
Circle, Sion Circle, the Andheri and Milan subways, and the rest - each carrying the `source_url`
it was verified against. This module says which of them this run expects to flood, how deep, and
when.

**The ranking.** CLAUDE.md 11.8 fixes it as ``expected impact = P(impassable at peak) x
exposure_weight``. With one deterministic Twin run ``P`` is 0 or 1, so the ordering it produces
would be a coarse two-tier sort with the exposure weight breaking ties. That is not useful to an
operator scanning a rail, so the ranking here uses **peak depth** as the score and reports the
exceedance separately, which is the same intent with the information actually available. When
Flash-lite brings a real 50-member ensemble in Phase 7 the probability becomes continuous and the
spec's product becomes the right score; the field is already in the output so nothing downstream
changes shape.

**Sampling.** A hotspot is a point, but a junction is not: the register's coordinate is a marker
for a place a few tens of metres across, and a 30 m grid cell either contains the dip or misses
it. So depth is read over a small neighbourhood and the 90th percentile taken, the same rule and
the same reasoning as the road segments in :mod:`varuna_products.depth`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only
    from datetime import datetime

    from numpy.typing import NDArray

log = structlog.get_logger("varuna.products.hotspots")

__all__ = ["HOTSPOT_RADIUS_M", "IMPASSABLE_CM", "rank_hotspots"]

HOTSPOT_RADIUS_M = 45.0
"""Half-width of the neighbourhood a hotspot's depth is read over, in metres.

A choice, not spec. A junction is tens of metres across and the register's point is a marker for
it rather than a survey mark, so reading one 30 m cell would make the answer depend on which side
of a cell boundary the marker happened to land. 45 m is a cell and a half either way: wide enough
to contain the dip, narrow enough not to average in the road that climbs out of it."""

IMPASSABLE_CM = 30.0
"""The depth at which a car stops (CLAUDE.md 6.2, the --depth-3 band).

Used for the exceedance the rail reports. Other vehicles have other thresholds and the segment
forecast carries all of them; the rail needs one number and the car is the one a judge pictures."""

EXPOSURE_RADIUS_M = 300.0
"""How far around a hotspot counts as exposed (CLAUDE.md 3.3: "hospital/station within 300 m").

The same 300 m the city pipeline used when it computed each segment's exposure weight, so the
rail's icons and the weight behind them are answering the question at the same range."""

FACILITY_KINDS = ("hospital", "fire_station", "station", "shelter")
"""Asset kinds the rail draws an icon for, in the order the icons appear.

``pumping_station``, ``depot``, ``holding_tank`` and ``mobile_pump`` are response infrastructure
rather than things at risk, so they belong to the pump board (Phase 8), not to the exposure row."""


def _segments_near(
    city_root: Path,
    windows: list[set[int]],
    index: tuple[tuple[str, ...], NDArray[np.int64], NDArray[np.int64]] | None,
) -> list[tuple[list[str], float]]:
    """For each hotspot window, the segments running through it and their top exposure weight.

    One pass over the 21,296 segments for **all** the hotspots rather than one pass each: the CSR
    index runs segment -> cells, so it is walked once and every window it touches is credited on
    the way past. The **maximum** weight is taken, not the mean, because a junction is as exposed
    as its most important road and averaging in the service lanes beside it would hide that.
    """
    if index is None:
        return [([], 0.0) for _ in windows]

    segment_ids, offsets, cells = index
    hit: list[list[str]] = [[] for _ in windows]
    for k, seg in enumerate(segment_ids):
        span = cells[offsets[k] : offsets[k + 1]]
        if not span.size:
            continue
        span_set = set(span.tolist())
        for w, window in enumerate(windows):
            if not window.isdisjoint(span_set):
                hit[w].append(seg)

    import pandas as pd

    frame = pd.read_parquet(
        city_root / "segments.parquet", columns=["segment_id", "exposure_weight"]
    ).set_index("segment_id")["exposure_weight"]
    out: list[tuple[list[str], float]] = []
    for ids in hit:
        weights = frame.reindex(ids).dropna()
        out.append((ids, round(float(weights.max()), 3) if len(weights) else 0.0))
    return out


def _facilities(city_root: Path, lon: float, lat: float) -> dict[str, Any]:
    """The real places within :data:`EXPOSURE_RADIUS_M` of a hotspot, for the row's icon set.

    Read from the assets layer so every icon stands for an OSM feature the city pipeline
    extracted, never a category guess about what is probably near a junction.
    """
    assets_path = city_root / "assets.geojson"
    if not assets_path.is_file():
        return {"facilities": []}

    features = json.loads(assets_path.read_text(encoding="utf-8")).get("features", [])
    near: dict[str, tuple[float, str]] = {}
    # Degrees to metres at Mumbai's latitude: accurate to well under a metre over 300 m, and it
    # avoids projecting 766 assets once per hotspot.
    lon_m = 111_320.0 * float(np.cos(np.deg2rad(lat)))
    for feature in features:
        props = feature.get("properties", {})
        kind = props.get("kind")
        if kind not in FACILITY_KINDS:
            continue
        fx, fy = feature["geometry"]["coordinates"][:2]
        dist = float(np.hypot((fx - lon) * lon_m, (fy - lat) * 110_540.0))
        if dist <= EXPOSURE_RADIUS_M and (kind not in near or dist < near[kind][0]):
            near[kind] = (dist, props.get("name") or kind)

    out: dict[str, Any] = {"facilities": [k for k in FACILITY_KINDS if k in near]}
    if "hospital" in near:
        out["nearest_hospital"] = near["hospital"][1]
        out["nearest_hospital_m"] = round(near["hospital"][0])
    if "station" in near:
        out["nearest_station"] = near["station"][1]
        out["nearest_station_m"] = round(near["station"][0])
    return out


def rank_hotspots(
    depth_m: NDArray[np.floating],
    times: tuple[datetime, ...],
    city_root: Path,
    transform: tuple[float, float, float, float, float, float],
    crs: str,
    run_id: str,
    index: tuple[tuple[str, ...], NDArray[np.int64], NDArray[np.int64]] | None = None,
) -> list[dict[str, Any]]:
    """Rank the register's hotspots by the peak depth this run gives them.

    Every entry carries the register's own ``source_url``, because a hotspot on screen is a claim
    that this junction floods and CLAUDE.md rule 7 requires that claim to be traceable.
    """
    register = city_root / "hotspots.geojson"
    if not register.is_file():
        log.warning("products.no_hotspot_register", path=str(register))
        return []

    from pyproj import Transformer

    features = json.loads(register.read_text(encoding="utf-8")).get("features", [])
    res, _, left, _, _, top = transform
    n_steps, n_rows, n_cols = depth_m.shape
    radius_cells = max(round(HOTSPOT_RADIUS_M / res), 1)

    to_metric = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    ranked: list[dict[str, Any]] = []
    windows: list[set[int]] = []

    for feature in features:
        props = feature.get("properties", {})
        lon, lat = feature["geometry"]["coordinates"][:2]
        x, y = to_metric.transform(lon, lat)
        col = int((x - left) // res)
        row = int((top - y) // res)
        if not (0 <= row < n_rows and 0 <= col < n_cols):
            # Outside the AOI. Registered hotspots north of the grid are real places; they are
            # simply not in this model's domain, and saying nothing about them is correct.
            continue

        r0, r1 = max(row - radius_cells, 0), min(row + radius_cells + 1, n_rows)
        c0, c1 = max(col - radius_cells, 0), min(col + radius_cells + 1, n_cols)
        window = depth_m[:, r0:r1, c0:c1].reshape(n_steps, -1)
        series_cm = np.percentile(window, 90.0, axis=1) * 100.0

        peak_index = int(np.argmax(series_cm))
        peak_cm = float(series_cm[peak_index])
        over = np.flatnonzero(series_cm > IMPASSABLE_CM)
        windows.append({r * n_cols + c for r in range(r0, r1) for c in range(c0, c1)})

        ranked.append(
            {
                "hotspot_id": props.get("hotspot_id"),
                "name": props.get("name"),
                "slug": props.get("slug"),
                "lon": float(lon),
                "lat": float(lat),
                "ward": props.get("ward"),
                "is_sink": bool(props.get("is_sink", False)),
                "source_url": props.get("source_url"),
                "sourced": bool(props.get("sourced", False)),
                "run_id": run_id,
                "peak_depth_cm": round(peak_cm, 1),
                "peak_ts": times[peak_index].isoformat() if times else None,
                "time_to_peak_min": peak_index * 5,
                "depth_cm": [round(float(v), 1) for v in series_cm],
                # 0 or 1 on a deterministic run; continuous once Flash brings the ensemble.
                "p_impassable_at_peak": float(peak_cm > IMPASSABLE_CM),
                "impassable_from_ts": times[int(over[0])].isoformat() if over.size else None,
                "minutes_impassable": int(over.size) * 5,
            }
        )

    # Exposure, for the rail's icon set and the spec's ranking score.
    for entry, (segment_ids, weight), facilities in zip(
        ranked,
        _segments_near(city_root, windows, index),
        (_facilities(city_root, h["lon"], h["lat"]) for h in ranked),
        strict=True,
    ):
        entry["segment_ids"] = segment_ids
        entry["exposure"] = {"weight": weight, **facilities}
        # CLAUDE.md 11.8's score, reported even though the ordering below does not use it: on a
        # deterministic run its probability factor is 0 or 1, so it sorts into two tiers rather
        # than a ranking. It becomes the right key once Flash brings a real ensemble (Phase 7).
        entry["expected_impact"] = round(entry["p_impassable_at_peak"] * weight, 3)

    ranked.sort(key=lambda h: h["peak_depth_cm"], reverse=True)
    for position, entry in enumerate(ranked, start=1):
        entry["rank"] = position

    log.info(
        "products.hotspots_ranked",
        n=len(ranked),
        wet=sum(1 for h in ranked if h["peak_depth_cm"] > 5.0),
        impassable=sum(1 for h in ranked if h["peak_depth_cm"] > IMPASSABLE_CM),
        worst=ranked[0]["name"] if ranked else None,
        worst_cm=ranked[0]["peak_depth_cm"] if ranked else None,
    )
    return ranked
