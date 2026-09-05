"""Shared constants for every VARUNA service.

Everything here is a number or a name that at least two services must agree on:
vehicle thresholds, alert hysteresis, cycle budgets, bus topics, city codes. Each
constant cites the CLAUDE.md section it comes from so a reviewer can check it.

Units are always in the name (``_CM``, ``_MS``, ``_M2S``) or in the docstring.
"""

from __future__ import annotations

from datetime import timedelta, timezone
from typing import Final, Literal

# --------------------------------------------------------------------------- time
IST: Final = timezone(timedelta(hours=5, minutes=30), name="IST")
"""Indian Standard Time. Every timestamp on the contract surface carries +05:30."""

STEP_MIN: Final[int] = 5
"""Forecast step in minutes (CLAUDE.md 10.3: 36 steps of 5 min)."""

N_STEPS: Final[int] = 36
"""Number of forecast steps per run: 3 h at 5-min cadence."""

LEAD_MIN_MIN: Final[int] = -60
"""Earliest lead shown on the time bar in minutes (observed half, CLAUDE.md 7.2)."""

LEAD_MAX_MIN: Final[int] = 180
"""Latest lead shown on the time bar in minutes."""

CYCLE_PERIOD_MIN: Final[int] = 5
"""One operational cycle every 5 sim-minutes (CLAUDE.md 11.11)."""

# ------------------------------------------------------------------- ensembles
SKY_MEMBERS: Final[int] = 20
"""VARUNA-Sky STEPS ensemble size (CLAUDE.md 11.1)."""

FLASH_MEMBERS: Final[int] = 50
"""VARUNA-Flash street-forecast ensemble size (CLAUDE.md 11.7)."""

# ------------------------------------------------------------------- cities
CITY_CODES: Final[dict[str, str]] = {"mumbai": "MUM", "chennai": "CHN"}
"""City slug (as in ``VARUNA_CITY``) to the three-letter code used in run ids."""

CITY_SLUGS: Final[dict[str, str]] = {code: slug for slug, code in CITY_CODES.items()}
"""Reverse of :data:`CITY_CODES`."""

# ------------------------------------------------------------------- depth
DepthBandKey = Literal["dry", "1", "2", "3", "4", "5"]

DEPTH_BAND_EDGES_CM: Final[tuple[int, int, int, int, int]] = (5, 15, 30, 45, 60)
"""Lower edges of depth bands 1..5 in cm (CLAUDE.md 6.2). Below 5 cm is ``dry``."""

DEPTH_THRESHOLDS_CM: Final[tuple[int, int, int, int]] = (15, 30, 45, 60)
"""Exceedance thresholds reported per segment: P(h > 15/30/45/60 cm) (CLAUDE.md 11.8)."""

VehicleProfile = Literal["ambulance", "fire_tender", "bus", "car", "two_wheeler", "pedestrian"]
"""Routing and safe-until profiles (CLAUDE.md 7.4, 11.8, 11.9)."""

VEHICLE_PROFILES: Final[tuple[VehicleProfile, ...]] = (
    "ambulance",
    "fire_tender",
    "bus",
    "car",
    "two_wheeler",
    "pedestrian",
)

PROFILE_THRESHOLDS_CM: Final[dict[VehicleProfile, int]] = {
    "two_wheeler": 15,
    "car": 30,
    "ambulance": 30,
    "bus": 45,
    "fire_tender": 45,
    "pedestrian": 30,
}
"""Impassability depth per profile in cm (CLAUDE.md 11.8; blueprint 6.8).

Two-wheeler 15, car 30, bus and truck 45. An ambulance is a van-class vehicle and
uses the car threshold with a stricter risk tolerance (0.2). A fire tender is a
truck (45). A pedestrian is unsafe at h >= 30 cm or when h times v >= 0.5 m^2/s
(:data:`PEDESTRIAN_HV_LIMIT_M2S`). Specialised rescue vehicles use 60 cm, the
top depth band, and are not a routing profile in the prototype.
"""

RESCUE_THRESHOLD_CM: Final[int] = 60
"""Depth above which only specialised rescue vehicles move (depth band 5)."""

PEDESTRIAN_HV_LIMIT_M2S: Final[float] = 0.5
"""Pedestrian hazard rule: unsafe when depth times velocity >= 0.5 m^2/s."""

DEFAULT_RISK_TOLERANCE: Final[float] = 0.5
"""Operator risk tolerance: safe-until is the first time P(h > threshold) exceeds it."""

PROFILE_RISK_TOLERANCE: Final[dict[VehicleProfile, float]] = {
    "ambulance": 0.2,
    "fire_tender": 0.5,
    "bus": 0.5,
    "car": 0.5,
    "two_wheeler": 0.5,
    "pedestrian": 0.5,
}
"""Default risk tolerance per profile (CLAUDE.md 11.8: tolerance 0.5, ambulance 0.2)."""

DepthHint = Literal["ankle", "knee", "waist"]

DEPTH_HINT_CM: Final[dict[DepthHint, tuple[int, int]]] = {
    "ankle": (10, 8),
    "knee": (45, 12),
    "waist": (90, 15),
}
"""Citizen depth chips to (mean cm, sd cm) (CLAUDE.md 11.6)."""

