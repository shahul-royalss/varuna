"""Finding the run an endpoint means when the caller did not name one.

**Every "latest run" is per city.** Runs from every city share `data/runs/`, their ids sort
chronologically, and `CHN-` sorts after `MUM-` for the same instant - so the moment Chennai was
onboarded, every endpoint that defaulted to "the newest run" began answering a Mumbai console with
Chennai water: the depth raster, the segment forecast, the drain health, the route. Nothing looked
broken, which is what made it worth a shared helper rather than four separate fixes.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from varuna_schemas.models.run import RunIdError, city_code
from varuna_schemas.paths import runs_dir
from varuna_schemas.settings import get_settings

__all__ = ["latest_run_for", "run_prefix"]


def run_prefix(city: str | None) -> str:
    """The run-id prefix for a city, e.g. ``"MUM-"``. Empty when the city is unknown."""
    name = city or get_settings().varuna_city
    try:
        return f"{city_code(name)}-"
    except RunIdError:
        return ""


def latest_run_for(
    city: str | None = None,
    requires: Callable[[Path], bool] | None = None,
) -> Path | None:
    """The newest run directory for a city, optionally one satisfying ``requires``.

    Returns None rather than raising: "no run yet" is an ordinary state on a cold console, and the
    callers each have their own message for it (CLAUDE.md 6.8).
    """
    root = runs_dir()
    if not root.is_dir():
        return None
    prefix = run_prefix(city)
    for path in sorted(root.iterdir(), reverse=True):
        if not path.is_dir() or path.name.startswith("."):
            continue
        if prefix and not path.name.startswith(prefix):
            continue
        if requires is not None and not requires(path):
            continue
        return path
    return None
