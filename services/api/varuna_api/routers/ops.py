"""The authority write path: the one thing in this product an official can actually do.

TECH_SPEC 3.6 and task D-07. Everything else VARUNA serves is a forecast being read; this is a
ward officer telling the system something it could not know - that a street is closed, that a
lorry is broken, that an alert has been seen - and having the next answer change because of it.

**Nothing here rewrites a product.** Every edit is one line appended to ``data/ops/<city>.jsonl``
through :mod:`varuna_route.ops_overlay`, and the router, the road-conditions feed and the alert
queue apply it at read time. CLAUDE.md rule 8 wants byte-identical bakes and P5.9 checks them, so
a closure that edited ``segments_wet.json`` would break the one property that makes a run
trustworthy. ``services/api/tests/test_ops.py`` takes the sha256 of every file in a baked run
before and after a closure, a pump status change and a dispatch, and proves not one byte moved.

**The gate.** ``VARUNA_OPS_PASSPHRASE`` unset means writes are refused, and the refusal names the
variable - on the deployed API it stays unset, so the desk is read-only there and
``GET /v1/ops/log`` says so in ``writes_enabled``. When it is set, a write must carry it in
``X-Varuna-Ops``; the browser prompts for it locally and never stores it. Thirty writes a minute
per process, which is far above a human at a desk and far below anything that could fill a disk.

**Why reads are ungated.** A closure is a public fact - the citizen dashboard has to be able to
say why a street is refused - so ``GET /v1/ops/closures``, ``/v1/ops/log`` and ``/v1/ops/alerts``
answer anyone. Only the acts are gated.
"""

from __future__ import annotations

import hmac
import json
import os
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends, Header, Query
from pydantic import Field
from varuna_schemas.constants import IST, STEP_MIN
from varuna_schemas.models import VarunaModel
from varuna_schemas.paths import city_dir, run_dir
from varuna_schemas.settings import get_settings

from varuna_api.routers.stubs import AlertActionRequest, PumpDispatchRequest, PumpOptimiseRequest
from varuna_api.runs_util import latest_run_for
from varuna_api.state import api_error

log = structlog.get_logger("varuna.api.ops")

router = APIRouter(prefix="/v1")

PASSPHRASE_ENV = "VARUNA_OPS_PASSPHRASE"
"""The one variable that decides whether this API can be written to at all (TECH_SPEC 3.6)."""

OPS_HEADER = "X-Varuna-Ops"
"""Header the passphrase travels in. Never a cookie, never localStorage: a desk that leaves the
passphrase in the browser is a desk anybody who borrows the laptop can act as."""

WRITES_PER_MINUTE = 30
"""Writes per process per rolling minute, as TECH_SPEC 3.6 sets it."""

WINDOW_S = 60.0

NO_FORECAST_CHANGED = (
    "This changed no forecast. Authority edits are an append-only overlay applied when a route "
    "or a feed is read; every baked product is byte-identical."
)
"""Printed with every write, because the desk has to know what it did *not* do (rule 6)."""

_writes: deque[float] = deque()
"""Monotonic stamps of the authorised writes in the current window."""


def reset_rate_limit() -> None:
    """Forget the window. Tests call it; nothing in the app does."""
    _writes.clear()


def writes_enabled() -> bool:
    """Whether this process holds a passphrase at all."""
    return bool(os.environ.get(PASSPHRASE_ENV, "").strip())


def _refuse_disabled() -> None:
    raise api_error(
        503,
        "ops_writes_disabled",
        f"This API cannot accept authority edits: {PASSPHRASE_ENV} is not set in its "
        "environment, so there is nothing to check a request against. Set it where the API "
        "runs and restart it; the deployed API leaves it unset on purpose and is read-only.",
    )


def _check_rate_limit() -> None:
    now = time.monotonic()
    while _writes and now - _writes[0] > WINDOW_S:
        _writes.popleft()
    if len(_writes) >= WRITES_PER_MINUTE:
        wait = round(WINDOW_S - (now - _writes[0]))
        raise api_error(
            429,
            "rate_limited",
            f"{WRITES_PER_MINUTE} authority edits a minute is the limit and this process has "
            f"used them. Wait {max(wait, 1)} s and send it again; nothing was written.",
        )
    _writes.append(now)


