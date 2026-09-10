"""Routing, reachability and the road-condition feed (CLAUDE.md 12; tasks P8.4, P8.6).

Three endpoints and one feed. The route and the isochrones are the console's; the feed is the
one a navigation app or a transit operator would consume, which is the fifth deliverable the
ministry asked for (CLAUDE.md 2.2) and the reason the contract is GeoJSON with validity windows
rather than something VARUNA-shaped.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Body, Query

from varuna_api.state import api_error

log = structlog.get_logger("varuna.api.route")

router = APIRouter(prefix="/v1", tags=["route"])

MAX_FEED_SEGMENTS = 800
"""Segments in one road-conditions document. The whole wet set is 1,498 on the 2 July storm; the
feed carries the ones a driver would be stopped by, worst first."""


def _point(value: Any, field: str) -> tuple[float, float]:
    """Parse ``[lon, lat]`` or ``{"lon":, "lat":}``, refusing anything outside the world."""
    if isinstance(value, dict):
        pair = (value.get("lon"), value.get("lat"))
    elif isinstance(value, (list, tuple)) and len(value) >= 2:
        pair = (value[0], value[1])
    else:
        raise api_error(422, "bad_point", f"{field} must be [lon, lat] or {{lon, lat}}.")
    try:
        lon, lat = float(pair[0]), float(pair[1])  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise api_error(422, "bad_point", f"{field} must be two numbers, [lon, lat].") from None
    if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
        raise api_error(422, "bad_point", f"{field} is not a coordinate: [{lon}, {lat}].")
    return lon, lat


def _when(value: Any, field: str) -> datetime | None:
    if value in (None, ""):
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        raise api_error(
            422,
            "bad_time",
            f"{field} must be ISO 8601 with an offset, e.g. 2019-07-02T08:40:00+05:30.",
        ) from None


@router.post("/route", summary="Route around the forecast water, beside what a naive router does")
def route(body: Annotated[dict[str, Any], Body()]) -> dict[str, Any]:
    """Plan one trip.

    Body: ``{origin, destination, depart_at?, profile?, risk_tolerance?, run_id?}``.

    Returns both routes, because the comparison is the product: a dispatcher who only sees the
    safe route has no way to judge whether the detour was worth it.
    """
    from varuna_route.profiles import PROFILES
    from varuna_route.router import as_dict, plan

    origin = _point(body.get("origin"), "origin")
    destination = _point(body.get("destination"), "destination")
    vehicle = str(body.get("profile") or "ambulance")
    if vehicle not in PROFILES:
        raise api_error(
            422,
            "unknown_profile",
            f"No vehicle profile {vehicle!r}. Valid profiles: {', '.join(sorted(PROFILES))}.",
        )

    tolerance = body.get("risk_tolerance")
    try:
        result = plan(
            origin,
            destination,
            depart_at=_when(body.get("depart_at"), "depart_at"),
            vehicle=vehicle,
            risk_tolerance=float(tolerance) if tolerance is not None else None,
            run_id=body.get("run_id"),
        )
    except FileNotFoundError as error:
        raise api_error(404, "no_run", str(error)) from error
    return as_dict(result)


@router.get("/route/facilities", summary="Hospitals and fire stations the isochrones can start at")
def route_facilities(city: str = "mumbai") -> dict[str, Any]:
    """The pickable facilities, from the city's own asset layer."""
    from varuna_route.reach import facilities

    try:
        found = facilities(city)
    except FileNotFoundError as error:
        raise api_error(404, "no_city", str(error)) from error
    return {
        "city": city,
        "count": len(found),
        "facilities": [
            {
                "asset_id": f.asset_id,
                "name": f.name,
                "kind": f.kind,
                "lon": f.lon,
                "lat": f.lat,
            }
            for f in found
        ],
    }


