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
from varuna_schemas.constants import DEFAULT_RISK_TOLERANCE, VehicleProfile
from varuna_schemas.models import (
    Alert,
    DrainHealthProduct,
    ErrorEnvelope,
    FeatureCollection,
    Observation,
    PhysicsCheckRequest,
    PhysicsCheckResponse,
    Pump,
    PumpAssignment,
    PumpPlan,
    ReachabilityResponse,
    ReportAck,
    ReportIn,
    RouteRequest,
    RouteResponse,
    SegmentSeries,
    VarunaModel,
    VerificationSummary,
    WhatIfRequest,
    WhatIfResponse,
)
from varuna_schemas.models.common import BBox, Timestamp

from varuna_api.state import not_implemented

NOT_BUILT = {501: {"model": ErrorEnvelope, "description": "Engine not built yet (phase named)"}}

router = APIRouter(prefix="/v1", responses=NOT_BUILT)

RunIdQ = Annotated[str | None, Query(description="Run id; default = latest published run")]
TimeQ = Annotated[str | None, Query(description="Valid time (ISO 8601 +05:30); default = now")]
BboxQ = Annotated[str | None, Query(description="minlon,minlat,maxlon,maxlat (WGS84)")]
ProfileQ = Annotated[VehicleProfile, Query(description="Vehicle profile for safe-until")]


# ---- request/response models that only the API needs -----------------------------------
class AlertActionRequest(VarunaModel):
    """Body of ``POST /v1/alerts/{id}/ack`` and ``/escalate``."""

    user: str = Field(description="Operator name or id shown in the alert log.")
    note: str | None = Field(default=None, max_length=500)


class PumpOptimiseRequest(VarunaModel):
    """Body of ``POST /v1/pumps/optimise``."""

    run_id: str | None = None
    hotspot_ids: list[str] = Field(default_factory=list, description="Empty = every hotspot.")
    solver: Literal["greedy", "milp"] = "greedy"


class PumpDispatchRequest(VarunaModel):
    """Body of ``POST /v1/pumps/dispatch``: dispatch a plan or explicit assignments."""

    plan_id: str | None = None
    assignments: list[PumpAssignment] = Field(default_factory=list)
    user: str = Field(default="control room")


class OnboardRequest(VarunaModel):
    """Body of ``POST /v1/onboard`` (city-in-a-box, CLAUDE.md 7.9)."""

    city: str = Field(description="City slug with a config under services/city/configs.")
    bbox: BBox | None = Field(default=None, description="Override the config's AOI.")
    design_storm: str = Field(default="CHN-IDF-25yr", description="Bundle for the first forecast.")
    from_cache_only: bool = Field(default=True, description="Never touch the network.")


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
@router.get(
    "/drains/health",
    tags=["drains"],
    response_model=DrainHealthProduct,
    summary="Drain-health product (posterior blockage per pipe)",
)
def drains_health(run_id: RunIdQ = None, bbox: BboxQ = None) -> DrainHealthProduct:
    raise not_implemented("The drain-health product (Pulse)", 7, "P7.4")


@router.get(
    "/drains/health.csv",
    tags=["drains"],
    response_class=Response,
    responses={**NOT_BUILT, 200: {"content": {"text/csv": {}}, "description": "Desilting CSV"}},
    summary="Desilting priority list as CSV",
)
def drains_health_csv(run_id: RunIdQ = None) -> Response:
    raise not_implemented("The desilting CSV export", 7, "P7.4")


@router.get(
    "/observations",
    tags=["observations"],
    response_model=list[Observation],
    summary="Observations assimilated in a run, with their effects",
)
def observations(run_id: RunIdQ = None) -> list[Observation]:
    raise not_implemented("Assimilated observations (Pulse)", 7, "P7.4")


@router.post(
    "/reports",
    tags=["observations"],
    response_model=ReportAck,
    status_code=202,
    summary="Citizen or field observation (depth chips ankle/knee/waist)",
)
def create_report(body: ReportIn) -> ReportAck:
    raise not_implemented("Report ingestion", 7, "P7.2")


# ---- route, reachability, feeds (Phase 8) -------------------------------------------------
@router.post(
    "/route",
    tags=["route"],
    response_model=RouteResponse,
    summary="Flood-safe route: naive versus VARUNA, avoided segments, alternates",
)
def route(body: RouteRequest) -> RouteResponse:
    raise not_implemented("Time-dependent routing", 8, "P8.2")


