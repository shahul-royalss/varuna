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


class StormCellSpec(VarunaModel):
    """One convective cell of the storm designer (CLAUDE.md 10.2; the ``/replay`` cell table).

    Positions and velocities are in :attr:`StormDesign.crs`, the city's metric CRS.
    ``birth_min`` is minutes from the bundle's ``t0`` and may be negative, which means the
    cell was already alive when the replay window opened.
    """

    id: IdStr
    birth_min: float = Field(description="Minutes from t0 at which the cell is born.")
    lifetime_min: float = Field(
        gt=0, description="Minutes from birth to death; the sine envelope spans exactly this."
    )
    start_x_m: float = Field(description="Cell centre at birth, easting in the design CRS.")
    start_y_m: float = Field(description="Cell centre at birth, northing in the design CRS.")
    u_ms: float = Field(description="Eastward velocity component in m/s.")
    v_ms: float = Field(description="Northward velocity component in m/s.")
    sigma_m: float = Field(gt=0, description="Gaussian radius in metres (2-6 km in the demo storm).")
    peak_mm_h: float = Field(
        ge=0, description="Peak rain rate at the cell centre before intensity_scale is applied."
    )

    @property
    def peak_min(self) -> float:
        """Minutes from t0 at which the sine envelope reaches 1."""
        return self.birth_min + self.lifetime_min / 2.0


class StormDesign(VarunaModel):
    """Storm-designer parameters for a reconstructed replay (CLAUDE.md 10.2, 7.8).

    Everything needed to regenerate ``truth/rain.zarr`` and ``radar/frames.zarr`` byte for
    byte: the cells, the stratiform background, the wind, the calibration multiplier and the
    radar-rendering constants. The ``/replay`` storm designer renders :attr:`cells` as a table.
    """

    kind: Literal["convective_cells"] = "convective_cells"
    crs: int = Field(
        ge=1024, le=32767, description="EPSG code of the metric CRS the cell coordinates use."
    )
    seed: int = Field(description="Seed of the generator (2019 for the demo bundle).")
    background_mm_h: float = Field(
        ge=0, description="Stratiform background rain rate (2-5 mm/h in the demo storm)."
    )
    wind_from_deg: float = Field(
        ge=0, lt=360, description="Meteorological direction the cells come from (225 = south-west)."
    )
    wind_speed_ms: float = Field(ge=0, description="Cell translation speed in m/s.")
    intensity_scale: float = Field(
        default=1.0, gt=0, description="Multiplier calibrate() applied to every cell peak."
    )
    cells: list[StormCellSpec] = Field(default_factory=list)
    coverage_radius_km: float = Field(
        default=30.0, gt=0, description="Radar coverage circle; pixels outside it carry no echo."
    )
    speckle_sigma: float = Field(
        default=0.12,
        ge=0,
        description="Standard deviation of the multiplicative log-normal speckle applied to Z.",
    )
    dbz_class_width: float = Field(
        default=5.0, gt=0, description="Reflectivity class width in dBZ (decoded imagery is 5 dBZ)."
    )
    min_dbz: float = Field(
        default=5.0, description="Frames below this class read as no echo, as a decoded image does."
    )
    notes: list[str] = Field(
        default_factory=list, description="Designer choices this bundle must state out loud."
    )


class DesignStorm(VarunaModel):
    """A Chicago hyetograph built from a stated design intensity (CLAUDE.md 10.1, P2.8).

    This is **not** an intensity-duration-frequency curve. No published IDF curve for Mumbai
    or Chennai could be sourced (``docs/research/data_sources.md`` section 6), so the depth
    comes from the drainage-norm design intensity in the city config and the shape comes from
    stated parameters. :attr:`basis` says so in UI-ready copy.
    """

    kind: Literal["chicago_hyetograph"] = "chicago_hyetograph"
    intensity_mm_h: float = Field(
        gt=0, description="The stated design intensity the depth is built from."
    )
    intensity_source: str = Field(
        min_length=8, description="Where that intensity comes from, file and field."
    )
    duration_min: int = Field(gt=0, description="Storm duration in minutes.")
    step_min: int = Field(gt=0, description="Hyetograph block length in minutes.")
    peak_position_r: float = Field(
        gt=0, lt=1, description="Peak position as a fraction of the duration (0.4 = 40 % in)."
    )
    shape_b_min: float = Field(gt=0, description="Chicago shape parameter b, in minutes (stated).")
    shape_c: float = Field(gt=0, lt=1, description="Chicago shape exponent c (stated).")
    total_depth_mm: float = Field(ge=0, description="intensity_mm_h * duration_min / 60, exactly.")
    hyetograph_mm_h: list[float] = Field(
        min_length=1, description="Block intensities in mm/h, one per step_min block."
    )
    basis: str = Field(
        min_length=40,
        description="Why this is not a fitted IDF curve and what would settle it (CLAUDE.md 0.6).",
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
    calibration_basis: str | None = Field(
        default=None,
        description=(
            "How every number in ``calibration`` was arrived at: what a gauge measured, what "
            "was inferred from it, and which source says so. Required once ``calibration`` "
            "carries anything (CLAUDE.md 0.6 and 0.7)."
        ),
    )
    storm: StormDesign | None = Field(
        default=None, description="Storm-designer parameters behind the radar and truth cubes."
    )
    design_storm: DesignStorm | None = Field(
        default=None, description="The Chicago hyetograph, on design-storm bundles only."
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
        if self.calibration and not self.calibration_basis:
            msg = (
                "calibration numbers need calibration_basis: say what was measured, what was "
                "inferred from it and which source says so"
            )
            raise ValueError(msg)
        if self.design_storm is not None and self.label != "Design storm":
            msg = "design_storm is only valid on a bundle labelled 'Design storm'"
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
    "DesignStorm",
    "GroundTruthKind",
    "GroundTruthPin",
    "StormCellSpec",
    "StormDesign",
    "TideSourceKind",
]
