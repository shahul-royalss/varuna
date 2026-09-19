"""Contract-only endpoints (CLAUDE.md 12) that answer 501 until their engine's phase lands.

Every route declares its request and response models so ``openapi.json`` and the generated
TypeScript types carry the full P0 contract now; the handler bodies are replaced phase by
phase (nowcast in Phase 5, drains/what-if in Phase 7, route/alerts/pumps in Phase 8,
onboard/verification in Phase 9). The 501 body names the phase so a dead control never says
"Something went wrong".
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response
from pydantic import Field
from varuna_schemas.constants import VehicleProfile
from varuna_schemas.models import (
    ErrorEnvelope,
    FeatureCollection,
    PhysicsCheckRequest,
    PhysicsCheckResponse,
    SegmentSeries,
    VarunaModel,
)
from varuna_schemas.models.alert import EscalationTarget
from varuna_schemas.models.common import BBox, Timestamp

from varuna_api.state import api_error, not_implemented

NOT_BUILT = {501: {"model": ErrorEnvelope, "description": "Engine not built yet (phase named)"}}

router = APIRouter(prefix="/v1", responses=NOT_BUILT)

RunIdQ = Annotated[str | None, Query(description="Run id; default = latest published run")]
TimeQ = Annotated[str | None, Query(description="Valid time (ISO 8601 +05:30); default = now")]
BboxQ = Annotated[str | None, Query(description="minlon,minlat,maxlon,maxlat (WGS84)")]
ProfileQ = Annotated[VehicleProfile, Query(description="Vehicle profile for safe-until")]


# ---- request/response models that only the API needs -----------------------------------
class AlertActionRequest(VarunaModel):
    """Body of ``POST /v1/alerts/{id}/ack`` and ``/escalate`` (served by ``varuna_api.routers.ops``)."""

    user: str = Field(description="Operator name or id shown in the alert log.")
    note: str | None = Field(default=None, max_length=500)
    city: str | None = Field(
        default=None, description="Whose ops log records it; default VARUNA_CITY."
    )
    escalate_to: EscalationTarget = Field(
        default="control_room",
        description="Step of the escalation matrix (blueprint 6.10). Ignored by /ack.",
    )


class PumpOptimiseRequest(VarunaModel):
    """Body of ``POST /v1/pumps/optimise`` (served by ``varuna_api.routers.ops``)."""

    run_id: str | None = None
    city: str | None = Field(
        default=None, description="Which built city's fleet; default VARUNA_CITY."
    )
    hotspot_ids: list[str] = Field(default_factory=list, description="Empty = every hotspot.")
    solver: Literal["greedy", "milp"] = "greedy"


class PumpDispatchRequest(VarunaModel):
    """Body of ``POST /v1/pumps/dispatch``: dispatch the current plan, or named pumps of it.

    The draft took a ``plan_id`` and a list of assignments. Neither survived contact with the
    served endpoint (task D-07): no plan is stored under an addressable id, so a ``plan_id``
    could only ever be a string nothing could look up, and accepting assignments from the client
    would let a caller dispatch benefit figures the optimiser never produced. The desk names the
    pumps; the API re-solves and dispatches what *it* assigned.
    """

    run_id: str | None = None
    city: str | None = None
    pump_ids: list[str] = Field(
        default_factory=list, description="Empty = every assignment in the current plan."
    )
    user: str = Field(default="control room")
    note: str | None = Field(default=None, max_length=500)


class OnboardRequest(VarunaModel):
    """Body of ``POST /v1/onboard`` (city-in-a-box, CLAUDE.md 7.9)."""

    city: str = Field(description="City slug with a config under services/city/configs.")
    bbox: BBox | None = Field(default=None, description="Override the config's AOI.")
    design_storm: str = Field(default="CHN-IDF-25yr", description="Bundle for the first forecast.")
    from_cache_only: bool = Field(
        default=True,
        description=(
            "Fail rather than download when the city's open-data tiles are not cached. "
            "False lets the job fetch them once. VARUNA_OFFLINE=1 refuses the network either way."
        ),
    )


OnboardStep = Literal[
    "choose_area",
    "fetch_open_data",
    "condition_terrain",
    "infer_drains",
    "build_graph",
    "first_forecast",
]


class OnboardJob(VarunaModel):
    """``GET /v1/onboard/{job_id}``; progress also streams on ``onboard.progress``."""

    job_id: str
    city: str
    status: Literal["queued", "running", "finished", "failed"]
    step: OnboardStep
    progress: float = Field(ge=0, le=1)
    started_at: Timestamp
    finished_at: Timestamp | None = None
    elapsed_s: float = Field(ge=0)
    log_tail: list[str] = Field(default_factory=list, description="Last real pipeline log lines.")
    first_run_id: str | None = None
    error: str | None = None


# ---- nowcast (Phase 5) ------------------------------------------------------------------
@router.get(
    "/nowcast/segments",
    tags=["nowcast"],
    response_model=FeatureCollection,
    summary="Segment quantiles, exceedance probabilities and safe-until",
)
def nowcast_segments(
    run_id: RunIdQ = None,
    bbox: BboxQ = None,
    t: TimeQ = None,
    profile: ProfileQ = "car",
    format: Annotated[Literal["geojson", "parquet"], Query()] = "geojson",
) -> FeatureCollection:
    raise not_implemented("The segment forecast product", 5, "P5.1")


@router.get(
    "/nowcast/raster",
    tags=["nowcast"],
    response_class=Response,
    responses={**NOT_BUILT, 200: {"content": {"image/png": {}}, "description": "Depth PNG"}},
    summary="Depth raster PNG for one step and statistic",
)
def nowcast_raster(
    run_id: RunIdQ = None,
    t: TimeQ = None,
    stat: Annotated[Literal["p50", "p90", "prob30"], Query()] = "p50",
) -> Response:
    raise not_implemented("Depth rasters", 5, "P5.3")


@router.get(
    "/nowcast/segments/{segment_id}/series",
    tags=["nowcast"],
    response_model=SegmentSeries,
    summary="One segment's fan-chart series and safe-until table",
)
def nowcast_segment_series(segment_id: str, run_id: RunIdQ = None) -> SegmentSeries:
    raise not_implemented("Segment series", 5, "P5.7")


# ---- drains and observations (Phase 7) ----------------------------------------------------
# Report ingestion is no longer a stub: `varuna_api.routers.reports` stores a report and
# queues it for the next cycle (tasks P7.2, P9.4).


# Route, reachability and the road-conditions feed are no longer stubs:
# `varuna_api.routers.route` serves all three (tasks P8.2, P8.3, P8.4).


# Alert acknowledgement and escalation, pump optimisation and pump dispatch are no longer stubs:
# `varuna_api.routers.ops` serves all four behind the authority gate (task D-07), and the three
# request models above stay here as the documented shapes of that contract - the same
# arrangement `OnboardRequest` has. They answer their own flatter shapes rather than `Alert` and
# `PumpPlan`: the stored alert carries fields those drafted models forbid, and the plan the
# board renders is the product's, not the draft's (ADR-0027 for the same decision on /v1/route).


# ---- what-if (Phase 7) --------------------------------------------------------------------
# The generic 501 says "the engine is not built yet", which is true of the physics check and
# misleading about the Twin: the Twin exists and runs every baked cycle. What is missing is a
# Twin run small enough to answer inside section 14's 10 s budget. The numbers are the
# `stage_ms.twin_total_ms` of the seven baked MUM-2019-07-02 cycles in demo/runs - 58,282 to
# 113,999 ms in six of them and 47,026 ms in the lightest - so the refusal names the measured
# cost rather than implying the physics is absent (CLAUDE.md 6.8, 7.7).
PHYSICS_CHECK_REFUSAL = (
    "The physics check lands in Phase 7 (task P7.8). It needs a Twin re-run of the scenario, "
    "and a full-AOI Mumbai Twin run measures 58-114 s in six of the seven baked cycles "
    "(47 s in the lightest) against this endpoint's 10 s budget, so the check would have to run "
    "on a bounded hotspot crop rather than the whole AOI. Such a crop was measured on "
    "2026-09-13 at about 0.9 s coupled over a 990 m window (33 x 33 cells, 392 edges), "
    "roughly ten times inside the budget and within 0.4 cm of the full run at the same "
    "cells, so the cost is not the obstacle - the crop is simply not built yet (P7.8)."
)


@router.post(
    "/whatif/physics-check",
    tags=["whatif"],
    response_model=PhysicsCheckResponse,
    summary="Re-run the Twin on a what-if and report the disagreement",
)
def physics_check(body: PhysicsCheckRequest) -> PhysicsCheckResponse:
    raise api_error(501, "not_implemented", PHYSICS_CHECK_REFUSAL)


# Replay bundles and the clock are no longer stubs: the clock landed with Phase 2 and lives in
# ``varuna_api.routers.replay`` (task P2.7).


# Onboarding is no longer a stub: ``varuna_api.routers.onboard`` runs the real city pipeline in a
# background thread and streams its own log lines (tasks P9.5, P9.6). `OnboardRequest` and
# `OnboardJob` stay here as the documented shapes of that contract.


# Verification is no longer a stub: `varuna_api.routers.verify` scores an event against its
# sourced ground truth (task P9.7).


# City layers are no longer a stub: Phase 1 landed, and ``varuna_api.routers.city`` serves
# them from city/<city>/map/ (task P1.12).


__all__ = [
    "PHYSICS_CHECK_REFUSAL",
    "AlertActionRequest",
    "OnboardJob",
    "OnboardRequest",
    "PumpDispatchRequest",
    "PumpOptimiseRequest",
    "router",
]
