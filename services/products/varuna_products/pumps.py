"""Where to send the pumps, and what it buys (CLAUDE.md 11.10, 7.6; tasks P8.9, P8.10).

**The inventory is synthetic and says so.** `city/<city>/assets.geojson` carries twelve mobile
pumps with `synthetic: true` and a note saying their capacity and status are invented; only the
depot coordinates are real OSM ward offices. Every product here carries that label forward, and
the board prints it in its header (CLAUDE.md rule 6).

**The benefit model, stated in full.** CLAUDE.md 11.10 wants benefit as "minutes above 45 cm
avoided", measured by re-running the emulator with the extra outflow. Flash-lite is Phase 7, so
there is no emulator to re-run and the honest alternative is an explicit reduced model rather
than a plausible-looking number:

    A pump at the hotspot removes `capacity_m3_per_h` from the water ponded over its
    neighbourhood - the same 45 m disc the depth is sampled over - which lowers the depth series
    at a constant rate of `capacity / area` metres per hour from the moment it arrives. The
    minutes above the threshold are then recounted on the lowered series.

That is a bathtub: it ignores the inflow that keeps arriving, the drain that is already pulling
water out, and the fact that a junction is not a cylinder. It will overstate the benefit of a
pump at a spot that is still filling. It is labelled ``reduced_model`` in the output and
"Bathtub estimate, not a physics run" on screen, and Phase 7 replaces it with the emulator
behind the same interface.

**The optimiser** is the greedy of CLAUDE.md 11.10 (P0; MILP is P1): pumps in descending
capacity, each to the hotspot with the largest weighted remaining excess, one hotspot per pump.
"""

from __future__ import annotations

import json
import math
from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pathlib import Path

log = structlog.get_logger("varuna.products.pumps")

__all__ = [
    "BENEFIT_LABEL",
    "PUMP_THRESHOLD_CM",
    "TRAVEL_SPEED_KMH",
    "build_pump_plan",
    "write_pump_plan",
]

PUMP_THRESHOLD_CM = 45.0
"""The depth pumping is judged against: `--depth-4`, where buses and trucks stop (CLAUDE.md 6.2).

CLAUDE.md 11.10 measures a pump's benefit in "minutes above 45 cm avoided", so this is the
spec's number rather than a choice."""

HOTSPOT_RADIUS_M = 45.0
"""The disc the depth series describes, and therefore the area a pump is drawing down.

The same radius `varuna_products.hotspots` samples over, so the depth being lowered and the area
it is spread across are the same patch of ground."""

TRAVEL_SPEED_KMH = 18.0
"""Assumed speed for a pump lorry crossing a flooding city.

A choice, and a conservative one: Mumbai traffic on a dry weekday averages more, and this is a
monsoon morning with streets closing. It is used only for the ETA on the dispatch order, never
for the benefit - the arrival time shifts when the drawdown starts, which is why it appears at
all. Route-aware travel time arrives with the routing service in P8.1."""

BENEFIT_LABEL = "Bathtub estimate, not a physics run"
"""What the board prints beside every benefit number (rule 6)."""


def _minutes_above(series: list[float], threshold: float, step_min: int) -> int:
    return sum(step_min for value in series if value > threshold)


def _drawn_down(
    series: list[float], rate_cm_per_step: float, from_step: int
) -> list[float]:
    """The depth series with a pump running from ``from_step``.

    The drawdown accumulates - a pump that has been running for an hour has removed an hour of
    water - and depth is floored at zero, because a pump cannot make a street concave.
    """
    out = list(series)
    removed = 0.0
    for i in range(from_step, len(out)):
        removed += rate_cm_per_step
        out[i] = max(out[i] - removed, 0.0)
    return out


