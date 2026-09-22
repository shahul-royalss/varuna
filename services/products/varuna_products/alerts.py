"""Turning a forecast into something a ward officer can act on (CLAUDE.md 11.10, P8.7).

An alert is the point where VARUNA stops describing water and starts asking someone to do
something, so the bar for raising one is higher than "a number went up".

**Hysteresis across cycles (CLAUDE.md 11.10, 7.5 AC1).** A level is raised when
``P(h > θ) >= 0.6`` in **two consecutive cycles** and cleared when it falls to ``<= 0.3``. The
memory is the previous run's own ``alerts.json``: every run writes a ``hysteresis`` record of
each situation (scope and place) and each level's state - ``pending`` after one cycle at or
above 0.6, ``raised`` after two, carried while the probability stays above 0.3 - and the next
cycle reads it (:func:`previous_record`, :func:`apply_cycle_hysteresis`). The previous run is an
input like the radar, so a bake stays byte-identical for identical inputs (rule 8,
``tests/test_alert_hysteresis.py`` bakes the same pair twice).

**What ``P`` is on these runs.** One cycle's exceedance is still read along its own forecast:
the depth has to stay above the threshold for two consecutive 5-minute steps
(:data:`MIN_PERSIST_STEPS`), because one step is a single cell's arithmetic. The Twin that feeds
the queue is one deterministic run, so that ``P`` is 0 or 1 and the 0.3-0.6 band that holds a
raised alert open is empty until the ensemble's probabilities reach this module; the state machine
carries the band anyway so nothing changes shape when they do. ``trigger_p`` says which number
triggered, and ``persists_unit`` says the count is in cycles.

**The first cycle raises nothing.** With no previous run within :data:`MAX_CYCLE_GAP_MIN`, every
exceedance is ``pending``: two consecutive cycles means two, and a bake that starts at 06:10 has
seen one. The queue says so rather than inventing a history.

**Scope.** CLAUDE.md 11.10 puts the state machine "per segment/ward". The chronic register leads
the queue: those are the named, sourced places a judge recognises. But on a cycle where the
register stays dry and 226 ordinary streets go over 45 cm, a queue of hotspots alone would report
an all-clear over a flooding city - so the streets follow, deduplicated by name so one road is one
alert rather than forty.

**Exercise, not Actual.** Every alert from a replay carries CAP ``status=Exercise`` (CLAUDE.md
11.10). A replay of 2 July 2019 must never produce a document that could be mistaken for a live
civil warning.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from xml.etree import ElementTree as ET

import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only
    from collections.abc import Mapping
    from pathlib import Path

log = structlog.get_logger("varuna.products.alerts")

__all__ = [
    "CLEAR_P",
    "ESCALATION_PATH",
    "LEVELS",
    "MAX_ALERTS",
    "MAX_CYCLE_GAP_MIN",
    "MIN_PERSIST_STEPS",
    "RAISE_CYCLES",
    "RAISE_P",
    "AlertQueue",
    "alert_identity",
    "apply_cycle_hysteresis",
    "build_alerts",
    "cap_xml",
    "escalation_by_level",
    "load_escalation",
    "previous_record",
    "run_cycle_ts",
    "situation_key",
    "street_series",
    "write_alerts",
]

LEVELS: tuple[tuple[str, int], ...] = (
    ("severe", 45),
    ("moderate", 30),
    ("watch", 15),
)
"""Level and its depth threshold in cm, worst first (CLAUDE.md 11.10).

The thresholds are the depth ramp's own bands, so an alert level and the colour of the street it
is about can never disagree."""

MIN_PERSIST_STEPS = 2
"""Steps a threshold must stay crossed for one cycle to count it as an exceedance: 10 minutes.

This is what makes one cycle's ``P`` 1 rather than 0 on a deterministic run; the hysteresis of
CLAUDE.md 11.10 is then applied across cycles (:data:`RAISE_CYCLES`). One step is a single 30 m
cell's arithmetic; two is a trend."""

RAISE_P = 0.6
"""``P(h > θ)`` at or above which a cycle counts towards raising a level (CLAUDE.md 11.10)."""

CLEAR_P = 0.3
"""``P(h > θ)`` at or below which a raised level clears (CLAUDE.md 11.10)."""

RAISE_CYCLES = 2
"""Consecutive cycles at or above :data:`RAISE_P` before a level is raised (CLAUDE.md 11.10)."""