def require_ops(
    x_varuna_ops: Annotated[str | None, Header(description="The desk passphrase.")] = None,
) -> None:
    """Gate every write: passphrase configured, passphrase presented, rate limit not spent.

    In that order. An unauthenticated caller cannot spend the window, because a refusal that
    consumed the budget would let anyone lock the real desk out of its own API; only writes that
    got past the passphrase are counted.
    """
    expected = os.environ.get(PASSPHRASE_ENV, "").strip()
    if not expected:
        _refuse_disabled()
    if not x_varuna_ops:
        raise api_error(
            401,
            "ops_passphrase_required",
            f"This is an authority edit and it carries no passphrase. Send it in the "
            f"{OPS_HEADER} header.",
        )
    if not hmac.compare_digest(x_varuna_ops.strip(), expected):
        raise api_error(
            403,
            "ops_passphrase_rejected",
            f"The {OPS_HEADER} passphrase does not match this API's {PASSPHRASE_ENV}. "
            "Nothing was written.",
        )
    _check_rate_limit()


OpsWrite = Annotated[None, Depends(require_ops)]
"""Dependency alias, so every gated route reads the same and none can forget the gate."""


# ---- request bodies ---------------------------------------------------------------------
class ClosureRequest(VarunaModel):
    """Body of ``POST /v1/ops/closures``."""

    segment_id: str = Field(description="The segment the officer is closing or reopening.")
    reason: str = Field(
        default="",
        max_length=300,
        description=(
            "Why, in the officer's own words. Required to close: a closure with no reason "
            "reaches the citizen screen with nothing to say after the comma, and UI_SPEC 4 "
            "refuses to soften it into 'closed'."
        ),
    )
    until: str | None = Field(
        default=None, description="ISO 8601 expiry with an offset; omit for until-reopened."
    )
    user: str = Field(default="ward officer", max_length=80)
    city: str | None = Field(default=None, description="Defaults to VARUNA_CITY.")
    reopen: bool = Field(default=False, description="Lift the closure instead of making one.")


class PumpStatusRequest(VarunaModel):
    """Body of ``POST /v1/ops/pumps/{pump_id}/status``."""

    status: Literal["available", "unavailable", "moved"]
    user: str = Field(default="ward officer", max_length=80)
    note: str | None = Field(default=None, max_length=300)
    city: str | None = None
    lon: float | None = Field(default=None, ge=-180.0, le=180.0)
    lat: float | None = Field(default=None, ge=-90.0, le=90.0)


# ---- shared helpers ---------------------------------------------------------------------
def _city(raw: str | None) -> str:
    """A city slug that can be a file name, or a 422 that says so."""
    from varuna_route import ops_overlay as ops

    name = (raw or get_settings().varuna_city or "").strip().lower()
    try:
        ops.overlay_path(name)
    except ValueError as error:
        raise api_error(422, "bad_city", f"{error}. Use a city slug such as 'mumbai'.") from None
    return name


def _time(raw: str | None, field: str) -> datetime | None:
    if raw in (None, ""):
        return None
    try:
        parsed = datetime.fromisoformat(str(raw))
    except ValueError:
        raise api_error(
            422,
            "bad_time",
            f"{field} must be ISO 8601 with an offset, e.g. 2019-07-02T10:00:00+05:30.",
        ) from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=IST)


def _append(city: str, entry: dict[str, Any]) -> dict[str, Any]:
    """Append through the overlay, turning its refusals into the section 12 envelope."""
    from varuna_route import ops_overlay as ops

    try:
        return ops.append(city, entry)
    except ValueError as error:
        raise api_error(422, "bad_ops_entry", str(error)) from None
    except OSError as error:
        raise api_error(
            503,
            "ops_log_unwritable",
            f"The ops log for {city} could not be written: {error}. Check that data/ops is "
            "writable where the API runs; nothing was recorded.",
        ) from None


