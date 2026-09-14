"""City-in-a-box on stage (CLAUDE.md 7.9, 12; tasks P9.5, P9.6).

`POST /v1/onboard` starts a build in a background thread and answers immediately with a job; the
wizard polls `GET /v1/onboard/{job_id}` and also receives the pipeline's own `onboard.progress`
events over the WebSocket. Both carry the same state, so a dropped socket degrades to polling
rather than to a frozen progress bar.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import structlog
from fastapi import APIRouter
from varuna_schemas.paths import city_dir

from varuna_api.onboard import get_job, latest_job, start_job
from varuna_api.routers.stubs import OnboardRequest
from varuna_api.state import api_error

log = structlog.get_logger("varuna.api.onboard")

router = APIRouter(prefix="/v1", tags=["onboard"])


@router.post("/onboard", status_code=202, summary="Start a city-in-a-box job")
def onboard(body: OnboardRequest) -> dict[str, Any]:
    """Build a city and run its first forecast.

    Validated through `OnboardRequest`, the documented shape (CLAUDE.md 12), so a malformed body
    gets the 422 envelope rather than a message about the city not existing.

    Answers 202 with the job straight away: the build is minutes of work and holding the request
    open for it would time out behind any proxy, and the wizard wants to render its first step
    immediately anyway.

    A request for a city that is already building returns that job rather than starting a second
    one - on stage, a double-click on "Start" must not raise a dialog.
    """
    from varuna_city.config import load_city_config
    from varuna_schemas.settings import get_settings

    # Refused before anything is validated or started. On 13 September 2026 a Chennai build was
    # started against the public Railway API: it downloaded tiles and OSM responses onto the
    # 500 MB volume beside two built cities, failed at `export` with ENOSPC, and left the volume
    # at 495 MB, after which the API crashed on its next restart and stayed down. The wizard is a
    # demo-laptop feature (CLAUDE.md 7.9 "on the demo laptop"), so the deployment says so.
    if not get_settings().varuna_onboard_enabled:
        raise api_error(
            403,
            "onboard_disabled",
            "City-in-a-box is switched off on this public deployment. A Chennai build needs about "
            "320 MB of terrain tiles, OSM responses and outputs, and the volume here is 500 MB "
            "shared with the Mumbai demo. Run the wizard against a local API (make demo), or "
            "build from the command line with make city CITY=chennai.",
        )

    city = body.city or "chennai"
    try:
        load_city_config(city)
    except (FileNotFoundError, KeyError, ValueError) as error:
        raise api_error(
            404,
            "unknown_city",
            f"No city config for {city!r}. Add services/city/configs/{city}.yaml.",
        ) from error

    state = start_job(
        city=city,
        design_storm=body.design_storm,
        from_cache_only=body.from_cache_only,
    )
    return state.to_dict()


@router.get("/onboard/{job_id}", summary="Job status, with the pipeline's own log tail")
def onboard_job(job_id: str) -> dict[str, Any]:
    """Poll one job. ``latest`` in place of an id returns the most recent job for a city."""
    state = get_job(job_id)
    if state is None:
        raise api_error(
            404, "no_job", f"No onboarding job {job_id!r}. Start one with POST /v1/onboard."
        )
    return state.to_dict()


@router.get("/onboard/city/{city}", summary="The most recent job for a city")
def onboard_latest(city: str) -> dict[str, Any]:
    """What the wizard asks on load, so a reopened tab rejoins a build already running."""
    state = latest_job(city)
    if state is None:
        return {
            "job_id": None,
            "city": city,
            "status": "none",
            "built": (Path(city_dir(city)) / "segments.parquet").is_file(),
        }
    payload = state.to_dict()
    payload["built"] = (Path(city_dir(city)) / "segments.parquet").is_file()
    return payload
