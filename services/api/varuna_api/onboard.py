"""City-in-a-box as a background job (CLAUDE.md 7.9, 12; task P9.5).

The wizard on stage is `run_city` in a thread, with its fourteen pipeline steps folded into the
six the screen shows and its real log lines forwarded as they are written. Nothing here is
scripted: CLAUDE.md 7.9's acceptance criterion is that every line in the log stream comes from
the pipeline, so this module installs a structlog processor that copies whatever the pipeline
logs into the job's tail, rather than composing sentences of its own.

**Why a thread and not a subprocess.** The pipeline publishes progress on the in-process bus that
the WebSocket already relays, so a thread reaches the browser with no extra plumbing. It holds the
GIL only in numpy and rasterio calls that release it, and the API is doing nothing else while a
judge watches a progress bar.

**One job at a time.** Two concurrent builds of the same city would write the same files from two
threads. A second request while one is running gets the running job back rather than an error -
on stage, a double-click on "Start" must not produce a failure dialog.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import structlog
from varuna_schemas.constants import IST

log = structlog.get_logger("varuna.api.onboard")

__all__ = ["OnboardState", "get_job", "latest_job", "start_job"]

MAX_LOG_LINES = 400
"""Log lines kept per job. The screen shows the tail; this bounds the memory a long build costs."""

STEP_OF: dict[str, str] = {
    "cache": "fetch_open_data",
    "dem": "fetch_open_data",
    "osm": "fetch_open_data",
    "landcover": "fetch_open_data",
    "hotspots": "fetch_open_data",
    "assets": "fetch_open_data",
    "condition": "condition_terrain",
    "roughness": "condition_terrain",
    "depressions": "condition_terrain",
    "segments": "build_graph",
    "drains": "infer_drains",
    "units": "build_graph",
    "export": "build_graph",
    "report": "build_graph",
}
"""Which of the wizard's six steps each pipeline step belongs to (CLAUDE.md 7.9).

The wizard's list is the story - "fetch open data", "condition terrain", "infer drains" - and the
pipeline's is the work. Mapping them keeps the screen honest about *what* is happening without
making a judge read fourteen rows, and it means adding a pipeline step never silently drops off
the screen: an unmapped name falls back to the step the wizard was already on."""

ORDER: tuple[str, ...] = (
    "choose_area",
    "fetch_open_data",
    "condition_terrain",
    "infer_drains",
    "build_graph",
    "first_forecast",
)


@dataclass
class OnboardState:
    """One onboarding run, readable while it is still going."""

    job_id: str
    city: str
    design_storm: str
    from_cache_only: bool
    status: str = "queued"
    step: str = "choose_area"
    progress: float = 0.0
    started_at: datetime = field(default_factory=lambda: datetime.now(tz=IST))
    finished_at: datetime | None = None
    lines: list[str] = field(default_factory=list)
    first_run_id: str | None = None
    error: str | None = None
    steps_done: int = 0
    steps_total: int = 14
    failed_step: str | None = None
    """The pipeline step that broke first, once one has. Freezes `step` and `progress` there."""

    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def elapsed_s(self) -> float:
        end = self.finished_at or datetime.now(tz=IST)
        return max((end - self.started_at).total_seconds(), 0.0)

    def note(self, line: str) -> None:
        with self.lock:
            self.lines.append(line)
            if len(self.lines) > MAX_LOG_LINES:
                del self.lines[: len(self.lines) - MAX_LOG_LINES]

    def to_dict(self) -> dict[str, Any]:
        with self.lock:
            tail = self.lines[-40:]
        return {
            "job_id": self.job_id,
            "city": self.city,
            "status": self.status,
            "step": self.step,
            "progress": round(self.progress, 3),
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "elapsed_s": round(self.elapsed_s, 1),
            "log_tail": tail,
            "first_run_id": self.first_run_id,
            "error": self.error,
        }


_JOBS: dict[str, OnboardState] = {}
_LATEST: dict[str, str] = {}
_GUARD = threading.Lock()


class _Tap:
    """A structlog processor that copies this thread's log lines into its job.

    Keyed on the thread, so a build running beside ordinary API traffic captures its own lines and
    nothing else. It returns the event dict untouched, so the normal console output is unaffected.
    """

    def __init__(self) -> None:
        self.by_thread: dict[int, OnboardState] = {}

    def attach(self, state: OnboardState) -> None:
        self.by_thread[threading.get_ident()] = state

    def detach(self) -> None:
        self.by_thread.pop(threading.get_ident(), None)

    def __call__(self, logger: Any, name: str, event: dict[str, Any]) -> dict[str, Any]:
        state = self.by_thread.get(threading.get_ident())
        if state is None:
            return event
        message = str(event.get("event", ""))
        if not message.startswith("city."):
            return event
        # The pipeline logs structured key-values; rendering them back to one line keeps the
        # stream readable without inventing wording.
        extras = " ".join(
            f"{k}={v}"
            for k, v in event.items()
            if k not in {"event", "level", "timestamp", "logger"} and v is not None
        )
        state.note(f"{message} {extras}".strip())
        if event.get("step") and state.failed_step is None:
            mapped = STEP_OF.get(str(event["step"]))
            if mapped:
                state.step = mapped
        if message == "city.step_failed" and state.failed_step is None:
            # Stop the screen on the step that actually broke, having just mapped `step` to it.
            #
            # `run_city` does not stop at a failed step: it records the failure and runs the
            # remaining thirteen, each of which fails for want of an output the first one never
            # wrote. Without this freeze the bar walks on to 83 % and the wizard names the *last*
            # step it saw, so a judge watches the build die at "Build graph" when what is missing
            # is the open data at step one. The deployed wizard reported exactly that.
            state.failed_step = str(event.get("step") or "")
            return event
        if state.failed_step is not None:
            return event
        if message == "city.step":
            state.steps_done += 1
            # The build is five sixths of the job; the design-storm cycle is the last sixth.
            state.progress = min(0.83, state.steps_done / max(state.steps_total, 1) * 0.83)
        return event


_TAP = _Tap()


def install_tap() -> None:
    """Add the log tap to structlog's processor chain, once."""
    import structlog as sl

    config = sl.get_config()
    processors = list(config["processors"])
    if any(isinstance(p, _Tap) for p in processors):
        return
    # Before the renderer, which is always last and consumes the event dict.
    processors.insert(max(len(processors) - 1, 0), _TAP)
    sl.configure(processors=processors)