MAX_CYCLE_GAP_MIN = 60
"""How far back a previous run may be and still count as the previous *cycle*.

The live cadence is five minutes and the shipped demo bake is every thirty (``make bake ARGS=
"--every 30"``), so an hour admits both. A run from yesterday is not the cycle before this one,
and carrying its state forward would raise an alert on the strength of a storm that ended."""

HYSTERESIS_VERSION = 1
"""Written into the record so a reader can tell the rule it was produced under."""

MAX_ALERTS = 60
"""How many alerts a run's queue carries, worst first.

A heavy cycle puts 226 segments over 45 cm. Deduplicated by street that is a few dozen roads,
which an operator can read; without a cap a bad hour produces a list nobody scrolls to the
bottom of, and the alerts that matter are buried in it."""

CAP_NS = "urn:oasis:names:tc:emergency:cap:1.2"

SENDER = "varuna@sih2026.example"
"""CAP requires a sender identifier. It is deliberately an example domain: VARUNA is a prototype
and must not appear to originate from a municipal or IMD address (rule 7)."""


def alert_identity(alert: Mapping[str, Any]) -> str:
    """The cycle-independent identity of one alert: scope, place and level.

    An alert's ``id`` is ``VARUNA-{run_id}-{key}-{level}``, so it names the cycle that raised it
    and no two cycles share one - measured on the seven baked demo cycles, not a single id is
    common to any two consecutive ones, while twelve situations carry from 03:10Z to 03:40Z. An
    id is therefore the right key for *this queue* and the wrong key for *this junction*: an
    officer who has acknowledged Hindmata at severe has not un-acknowledged it because a new
    cycle landed.

    The place is the register's ``hotspot_id`` where there is one and the ``area_desc`` otherwise,
    which for a street alert is the street's own name (``build_alerts`` passes ``area=street``).
    The level is part of the identity on purpose: a junction stepping from moderate to severe is
    a new situation and deserves fresh eyes.

    **This is one half of a pair.** ``apps/command/lib/alert-identity.ts`` computes the same
    string in the browser to decide which cards are new (motion M16), and
    ``services/api/varuna_api/routers/ops.py`` stores it on every acknowledgement so the state
    can be found again next cycle. The two must not drift, so the fallback below mirrors the
    TypeScript ``??`` exactly - absent, not merely falsy - and
    ``services/products/tests/test_alert_identity.py`` runs the TypeScript file's own cases.
    """
    hotspot_id = alert.get("hotspot_id")
    place = alert.get("area_desc", "") if hotspot_id is None else hotspot_id
    return f"{alert.get('scope', '')}|{place}|{alert.get('level', '')}"


def _runs(above: list[bool], min_steps: int) -> list[tuple[int, int]]:
    """Index ranges where ``above`` stays true for at least ``min_steps`` steps."""
    windows: list[tuple[int, int]] = []
    start: int | None = None
    for i, flag in enumerate([*above, False]):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            if i - start >= min_steps:
                windows.append((start, i - 1))
            start = None
    return windows


def street_series(
    depth_cm: dict[str, list[float]],
    names: dict[str, str],
    points: dict[str, tuple[float, float]] | None = None,
) -> dict[str, list[float]]:
    """Collapse per-segment depth series onto street names, keeping the worst step by step.

    A named road is dozens of segments and they flood at different depths; the alert is about the
    road, so each step takes the deepest segment on it. Unnamed ways are dropped rather than
    given a placeholder: an alert that cannot say where it is cannot be acted on.
    """
    out: dict[str, list[float]] = {}
    deepest: dict[str, tuple[float, str]] = {}
    for segment_id, series in depth_cm.items():
        name = names.get(segment_id)
        if not name or not series:
            continue
        current = out.get(name)
        if current is None:
            out[name] = list(series)
        else:
            for i, value in enumerate(series[: len(current)]):
                if value > current[i]:
                    current[i] = value
        # The road's pin goes on its worst segment: that is where a pump would be sent and what
        # the CAP circle should cover, not the road's midpoint two kilometres away.
        peak = max(series)
        if name not in deepest or peak > deepest[name][0]:
            deepest[name] = (peak, segment_id)

    if points is not None:
        STREET_POINTS.clear()
        for name, (_peak, segment_id) in deepest.items():
            point = points.get(segment_id)
            if point:
                STREET_POINTS[name] = point
    return out


