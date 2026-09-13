"""Does the traffic detector's third filter actually run? (CLAUDE.md 11.6; task P7.1)

11.6 asks for three filters over a slowdown: it has to be deep against the segment's own
baseline, it has to persist, and it has to have no other explanation - "not explained by
network-wide congestion (neighbouring dry segments within 500 m have z > -1)". The first two are
exercised here because they decide what becomes an observation at all; the third is exercised
through the map ``run_pulse`` builds for it, because the filter was implemented and then never
handed the neighbours it needs, so it had never once fired on a real cycle.

The speeds are written the way the bundle writes them - ISO strings with an offset, one row per
segment per snapshot - so the frames below are the shape the detector meets in the pipeline.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString
from varuna_pulse.cycle import _neighbour_map
from varuna_pulse.traffic import detect_anomalies

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
CYCLE_TS = datetime(2019, 7, 2, 8, 40, tzinfo=IST)
SNAPSHOTS = [CYCLE_TS - timedelta(minutes=10), CYCLE_TS - timedelta(minutes=5), CYCLE_TS]

BASELINE_KMH = 40.0
"""An arterial's weekday-hour speed. The z-score is against this, not against a city average."""

FLOODED_KMH = 3.0
"""Under 5 km/h, which CLAUDE.md 11.6 reads as at least 20 cm of water."""

# UTM 43N (EPSG:32643), the CRS the Mumbai city build uses, so the 500 m radius is metres.
CRS = "EPSG:32643"
CLUSTER_X = 270_000.0
CLUSTER_Y = 2_101_800.0


def _speeds(rows: list[tuple[datetime, str, float]]) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "ts": ts.isoformat(),
                "segment_id": segment_id,
                "kmh": kmh,
                "baseline_kmh": BASELINE_KMH,
                "synthetic": True,
            }
            for ts, segment_id, kmh in rows
        ]
    )


def _write_segments(city_root: Path, places: dict[str, tuple[float, float]]) -> None:
    """A minimal ``segments.parquet``: one 20 m stub of road per segment, at a given point."""
    city_root.mkdir(parents=True, exist_ok=True)
    frame = gpd.GeoDataFrame(
        {"segment_id": list(places)},
        geometry=[LineString([(x - 10.0, y), (x + 10.0, y)]) for x, y in places.values()],
        crs=CRS,
    )
    frame.to_parquet(city_root / "segments.parquet")


def test_two_slow_snapshots_become_an_observation() -> None:
    """A street below the threshold on both snapshots is evidence of water."""
    speeds = _speeds(
        [
            (SNAPSHOTS[0], "S0-001", BASELINE_KMH),
            (SNAPSHOTS[1], "S0-001", FLOODED_KMH),
            (SNAPSHOTS[2], "S0-001", FLOODED_KMH),
        ]
    )

    observations = detect_anomalies(speeds, at=CYCLE_TS, raining=True)

    assert [o.segment_id for o in observations] == ["S0-001"]
    assert observations[0].z < -2.5
    assert observations[0].n_consecutive == 2
    # The depth the speed supports, with the uncertainty 11.6 attaches to it.
    assert (observations[0].depth_cm, observations[0].depth_sd_cm) == (20.0, 8.0)


def test_one_slow_snapshot_is_not_an_observation() -> None:
    """One dip in an otherwise normal window is a bus at a stop, not a flooded street.

    The persistence filter is what says so: the dip itself is deep (sigma is estimated from the
    snapshot before the window, where this street was moving normally, so the last reading is
    well past the threshold) but only the last of the two scored snapshots is below it.
    """
    speeds = _speeds(
        [
            (SNAPSHOTS[0], "S0-001", BASELINE_KMH),
            (SNAPSHOTS[1], "S0-001", BASELINE_KMH),
            (SNAPSHOTS[2], "S0-001", FLOODED_KMH),
        ]
    )

    assert detect_anomalies(speeds, at=CYCLE_TS, raining=True) == []


def test_a_slowdown_whose_neighbours_are_equally_slow_is_rejected(tmp_path: Path) -> None:
    """Three streets within 500 m all stopped is an area, not three floods.

    The neighbour map comes from ``run_pulse``'s own builder rather than from a literal, because
    the defect this test is here for was the map never being built: the filter was correct and
    the call site passed it nothing. ``S0-100``, five kilometres away with no neighbour in the
    feed, is the control - a local anomaly has to survive the filter or the filter is a mute.
    """
    clustered = {
        "S0-001": (CLUSTER_X, CLUSTER_Y),
        "S0-002": (CLUSTER_X + 150.0, CLUSTER_Y),
        "S0-003": (CLUSTER_X + 300.0, CLUSTER_Y),
    }
    places = {**clustered, "S0-100": (CLUSTER_X + 5_000.0, CLUSTER_Y)}
    _write_segments(tmp_path, places)
    speeds = _speeds(
        [
            (ts, segment_id, BASELINE_KMH if ts == SNAPSHOTS[0] else FLOODED_KMH)
            for ts in SNAPSHOTS
            for segment_id in places
        ]
    )

    untested = detect_anomalies(speeds, at=CYCLE_TS, raining=True)
    assert sorted(o.segment_id for o in untested) == sorted(places)

    neighbours = _neighbour_map(tmp_path, [o.segment_id for o in untested])
    assert neighbours["S0-001"] == ["S0-002", "S0-003"]
    assert neighbours["S0-100"] == []

    kept = detect_anomalies(speeds, at=CYCLE_TS, raining=True, neighbours=neighbours)
    assert [o.segment_id for o in kept] == ["S0-100"]


def test_sigma_comes_from_the_history_not_from_the_two_scored_snapshots() -> None:
    """How erratic the street normally is decides how deep its dip has to be.

    11.6 scores against the segment's own sigma. The feed carries no sigma, and taking it from
    the two snapshots being scored makes it ``|dv|/sqrt(2)`` - two streets equally slow at
    3 km/h then get the same z whatever their normal behaviour was, and on the 2 July feed
    42.4 % of rows fell through to the floor because a segment slow twice has no scatter at all.

    ``S0-ERRATIC`` swings between 20 and 60 km/h all hour, so 3 km/h is 1.77 of its standard
    deviations and not evidence; ``S0-STEADY`` holds 36-44, so the same 3 km/h is 8.86 of its
    own. Under a sigma taken from inside the window both would score -4.6 and both would be
    observations.
    """
    # Twelve snapshots ending ten minutes back, so the two scored below sit outside them.
    history = [CYCLE_TS - timedelta(minutes=5 * (n + 2)) for n in reversed(range(12))]
    swings = {"S0-ERRATIC": (20.0, 60.0), "S0-STEADY": (36.0, 44.0)}
    rows = [
        (ts, segment_id, swing[n % 2])
        for n, ts in enumerate(history)
        for segment_id, swing in swings.items()
    ]
    rows += [
        (ts, segment_id, FLOODED_KMH)
        for ts in (CYCLE_TS - timedelta(minutes=5), CYCLE_TS)
        for segment_id in swings
    ]

    observations = detect_anomalies(_speeds(rows), at=CYCLE_TS, raining=True)

    assert [o.segment_id for o in observations] == ["S0-STEADY"]
    assert observations[0].z < -7.0
