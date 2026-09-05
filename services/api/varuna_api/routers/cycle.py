"""``GET /v1/cycle/status`` and ``POST /v1/cycle/compute`` (Compute live)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from varuna_schemas.constants import STAGE_BUDGET_MS, TOTAL_CYCLE_BUDGET_MS
from varuna_schemas.models import ComputeRequest, CycleStatus, ErrorEnvelope

from varuna_api.state import AppState, get_state, not_implemented

router = APIRouter(prefix="/v1/cycle", tags=["cycle"])


@router.get("/status", response_model=CycleStatus, summary="Orchestrator status and budgets")
def cycle_status(state: Annotated[AppState, Depends(get_state)]) -> CycleStatus:
    """Idle until Phase 5 wires the orchestrator; the budgets feed the cycle budget bar."""
    last = state.latest_run()
    return CycleStatus(
        run_id=last.run_id if last else None,
        stage="idle",
        stage_ms=dict(last.stage_ms) if last else {},
        cycle_ts=last.cycle_ts if last else None,
        mode=last.mode if last else None,
        replay_mode=last.replay_mode if last else None,
        bundle=last.bundle if last else state.settings.varuna_bundle,
        budget_ms=dict(STAGE_BUDGET_MS),
        total_budget_ms=TOTAL_CYCLE_BUDGET_MS,
        degraded_feeds=list(last.degraded_feeds) if last else [],
    )


@router.post(
    "/compute",
    response_model=CycleStatus,
    status_code=202,
    responses={501: {"model": ErrorEnvelope}},
    summary="Compute live: run one real cycle now",
)
def compute(body: ComputeRequest, state: Annotated[AppState, Depends(get_state)]) -> CycleStatus:
    raise not_implemented("Compute live (the cycle orchestrator)", 5, "P5.6")


__all__ = ["router"]