@router.get("/reachability", summary="One facility's 5/10/15-minute catchment, against dry")
def reachability(
    facility: Annotated[str, Query(description="asset_id or exact name from /v1/route/facilities")],
    t: Annotated[str | None, Query(description="Instant to measure at, ISO 8601.")] = None,
    profile: str = "ambulance",
    city: str = "mumbai",
    run_id: str | None = None,
) -> dict[str, Any]:
    """Isochrones and the collapse flag."""
    from varuna_route.reach import as_dict
    from varuna_route.reach import reachability as compute

    try:
        result = compute(facility, at=_when(t, "t"), vehicle=profile, city=city, run_id=run_id)
    except KeyError as error:
        raise api_error(404, "unknown_facility", str(error).strip("'")) from error
    except FileNotFoundError as error:
        raise api_error(404, "no_run", str(error)) from error
    return as_dict(result)


@router.get("/feeds/road-conditions", summary="Impassable and degraded roads, as GeoJSON")
def road_conditions(
    profile: str = "car",
    run_id: str | None = None,
    city: str = "mumbai",
) -> dict[str, Any]:
    """The provider feed: every segment this run predicts will stop the given vehicle.

    One feature per segment, with the window it is impassable for. A navigation app does not want
    a depth in centimetres, it wants "closed from 08:20 to 10:05", so that is what this carries -
    with the depth beside it for anyone who does.
    """
    from varuna_route.forecast import load_depths
    from varuna_route.graph import load_graph
    from varuna_route.profiles import PROFILES
    from varuna_route.profiles import profile as get_profile

    if profile not in PROFILES:
        raise api_error(
            422,
            "unknown_profile",
            f"No vehicle profile {profile!r}. Valid profiles: {', '.join(sorted(PROFILES))}.",
        )
    try:
        depths = load_depths(run_id)
        graph = load_graph(city)
    except FileNotFoundError as error:
        raise api_error(404, "no_run", str(error)) from error

    vehicle = get_profile(profile)
    # One representative edge per segment carries its name and geometry endpoints.
    first_edge: dict[str, int] = {}
    for e, segment_id in enumerate(graph.edge_segment):
        first_edge.setdefault(segment_id, e)

    features: list[dict[str, Any]] = []
    for segment_id, series in depths.depth_cm.items():
        over = [k for k, value in enumerate(series) if value > vehicle.depth_cm]
        if not over:
            continue
        e = first_edge.get(segment_id)
        if e is None:
            continue
        tail = int(graph.edge_tail[e])
        head = int(graph.head[e])
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [round(float(graph.lon[tail]), 6), round(float(graph.lat[tail]), 6)],
                        [round(float(graph.lon[head]), 6), round(float(graph.lat[head]), 6)],
                    ],
                },
                "properties": {
                    "segment_id": segment_id,
                    "name": graph.edge_name[e] or None,
                    "condition": "impassable",
                    "profile": vehicle.key,
                    "peak_depth_cm": round(max(series), 1),
                    "from": depths.time_of(over[0]).isoformat(),
                    "to": depths.time_of(over[-1]).isoformat(),
                },
            }
        )

    features.sort(key=lambda f: -float(f["properties"]["peak_depth_cm"]))
    truncated = len(features) > MAX_FEED_SEGMENTS
    log.info(
        "api.road_conditions",
        run_id=depths.run_id,
        profile=vehicle.key,
        segments=len(features),
    )
    return {
        "type": "FeatureCollection",
        "run_id": depths.run_id,
        "valid_ts": depths.valid_ts.isoformat(),
        "profile": vehicle.key,
        "threshold_cm": vehicle.depth_cm,
        "count": len(features),
        "truncated": truncated,
        "features": features[:MAX_FEED_SEGMENTS],
        "notes": [
            "Forecast from a reconstructed replay of 2 July 2019, not a live observation.",
            f"A segment is listed when its predicted depth exceeds {vehicle.depth_cm:.0f} cm, "
            f"the depth at which a {vehicle.label.lower()} stops.",
        ],
    }