MIN_FREE_BYTES = 160 * 1024**2
"""Free space demanded before fetching tiles, sized on the two cities this project ships.

Measured, not guessed: Chennai's three tiles are 138.6 MB and Mumbai's are 143.1 MB (two
Copernicus GLO-30 degrees plus one 3-degree ESA WorldCover each, and the WorldCover tile is
~120 MB of that on its own). 160 MB covers either with room to spare.

The city folder is not counted because a rebuild overwrites it in place rather than adding to
it, and the tiles are dropped again straight after a fetch - see `_drop_fetched_tiles`. The
Railway volume is 500 MB with 311 MB already resident, so a floor much above this would refuse
a download that in fact fits.
"""


def _drop_fetched_tiles(state: OnboardState, tiles: list[Path]) -> None:
    """Delete the tiles this job downloaded, once the city they built is on disk.

    Only ever the files `_warm_cache` fetched in this run. A warm cache fetches nothing and so
    drops nothing, which is what protects the demo laptop: `tools/prefetch_city_cache.py` put
    those tiles there deliberately and CLAUDE.md 7.9 needs them for the offline rehearsal.

    This mirrors the Railway entrypoint's `drop_download_cache` and for the same reason - the
    500 MB volume already holds 311 MB, so 139 MB of tiles is affordable during a build and dead
    weight after one. The cost is honest: onboarding the same city again re-downloads.
    """
    freed = 0
    for tile in tiles:
        try:
            if tile.is_file():
                freed += tile.stat().st_size
                tile.unlink()
        except OSError as error:  # a tile we cannot remove is wasted space, not a failed build
            log.warning("onboard.tile_not_dropped", path=str(tile), error=str(error))
    if freed:
        state.note(
            f"Released {freed / 1e6:.0f} MB of downloaded tiles; the built city is what persists."
        )