def _haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def build_pump_plan(
    hotspots: list[dict[str, Any]],
    city_root: Path,
    run_id: str,
    step_min: int = 5,
    streets: dict[str, list[float]] | None = None,
    street_points: dict[str, tuple[float, float]] | None = None,
) -> dict[str, Any]:
    """Assign the synthetic pump fleet to the places that flood, greedily by benefit.

    Only places that actually cross the threshold are candidates: dispatching a lorry to a
    junction the forecast keeps below 45 cm is the kind of thing an operator would notice, and a
    board that suggests it stops being trusted.

    Candidates are the chronic register **and** the named streets, for the same reason the alert
    queue carries both - on a cycle where the register stays below 45 cm and 226 streets do not,
    a board scoped to hotspots would send twelve pumps nowhere.
    """
    assets_path = city_root / "assets.geojson"
    if not assets_path.is_file():
        return {"run_id": run_id, "pumps": [], "assignments": [], "unassigned": []}

    features = json.loads(assets_path.read_text(encoding="utf-8")).get("features", [])
    pumps = []
    for feature in features:
        props = feature.get("properties", {})
        if props.get("kind") != "mobile_pump":
            continue
        lon, lat = feature["geometry"]["coordinates"][:2]
        pumps.append(
            {
                "pump_id": props.get("asset_id"),
                "capacity_m3_per_h": float(props.get("capacity_m3_per_h") or 0.0),
                "depot": props.get("depot"),
                "status": props.get("status", "available"),
                "lon": float(lon),
                "lat": float(lat),
                "synthetic": bool(props.get("synthetic", True)),
            }
        )
    pumps.sort(key=lambda p: -p["capacity_m3_per_h"])

    area_m2 = math.pi * HOTSPOT_RADIUS_M**2
    candidates: list[dict[str, Any]] = []
    for hotspot in hotspots:
        series = [float(v) for v in hotspot.get("depth_cm", [])]
        before = _minutes_above(series, PUMP_THRESHOLD_CM, step_min)
        if before <= 0:
            continue
        candidates.append({"hotspot": hotspot, "series": series, "minutes_before": before})

    for street, series in (streets or {}).items():
        point = (street_points or {}).get(street)
        if point is None:
            continue  # no coordinate, nowhere to send a lorry
        values = [float(v) for v in series]
        before = _minutes_above(values, PUMP_THRESHOLD_CM, step_min)
        if before <= 0:
            continue
        candidates.append(
            {
                # Shaped like a hotspot so the loop below does not care which it is; the id is
                # prefixed so a street can never collide with a register entry.
                "hotspot": {
                    "hotspot_id": f"street:{street}",
                    "name": street,
                    "lon": point[0],
                    "lat": point[1],
                    "exposure": {"weight": 0.5},
                },
                "series": values,
                "minutes_before": before,
            }
        )
    candidates.sort(key=lambda c: -c["minutes_before"])

    assignments: list[dict[str, Any]] = []
    taken: set[str] = set()
    for pump in pumps:
        best: dict[str, Any] | None = None
        for candidate in candidates:
            hotspot = candidate["hotspot"]
            key = str(hotspot.get("hotspot_id"))
            if key in taken:
                continue

            travel_min = (
                _haversine_km(pump["lon"], pump["lat"], hotspot["lon"], hotspot["lat"])
                / TRAVEL_SPEED_KMH
                * 60.0
            )
            arrive_step = int(travel_min // step_min)
            if arrive_step >= len(candidate["series"]):
                continue  # arrives after the forecast ends; it cannot help in this window

            # m3/h over the disc, as cm of depth per 5-minute step.
            rate_cm_per_step = (
                pump["capacity_m3_per_h"] / area_m2 * 100.0 * (step_min / 60.0)
            )
            after = _minutes_above(
                _drawn_down(candidate["series"], rate_cm_per_step, arrive_step),
                PUMP_THRESHOLD_CM,
                step_min,
            )
            saved = candidate["minutes_before"] - after
            # Weighted by exposure: two junctions saving the same minutes are not equal if one
            # of them is beside a hospital.
            weight = float(hotspot.get("exposure", {}).get("weight") or 0.5)
            score = saved * (0.5 + weight)
            if saved > 0 and (best is None or score > best["score"]):
                best = {
                    "score": score,
                    "hotspot_id": key,
                    "hotspot_name": hotspot.get("name"),
                    "lon": hotspot.get("lon"),
                    "lat": hotspot.get("lat"),
                    "pump_id": pump["pump_id"],
                    "capacity_m3_per_h": pump["capacity_m3_per_h"],
                    "depot": pump["depot"],
                    "eta_min": round(travel_min),
                    "minutes_before": candidate["minutes_before"],
                    "minutes_after": after,
                    "minutes_saved": saved,
                }

        if best is not None:
            taken.add(best["hotspot_id"])
            assignments.append(best)

    plan = {
        "run_id": run_id,
        "threshold_cm": PUMP_THRESHOLD_CM,
        "benefit_model": "reduced_model",
        "benefit_label": BENEFIT_LABEL,
        "inventory": "synthetic",
        "travel_speed_kmh": TRAVEL_SPEED_KMH,
        "n_pumps": len(pumps),
        "pumps": pumps,
        "assignments": assignments,
        "unassigned": [
            {
                "hotspot_id": c["hotspot"].get("hotspot_id"),
                "name": c["hotspot"].get("name"),
                "minutes_above": c["minutes_before"],
            }
            for c in candidates
            if str(c["hotspot"].get("hotspot_id")) not in taken
        ],
        "total_minutes_saved": sum(a["minutes_saved"] for a in assignments),
    }
    log.info(
        "products.pump_plan",
        run_id=run_id,
        pumps=len(pumps),
        assigned=len(assignments),
        candidates=len(candidates),
        minutes_saved=plan["total_minutes_saved"],
    )
    return plan


def write_pump_plan(run_dir: Path, plan: dict[str, Any]) -> None:
    """Write ``pump_plan.json`` into a run directory (CLAUDE.md 10.3)."""
    (run_dir / "pump_plan.json").write_text(
        json.dumps(plan, separators=(",", ":")), encoding="utf-8"
    )