# ------------------------------------------------------------------- alerts
AlertLevel = Literal["watch", "moderate", "severe"]

ALERT_LEVEL_THRESHOLDS_CM: Final[dict[AlertLevel, int]] = {
    "watch": 15,
    "moderate": 30,
    "severe": 45,
}
"""Alert levels by depth threshold (CLAUDE.md 11.10)."""

ALERT_RAISE_P: Final[float] = 0.6
"""Raise an alert when P(h > threshold) >= 0.6 for :data:`ALERT_PERSIST_CYCLES` cycles."""

ALERT_CLEAR_P: Final[float] = 0.3
"""Clear an alert when P(h > threshold) <= 0.3 (hysteresis)."""

ALERT_PERSIST_CYCLES: Final[int] = 2
"""Consecutive cycles above the raise probability before an alert is raised."""

# ------------------------------------------------------------------- drains
DRAIN_BAND_EDGES: Final[tuple[float, float, float]] = (0.25, 0.5, 0.75)
"""Posterior blockage beta band edges (CLAUDE.md 6.2): 0-0.25, 0.25-0.5, 0.5-0.75, > 0.75."""

CLEANED_BETA: Final[float] = 0.05
"""Blockage assigned to a pipe cleaned in a what-if (CLAUDE.md 11.7)."""

CLEAN_TOP_N_DEFAULT: Final[int] = 14
"""The demo's 'clean top 14 by beta' what-if (CLAUDE.md 7.7)."""

# ------------------------------------------------------------------- cycle
CycleStage = Literal[
    "decode",
    "sky",
    "twin",
    "flash",
    "pulse",
    "products",
    "route",
    "alerts",
    "publish",
    "idle",
]

CYCLE_STAGES: Final[tuple[CycleStage, ...]] = (
    "decode",
    "sky",
    "twin",
    "flash",
    "pulse",
    "products",
    "route",
    "alerts",
    "publish",
)
"""Stages in execution order (Twin and Flash run in parallel)."""

STAGE_BUDGET_MS: Final[dict[str, int]] = {
    "decode": 500,
    "sky": 5000,
    "twin": 8000,
    "flash": 300,
    "pulse": 3000,
    "products": 2000,
    "route": 2000,
    "alerts": 500,
    "publish": 200,
}
"""Per-stage wall-clock budgets in ms on the demo laptop.

Sky <= 5 s (CLAUDE.md 11.1), Twin <= 8 s (11.3), Flash-lite <= 300 ms (11.7),
Pulse <= 3 s (11.6), products <= 2 s (11.8), reachability <= 2 s per facility (11.9),
baked publish <= 200 ms (11.11). Twin and Flash run in parallel so the live cycle
total is :data:`TOTAL_CYCLE_BUDGET_MS`.
"""

TOTAL_CYCLE_BUDGET_MS: Final[int] = 15_000
"""Live cycle budget on the demo laptop (CLAUDE.md 11.11 and 14)."""

BAKED_PUBLISH_BUDGET_MS: Final[int] = 200
"""Baked run publish to map swap budget (CLAUDE.md 14)."""

# ------------------------------------------------------------------- bus and websocket
BusTopic = Literal[
    "radar.frames",
    "gauges.obs",
    "traffic.speeds",
    "reports.raw",
    "tide.stage",
    "runs.published",
    "cycle.stage",
    "alerts",
]

BUS_TOPICS: Final[tuple[BusTopic, ...]] = (
    "radar.frames",
    "gauges.obs",
    "traffic.speeds",
    "reports.raw",
    "tide.stage",
    "runs.published",
    "cycle.stage",
    "alerts",
)
"""In-process bus topics (CLAUDE.md 11.11); the names match the blueprint's Redpanda topics."""

WsTopic = Literal[
    "runs.published",
    "cycle.stage",
    "alert.raised",
    "alert.acknowledged",
    "alert.escalated",
    "alert.cleared",
    "obs.assimilated",
    "replay.clock",
    "onboard.progress",
    "pumps.dispatched",
    "reports.ack",
]

WS_TOPICS: Final[tuple[WsTopic, ...]] = (
    "runs.published",
    "cycle.stage",
    "alert.raised",
    "alert.acknowledged",
    "alert.escalated",
    "alert.cleared",
    "obs.assimilated",
    "replay.clock",
    "onboard.progress",
    "pumps.dispatched",
    "reports.ack",
)
"""Events relayed on ``WS /v1/live`` (CLAUDE.md 11.11: runs.published, cycle.stage,
alert.*, obs.assimilated, replay.clock, onboard.progress) plus ``pumps.dispatched``
for the phone mock and ``reports.ack`` for the citizen feedback count."""

# ------------------------------------------------------------------- honesty labels
EMULATOR_LABEL: Final[str] = "Reduced-order emulator calibrated to VARUNA-Twin"
INFERRED_DRAINS_LABEL: Final[str] = "Drain graph inferred from roads and terrain"
RECONSTRUCTED_REPLAY_LABEL: Final[str] = "Reconstructed replay"
SYNTHETIC_PUMPS_LABEL: Final[str] = "Synthetic pump inventory"
"""UI copy for the simplifications the user can see (CLAUDE.md 0.6 and 6.8)."""