def _run_path(run_id: str | None, city: str, needs: str) -> Path:
    """The run to act on: the one named, or the newest of this city carrying ``needs``."""
    if run_id:
        path = run_dir(run_id)
        if not (path / needs).is_file():
            raise api_error(
                404,
                "run_not_found",
                f"Run {run_id} has no {needs}. Run `make bake BUNDLE=MUM-2019-07-02`.",
                run_id=run_id,
            )
        return path
    latest = latest_run_for(city, lambda p: (p / needs).is_file())
    if latest is None:
        raise api_error(
            404,
            "no_run",
            f"No baked run for {city} carries {needs}. Run `make bake BUNDLE=MUM-2019-07-02`, "
            "or press Compute live on the replay panel.",
        )
    return latest


# ---- alert state ------------------------------------------------------------------------
def apply_alert_state(alerts: list[dict[str, Any]], city: str) -> list[dict[str, Any]]:
    """Overlay the desk's acknowledgements onto a run's alert queue, at read time.

    The queue is a product: the cycle computed it and no officer may edit it. What an officer
    changes is the *state* of an alert, which lives in the ops log, so the two are folded
    together here and nowhere else. Later entries win, and the history keeps both, so an alert
    escalated after it was acknowledged still says who acknowledged it.
    """
    from varuna_route import ops_overlay as ops

    actions: dict[str, list[dict[str, Any]]] = {}
    for entry in ops.entries(city):
        kind = entry.get("kind")
        if kind not in {"alert_ack", "alert_escalate"}:
            continue
        alert_id = str(entry.get("alert_id", "")).strip()
        if alert_id:
            actions.setdefault(alert_id, []).append(entry)
    if not actions:
        return alerts

    out: list[dict[str, Any]] = []
    for alert in alerts:
        history = list(actions.get(str(alert.get("id")), ()))
        if not history:
            out.append(alert)
            continue
        updated = dict(alert)
        updated["history"] = [
            {
                "ts": e.get("ts"),
                "state": "acknowledged" if e["kind"] == "alert_ack" else "escalated",
                "user": e.get("user", "unknown"),
                "note": e.get("note"),
            }
            for e in history
        ]
        for e in history:
            if e["kind"] == "alert_ack":
                updated["state"] = "acknowledged"
                updated["acknowledged_by"] = e.get("user", "unknown")
                updated["acknowledged_ts"] = e.get("ts")
            else:
                updated["state"] = "escalated"
                updated["escalated_to"] = e.get("to")
        out.append(updated)
    return out


def _alert_queue(path: Path) -> list[dict[str, Any]]:
    record = path / "alerts.json"
    if not record.is_file():
        raise api_error(
            404,
            "no_alerts",
            f"Run {path.name} has no alert product. Run `make bake BUNDLE=MUM-2019-07-02`.",
            run_id=path.name,
        )
    body = json.loads(record.read_text(encoding="utf-8"))
    return list(body.get("alerts", []))


def _alert_action(
    alert_id: str, body: AlertActionRequest, run_id: str | None, kind: str
) -> dict[str, Any]:
    city = _city(body.city)
    path = _run_path(run_id, city, "alerts.json")
    queue = _alert_queue(path)
    if not any(str(a.get("id")) == alert_id for a in queue):
        raise api_error(
            404,
            "alert_not_found",
            f"Run {path.name} raised no alert {alert_id}. Open /v1/alerts for the queue it did.",
            run_id=path.name,
        )

    entry: dict[str, Any] = {
        "kind": kind,
        "alert_id": alert_id,
        "run_id": path.name,
        "user": body.user,
        "note": body.note,
    }
    if kind == "alert_escalate":
        entry["to"] = body.escalate_to
    stored = _append(city, entry)

    overlaid = apply_alert_state(queue, city)
    alert = next(a for a in overlaid if str(a.get("id")) == alert_id)
    log.info("api.alert_action", kind=kind, alert_id=alert_id, run_id=path.name, user=body.user)
    return {"run_id": path.name, "entry": stored, "alert": alert, "notes": [NO_FORECAST_CHANGED]}