STREET_POINTS: dict[str, tuple[float, float]] = {}
"""Street name to the lon/lat of its worst-flooding segment, filled by :func:`street_series`.

A module-level cache rather than a second return value, so the existing callers of
``street_series`` keep their shape; ``build_alerts`` and the pump plan read it straight after."""


def _level_alerts(
    series: list[float],
    *,
    key: str,
    name: str,
    area: str,
    run_id: str,
    cycle_ts: datetime,
    times: tuple[datetime, ...],
    mode: str,
    scope: str,
    scope_id: str | None,
    hotspot_id: str | None = None,
    lon: float | None = None,
    lat: float | None = None,
    source_url: str | None = None,
    escalation: Mapping[str, list[str]] | None = None,
) -> dict[str, dict[str, Any]]:
    """One candidate alert per level this series crosses for :data:`MIN_PERSIST_STEPS`, worst first.

    Every level, not only the worst, because the cross-cycle rule runs per level: a junction that
    has been over 30 cm for two cycles and over 45 cm for one is a raised *moderate* and a pending
    *severe*, and only a per-level record can say so.
    """
    out: dict[str, dict[str, Any]] = {}
    for level, threshold in LEVELS:
        windows = _runs([cm > threshold for cm in series], MIN_PERSIST_STEPS)
        if not windows:
            continue

        start, end = max(windows, key=lambda w: w[1] - w[0])
        peak = max(series[start : end + 1])
        from_ts = times[start] if start < len(times) else cycle_ts
        to_ts = times[end] if end < len(times) else cycle_ts

        alert: dict[str, Any] = {
            "id": f"VARUNA-{run_id}-{key}-{level}".upper().replace("_", "-"),
            "run_id": run_id,
            "scope": scope,
            "scope_id": scope_id,
            "hotspot_id": hotspot_id,
            "level": level,
            "threshold_cm": threshold,
            "headline": (
                f"{name}: depth above {threshold} cm from "
                f"{from_ts.strftime('%H:%M')} to {to_ts.strftime('%H:%M')}"
            ),
            "instruction": (
                f"Avoid {name} for the window. Peak forecast {peak:.0f} cm. Route emergency "
                "vehicles around it; see the reachability tab for the affected catchment."
            ),
            "area_desc": area,
            "lon": lon,
            "lat": lat,
            # 0 or 1 on a deterministic run. Reported rather than dressed up.
            "trigger_p": 1.0,
            "window_from": from_ts.isoformat(),
            "window_to": to_ts.isoformat(),
            "peak_cm": round(peak, 1),
            "raised_ts": cycle_ts.isoformat(),
            "persists_cycles": end - start + 1,
            "persists_unit": "forecast steps of 5 minutes",
            "window_steps": end - start + 1,
            "state": "raised",
            "channels": ["dashboard"],
            "source_url": source_url,
            "cap_status": "Exercise" if mode != "live" else "Actual",
        }
        if escalation is not None:
            alert["notify"] = list(escalation.get(level, []))
        out[level] = alert
    return out


def _alert_from_series(series: list[float], **kwargs: Any) -> dict[str, Any] | None:
    """The worst level a depth series reaches, as one alert, or None if it stays below `watch`.

    Worst level only. A street that goes over 45 cm is also over 30 and over 15, and sending a
    ward officer three messages about one road is how a queue gets ignored.
    """
    levels = _level_alerts(series, **kwargs)
    return next(iter(levels.values()), None)


def situation_key(alert: Mapping[str, Any]) -> str:
    """The place an alert is about, without its level: :func:`alert_identity` minus the level.

    The cross-cycle record is kept per situation and per level inside it, so a junction stepping
    from moderate to severe is one situation with two levels rather than two unrelated alerts.
    """
    return alert_identity(alert).rsplit("|", 1)[0]


class AlertQueue(list[dict[str, Any]]):
    """The queue :func:`build_alerts` returns: a list, plus what the next step needs.

    ``candidates`` is every level every situation crossed this cycle, uncapped by
    :data:`MAX_ALERTS` - the cap is for a reader, and a hysteresis record that forgot the 61st
    street would raise it from scratch next cycle. ``cycle_ts`` is the instant the queue speaks for.
    ``final`` is True once the cross-cycle rule has been applied to it.
    """

    candidates: dict[str, dict[str, dict[str, Any]]]
    cycle_ts: datetime | None
    run_id: str | None
    final: bool
    pending: list[dict[str, Any]]
    cleared: list[dict[str, Any]]
    n_raised: int
    n_pending: int
    n_cleared: int
    record: dict[str, Any] | None

    def __init__(self, items: list[dict[str, Any]] | None = None) -> None:
        super().__init__(items or [])
        self.candidates = {}
        self.cycle_ts = None
        self.run_id = None
        self.final = False
        self.pending = []
        self.cleared = []
        self.n_raised = 0
        self.n_pending = 0
        self.n_cleared = 0
        self.record = None


