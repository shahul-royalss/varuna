"""Citizen reports as observations (CLAUDE.md 11.6, 7.11; task P7.2).

A person standing in the water is the only observation VARUNA gets that measures depth directly,
and the depth chips are chosen so they can: ankle, knee and waist are body landmarks, not
guesses at a number. What the reporter is actually being asked is "how deep is it on you", which
people are good at, instead of "how many centimetres", which nobody is.

**The chips and their spread** are CLAUDE.md 11.6's: 10 / 45 / 90 cm with sd 8 / 12 / 15. The
spread widens with depth because the landmarks are further apart up the body and because deep
water is harder to stand in and judge.

**Deduplication** is 50 m and 10 minutes, also from the spec. Six people reporting one flooded
junction is one observation about the junction, not six - and treating it as six would let a
busy street outvote a quiet one in the EnKF for reasons that have nothing to do with water.

Every report carries whether it is synthetic. The bundle's stream is (labelled) synthetic; a
report posted through ``POST /v1/reports`` on the day is not, and the two must stay
distinguishable in the observation record (rule 7).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only
    from datetime import datetime
    from pathlib import Path

log = structlog.get_logger("varuna.pulse.reports")

__all__ = [
    "DEDUPE_MINUTES",
    "DEDUPE_RADIUS_M",
    "DEPTH_CHIPS",
    "ReportObservation",
    "observations_from",
    "read_reports",
]

DEPTH_CHIPS: dict[str, tuple[float, float]] = {
    "ankle": (10.0, 8.0),
    "knee": (45.0, 12.0),
    "waist": (90.0, 15.0),
}
"""Chip to (depth cm, sd cm), from CLAUDE.md 11.6."""

DEDUPE_RADIUS_M = 50.0
DEDUPE_MINUTES = 10.0


@dataclass(frozen=True, slots=True)
class ReportObservation:
    """One de-duplicated citizen report, ready for assimilation."""

    report_id: str
    ts: datetime
    lon: float
    lat: float
    depth_cm: float
    depth_sd_cm: float
    chip: str
    place: str | None
    synthetic: bool
    n_merged: int = 1
    kind: str = "report"

    @property
    def weight(self) -> float:
        """Inverse variance, sharpened by agreement.

        Two independent people saying "knee" at the same junction is stronger evidence than one,
        so the merged spread narrows as ``sd / sqrt(n)`` - the standard error of a mean. It does
        not narrow without limit: `n_merged` is capped where it is used, because six reports from
        one crowd are not six independent measurements.
        """
        sd = self.depth_sd_cm / math.sqrt(min(self.n_merged, 4))
        return 1.0 / max(sd**2, 1e-6)


def _metres_apart(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Local flat-earth distance; exact enough at the 50 m scale this is used for."""
    lon_m = 111_320.0 * math.cos(math.radians(lat1))
    return math.hypot((lon2 - lon1) * lon_m, (lat2 - lat1) * 110_540.0)


def observations_from(rows: list[dict[str, Any]], *, until: datetime) -> list[ReportObservation]:
    """De-duplicate raw reports into observations, keeping only those already made.

    ``until`` matters on a replay: a cycle at 07:40 must not assimilate a report filed at 08:20.
    Letting the future leak in is the easiest way to build a system that verifies beautifully and
    forecasts nothing.
    """
    parsed: list[ReportObservation] = []
    for row in rows:
        chip = str(row.get("depth_hint") or "").lower()
        if chip not in DEPTH_CHIPS:
            continue
        ts = _parse_ts(row.get("ts"))
        if ts is None or ts > until:
            continue
        depth, sd = DEPTH_CHIPS[chip]
        parsed.append(
            ReportObservation(
                report_id=str(row.get("id") or f"RPT-{len(parsed)}"),
                ts=ts,
                lon=float(row["lon"]),
                lat=float(row["lat"]),
                depth_cm=depth,
                depth_sd_cm=sd,
                chip=chip,
                place=row.get("place"),
                synthetic=bool(row.get("synthetic", False)),
            )
        )

    parsed.sort(key=lambda r: r.ts)
    kept: list[ReportObservation] = []
    merged: list[int] = []
    for report in parsed:
        hit = None
        for index, existing in enumerate(kept):
            close = _metres_apart(existing.lon, existing.lat, report.lon, report.lat)
            recent = abs((report.ts - existing.ts) / timedelta(minutes=1)) <= DEDUPE_MINUTES
            if close <= DEDUPE_RADIUS_M and recent:
                hit = index
                break
        if hit is None:
            kept.append(report)
            merged.append(1)
        else:
            merged[hit] += 1

    out = [
        ReportObservation(
            report_id=report.report_id,
            ts=report.ts,
            lon=report.lon,
            lat=report.lat,
            depth_cm=report.depth_cm,
            depth_sd_cm=report.depth_sd_cm,
            chip=report.chip,
            place=report.place,
            synthetic=report.synthetic,
            n_merged=count,
        )
        for report, count in zip(kept, merged, strict=True)
    ]
    log.info(
        "pulse.reports",
        raw=len(parsed),
        observations=len(out),
        merged=len(parsed) - len(out),
        until=str(until),
    )
    return out


def read_reports(bundle_dir: Path, *, until: datetime) -> list[ReportObservation]:
    """Read ``reports.jsonl`` from a replay bundle and de-duplicate it."""
    path = bundle_dir / "reports.jsonl"
    if not path.is_file():
        return []
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return observations_from(rows, until=until)


def _parse_ts(value: object) -> datetime | None:
    from datetime import datetime as dt

    if isinstance(value, dt):
        return value
    if not isinstance(value, str):
        return None
    try:
        return dt.fromisoformat(value)
    except ValueError:
        return None