def _warm_cache(state: OnboardState) -> list[Path]:
    """Put this city's open-data tiles on disk before the build asks for them.

    The pipeline never downloads. Its first step verifies `city/cache/` against the manifest and
    raises if a tile is missing (`varuna_city.cache`: "Phase 1 never downloads"). That is right on
    the demo laptop, where `tools/prefetch_city_cache.py` has already run and CLAUDE.md 7.9 wants
    the wizard to work with the venue's network off.

    It was wrong everywhere else, and that is why city-in-a-box did not work on the deployed site.
    The Railway entrypoint *deletes* the tiles after the first build - `drop_download_cache`, on
    purpose, because the 500 MB volume cannot hold both the 339 MB cache and the city it produces -
    so the wizard demanded a cache the deployment had removed by design. Every run failed at the
    `cache` step, and, before the freeze above, reported it as "Build graph" at 83 %.

    Three outcomes, each named in the log:

    * cache already warm -> return without touching the network (the stage path)
    * cache cold, downloading refused -> raise, naming the command that fills it
    * cache cold, downloading allowed -> fetch this city's tiles only, then build

    Returns the tiles it downloaded, so the caller can release them once the build has consumed
    them. Empty when the cache was already warm, which is what keeps a laptop's prefetched tiles
    untouched.
    """
    import os
    import shutil
    import subprocess
    import sys

    from varuna_city.cache import cache_root, verify_cache
    from varuna_city.config import load_city_config
    from varuna_schemas.paths import repo_root

    rows = verify_cache(load_city_config(state.city), strict=False)
    missing = [row for row in rows if not row.ok]
    if not missing:
        state.note(f"Open data already cached: {len(rows)} tiles present. Nothing to download.")
        return []

    names = ", ".join(row.key for row in missing)
    offline = state.from_cache_only or os.environ.get("VARUNA_OFFLINE") == "1"
    if offline:
        msg = (
            f"{len(missing)} of {len(rows)} open-data tiles are not cached ({names}), and this "
            f"job was asked not to download. Fill the cache with "
            f"`uv run python tools/prefetch_city_cache.py --city {state.city}`, or start the job "
            f"with from_cache_only=false to let it fetch them."
        )
        raise RuntimeError(msg)

    root = cache_root()
    root.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(root).free
    if free < MIN_FREE_BYTES:
        msg = (
            f"Not enough room to cache {state.city}'s open data: {free / 1e6:.0f} MB free at "
            f"{root}, and the tiles plus the city they build need about "
            f"{MIN_FREE_BYTES / 1e6:.0f} MB. Free space on the volume and start the job again."
        )
        raise RuntimeError(msg)

    script = repo_root() / "tools" / "prefetch_city_cache.py"
    if not script.is_file():
        msg = f"The prefetch tool is not in this image ({script}), so the tiles cannot be fetched."
        raise RuntimeError(msg)

    state.note(
        f"{len(missing)} tiles are not cached ({names}). Fetching them once from Copernicus and "
        f"ESA; {free / 1e6:.0f} MB free."
    )
    # Streamed rather than captured: CLAUDE.md 7.9's acceptance criterion is that every line the
    # wizard shows comes from the pipeline, and a download that takes a minute should say so while
    # it happens rather than in one block when it is over.
    # Fixed argv, no shell, script path derived from the repo root - not user input.
    process = subprocess.Popen(
        [sys.executable, str(script), "--city", state.city],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=str(repo_root()),
    )
    assert process.stdout is not None
    for line in process.stdout:
        if line.strip():
            state.note(line.rstrip())
    if process.wait() != 0:
        msg = (
            f"Fetching {state.city}'s open data failed (prefetch exited {process.returncode}). "
            f"The log above is the downloader's own output."
        )
        raise RuntimeError(msg)

    still_missing = [row.key for row in verify_cache(load_city_config(state.city)) if not row.ok]
    if still_missing:
        msg = f"Tiles are still missing after the fetch: {', '.join(still_missing)}."
        raise RuntimeError(msg)
    state.note(f"Open data cached. Building {state.city}.")
    return [Path(row.path) for row in missing]


def _run(state: OnboardState) -> None:
    from varuna_city.pipeline import STEPS, run_city

    _TAP.attach(state)
    state.status = "running"
    state.steps_total = len(STEPS)
    try:
        state.step = "fetch_open_data"
        state.note(f"Building {state.city} from {'cache' if state.from_cache_only else 'source'}.")
        fetched = _warm_cache(state)
        result = run_city(state.city)
        failed = [s for s in result.steps if s.status not in {"ok", "cached"}]
        if failed:
            names = ", ".join(s.name for s in failed)
            msg = f"The {state.city} build failed at: {names}."
            raise RuntimeError(msg)
        # Only after the build succeeded: a failed one is retried from what is already on disk,
        # and deleting the tiles first would make the retry re-download them.
        _drop_fetched_tiles(state, fetched)

        state.step = "first_forecast"
        state.progress = 0.85
        state.note(f"City built. Running the first cycle on {state.design_storm}.")
        state.first_run_id = _first_forecast(state)
        state.progress = 1.0
        state.status = "finished"
    except Exception as error:  # a build failure is a job outcome, not an API crash
        state.status = "failed"
        state.error = str(error)
        state.note(f"Failed: {error}")
        log.warning("onboard.failed", job=state.job_id, city=state.city, error=str(error))
    finally:
        state.finished_at = datetime.now(tz=IST)
        _TAP.detach()
        log.info(
            "onboard.done",
            job=state.job_id,
            city=state.city,
            status=state.status,
            elapsed_s=round(state.elapsed_s, 1),
            run_id=state.first_run_id,
        )


