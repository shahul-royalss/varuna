"""Reading flooded streets out of traffic that has stopped moving (CLAUDE.md 11.6, task P7.1).

This is the observation that makes VARUNA self-correcting. Nobody instruments a drain, but every
city already measures its own roads continuously, and a street under 20 cm of water stops
carrying traffic. The inference is indirect and the whole job here is to keep it honest: a jam is
evidence of flooding only when the jam has no other explanation.

**Three filters, in order.**

1. **Depth of the anomaly.** ``z = (v - mu_wd,hr) / sigma`` against the segment's own weekday-hour
   baseline, and the anomaly has to reach ``z < -2.5``. A segment's normal speed is its own; a
   trunk road at 12 km/h is congested and a lane in Dharavi at 12 km/h is a Tuesday.
2. **Persistence.** Two consecutive snapshots. One slow reading is a bus stopping.
3. **Spatial confounding.** Network-wide congestion is not flooding. An anomaly is rejected when
   its dry neighbours within 500 m are slow too - if the whole area has stopped, the cause is the
   area, not this street.

Only during rain, because the prior below is about water.

**The depth prior** is CLAUDE.md 11.6's, and it is deliberately vague: `v < 5 km/h` implies at
least 20 cm with a standard deviation of 8, `5-15 km/h` implies 10-20 cm. A stopped car says the
street is impassable, not how deep it is, and the EnKF should receive that uncertainty rather
than a made-up number.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC
from typing import TYPE_CHECKING

import numpy as np
import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only
    from datetime import datetime

    import pandas as pd

log = structlog.get_logger("varuna.pulse.traffic")

__all__ = [
    "ANOMALY_Z",
    "CONFOUNDER_RADIUS_M",
    "MIN_CONSECUTIVE",
    "NEIGHBOUR_Z",
    "TrafficObservation",
    "depth_prior_cm",
    "detect_anomalies",
]

ANOMALY_Z = -2.5
"""How far below its own baseline a segment must fall to count (CLAUDE.md 11.6).

2.5 standard deviations is about one snapshot in 160 by chance on a normal distribution. Mumbai
traffic is not normal and the synthetic feed carries 3 % deliberate confounders, which is what
the persistence and neighbour tests below are for."""

MIN_CONSECUTIVE = 2
"""Snapshots the anomaly must persist for. One is a bus at a stop; two is a street."""

CONFOUNDER_RADIUS_M = 500.0
"""How far to look for the "is the whole area slow?" test (CLAUDE.md 11.6)."""

NEIGHBOUR_Z = -1.0
"""A neighbour above this is behaving normally, so the anomaly is local and survives.