@router.post(
    "/alerts/{alert_id}/ack",
    tags=["alerts"],
    summary="Acknowledge an alert (recorded in the ops log)",
)
def alert_ack(
    alert_id: str,
    body: AlertActionRequest,
    _gate: OpsWrite,
    run_id: Annotated[str | None, Query()] = None,
) -> dict[str, Any]:
    """Record that an officer has seen this alert, and answer with the alert as it now reads.

    The response is the product's own alert with the ops log folded in - not a model of one -
    because the queue carries fields the drafted ``Alert`` schema forbids, the same reason
    ``/v1/route`` serves its own flatter shape (ADR-0027).
    """
    return _alert_action(alert_id, body, run_id, "alert_ack")


@router.post(
    "/alerts/{alert_id}/escalate",
    tags=["alerts"],
    summary="Escalate an alert up the matrix (recorded in the ops log)",
)
def alert_escalate(
    alert_id: str,
    body: AlertActionRequest,
    _gate: OpsWrite,
    run_id: Annotated[str | None, Query()] = None,
) -> dict[str, Any]:
    """Escalate to the next step of the matrix. ``escalate_to`` names it; the log keeps who."""
    return _alert_action(alert_id, body, run_id, "alert_escalate")


@router.get("/ops/alerts", tags=["alerts"], summary="A run's alerts with the desk's state applied")
def ops_alerts(
    run_id: Annotated[str | None, Query()] = None,
    city: Annotated[str | None, Query()] = None,
    level: Annotated[Literal["severe", "moderate", "watch"] | None, Query()] = None,
) -> dict[str, Any]:
    """The alert queue as the authority desk sees it: the run's own alerts, plus their state.

    ``GET /v1/alerts`` serves the product untouched and is not this endpoint's to change - it
    belongs to the depth router - so the desk reads the overlaid queue here and an
    acknowledgement survives a reload.
    """
    name = _city(city)
    path = _run_path(run_id, name, "alerts.json")
    queue = apply_alert_state(_alert_queue(path), name)
    if level:
        queue = [a for a in queue if a.get("level") == level]
    return {
        "run_id": path.name,
        "city": name,
        "n_total": len(queue),
        "alerts": queue,
        "writes_enabled": writes_enabled(),
        "notes": [NO_FORECAST_CHANGED],
    }


# ---- closures ---------------------------------------------------------------------------
def _closure_view(city: str, at: datetime | None = None) -> dict[str, Any]:
    from varuna_route import ops_overlay as ops

    overlay = ops.active(city, at=at)
    return {
        "city": city,
        "at": overlay.at.isoformat(),
        "n_closed": len(overlay.closures),
        "closures": [
            {
                "segment_id": c.segment_id,
                "reason": c.reason,
                "user": c.user,
                "ts": c.ts.isoformat(),
                "until": c.until.isoformat() if c.until else None,
                "id": c.entry_id,
            }
            for c in sorted(overlay.closures.values(), key=lambda c: c.ts, reverse=True)
        ],
        "n_entries": overlay.n_entries,
        "writes_enabled": writes_enabled(),
    }


@router.post("/ops/closures", tags=["ops"], summary="Close or reopen a street")
def post_closure(body: ClosureRequest, _gate: OpsWrite) -> dict[str, Any]:
    """Close a street, or reopen one. Both are appends; nothing is ever deleted.

    A closure beats the forecast: the router treats the segment as impassable whatever the depth
    says, and the reason the officer typed comes back on the route as a structured reason for
    the screen to word (TECH_SPEC 3.2).
    """
    city = _city(body.city)
    segment_id = body.segment_id.strip()
    if not segment_id:
        raise api_error(422, "bad_segment", "Name the segment_id to close.")
    reason = body.reason.strip()
    if not body.reopen and not reason:
        raise api_error(
            422,
            "closure_needs_a_reason",
            "A closure needs a reason: it is shown to drivers as the street's explanation, and "
            "there is nothing honest to print without one.",
        )
    until = _time(body.until, "until")
    if until is not None and not body.reopen and until <= datetime.now(IST):
        # Accepting it would append a closure that `active` drops on the way back out: the
        # officer would see "0 closed" beside their own entry and have no idea why.
        raise api_error(
            422,
            "closure_already_expired",
            f"That closure expires at {until.isoformat()}, which has already passed, so it "
            "would close nothing. Give a later `until`, or omit it to close until reopened.",
        )
    entry = _append(
        city,
        {
            "kind": "reopen" if body.reopen else "closure",
            "segment_id": segment_id,
            "reason": reason,
            "user": body.user,
            **({"until": until.isoformat()} if until else {}),
        },
    )
    view = _closure_view(city)
    log.info(
        "api.ops_closure",
        city=city,
        segment_id=segment_id,
        reopen=body.reopen,
        n_closed=view["n_closed"],
    )
    return {"entry": entry, **view, "notes": [NO_FORECAST_CHANGED]}


