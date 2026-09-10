"""Citizen and field observation ingestion (CLAUDE.md 12, 7.11; task P9.4, completing P7.2).

A report is stored, de-duplicated through the same code path Pulse uses on the replay stream, and
acknowledged with the number of streets it will inform.

**What the acknowledgement can honestly say.** CLAUDE.md 7.11 wants "Thanks - your report improved
the forecast for 3 streets", and that number is Pulse's: segments whose p50 moves by more than
3 cm once the EnKF has assimilated the observation. That happens on the *next* cycle, not inside
this request - assimilating one report against the whole drain graph is seconds of work, and a
citizen pressing Send on a phone should not wait for it.

So the response returns what is true now: how many streets this run already has water on within
the radius the report can inform, and a message that says the forecast is updated on the next
cycle. `feedback_streets` stays null until a cycle has actually run, rather than carrying a
number this request did not compute (rule 6).
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import structlog
from fastapi import APIRouter, status
from varuna_schemas.paths import data_dir, runs_dir

from varuna_api.state import api_error

log = structlog.get_logger("varuna.api.reports")

router = APIRouter(prefix="/v1", tags=["observations"])

IST = timezone(timedelta(hours=5, minutes=30))

INFORM_RADIUS_M = 400.0
"""How far a report can speak for.

A person reports the water they are standing in. The pipes under the next four hundred metres are
the ones an assimilation can plausibly move from it - beyond that the hydraulic connection is
weaker than the noise. The same order as `varuna_pulse.enkf`'s three-hop localisation."""

DEPTH_CHIPS: dict[str, float] = {"ankle": 10.0, "knee": 45.0, "waist": 90.0}
"""Body landmarks to centimetres (CLAUDE.md 11.6). Kept in step with `varuna_pulse.reports`."""


def _inbox() -> Path:
    return Path(data_dir()) / "reports" / "inbox.jsonl"


def _metres(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    lon_m = 111_320.0 * math.cos(math.radians(lat1))
    return math.hypot((lon2 - lon1) * lon_m, (lat2 - lat1) * 110_540.0)


def _streets_near(lon: float, lat: float) -> tuple[int, str | None]:
    """Wet streets within :data:`INFORM_RADIUS_M` of a point in the newest run."""
    root = runs_dir()
    if not root.is_dir():
        return 0, None
    runs = [p for p in sorted(root.iterdir(), reverse=True) if (p / "segments_wet.json").is_file()]
    if not runs:
        return 0, None

    from varuna_route.graph import load_graph

    path = runs[0]
    wet = json.loads((path / "segments_wet.json").read_text(encoding="utf-8"))
    graph = load_graph("mumbai")
    first: dict[str, int] = {}
    for e, segment_id in enumerate(graph.edge_segment):
        first.setdefault(segment_id, e)

    count = 0
    for segment_id in wet.get("depth_cm", {}):
        e = first.get(segment_id)
        if e is None:
            continue
        tail = int(graph.edge_tail[e])
        if _metres(lon, lat, float(graph.lon[tail]), float(graph.lat[tail])) <= INFORM_RADIUS_M:
            count += 1
    return count, str(wet.get("run_id", path.name))


@router.post(
    "/reports",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Citizen or field observation (depth chips ankle/knee/waist)",
)
def create_report(body: dict[str, Any]) -> dict[str, Any]:
    """Accept one report and queue it for the next cycle's assimilation."""
    chip = str(body.get("depth_hint", "")).lower()
    if chip not in DEPTH_CHIPS:
        raise api_error(
            422,
            "bad_depth_hint",
            f"depth_hint must be one of {', '.join(sorted(DEPTH_CHIPS))} - the body landmarks the "
            "report flow offers.",
        )
    try:
        lat = float(body["lat"])
        lon = float(body["lon"])
    except (KeyError, TypeError, ValueError):
        raise api_error(422, "bad_location", "A report needs a lat and a lon.") from None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        raise api_error(422, "bad_location", f"That is not a coordinate: [{lon}, {lat}].")

    now = datetime.now(tz=IST)
    ts = str(body.get("ts") or now.isoformat())
    report_id = f"rpt-{int(now.timestamp() * 1000):d}"
    row = {
        "id": report_id,
        "ts": ts,
        "received_at": now.isoformat(),
        "lat": lat,
        "lon": lon,
        "depth_hint": chip,
        "depth_cm": DEPTH_CHIPS[chip],
        "text": str(body.get("text") or "")[:280] or None,
        # The photo is not stored: it is a data URL of up to a few megabytes per report, this
        # service has a 500 MB volume, and nothing in the pipeline reads it. Whether one was
        # attached is worth keeping, because it is a trust signal for a later reporter weighting.
        "has_photo": bool(body.get("photo_data_url")),
        "source": str(body.get("source") or "public-map"),
        "synthetic": False,
    }

    inbox = _inbox()
    inbox.parent.mkdir(parents=True, exist_ok=True)
    with inbox.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, separators=(",", ":")) + "\n")

    near, run_id = _streets_near(lon, lat)
    log.info("api.report", report_id=report_id, chip=chip, near=near, run_id=run_id)
    return {
        "id": report_id,
        "accepted": True,
        "run_id": run_id,
        "streets_nearby": near,
        # Null on purpose: the count of streets whose forecast this report *changed* is Pulse's,
        # and Pulse runs on the next cycle. See the module docstring.
        "feedback_streets": None,
        "message": (
            f"Thanks. Your report is queued against {near} street"
            f"{'' if near == 1 else 's'} VARUNA is already forecasting water on; the next cycle "
            "assimilates it."
            if near
            else "Thanks. Your report is queued; the next cycle assimilates it."
        ),
    }


@router.get("/reports", summary="Reports received since the service started")
def list_reports(limit: int = 50) -> dict[str, Any]:
    """The inbox, newest first. What the drain X-ray's timeline reads before a cycle has run."""
    inbox = _inbox()
    if not inbox.is_file():
        return {"count": 0, "reports": []}
    rows = [json.loads(line) for line in inbox.read_text(encoding="utf-8").splitlines() if line]
    rows.reverse()
    return {"count": len(rows), "reports": rows[: max(1, min(limit, 500))]}
