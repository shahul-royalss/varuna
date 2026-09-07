"""Replay bundles and the shared simulation clock (CLAUDE.md 7.8, 10.2, 12; task P2.7).

``GET /v1/replay/bundles`` lists what is under ``bundles/``; the other routes drive the one
clock the process owns. Every control answers with the whole :class:`ReplayClock` state, so a
client never has to guess what its own request did, and the same state goes out on the bus as
``replay.clock`` for every other open tab.

The clock is opened lazily: the first request for it loads ``VARUNA_BUNDLE``'s manifest. When
that bundle is not on disk the answer is a 404 whose message names the make target rather than
an empty clock that pretends a replay exists.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from varuna_replay.bundle import BundleNotFoundError
from varuna_replay.clock import REPLAY_SPEEDS, ReplayClock
from varuna_schemas.models import (
    ErrorEnvelope,
    ReplayBundleSummary,
    ReplaySeekRequest,
    ReplaySpeedRequest,
    VarunaModel,
)
from varuna_schemas.models import (
    ReplayClock as ReplayClockState,
)

from varuna_api.replay import bundle_hint, bundle_summaries
from varuna_api.state import AppState, api_error, get_state

router = APIRouter(
    prefix="/v1/replay",
    tags=["replay"],
    responses={404: {"model": ErrorEnvelope, "description": "No such bundle under bundles/"}},
)

State = Annotated[AppState, Depends(get_state)]

BundleQ = Annotated[
    str | None,
    Query(description="Bundle id; default = VARUNA_BUNDLE, or the bundle already open."),
]


class ReplayBundleRequest(VarunaModel):
    """Body of ``POST /v1/replay/bundle``: which bundle the clock should walk."""

    bundle_id: str = Field(description="Bundle id, e.g. MUM-2019-07-02.")


async def _clock(state: AppState, bundle_id: str | None = None) -> ReplayClock:
    """The open clock, opening ``bundle_id`` (or the configured bundle) when there is none."""
    wanted = bundle_id or (
        state.replay.clock.bundle_id if state.replay.clock else state.settings.varuna_bundle
    )
    try:
        return await state.replay.open(
            wanted, bus=state.bus, registry=state.registry, settings=state.settings
        )
    except BundleNotFoundError as exc:
        raise api_error(
            404,
            "bundle_not_found",
            f"No replay bundle {wanted} under bundles/. {bundle_hint(wanted)}",
        ) from exc
    except ValueError as exc:  # an unreadable manifest
        raise api_error(
            422,
            "bundle_invalid",
            f"The manifest of {wanted} does not match the bundle contract: {exc}. "
            f"Run varuna bundle validate {wanted}.",
        ) from exc


@router.get(
    "/bundles",
    response_model=list[ReplayBundleSummary],
    summary="Replay bundles on disk, with their build and bake status",
)
async def replay_bundles(state: State) -> list[ReplayBundleSummary]:
    """Every folder under ``bundles/`` with a manifest. An empty list means none is generated."""
    return bundle_summaries(state.registry)


@router.get("/clock", response_model=ReplayClockState, summary="The replay clock")
async def replay_clock(state: State, bundle: BundleQ = None) -> ReplayClockState:
    clock = await _clock(state, bundle)
    return clock.snapshot()


@router.post("/play", response_model=ReplayClockState, summary="Play")
async def replay_play(state: State, bundle: BundleQ = None) -> ReplayClockState:
    clock = await _clock(state, bundle)
    return await clock.play()


@router.post("/pause", response_model=ReplayClockState, summary="Pause")
async def replay_pause(state: State, bundle: BundleQ = None) -> ReplayClockState:
    clock = await _clock(state, bundle)
    return await clock.pause()


@router.post("/seek", response_model=ReplayClockState, summary="Seek to a simulated instant")
async def replay_seek(
    body: ReplaySeekRequest, state: State, bundle: BundleQ = None
) -> ReplayClockState:
    """Times outside the bundle window are clamped to it, not refused."""
    clock = await _clock(state, bundle)
    return await clock.seek(body.sim_time)


@router.post(
    "/speed",
    response_model=ReplayClockState,
    responses={422: {"model": ErrorEnvelope, "description": "Speed the time bar does not offer"}},
    summary="Set the replay speed",
)
async def replay_speed(
    body: ReplaySpeedRequest, state: State, bundle: BundleQ = None
) -> ReplayClockState:
    clock = await _clock(state, bundle)
    try:
        return await clock.set_speed(body.speed)
    except ValueError as exc:
        offered = ", ".join(f"{speed:g}" for speed in REPLAY_SPEEDS)
        raise api_error(
            422, "invalid_speed", f"{exc} The time bar offers {offered}."
        ) from exc


@router.post(
    "/bundle",
    response_model=ReplayClockState,
    summary="Point the clock at another bundle",
)
async def replay_set_bundle(body: ReplayBundleRequest, state: State) -> ReplayClockState:
    """What a bundle card on ``/replay`` does: the clock reopens at the new bundle's ``t0``."""
    clock = await _clock(state, body.bundle_id)
    return clock.snapshot()


__all__ = ["ReplayBundleRequest", "router"]