@router.get("/ops/closures", tags=["ops"], summary="Streets an authority has closed")
def get_closures(
    city: Annotated[str | None, Query()] = None,
    at: Annotated[str | None, Query(description="Evaluate expiries at this time.")] = None,
) -> dict[str, Any]:
    """The live closure set, folded from the log and with expiries applied at ``at``."""
    return _closure_view(_city(city), _time(at, "at"))


# ---- pump status ------------------------------------------------------------------------
@router.post("/ops/pumps/{pump_id}/status", tags=["ops"], summary="Set a pump's status")
def post_pump_status(pump_id: str, body: PumpStatusRequest, _gate: OpsWrite) -> dict[str, Any]:
    """Mark a pump available, unavailable, or moved to a new depot.

    An unavailable pump is not assigned by the next optimise. A moved one still is, from the
    point given here - see ``varuna_products.pumps.ASSIGNABLE_STATES``.
    """
    from varuna_route import ops_overlay as ops

    city = _city(body.city)
    identifier = pump_id.strip()
    if not identifier:
        raise api_error(422, "bad_pump", "Name the pump to set a status on.")
    if (body.lon is None) != (body.lat is None):
        raise api_error(
            422,
            "bad_point",
            "A moved pump needs both lon and lat, or neither. Half a coordinate is not a depot.",
        )
    entry = _append(
        city,
        {
            "kind": "pump_status",
            "pump_id": identifier,
            "status": body.status,
            "user": body.user,
            "note": body.note,
            **({"lon": body.lon, "lat": body.lat} if body.lon is not None else {}),
        },
    )
    overlay = ops.active(city)
    log.info("api.ops_pump_status", city=city, pump_id=identifier, status=body.status)
    return {
        "entry": entry,
        "city": city,
        "pumps": {
            pid: {
                "status": p.status,
                "user": p.user,
                "ts": p.ts.isoformat(),
                "lon": p.lon,
                "lat": p.lat,
            }
            for pid, p in sorted(overlay.pumps.items())
        },
        "notes": [
            NO_FORECAST_CHANGED,
            "The next POST /v1/pumps/optimise honours this; the run's own pump_plan.json still "
            "holds the plan the cycle computed.",
        ],
    }


# ---- the log ----------------------------------------------------------------------------
@router.get("/ops/log", tags=["ops"], summary="The append-only authority log")
def ops_log(
    city: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=2000)] = 200,
    kind: Annotated[str | None, Query(description="Filter to one entry kind.")] = None,
) -> dict[str, Any]:
    """Every authority edit for a city, newest first - the audit trail the desk is judged on."""
    from varuna_route import ops_overlay as ops

    name = _city(city)
    rows = ops.entries(name)
    if kind:
        if kind not in ops.KINDS:
            raise api_error(
                422,
                "bad_kind",
                f"No ops entry kind {kind!r}. Valid kinds: {', '.join(sorted(ops.KINDS))}.",
            )
        rows = [r for r in rows if r.get("kind") == kind]
    newest = list(reversed(rows))[:limit]
    return {
        "city": name,
        "n_entries": len(rows),
        "n_returned": len(newest),
        "entries": newest,
        "writes_enabled": writes_enabled(),
        "passphrase_env": PASSPHRASE_ENV,
        "notes": [
            NO_FORECAST_CHANGED,
            (
                "Writes are enabled on this API."
                if writes_enabled()
                else f"This API is read-only: {PASSPHRASE_ENV} is not set where it runs."
            ),
        ],
    }


