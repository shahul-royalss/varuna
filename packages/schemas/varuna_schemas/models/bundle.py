"""Replay bundle manifest and the sourced ground-truth pins (CLAUDE.md 10.2).

A bundle is a folder ``bundles/<ID>/`` with ``manifest.json`` (this model), radar frames,
a truth rain field (synthetic bundles), gauges, tide, traffic, reports and
``ground_truth.geojson`` whose feature properties follow :class:`GroundTruthPin`.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import Field, field_validator, model_validator

from varuna_schemas.constants import CYCLE_PERIOD_MIN
from varuna_schemas.models.city import RadarDomain
from varuna_schemas.models.common import (
    BBox,
    HttpUrlStr,
    IdStr,
    Latitude,
    Longitude,
    Timestamp,
    VarunaModel,
)

BundleLabel = Literal["Reconstructed replay", "Design storm"]
"""Honesty label shown on the bundle card and the mode banner."""

TideSourceKind = Literal["tide_table", "illustrative"]
GroundTruthKind = Literal["log", "news", "social", "platform"]
"""Where a pin came from: an official log (BMC), a news archive, a geotagged post, a platform
such as the IIT-B Mumbai Flood site."""


class BundleSource(VarunaModel):
    """A public source cited by the bundle (gauge totals, event timeline, tide table)."""

    name: str = Field(description="e.g. IMD Santacruz 24-h total, 2 July 2019")
    url: HttpUrlStr
    note: str | None = Field(default=None, description="What number was taken and how.")
    used_for: str | None = Field(
        default=None, description="e.g. 'AOI 3-hour accumulation target 15:00-21:00 IST'."
    )


class BundleManifest(VarunaModel):
    """``bundles/<ID>/manifest.json``."""

    id: str = Field(pattern=r"^[A-Z]{3}-[A-Za-z0-9-]+$", description="e.g. MUM-2019-07-02")
    city: str = Field(description="City slug, e.g. mumbai.")
    label: BundleLabel
    t0: Timestamp = Field(description="First replay instant (IST).")
    t1: Timestamp = Field(description="Last replay instant (IST).")
    cadences: dict[str, int] = Field(
        description="Stream cadences in minutes: radar, truth, gauges, tide, traffic, reports, cycle.",
    )
    radar_domain: RadarDomain
    aoi: BBox = Field(description="WGS84 AOI bbox the bundle was built for.")
    sources: list[BundleSource] = Field(default_factory=list)
    seed: int = Field(description="Seed of every synthetic generator (2019 for the demo).")
    synthetic_notes: list[str] = Field(
        default_factory=list,
        description="What is synthetic, in UI-ready copy, e.g. 'Radar frames: storm-designer reconstruction'.",
    )
    event_date: date | None = None
    description: str | None = None
    tide_source: TideSourceKind | None = None
    ground_truth_n: int = Field(default=0, ge=0, description="Sourced pins inside the AOI.")
    calibration: dict[str, float] = Field(
        default_factory=dict,
        description="Calibration targets, e.g. {'aoi_3h_accumulation_mm': 152.0}.",
    )

    @field_validator("cadences")
    @classmethod
    def _positive_cadences(cls, value: dict[str, int]) -> dict[str, int]:
        bad = {key: minutes for key, minutes in value.items() if minutes <= 0}
        if bad:
            msg = f"cadences must be positive minutes, got {bad}"
            raise ValueError(msg)
        return value

    @model_validator(mode="after")
    def _window(self) -> BundleManifest:
        if self.t1 <= self.t0:
            msg = "t1 must be after t0"
            raise ValueError(msg)
        if self.label == "Reconstructed replay" and not self.sources:
            msg = "a reconstructed replay must cite at least one public source"
            raise ValueError(msg)
        return self

    @property
    def duration_min(self) -> int:
        return int((self.t1 - self.t0).total_seconds() // 60)

    @property
    def n_cycles(self) -> int:
        """Cycles from t0 to t1 inclusive at the 5-minute cadence."""
        return self.duration_min // CYCLE_PERIOD_MIN + 1

    @property
    def is_reconstructed(self) -> bool:
        return self.label == "Reconstructed replay"


class GroundTruthPin(VarunaModel):
    """Properties of one feature in ``ground_truth.geojson``. Real and sourced, never synthetic
    (CLAUDE.md 0.7, 10.2)."""

    id: IdStr
    ts: Timestamp = Field(description="Best estimate of when the flooding was observed (IST).")
    ts_uncertainty_min: int = Field(default=0, ge=0, description="Half-width of the time window.")
    name: str = Field(description="e.g. Hindmata junction")
    lon: Longitude
    lat: Latitude
    depth_cm: float | None = Field(
        default=None, ge=0, description="Only when the source states or shows a depth."
    )
    kind: GroundTruthKind
    text: str | None = Field(default=None, description="Short quote or paraphrase of the source.")
    source_url: HttpUrlStr
    synthetic: bool = Field(default=False, description="Always False: ground truth is sourced.")

    @field_validator("synthetic")
    @classmethod
    def _never_synthetic(cls, value: bool) -> bool:
        if value:
            msg = "ground-truth pins cannot be synthetic; put synthetic reports in reports.jsonl"
            raise ValueError(msg)
        return value


__all__ = [
    "BundleLabel",
    "BundleManifest",
    "BundleSource",
    "GroundTruthKind",
    "GroundTruthPin",
    "TideSourceKind",
]
