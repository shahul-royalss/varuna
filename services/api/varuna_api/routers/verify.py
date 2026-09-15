"""Verification scores for one event (CLAUDE.md 12, 7.10; task P9.7).

Every number comes from `varuna_verify`, computed from run artifacts and the bundle's curated
pins. Nothing here is typed in, and what cannot be computed is returned as an `unavailable` entry
with the reason rather than as a plausible figure (rule 6).

**Scored once per set of inputs.** The sweep reads every run's wet streets and routes against the
city graph: 9-10 s warm on the laptop and far longer on a shared host, and every top bar and the
landing page ask for it. The answer is kept until an input changes - the bundle's ground truth or
any run's `segments_wet.json` (added, removed or rewritten) - so a new bake is scored again and
a page load never recomputes a score nobody's inputs moved. Concurrent first requests wait for
the one computation rather than each starting their own.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Query

from varuna_api.state import api_error

log = structlog.get_logger("varuna.api.verify")

router = APIRouter(prefix="/v1", tags=["verification"])

_cache: dict[str, tuple[tuple[Any, ...], dict[str, Any]]] = {}
_lock = threading.Lock()


def _stat(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_size, stat.st_mtime_ns


def inputs_fingerprint(event: str) -> tuple[Any, ...]:
    """What the sweep for ``event`` reads: its ground truth and every run's wet streets."""
    from varuna_schemas.paths import bundles_dir, runs_dir

    parts: list[Any] = [_stat(Path(bundles_dir()) / event / "ground_truth.geojson")]
    root = runs_dir()
    if root.is_dir():
        for run in sorted(root.iterdir()):
            wet = _stat(run / "segments_wet.json")
            if wet is not None:
                parts.append((run.name, *wet))
    return tuple(parts)


def scored_sweep(event: str) -> dict[str, Any]:
    """``varuna_verify.event.sweep(event)``, recomputed only when its inputs have changed."""
    from varuna_verify.event import sweep

    with _lock:
        key = inputs_fingerprint(event)
        hit = _cache.get(event)
        if hit is not None and hit[0] == key:
            return hit[1]
        result = sweep(event)
        _cache[event] = (key, result)
        log.info("verify.scored", bundle=event, runs=len(key) - 1)
        return result


def clear_cache() -> None:
    """Forget every kept score (tests)."""
    with _lock:
        _cache.clear()


@router.get("/verification", summary="Scores for an event against its sourced ground truth")
def verification(
    event: Annotated[str, Query(description="Bundle id, e.g. MUM-2019-07-02")] = "MUM-2019-07-02",
) -> dict[str, Any]:
    """Detection, timing and the threshold sweep, plus what could not be scored and why."""
    try:
        return scored_sweep(event)
    except FileNotFoundError as error:
        raise api_error(404, "no_ground_truth", str(error)) from error
