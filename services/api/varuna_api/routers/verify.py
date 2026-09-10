"""Verification scores for one event (CLAUDE.md 12, 7.10; task P9.7).

Every number comes from `varuna_verify`, computed from run artifacts and the bundle's curated
pins. Nothing here is typed in, and what cannot be computed is returned as an `unavailable` entry
with the reason rather than as a plausible figure (rule 6).
"""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Query

from varuna_api.state import api_error

log = structlog.get_logger("varuna.api.verify")

router = APIRouter(prefix="/v1", tags=["verification"])


@router.get("/verification", summary="Scores for an event against its sourced ground truth")
def verification(
    event: Annotated[str, Query(description="Bundle id, e.g. MUM-2019-07-02")] = "MUM-2019-07-02",
) -> dict[str, Any]:
    """Detection, timing and the threshold sweep, plus what could not be scored and why."""
    from varuna_verify.event import sweep

    try:
        return sweep(event)
    except FileNotFoundError as error:
        raise api_error(404, "no_ground_truth", str(error)) from error