def _sort_queue(alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    order = {level: i for i, (level, _) in enumerate(LEVELS)}
    # Hotspots first inside a level: they are the named, sourced places, and a judge scanning the
    # queue should meet Hindmata before an arterial road they have not heard of.
    return sorted(
        alerts, key=lambda a: (order[a["level"]], a["scope"] != "hotspot", -a["peak_cm"], a["id"])
    )


def build_alerts(
    hotspots: list[dict[str, Any]],
    run_id: str,
    cycle_ts: datetime,
    times: tuple[datetime, ...],
    mode: str = "baked",
    streets: dict[str, list[float]] | None = None,
    *,
    previous: Mapping[str, Any] | None = None,
    escalation: Mapping[str, list[str]] | None = None,
) -> AlertQueue:
    """The run's alert queue: the chronic register first, then the streets behind it.

    Without ``previous`` this is what *this cycle alone* says - the worst level each place crosses
    - and the returned :class:`AlertQueue` carries every candidate so :func:`write_alerts` can
    apply the cross-cycle rule against the previous run on disk. With ``previous`` (a record from
    :func:`previous_record`, or ``{}`` for "there was no previous cycle") the rule is applied here
    and the queue is final.

    ``escalation`` is level to the tiers it reaches (:func:`escalation_by_level`); absent, it is
    read from ``config/escalation.yaml`` when that file exists.
    """
    if escalation is None:
        escalation = escalation_by_level()
    candidates: dict[str, dict[str, dict[str, Any]]] = {}

    for hotspot in hotspots:
        series = [float(v) for v in hotspot.get("depth_cm", [])]
        if not series:
            continue
        name = str(hotspot.get("name"))
        levels = _level_alerts(
            series,
            key=str(hotspot.get("slug") or hotspot.get("hotspot_id") or "spot"),
            name=name,
            area=f"Ward {hotspot['ward']}, {name}" if hotspot.get("ward") else name,
            run_id=run_id,
            cycle_ts=cycle_ts,
            times=times,
            mode=mode,
            scope="hotspot",
            scope_id=hotspot.get("hotspot_id"),
            hotspot_id=hotspot.get("hotspot_id"),
            lon=hotspot.get("lon"),
            lat=hotspot.get("lat"),
            source_url=hotspot.get("source_url"),
            escalation=escalation,
        )
        if levels:
            candidates[situation_key(next(iter(levels.values())))] = levels

    for index, (street, series) in enumerate(sorted((streets or {}).items())):
        levels = _level_alerts(
            list(series),
            key=f"street-{index:04d}",
            name=street,
            area=street,
            run_id=run_id,
            cycle_ts=cycle_ts,
            times=times,
            mode=mode,
            scope="segment",
            scope_id=None,
            lon=STREET_POINTS.get(street, (None, None))[0],
            lat=STREET_POINTS.get(street, (None, None))[1],
            escalation=escalation,
        )
        if levels:
            candidates.setdefault(situation_key(next(iter(levels.values()))), levels)

    worst = [next(iter(levels.values())) for levels in candidates.values()]
    queue = AlertQueue(_sort_queue(worst)[:MAX_ALERTS])
    queue.candidates = candidates
    queue.cycle_ts = cycle_ts
    queue.run_id = run_id

    if previous is not None:
        queue = apply_cycle_hysteresis(queue, previous)

    log.info(
        "products.alerts",
        run_id=run_id,
        n=len(queue),
        final=queue.final,
        pending=len(queue.pending),
        cleared=len(queue.cleared),
        severe=sum(1 for a in queue if a["level"] == "severe"),
        moderate=sum(1 for a in queue if a["level"] == "moderate"),
        watch=sum(1 for a in queue if a["level"] == "watch"),
        hotspot_scoped=sum(1 for a in queue if a["scope"] == "hotspot"),
    )
    return queue


# ---- cross-cycle hysteresis ------------------------------------------------------------------
_RUN_ID = re.compile(r"^(?P<city>[A-Z0-9]+)-(?P<ts>\d{8}T\d{4})Z-")


def run_cycle_ts(run_id: str) -> tuple[str, datetime] | None:
    """The city prefix and UTC cycle time a run id encodes (CLAUDE.md 10.3), or None."""
    match = _RUN_ID.match(run_id)
    if match is None:
        return None
    moment = datetime.strptime(match["ts"], "%Y%m%dT%H%M").replace(tzinfo=UTC)
    return match["city"], moment


def _record_from_legacy(alerts: list[dict[str, Any]]) -> dict[str, Any]:
    """A hysteresis record reconstructed from a queue written before the record existed.

    Such a queue raised on one cycle's evidence, so each of its alerts is read as one cycle at or
    above :data:`RAISE_P` for its level and every level below it - ``pending``, not ``raised``.
    Reading it as raised would carry a single-cycle alert straight into a second cycle's queue
    as if it had already met the two-cycle rule.
    """
    order = [level for level, _ in LEVELS]
    situations: dict[str, dict[str, Any]] = {}
    for alert in alerts:
        level = str(alert.get("level", ""))
        if level not in order:
            continue
        entry = situations.setdefault(situation_key(alert), {"levels": {}})
        for lower in order[order.index(level) :]:
            entry["levels"][lower] = {
                "p": float(alert.get("trigger_p", 1.0)),
                "state": "pending",
                "cycles": 1,
                "since_ts": alert.get("raised_ts"),
                "raised_ts": None,
            }
    return {"situations": situations}


def previous_record(
    run_id: str, runs_root: Path | None = None, *, max_gap_min: int = MAX_CYCLE_GAP_MIN
) -> dict[str, Any]:
    """The hysteresis record of the cycle before ``run_id``, or ``{}`` when there was none.

    The previous cycle is the run of the same city whose cycle time is the latest one before
    this run's, no more than ``max_gap_min`` minutes earlier. Folders whose name starts with a dot
    are the registry's in-flight temporaries and are never read. Ties on the cycle time (a baked
    and a live run of the same instant) go to the name that sorts first, so the choice is a
    function of the directory and not of the file system's listing order.
    """
    here = run_cycle_ts(run_id)
    if here is None:
        return {}
    city, cycle = here
    if runs_root is None:
        from varuna_schemas.paths import runs_dir

        runs_root = runs_dir()
    if not runs_root.is_dir():
        return {}

    best: tuple[datetime, str] | None = None
    for child in runs_root.iterdir():
        name = child.name
        if name.startswith(".") or name == run_id or not child.is_dir():
            continue
        parsed = run_cycle_ts(name)
        if parsed is None or parsed[0] != city:
            continue
        moment = parsed[1]
        if not (cycle - timedelta(minutes=max_gap_min) <= moment < cycle):
            continue
        if not (child / "alerts.json").is_file():
            continue
        if best is None or moment > best[0] or (moment == best[0] and name < best[1]):
            best = (moment, name)
    if best is None:
        return {}

    try:
        body = json.loads((runs_root / best[1] / "alerts.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        log.warning("products.alerts_previous_unreadable", run_id=best[1], error=str(error))
        return {}
    record = body.get("hysteresis")
    if not isinstance(record, dict):
        record = _record_from_legacy(list(body.get("alerts", [])))
        record["legacy"] = True
    return {**record, "run_id": best[1]}


def _cleared_entry(
    level: str, prior: Mapping[str, Any], meta: Mapping[str, Any], cycle_iso: str
) -> dict[str, Any]:
    return {
        "situation": meta.get("situation"),
        "scope": meta.get("scope"),
        "hotspot_id": meta.get("hotspot_id"),
        "area_desc": meta.get("area_desc"),
        "name": meta.get("name"),
        "level": level,
        "raised_ts": prior.get("raised_ts"),
        "cleared_ts": cycle_iso,
        "persists_cycles": int(prior.get("cycles", 0)),
        "persists_unit": "cycles",
        "state": "cleared",
    }


def apply_cycle_hysteresis(queue: AlertQueue, previous: Mapping[str, Any]) -> AlertQueue:
    """CLAUDE.md 11.10's rule, per situation and level, against the previous cycle's record.

    For each level: ``P >= RAISE_P`` moves nothing to ``pending``, ``pending`` to ``raised`` and
    keeps ``raised`` raised; ``CLEAR_P < P < RAISE_P`` keeps a raised level raised and drops a
    pending one; ``P <= CLEAR_P`` clears a raised level and drops a pending one. A situation's
    card is its worst raised level; a situation whose worst crossing is still pending is listed
    under ``pending`` so the screen can say "raises next cycle if it holds".
    """
    cycle = queue.cycle_ts
    if cycle is None:
        msg = "apply_cycle_hysteresis needs the queue's cycle_ts; build it with build_alerts"
        raise ValueError(msg)
    cycle_iso = cycle.isoformat()
    order = [level for level, _ in LEVELS]
    prior_situations: Mapping[str, Any] = previous.get("situations", {}) or {}

    record: dict[str, dict[str, Any]] = {}
    raised: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    cleared: list[dict[str, Any]] = []

    for key in sorted(set(queue.candidates) | set(prior_situations)):
        now = queue.candidates.get(key, {})
        prior = (prior_situations.get(key) or {}).get("levels", {}) or {}
        sample = next(iter(now.values()), None)
        meta = {
            "situation": key,
            "scope": (sample or {}).get("scope") or (prior_situations.get(key) or {}).get("scope"),
            "hotspot_id": (sample or {}).get("hotspot_id")
            or (prior_situations.get(key) or {}).get("hotspot_id"),
            "area_desc": (sample or {}).get("area_desc")
            or (prior_situations.get(key) or {}).get("area_desc"),
            "name": (prior_situations.get(key) or {}).get("name")
            or ((sample or {}).get("headline", "").split(":", 1)[0] or None),
        }
        levels: dict[str, dict[str, Any]] = {}
        for level in order:
            candidate = now.get(level)
            p = float(candidate["trigger_p"]) if candidate else 0.0
            before = prior.get(level) or {}
            state = before.get("state")
            if p >= RAISE_P:
                if state == "raised":
                    levels[level] = {
                        **before,
                        "p": p,
                        "cycles": int(before.get("cycles", 1)) + 1,
                    }
                elif state == "pending" and int(before.get("cycles", 1)) + 1 >= RAISE_CYCLES:
                    levels[level] = {
                        "p": p,
                        "state": "raised",
                        "cycles": int(before.get("cycles", 1)) + 1,
                        "since_ts": before.get("since_ts"),
                        "raised_ts": cycle_iso,
                    }
                else:
                    levels[level] = {
                        "p": p,
                        "state": "pending" if RAISE_CYCLES > 1 else "raised",
                        "cycles": 1,
                        "since_ts": cycle_iso,
                        "raised_ts": cycle_iso if RAISE_CYCLES <= 1 else None,
                    }
            elif p > CLEAR_P and state == "raised":
                levels[level] = {**before, "p": p, "cycles": int(before.get("cycles", 1)) + 1}
            elif state == "raised":
                cleared.append(_cleared_entry(level, before, meta, cycle_iso))

        if levels:
            record[key] = {
                "scope": meta["scope"],
                "hotspot_id": meta["hotspot_id"],
                "area_desc": meta["area_desc"],
                "name": meta["name"],
                "levels": levels,
            }

        worst_raised = next(
            (lv for lv in order if levels.get(lv, {}).get("state") == "raised"), None
        )
        if worst_raised is not None and worst_raised in now:
            state = levels[worst_raised]
            card = dict(now[worst_raised])
            card["raised_ts"] = state["raised_ts"]
            card["sent_ts"] = cycle_iso
            card["first_seen_ts"] = state.get("since_ts")
            card["persists_cycles"] = int(state["cycles"])
            card["persists_unit"] = "cycles"
            card["hysteresis"] = {
                "rule": "cycles",
                "raise_p": RAISE_P,
                "clear_p": CLEAR_P,
                "raise_cycles": RAISE_CYCLES,
            }
            raised.append(card)
        worst_pending = next(
            (lv for lv in order if levels.get(lv, {}).get("state") == "pending"), None
        )
        if worst_pending is not None and (
            worst_raised is None or order.index(worst_pending) < order.index(worst_raised)
        ):
            candidate = now[worst_pending]
            pending.append(
                {
                    "id": candidate["id"],
                    "situation": key,
                    "scope": candidate["scope"],
                    "hotspot_id": candidate.get("hotspot_id"),
                    "area_desc": candidate["area_desc"],
                    "level": worst_pending,
                    "threshold_cm": candidate["threshold_cm"],
                    "headline": candidate["headline"],
                    "peak_cm": candidate["peak_cm"],
                    "trigger_p": candidate["trigger_p"],
                    "since_ts": levels[worst_pending]["since_ts"],
                    "persists_cycles": int(levels[worst_pending]["cycles"]),
                    "persists_unit": "cycles",
                    "state": "pending",
                }
            )

    out = AlertQueue(_sort_queue(raised)[:MAX_ALERTS])
    out.candidates = queue.candidates
    out.cycle_ts = cycle
    out.run_id = queue.run_id
    out.final = True
    level_rank = {level: i for i, level in enumerate(order)}
    # The lists are capped for a reader like the queue is; the counts are not, so a screen can say
    # "and 180 more" rather than implying sixty was all there was.
    out.n_raised = len(raised)
    out.n_pending = len(pending)
    out.n_cleared = len(cleared)
    out.pending = sorted(
        pending,
        key=lambda a: (level_rank[a["level"]], a["scope"] != "hotspot", -a["peak_cm"], a["id"]),
    )[:MAX_ALERTS]
    out.cleared = sorted(cleared, key=lambda a: (level_rank[a["level"]], str(a["situation"])))[
        :MAX_ALERTS
    ]
    out.record = {
        "version": HYSTERESIS_VERSION,
        "rule": {
            "raise_p": RAISE_P,
            "clear_p": CLEAR_P,
            "raise_cycles": RAISE_CYCLES,
            "min_persist_steps": MIN_PERSIST_STEPS,
            "max_cycle_gap_min": MAX_CYCLE_GAP_MIN,
        },
        "cycle_ts": cycle_iso,
        "previous_run_id": previous.get("run_id"),
        "previous_legacy": bool(previous.get("legacy", False)),
        "situations": record,
    }
    return out


# ---- escalation matrix -------------------------------------------------------------------------
ESCALATION_PATH = "config/escalation.yaml"
"""Where the escalation matrix lives, relative to the repository root (CLAUDE.md 11.10)."""


def load_escalation(path: Path | None = None) -> dict[str, Any] | None:
    """``config/escalation.yaml`` as a dict, or None when the file is not there.

    None rather than a default matrix: a matrix typed into this module would be a second copy of
    the config that nobody edits, and the screen should say the file is missing instead.
    """
    import yaml
    from varuna_schemas.paths import repo_root

    target = path if path is not None else repo_root() / ESCALATION_PATH
    if not target.is_file():
        return None
    body = yaml.safe_load(target.read_text(encoding="utf-8")) or {}
    tiers = body.get("tiers")
    if not isinstance(tiers, list) or not tiers:
        msg = f"{target} has no tiers; it must list the escalation matrix in order"
        raise ValueError(msg)
    known = {level for level, _ in LEVELS}
    for tier in tiers:
        if not isinstance(tier, dict) or not tier.get("id"):
            msg = f"{target}: every tier needs an id"
            raise ValueError(msg)
        unknown = set(tier.get("levels") or []) - known
        if unknown:
            msg = f"{target}: tier {tier['id']} names unknown levels {sorted(unknown)}"
            raise ValueError(msg)
    return {"version": body.get("version", 1), "tiers": tiers, "path": ESCALATION_PATH}


def escalation_by_level(path: Path | None = None) -> dict[str, list[str]] | None:
    """Alert level to the tier ids it reaches when raised, in matrix order; None without config."""
    matrix = load_escalation(path)
    if matrix is None:
        return None
    return {
        level: [str(t["id"]) for t in matrix["tiers"] if level in (t.get("levels") or [])]
        for level, _ in LEVELS
    }


def _cap_datetime(value: str) -> str:
    """An ISO timestamp in the one form CAP 1.2 accepts: whole seconds and an explicit offset.

    The CAP 1.2 schema restricts ``sent``, ``onset`` and ``expires`` to the pattern
    ``YYYY-MM-DDThh:mm:ss+hh:mm``. ``datetime.isoformat()`` meets it only by accident: a cycle
    time carrying microseconds writes ``06:40:00.123456+05:30`` and a naive one writes no offset,
    and either document fails validation (``tests/test_cap_schema.py``). Truncating to seconds
    loses nothing a warning needs. A missing offset is refused rather than assumed, because
    guessing IST would put a time on a civil warning that nothing measured.
    """
    moment = datetime.fromisoformat(value)
    if moment.utcoffset() is None:
        raise ValueError(
            f"CAP 1.2 needs an explicit UTC offset on every time, and {value!r} has none. "
            "Pass timezone-aware datetimes (varuna_schemas.constants.IST) to build_alerts."
        )
    return moment.isoformat(timespec="seconds")


def cap_xml(alert: dict[str, Any]) -> str:
    """One alert as a CAP 1.2 document.

    ``status`` is ``Exercise`` for every replay alert (CLAUDE.md 11.10): the document is valid
    CAP and can be pasted into any CAP reader, and it says on its face that it is a drill.
    Validity is checked against the vendored OASIS schema, not asserted: see
    :func:`varuna_products.schemas.validate_cap`.
    """
    ET.register_namespace("", CAP_NS)
    root = ET.Element(f"{{{CAP_NS}}}alert")

    def child(parent: ET.Element, tag: str, text: str) -> ET.Element:
        node = ET.SubElement(parent, f"{{{CAP_NS}}}{tag}")
        node.text = text
        return node

    child(root, "identifier", alert["id"])
    child(root, "sender", SENDER)
    # `sent` is when *this document* went out. An alert carried across cycles keeps the cycle it
    # was raised on in `raised_ts` for the card, and each cycle's document is sent at that cycle
    # (`sent_ts`); a queue written before the cross-cycle rule has only `raised_ts`, which was
    # the same instant.
    child(root, "sent", _cap_datetime(alert.get("sent_ts") or alert["raised_ts"]))
    child(root, "status", alert.get("cap_status", "Exercise"))
    child(root, "msgType", "Alert")
    child(root, "scope", "Public")

    info = ET.SubElement(root, f"{{{CAP_NS}}}info")
    child(info, "category", "Met")
    child(info, "event", "Street flooding")
    child(info, "urgency", "Expected")
    child(
        info,
        "severity",
        {"severe": "Severe", "moderate": "Moderate", "watch": "Minor"}[alert["level"]],
    )
    # "Likely" and not "Observed": this is a forecast, and CAP has a word for that.
    child(info, "certainty", "Likely")
    child(info, "onset", _cap_datetime(alert["window_from"]))
    child(info, "expires", _cap_datetime(alert["window_to"]))
    child(info, "headline", alert["headline"])
    child(info, "description", f"VARUNA nowcast run {alert['run_id']}.")
    if alert.get("instruction"):
        child(info, "instruction", alert["instruction"])

    area = ET.SubElement(info, f"{{{CAP_NS}}}area")
    child(area, "areaDesc", alert["area_desc"])
    if alert.get("lon") is not None and alert.get("lat") is not None:
        # A 500 m circle around the junction: CAP's own shorthand for "about here", and honest
        # about the resolution a 30 m grid supports at a point.
        child(area, "circle", f"{alert['lat']},{alert['lon']} 0.5")

    ET.indent(root, space="  ")
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode")


def write_alerts(
    run_dir: Path,
    alerts: list[dict[str, Any]],
    *,
    runs_root: Path | None = None,
    run_id: str | None = None,
) -> list[dict[str, Any]]:
    """Write ``alerts.json`` and one CAP document per alert into the run directory.

    **This is where the cross-cycle rule meets the disk.** Given the :class:`AlertQueue`
    :func:`build_alerts` returns, not yet final, the previous cycle's record is read from
    ``runs_root`` - by default the folder ``run_dir`` sits in, which is the registry's root while
    the cycle writes into its temporary directory - and :func:`apply_cycle_hysteresis` decides
    what is raised. The run id comes from the queue itself unless given. A plain list is written
    as it is, which is what a caller that has already decided (or a test) hands in.

    Returns the queue as written, so a caller can read what was raised.
    """
    queue: list[dict[str, Any]] = alerts
    if isinstance(alerts, AlertQueue) and not alerts.final:
        name = run_id or alerts.run_id
        root = runs_root if runs_root is not None else run_dir.parent
        previous = previous_record(name, root) if name else {}
        queue = apply_cycle_hysteresis(alerts, previous)

    body: dict[str, Any] = {"alerts": list(queue)}
    if isinstance(queue, AlertQueue) and queue.final:
        body["n_raised"] = queue.n_raised
        body["pending"] = queue.pending
        body["n_pending"] = queue.n_pending
        body["cleared"] = queue.cleared
        body["n_cleared"] = queue.n_cleared
        body["hysteresis"] = queue.record
    (run_dir / "alerts.json").write_text(json.dumps(body, separators=(",", ":")), encoding="utf-8")
    if not queue:
        return queue
    folder = run_dir / "alerts"
    folder.mkdir(exist_ok=True)
    for alert in queue:
        (folder / f"{alert['id']}.cap.xml").write_text(cap_xml(alert), encoding="utf-8")
    return queue
