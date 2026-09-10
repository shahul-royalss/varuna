"""The depth a route reads off a run, per segment and per five-minute step (task P8.1).

**Read from ``segments_wet.json``, not from the parquet.** ``segment_forecast.parquet`` is the
product of record - 766,656 rows, every segment at every step - and re-reading 19 MB of it per
request would spend the whole 300 ms route budget on IO. The cycle also writes the compact form
this loads: only the segments the run ever wetted (1,498 of 21,296 on the 2 July storm), which is
the same information for routing purposes because a segment that never reaches 5 cm never changes
anybody's route.

**What the probabilities are worth.** A baked run is deterministic - ``ensemble_n`` is 1, because
Phase 7's 50-member products are not built - so ``P(h > threshold)`` here is 0 or 1 and the risk
tolerance has nothing to bite on. The router still carries the tolerance through, because the
interface is what it will be once the ensemble lands; every response says which it got
(CLAUDE.md 6, and the note is printed on screen, not buried).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path

import structlog
from varuna_schemas.paths import run_dir, runs_dir

log = structlog.get_logger("varuna.route.forecast")

__all__ = ["SegmentDepths", "latest_run_dir", "load_depths"]

STEP_MIN = 5
"""Forecast step, minutes. Matches the cycle's own step (CLAUDE.md 10.3)."""

DRY_CM = 5.0
"""Below this a segment is dry enough that no profile slows for it (CLAUDE.md 6.2 `--depth-dry`)."""


@dataclass(frozen=True, slots=True)
class SegmentDepths:
    """One run's depth series for every segment it wetted."""

    run_id: str
    times: tuple[datetime, ...]
    """The instant each forecast step is valid at, as the cycle wrote them."""

    depth_cm: dict[str, list[float]]
    n_steps: int
    n_total: int
    """Segments in the city, wet or not - so the response can say 1,498 of 21,296."""

    ensemble_n: int

    @property
    def valid_ts(self) -> datetime:
        """When the forecast starts."""
        return self.times[0]

    def step_at(self, when: datetime) -> int:
        """Which forecast step covers an instant, clamped to the run's window.

        Clamped rather than refused: a route that runs past the end of the forecast is a real
        request ("leave at 09:30, the forecast ends at 09:40"), and holding the last step is the
        honest answer - the water at +180 min is the last thing this run knows.
        """
        delta = (when - self.times[0]).total_seconds() / 60.0
        return max(0, min(self.n_steps - 1, int(delta // STEP_MIN)))

    def depth_at(self, segment_id: str, step: int) -> float:
        """Depth in cm on a segment at a step; 0 for anything the run never wetted."""
        series = self.depth_cm.get(segment_id)
        if not series:
            return 0.0
        return series[step] if step < len(series) else series[-1]

    def peak(self, segment_id: str) -> float:
        series = self.depth_cm.get(segment_id)
        return max(series) if series else 0.0

    def time_of(self, step: int) -> datetime:
        if step < len(self.times):
            return self.times[step]
        return self.times[-1] + timedelta(minutes=STEP_MIN * (step - len(self.times) + 1))


def latest_run_dir(city: str = "mumbai") -> Path:
    """The newest run **for a city** that carries a segment forecast.

    The city filter is load-bearing. Runs from every city share `data/runs/` and their ids sort
    chronologically, so once Chennai was onboarded its `CHN-` runs sorted above Mumbai's and the
    router began planning Mumbai trips against Chennai depths - a wrong answer that looked
    entirely normal.

    Raises:
        FileNotFoundError: nothing is baked. The message carries the command that fixes it.
    """
    from varuna_schemas.models.run import RunIdError, city_code

    try:
        prefix = f"{city_code(city)}-"
    except RunIdError:
        prefix = ""
    root = runs_dir()
    candidates = (
        [
            p
            for p in sorted(root.iterdir(), reverse=True)
            if p.is_dir()
            and (not prefix or p.name.startswith(prefix))
            and (p / "segments_wet.json").is_file()
        ]
        if root.is_dir()
        else []
    )
    if not candidates:
        msg = (
            "No baked run to route against. Press Play on the replay, or run "
            "`make bake BUNDLE=MUM-2019-07-02`."
        )
        raise FileNotFoundError(msg)
    return candidates[0]


@lru_cache(maxsize=4)
def _load(path_str: str, mtime_ns: int) -> SegmentDepths:
    del mtime_ns  # part of the cache key: a re-baked run invalidates itself.
    path = Path(path_str)
    wet = json.loads((path / "segments_wet.json").read_text(encoding="utf-8"))
    depth = {str(k): [float(v) for v in series] for k, series in wet.get("depth_cm", {}).items()}
    n_steps = max((len(v) for v in depth.values()), default=1)
    # `valid_ts` is the list of step times, one per forecast step, exactly as the cycle wrote it.
    stamps = wet.get("valid_ts") or []
    times = tuple(datetime.fromisoformat(str(t)) for t in stamps)
    if not times:
        msg = f"{path.name}/segments_wet.json carries no step times; it cannot be routed against."
        raise ValueError(msg)

    ensemble_n = 1
    meta_path = path / "run.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        ensemble_n = int(meta.get("ensemble_n", 1) or 1)

    depths = SegmentDepths(
        run_id=str(wet.get("run_id", path.name)),
        times=times,
        depth_cm=depth,
        n_steps=n_steps,
        n_total=int(wet.get("n_segments_total", len(depth))),
        ensemble_n=ensemble_n,
    )
    log.info(
        "route.depths_loaded",
        run_id=depths.run_id,
        wet=len(depth),
        total=depths.n_total,
        steps=n_steps,
    )
    return depths


def load_depths(run_id: str | None = None, city: str = "mumbai") -> SegmentDepths:
    """Load a run's segment depths, cached on the file's mtime."""
    path = run_dir(run_id) if run_id else latest_run_dir(city)
    wet = path / "segments_wet.json"
    if not wet.is_file():
        msg = f"Run {path.name} has no segment forecast; it cannot be routed against."
        raise FileNotFoundError(msg)
    return _load(str(path), wet.stat().st_mtime_ns)