def _peak_cycle_ts(bundle: str) -> Any:
    """The cycle to issue the first forecast from: the storm's **median** frame.

    Two wrong answers were tried first, and both are instructive about what a nowcast is.

    **The bundle's first cycle** forecasts nothing. `CHN-IDF-25yr` builds from 40 dBZ at 05:40 to
    65 dBZ at 06:50; a nowcast issued at 06:00 can only extrapolate the 40 dBZ in front of it, so
    the AOI got 0.7 mm/h and not one street was wet. Sky was right and the answer was useless.

    **The peak frame** forecasts a catastrophe that is not in the bundle. A Chicago hyetograph is a
    single sharp spike with no advection: every frame is the same cell at a different intensity,
    so STEPS has no motion to extrapolate and simply persists whatever instant it was handed. Issue
    at the 65 dBZ peak and it holds 447 mm/h for three hours - the design storm specifies 150 mm
    of rain and the forecast delivered **609 mm**, a metre of water on the median street. Nothing
    was broken; the nowcast cannot know a spike is about to fall off, and a spike with no motion is
    a pathological thing to hand one.

    **The median frame** is the honest issue time. It is the intensity the storm actually sustains,
    so persisting it neither invents the peak nor misses the event. It is also what the design
    storm is *for*: a stated depth over a stated duration to drive the Twin, rather than a moving
    system to test a nowcast against.

    Returns None when the radar cannot be read, and the caller falls back to the default cycle.
    """
    from datetime import timedelta

    import numpy as np
    import zarr
    from varuna_replay.bundle import bundle_dir, load_manifest

    try:
        manifest = load_manifest(bundle)
        store = zarr.open(str(bundle_dir(bundle) / "radar" / "frames.zarr"), mode="r")
        dbz = np.asarray(store["dbz"])
        minutes = np.asarray(store["time_min"])
        per_frame = [
            float(np.nanmax(dbz[i])) if np.isfinite(dbz[i]).any() else float("-inf")
            for i in range(dbz.shape[0])
        ]
        usable = [v for v in per_frame if np.isfinite(v)]
        if not usable:
            return None
        median = float(np.median(usable))
        chosen = int(np.argmin([abs(v - median) for v in per_frame]))
        return manifest.t0 + timedelta(minutes=float(minutes[chosen]))
    except Exception as error:  # a bundle without readable radar still gets a default cycle
        log.warning("onboard.peak_cycle_failed", bundle=bundle, error=str(error))
        return None


def _first_forecast(state: OnboardState) -> str | None:
    """Run one cycle of the design storm on the newly built city.

    Returns the run id, or None with a note when the bundle is not there. A city built without a
    first forecast is still a city; refusing to report the build because the storm is missing
    would hide the thing that did work (CLAUDE.md 6.8).
    """
    from varuna_cycle.twin_cycle import run_cycle

    cycle_ts = _peak_cycle_ts(state.design_storm)
    if cycle_ts is not None:
        state.note(
            f"Forecasting from {cycle_ts:%H:%M} IST, the design storm's median frame - the "
            f"intensity it sustains rather than its instantaneous peak."
        )
    try:
        result = run_cycle(
            bundle=state.design_storm,
            cycle_ts=cycle_ts,
            city=state.city,
            mode="baked",
            overwrite=True,
        )
    except FileNotFoundError as error:
        state.note(
            f"No first forecast: the {state.design_storm} bundle is not built "
            f"(`make bundle BUNDLE={state.design_storm}`). The city itself is ready."
        )
        log.warning("onboard.no_bundle", city=state.city, error=str(error))
        return None
    state.note(
        f"First forecast published: {result.run_id}, peak {result.peak_depth_cm} cm on "
        f"{result.wet_segments} wet segments."
    )
    return result.run_id


def start_job(city: str, design_storm: str, from_cache_only: bool) -> OnboardState:
    """Start a build, or hand back the one already running for this city."""
    with _GUARD:
        running = _JOBS.get(_LATEST.get(city, ""))
        if running is not None and running.status in {"queued", "running"}:
            return running

        state = OnboardState(
            job_id=f"onboard-{city}-{uuid.uuid4().hex[:8]}",
            city=city,
            design_storm=design_storm,
            from_cache_only=from_cache_only,
        )
        _JOBS[state.job_id] = state
        _LATEST[city] = state.job_id

    install_tap()
    thread = threading.Thread(target=_run, args=(state,), name=f"onboard-{city}", daemon=True)
    thread.start()
    log.info("onboard.started", job=state.job_id, city=city, storm=design_storm)
    # A moment for the thread to mark itself running, so the first poll is not "queued" forever
    # if the caller polls immediately.
    time.sleep(0.05)
    return state


def get_job(job_id: str) -> OnboardState | None:
    return _JOBS.get(job_id)


def latest_job(city: str) -> OnboardState | None:
    return _JOBS.get(_LATEST.get(city, ""))