# ---- pumps: optimise and dispatch --------------------------------------------------------
def _pump_overrides(city: str) -> tuple[dict[str, str], dict[str, tuple[float, float]]]:
    """The desk's pump statuses and moved depots, for :func:`build_pump_plan`."""
    from varuna_route import ops_overlay as ops

    overlay = ops.active(city)
    statuses = {pid: p.status for pid, p in overlay.pumps.items()}
    depots = {
        pid: (p.lon, p.lat)
        for pid, p in overlay.pumps.items()
        if p.lon is not None and p.lat is not None
    }
    return statuses, depots


def _optimise(run_id: str | None, city: str, solver: str) -> dict[str, Any]:
    """Re-run the greedy for a run, honouring the desk's pump statuses.

    The plan is returned and **not written into the run**: the run directory is what the cycle
    produced, and an officer pressing Optimise must not change it (rule 8).
    """
    from time import perf_counter

    from varuna_products.alerts import STREET_POINTS, street_series
    from varuna_products.depth import segment_names, segment_points
    from varuna_products.pumps import build_pump_plan, rain_for_run

    if solver == "milp":
        raise api_error(
            501,
            "not_implemented",
            "The MILP solver is P1 (task P8.9). The greedy of CLAUDE.md 11.10 is what runs "
            "today; send solver='greedy'.",
        )

    root = city_dir(city)
    if not (root / "assets.geojson").is_file():
        raise api_error(
            503,
            "no_city",
            f"There is no pump inventory for {city}: {root / 'assets.geojson'} is missing, so "
            f"there is no fleet to assign. Run `make city CITY={city}`.",
        )
    path = _run_path(run_id, city, "hotspots.json")
    notes: list[str] = [
        "The plan was computed now and not written into the run; the run's own pump_plan.json "
        "is the one the cycle produced and is unchanged."
    ]

    hotspots = json.loads((path / "hotspots.json").read_text(encoding="utf-8"))
    if isinstance(hotspots, dict):
        hotspots = hotspots.get("hotspots", [])

    streets: dict[str, list[float]] = {}
    points: dict[str, tuple[float, float]] = {}
    segments_readable = True
    wet = path / "segments_wet.json"
    try:
        if wet.is_file():
            depth = json.loads(wet.read_text(encoding="utf-8")).get("depth_cm", {})
            streets = street_series(
                {sid: [float(v) for v in series] for sid, series in depth.items()},
                segment_names(root),
                segment_points(root),
            )
            points = dict(STREET_POINTS)
        else:
            notes.append(
                f"Run {path.name} carries no segments_wet.json, so only the chronic register "
                "was a candidate; named streets were not."
            )
    except (OSError, ValueError, KeyError) as error:
        segments_readable = False
        notes.append(
            f"Street candidates were skipped: the city's segment table could not be read "
            f"({error}). Only the chronic hotspot register was considered."
        )

    rain = rain_for_run(path.name)
    if rain and not segments_readable:
        # The emulator prices a candidate by slicing itself down to that candidate's road
        # segments, which it finds through the same table that just failed to read. Handing it
        # the storm anyway would make it raise mid-plan; withholding it falls back to the
        # bathtub model, which needs no city at all, and the label says which one ran.
        rain = None
        notes.append(
            "The emulator was not used: it prices a pump on the candidate's own road segments "
            "and this city's segment table could not be read."
        )
    if not rain:
        notes.append(
            "The benefit is the bathtub estimate rather than the emulator; benefit_model and "
            "benefit_label say so beside every number."
        )
    statuses, depots = _pump_overrides(city)

    started = perf_counter()
    plan = build_pump_plan(
        hotspots,
        root,
        path.name,
        STEP_MIN,
        streets,
        points,
        rain_mm_h=rain,
        pump_status=statuses,
        pump_depots=depots,
    )
    plan["solver"] = "greedy"
    plan["solve_ms"] = round((perf_counter() - started) * 1000.0)
    plan["city"] = city
    if plan.get("withheld"):
        held = ", ".join(f"{w['pump_id']} ({w['status']})" for w in plan["withheld"])
        notes.append(f"Withheld by the desk and not assigned: {held}.")
    plan["notes"] = notes
    log.info(
        "api.pumps_optimise",
        run_id=path.name,
        assigned=len(plan.get("assignments", [])),
        withheld=len(plan.get("withheld", [])),
        ms=plan["solve_ms"],
    )
    return plan


