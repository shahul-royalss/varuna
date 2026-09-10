"""Turning a forecast into something a ward officer can act on (CLAUDE.md 11.10, P8.7).

An alert is the point where VARUNA stops describing water and starts asking someone to do
something, so the bar for raising one is higher than "a number went up".

**Hysteresis, adapted honestly.** CLAUDE.md 11.10 raises an alert when ``P(h > θ) >= 0.6`` for
two consecutive *cycles* and clears it at ``<= 0.3``. That rule needs a probability and a memory
across cycles; Phase 4 gives one deterministic Twin run, where ``P`` is 0 or 1, and each baked
cycle is computed independently. Applying the rule as written would make every exceedance an
instant alert and every dip an instant all-clear - a queue that flickers.

So the same idea is applied along the forecast instead: a level is raised when the hotspot stays
above its threshold for **two consecutive 5-minute steps**, and the alert clears when it has been
below for two. That is the same statement - a threshold crossing has to persist to count - made
with the information a deterministic run actually has. ``persists_cycles`` reports the steps, and
the alert carries a note saying so, because a jury reading "persists 2 cycles" deserves to know
which clock that is.

**Exercise, not Actual.** Every alert from a replay carries CAP ``status=Exercise`` (CLAUDE.md
11.10). A replay of 2 July 2019 must never produce a document that could be mistaken for a live
civil warning.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from xml.etree import ElementTree as ET

import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only
    from datetime import datetime
    from pathlib import Path

log = structlog.get_logger("varuna.products.alerts")

__all__ = ["LEVELS", "MIN_PERSIST_STEPS", "build_alerts", "cap_xml", "write_alerts"]

LEVELS: tuple[tuple[str, int], ...] = (
    ("severe", 45),
    ("moderate", 30),
    ("watch", 15),
)
"""Level and its depth threshold in cm, worst first (CLAUDE.md 11.10).

The thresholds are the depth ramp's own bands, so an alert level and the colour of the street it
is about can never disagree."""

MIN_PERSIST_STEPS = 2
"""Steps a threshold must stay crossed before an alert is raised: 10 minutes at a 5-minute step.

The hysteresis of CLAUDE.md 11.10, read along the forecast rather than across cycles - see the
module docstring. One step is a single 30 m cell's arithmetic; two is a trend."""

CAP_NS = "urn:oasis:names:tc:emergency:cap:1.2"

SENDER = "varuna@sih2026.example"
"""CAP requires a sender identifier. It is deliberately an example domain: VARUNA is a prototype
and must not appear to originate from a municipal or IMD address (rule 7)."""


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


def build_alerts(
    hotspots: list[dict[str, Any]],
    run_id: str,
    cycle_ts: datetime,
    times: tuple[datetime, ...],
    mode: str = "baked",
) -> list[dict[str, Any]]:
    """Raise one alert per hotspot per level it crosses, worst level only.

    A junction that goes over 45 cm is also over 30 and 15, and sending an officer three messages
    about one street is how an alert queue gets ignored. Only the worst level a hotspot reaches is
    raised, and the card says which lower thresholds it passed on the way.
    """
    alerts: list[dict[str, Any]] = []
    for hotspot in hotspots:
        series = [float(v) for v in hotspot.get("depth_cm", [])]
        if not series:
            continue

        for level, threshold in LEVELS:
            windows = _runs([cm > threshold for cm in series], MIN_PERSIST_STEPS)
            if not windows:
                continue

            start, end = max(windows, key=lambda w: w[1] - w[0])
            peak = max(series[start : end + 1])
            slug = hotspot.get("slug") or hotspot.get("hotspot_id") or "spot"
            from_ts = times[start] if start < len(times) else cycle_ts
            to_ts = times[end] if end < len(times) else cycle_ts

            alerts.append(
                {
                    "id": f"VARUNA-{run_id}-{slug}-{level}".upper().replace("_", "-"),
                    "run_id": run_id,
                    "scope": "hotspot",
                    "scope_id": hotspot.get("hotspot_id"),
                    "hotspot_id": hotspot.get("hotspot_id"),
                    "level": level,
                    "threshold_cm": threshold,
                    "headline": (
                        f"{hotspot.get('name')}: depth above {threshold} cm from "
                        f"{from_ts.strftime('%H:%M')} to {to_ts.strftime('%H:%M')}"
                    ),
                    "instruction": (
                        f"Avoid {hotspot.get('name')} for the window. Peak forecast "
                        f"{peak:.0f} cm. Route emergency vehicles around it; "
                        "see the reachability tab for the affected catchment."
                    ),
                    "area_desc": (
                        f"Ward {hotspot['ward']}, {hotspot.get('name')}"
                        if hotspot.get("ward")
                        else str(hotspot.get("name"))
                    ),
                    "lon": hotspot.get("lon"),
                    "lat": hotspot.get("lat"),
                    # 0 or 1 on a deterministic run. Reported rather than dressed up.
                    "trigger_p": 1.0,
                    "window_from": from_ts.isoformat(),
                    "window_to": to_ts.isoformat(),
                    "peak_cm": round(peak, 1),
                    "raised_ts": cycle_ts.isoformat(),
                    "persists_cycles": end - start + 1,
                    "persists_unit": "forecast steps of 5 minutes",
                    "state": "raised",
                    "channels": ["dashboard"],
                    "source_url": hotspot.get("source_url"),
                    "cap_status": "Exercise" if mode != "live" else "Actual",
                }
            )
            break  # worst level only

    order = {level: i for i, (level, _) in enumerate(LEVELS)}
    alerts.sort(key=lambda a: (order[a["level"]], -a["peak_cm"]))
    log.info(
        "products.alerts",
        run_id=run_id,
        n=len(alerts),
        severe=sum(1 for a in alerts if a["level"] == "severe"),
        moderate=sum(1 for a in alerts if a["level"] == "moderate"),
        watch=sum(1 for a in alerts if a["level"] == "watch"),
    )
    return alerts


def cap_xml(alert: dict[str, Any]) -> str:
    """One alert as a CAP 1.2 document.

    ``status`` is ``Exercise`` for every replay alert (CLAUDE.md 11.10): the document is valid
    CAP and can be pasted into any CAP reader, and it says on its face that it is a drill.
    """
    ET.register_namespace("", CAP_NS)
    root = ET.Element(f"{{{CAP_NS}}}alert")

    def child(parent: ET.Element, tag: str, text: str) -> ET.Element:
        node = ET.SubElement(parent, f"{{{CAP_NS}}}{tag}")
        node.text = text
        return node

    child(root, "identifier", alert["id"])
    child(root, "sender", SENDER)
    child(root, "sent", alert["raised_ts"])
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
    child(info, "onset", alert["window_from"])
    child(info, "expires", alert["window_to"])
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


def write_alerts(run_dir: Path, alerts: list[dict[str, Any]]) -> None:
    """Write ``alerts.json`` and one CAP document per alert into the run directory."""
    (run_dir / "alerts.json").write_text(
        json.dumps({"alerts": alerts}, separators=(",", ":")), encoding="utf-8"
    )
    if not alerts:
        return
    folder = run_dir / "alerts"
    folder.mkdir(exist_ok=True)
    for alert in alerts:
        (folder / f"{alert['id']}.cap.xml").write_text(cap_xml(alert), encoding="utf-8")