@router.get(
    "/reachability",
    tags=["route"],
    response_model=ReachabilityResponse,
    summary="5/10/15-minute isochrones for a facility with the collapse flag",
)
def reachability(
    facility: Annotated[str, Query(description="Asset id, e.g. kem-hospital")],
    profile: ProfileQ = "ambulance",
    t: TimeQ = None,
    run_id: RunIdQ = None,
    risk_tolerance: Annotated[float, Query(ge=0, le=1)] = DEFAULT_RISK_TOLERANCE,
) -> ReachabilityResponse:
    raise not_implemented("Reachability isochrones", 8, "P8.3")


@router.get(
    "/feeds/road-conditions",
    tags=["route"],
    response_model=FeatureCollection,
    summary="Provider feed: impassable and degraded segments with validity windows",
)
def road_conditions(run_id: RunIdQ = None, profile: ProfileQ = "car") -> FeatureCollection:
    raise not_implemented("The road-conditions feed", 8, "P8.4")


# ---- alerts (Phase 8) ---------------------------------------------------------------------
@router.post("/alerts/{alert_id}/ack", tags=["alerts"], response_model=Alert, summary="Acknowledge")
def alert_ack(alert_id: str, body: AlertActionRequest) -> Alert:
    raise not_implemented("Alert acknowledgement", 8, "P8.8")


@router.post(
    "/alerts/{alert_id}/escalate", tags=["alerts"], response_model=Alert, summary="Escalate"
)
def alert_escalate(alert_id: str, body: AlertActionRequest) -> Alert:
    raise not_implemented("Alert escalation", 8, "P8.8")


# ---- pumps (Phase 8) ----------------------------------------------------------------------
@router.get("/pumps", tags=["pumps"], response_model=list[Pump], summary="Pump inventory")
def pumps() -> list[Pump]:
    raise not_implemented("The pump inventory (synthetic, labelled)", 8, "P8.9")


@router.post(
    "/pumps/optimise", tags=["pumps"], response_model=PumpPlan, summary="Optimise assignments"
)
def pumps_optimise(body: PumpOptimiseRequest | None = None) -> PumpPlan:
    raise not_implemented("Pump dispatch optimisation", 8, "P8.9")


@router.post(
    "/pumps/dispatch",
    tags=["pumps"],
    response_model=PumpPlan,
    status_code=202,
    summary="Dispatch pumps (creates the order, alert and phone-mock message)",
)
def pumps_dispatch(body: PumpDispatchRequest) -> PumpPlan:
    raise not_implemented("Pump dispatch", 8, "P8.10")


# ---- what-if (Phase 7) --------------------------------------------------------------------
@router.post(
    "/whatif", tags=["whatif"], response_model=WhatIfResponse, summary="What-if via the emulator"
)
def whatif(body: WhatIfRequest) -> WhatIfResponse:
    raise not_implemented("What-if (Flash-lite emulator)", 7, "P7.8")


@router.post(
    "/whatif/physics-check",
    tags=["whatif"],
    response_model=PhysicsCheckResponse,
    summary="Re-run the Twin on a what-if and report the disagreement",
)
def physics_check(body: PhysicsCheckRequest) -> PhysicsCheckResponse:
    raise not_implemented("The physics check", 7, "P7.8")


# Replay bundles and the clock are no longer stubs: the clock landed with Phase 2 and lives in
# ``varuna_api.routers.replay`` (task P2.7).


# ---- onboarding and verification (Phase 9) -------------------------------------------------
@router.post(
    "/onboard",
    tags=["onboard"],
    response_model=OnboardJob,
    status_code=202,
    summary="Start a city-in-a-box job",
)
def onboard(body: OnboardRequest) -> OnboardJob:
    raise not_implemented("City onboarding", 9, "P9.5")


@router.get("/onboard/{job_id}", tags=["onboard"], response_model=OnboardJob, summary="Job status")
def onboard_job(job_id: str) -> OnboardJob:
    raise not_implemented("City onboarding", 9, "P9.5")


@router.get(
    "/verification",
    tags=["verification"],
    response_model=VerificationSummary,
    summary="Verification scores and chart data for an event",
)
def verification(
    event: Annotated[str, Query(description="Bundle id, e.g. MUM-2019-07-02")] = "MUM-2019-07-02",
) -> VerificationSummary:
    raise not_implemented("Verification scores", 9, "P9.7")


# City layers are no longer a stub: Phase 1 landed, and ``varuna_api.routers.city`` serves
# them from city/<city>/map/ (task P1.12).


__all__ = [
    "AlertActionRequest",
    "OnboardJob",
    "OnboardRequest",
    "PumpDispatchRequest",
    "PumpOptimiseRequest",
    "router",
]