If *every* neighbour within 500 m is below it, the slowdown is regional - a procession, a
signal failure, the tail of a jam somewhere else - and attributing it to water on this segment
would teach the drain model something false."""


@dataclass(frozen=True, slots=True)
class TrafficObservation:
    """One segment inferred to be flooded, with the depth that inference supports."""

    segment_id: str
    ts: datetime
    speed_kmh: float
    baseline_kmh: float
    z: float
    depth_cm: float
    depth_sd_cm: float
    n_consecutive: int
    kind: str = "traffic"

    @property
    def weight(self) -> float:
        """Inverse variance, which is what the EnKF wants."""
        return 1.0 / max(self.depth_sd_cm**2, 1e-6)


def depth_prior_cm(speed_kmh: float) -> tuple[float, float]:
    """Depth implied by a speed, as (mean, sd) in cm (CLAUDE.md 11.6).

    Returns ``(0, 0)`` above 15 km/h: a street moving at 20 km/h is not evidence of any depth,
    and returning a small positive number would let normal traffic quietly pull the posterior.
    """
    if speed_kmh < 5.0:
        return 20.0, 8.0
    if speed_kmh < 15.0:
        return 15.0, 6.0
    return 0.0, 0.0


def detect_anomalies(
    speeds: pd.DataFrame,
    *,
    at: datetime,
    raining: bool = True,
    neighbours: dict[str, list[str]] | None = None,
    incident_segments: set[str] | None = None,
) -> list[TrafficObservation]:
    """Segments whose slowdown is best explained by water, at one snapshot.

    Args:
        speeds: the feed, with ``ts``, ``segment_id``, ``kmh`` and ``baseline_kmh``.
        at: the snapshot to score. Earlier snapshots are read for the persistence test.
        raining: when false, nothing is returned - the depth prior is about rain.
        neighbours: segment id to the ids within :data:`CONFOUNDER_RADIUS_M`, for the spatial
            test. Without it that test is skipped and the result says so in the log.
        incident_segments: segments the feed has tagged with a non-weather incident; rejected
            outright (CLAUDE.md 11.6's confounder handling).
    """
    if not raining or speeds.empty:
        return []

    frame = speeds.copy()
    frame["ts"] = _as_ts(frame["ts"])
    stamps = sorted(frame["ts"].unique())
    if not stamps:
        return []

    # `_as_ts` drops the offset after normalising to UTC, so the cutoff has to be made naive
    # the same way - comparing a tz-aware instant against a naive numpy datetime warns and then
    # gives the wrong answer by the offset, which on IST is five and a half hours of forecast.
    cutoff = np.datetime64(at.astimezone(UTC).replace(tzinfo=None))
    target = max((s for s in stamps if s <= cutoff), default=None)
    if target is None:
        return []
    history = [s for s in stamps if s <= target][-MIN_CONSECUTIVE:]
    if len(history) < MIN_CONSECUTIVE:
        return []

    # The baseline's spread is not in the feed, so it is estimated from the segment's own
    # deviation across the window. A feed that carries sigma should pass it through instead.
    window = frame[frame["ts"].isin(history)].copy()
    window["z"] = _z_scores(window)

    per_segment = window.groupby("segment_id")
    incidents = incident_segments or set()
    slow: dict[str, float] = {}
    observations: list[TrafficObservation] = []

    for segment_id, group in per_segment:
        z = float(group["z"].min())
        slow[str(segment_id)] = z

    rejected_incident = rejected_regional = 0
    for segment_id, group in per_segment:
        key = str(segment_id)
        ordered = group.sort_values("ts")
        if not bool((ordered["z"] < ANOMALY_Z).all()):
            continue  # did not persist across the window
        if key in incidents:
            rejected_incident += 1
            continue

        if neighbours is not None:
            nearby = [slow[n] for n in neighbours.get(key, []) if n in slow]
            # Every neighbour also slow -> the area is slow, not this street.
            if nearby and max(nearby) < NEIGHBOUR_Z:
                rejected_regional += 1
                continue

        latest = ordered.iloc[-1]
        speed = float(latest["kmh"])
        depth, sd = depth_prior_cm(speed)
        if depth <= 0.0:
            continue
        observations.append(
            TrafficObservation(
                segment_id=key,
                ts=at,
                speed_kmh=speed,
                baseline_kmh=float(latest["baseline_kmh"]),
                z=float(latest["z"]),
                depth_cm=depth,
                depth_sd_cm=sd,
                n_consecutive=len(ordered),
            )
        )

    log.info(
        "pulse.traffic_anomalies",
        at=str(at),
        n=len(observations),
        segments_scored=int(per_segment.ngroups),
        rejected_incident=rejected_incident,
        rejected_regional=rejected_regional,
        spatial_test=neighbours is not None,
    )
    return observations


def _as_ts(column: pd.Series) -> pd.Series:
    import pandas as pd

    return pd.to_datetime(column, utc=True, format="mixed").dt.tz_localize(None)


def _z_scores(window: pd.DataFrame) -> np.ndarray:
    """``(v - baseline) / sigma`` per row, with sigma from the segment's own scatter.

    A floor on sigma stops a segment whose baseline never varies from producing an infinite z
    the moment it moves at all.
    """
    deviation = window["kmh"].to_numpy(dtype=np.float64) - window["baseline_kmh"].to_numpy(
        dtype=np.float64
    )
    sigma = window.groupby("segment_id")["kmh"].transform("std").to_numpy(dtype=np.float64)
    sigma = np.where(np.isfinite(sigma) & (sigma > 1.0), sigma, np.maximum(
        window["baseline_kmh"].to_numpy(dtype=np.float64) * 0.2, 3.0
    ))
    return deviation / sigma