@router.post("/pumps/optimise", tags=["pumps"], summary="Re-run the greedy optimiser on demand")
def pumps_optimise(_gate: OpsWrite, body: PumpOptimiseRequest | None = None) -> dict[str, Any]:
    """Assign the fleet to the places that flood, honouring what the desk has marked.

    Gated with the writes even though it stores nothing: it is one of the desk's acts, and the
    greedy re-prices every candidate through the emulator, which is not something an
    unauthenticated caller should be able to ask for thirty times a second.
    """
    request = body or PumpOptimiseRequest()
    return _optimise(request.run_id, _city(request.city), request.solver)


@router.post(
    "/pumps/dispatch",
    tags=["pumps"],
    status_code=202,
    summary="Dispatch the plan (records the order; sends no lorry)",
)
def pumps_dispatch(body: PumpDispatchRequest, _gate: OpsWrite) -> dict[str, Any]:
    """Record a dispatch order for the current plan, and return it in plain language.

    202 rather than 200: the order is accepted and recorded, and nothing downstream of this
    prototype moves because of it. The inventory is synthetic, and the response says so.
    """
    city = _city(body.city)
    plan = _optimise(body.run_id, city, "greedy")
    wanted = {p.strip() for p in body.pump_ids if p.strip()}
    if wanted:
        unknown = sorted(wanted - {a["pump_id"] for a in plan["assignments"]})
        if unknown:
            raise api_error(
                422,
                "pump_not_in_plan",
                f"The current plan assigns nothing to {', '.join(unknown)}, so there is no "
                "order to dispatch for it. Optimise first, then dispatch what it assigned.",
            )
    chosen = [a for a in plan["assignments"] if not wanted or a["pump_id"] in wanted]
    if not chosen:
        raise api_error(
            409,
            "nothing_to_dispatch",
            "The optimiser assigned no pump on this run - no candidate crosses 45 cm, or every "
            "pump is withheld. There is no order to give.",
        )

    orders: list[dict[str, Any]] = []
    entries: list[dict[str, Any]] = []
    for assignment in chosen:
        text = (
            f"Move {assignment['pump_id']} from {assignment['depot']} to "
            f"{assignment['hotspot_name']} now; ETA {assignment['eta_min']} min; prevents about "
            f"{assignment['minutes_saved']} min above {plan['threshold_cm']:.0f} cm."
        )
        orders.append({**assignment, "order_text": text})
        entries.append(
            _append(
                city,
                {
                    "kind": "dispatch",
                    "pump_id": assignment["pump_id"],
                    "hotspot_id": assignment["hotspot_id"],
                    "hotspot_name": assignment["hotspot_name"],
                    "run_id": plan["run_id"],
                    "eta_min": assignment["eta_min"],
                    "minutes_saved": assignment["minutes_saved"],
                    "benefit_model": assignment["benefit_model"],
                    "order_text": text,
                    "user": body.user,
                    "note": body.note,
                },
            )
        )

    log.info("api.pumps_dispatch", run_id=plan["run_id"], n=len(orders), user=body.user, city=city)
    return {
        "run_id": plan["run_id"],
        "city": city,
        "dispatched": True,
        "dispatched_by": body.user,
        "dispatched_ts": entries[-1]["ts"],
        "n_dispatched": len(orders),
        "orders": orders,
        "entries": entries,
        "benefit_model": plan["benefit_model"],
        "benefit_label": plan["benefit_label"],
        "synthetic_inventory": True,
        "notes": [
            *plan["notes"],
            NO_FORECAST_CHANGED,
            "The pump inventory is synthetic: this order is recorded in the ops log and no "
            "lorry is called.",
        ],
    }


__all__ = [
    "NO_FORECAST_CHANGED",
    "OPS_HEADER",
    "PASSPHRASE_ENV",
    "WRITES_PER_MINUTE",
    "ClosureRequest",
    "PumpStatusRequest",
    "apply_alert_state",
    "require_ops",
    "reset_rate_limit",
    "router",
    "writes_enabled",
]
