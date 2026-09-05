"""Flood-safe routing, reachability and the road-conditions feed
(``POST /v1/route``, ``GET /v1/reachability``, ``GET /v1/feeds/road-conditions``;
CLAUDE.md 7.4, 11.9, 12; blueprint 9.3).
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field, computed_field, model_validator

from varuna_schemas.constants import (
    PROFILE_RISK_TOLERANCE,
    PROFILE_THRESHOLDS_CM,
    REACH_COLLAPSE_RATIO,
    VehicleProfile,
)
from varuna_schemas.models.common import (
    IdStr,
    Latitude,
    LineString,
    Longitude,
    LonLat,
    MultiPolygon,
    Polygon,
    Probability,
    Timestamp,
    VarunaModel,
)
from varuna_schemas.models.hotspot import FacilityKind

RouteConfidence = Literal["high", "medium", "low"]
"""Falls with lead time: high below 60 min, medium to 120 min, low beyond (Sky skill decays)."""

RouteLabel = Literal["VARUNA", "Naive (shortest)", "Alternate"]
RoadStatus = Literal["passable", "degraded", "impassable"]
ReachMinutes = Literal[5, 10, 15]


class RouteRequest(VarunaModel):
    """Body of ``POST /v1/route``."""

    origin: LonLat = Field(description="[lon, lat], e.g. KEM Hospital [72.8419, 19.0035].")
    destination: LonLat = Field(description="[lon, lat], e.g. Sion Hospital [72.8628, 19.0176].")
    depart_at: Timestamp | None = Field(
        default=None, description="Departure (IST); None = the console's scrub time."
    )
    profile: VehicleProfile = "car"
    risk_tolerance: Probability | None = Field(
        default=None, description="Max P(impassable) accepted per segment; None = profile default."
    )
    run_id: str | None = Field(default=None, description="None = the latest published run.")
    alternates: int = Field(default=2, ge=0, le=2, description="Number of alternates to return.")
    origin_name: str | None = None
    destination_name: str | None = None

    @property
    def effective_risk_tolerance(self) -> float:
        return (
            self.risk_tolerance
            if self.risk_tolerance is not None
            else PROFILE_RISK_TOLERANCE[self.profile]
        )

    @property
    def threshold_cm(self) -> int:
        return PROFILE_THRESHOLDS_CM[self.profile]


class AvoidedSegment(VarunaModel):
    """A segment the naive route uses that VARUNA avoids, with why."""

    segment_id: IdStr
    name: str = Field(description="e.g. Hindmata junction")
    reached_ts: Timestamp = Field(description="When the naive route would have reached it (IST).")
    threshold_cm: int = Field(gt=0, description="Profile threshold applied.")
    p_exceed: Probability = Field(description="P(depth > threshold) at reached_ts.")
    depth_p50_cm: float | None = Field(default=None, ge=0)


class RouteResult(VarunaModel):
    """One route with its forecast-aware summary."""

    label: RouteLabel = "VARUNA"
    geometry: LineString
    eta_min: float = Field(ge=0, description="Travel time in minutes under the forecast.")
    distance_km: float = Field(ge=0)
    max_expected_depth_cm: float = Field(ge=0, description="Max p50 depth met along the route.")
    safe_until: Timestamp | None = Field(
        default=None,
        description="Latest departure for which the route stays passable; None = horizon.",
    )
    arrival_ts: Timestamp | None = None
    segment_ids: list[IdStr] = Field(default_factory=list)
    max_p_exceed: Probability | None = Field(
        default=None, description="Highest P(impassable) on any segment of the route."
    )


class RouteResponse(VarunaModel):
    """Response of ``POST /v1/route`` (blueprint 9.3 shape, with the naive route for comparison)."""

    run_id: str
    valid_ts: Timestamp = Field(description="Cycle time of the run used (IST).")
    profile: VehicleProfile
    depart_at: Timestamp
    risk_tolerance: Probability
    route: RouteResult
    naive: RouteResult | None = Field(
        default=None, description="Shortest route ignoring the forecast."
    )
    avoided: list[AvoidedSegment] = Field(default_factory=list)
    alternates: list[RouteResult] = Field(default_factory=list)
    confidence: RouteConfidence
    confidence_note: str = Field(description="e.g. 'high (lead 30 min)'.")
    explanation: str | None = Field(
        default=None,
        description="Plain language, e.g. 'Avoids Hindmata (82 % above 45 cm at 18:10) via Bharatmata'.",
    )
    compute_ms: int = Field(ge=0, description="Routing wall-clock (budget 300 ms).")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def eta_delta_min(self) -> float | None:
        """Extra minutes versus the naive route (positive = VARUNA is slower but safer)."""
        return None if self.naive is None else self.route.eta_min - self.naive.eta_min


class Isochrone(VarunaModel):
    """Area reachable from a facility within ``minutes`` under the forecast."""

    minutes: ReachMinutes
    polygon: Polygon | MultiPolygon | None = Field(
        default=None, description="Concave hull of reached nodes; None when nothing is reachable."
    )
    area_km2: float = Field(ge=0)
    reachable_nodes: int | None = Field(default=None, ge=0)


class ReachabilityResponse(VarunaModel):
    """``GET /v1/reachability`` and one feature group of ``reachability.geojson``."""

    run_id: str
    valid_ts: Timestamp = Field(description="Cycle time of the run (IST).")
    t: Timestamp = Field(description="Forecast slice the isochrones are computed for (IST).")
    facility_id: IdStr
    facility_name: str = Field(description="e.g. KEM Hospital, Parel")
    facility_kind: FacilityKind
    lon: Longitude
    lat: Latitude
    profile: VehicleProfile
    isochrones: list[Isochrone] = Field(default_factory=list)
    dry_area_15_km2: float = Field(ge=0, description="15-min catchment area with no flooding.")

    @model_validator(mode="after")
    def _one_per_level(self) -> ReachabilityResponse:
        levels = [iso.minutes for iso in self.isochrones]
        if len(levels) != len(set(levels)):
            msg = "one isochrone per minutes level"
            raise ValueError(msg)
        return self

    def area_km2(self, minutes: int) -> float | None:
        for iso in self.isochrones:
            if iso.minutes == minutes:
                return iso.area_km2
        return None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def catchment_ratio(self) -> float | None:
        """15-min area divided by the dry baseline (the ring gauge)."""
        area = self.area_km2(15)
        if area is None or self.dry_area_15_km2 <= 0:
            return None
        return area / self.dry_area_15_km2

    @computed_field  # type: ignore[prop-decorator]
    @property
    def collapse(self) -> bool:
        """True when the 15-min catchment is below 40 % of the dry baseline."""
        ratio = self.catchment_ratio
        return ratio is not None and ratio < REACH_COLLAPSE_RATIO


class RoadCondition(VarunaModel):
    """Feature properties of the ``road-conditions`` provider feed (impassable / degraded segments
    with validity windows) for navigation and transit apps."""

    segment_id: IdStr
    name: str | None = None
    status: RoadStatus
    profile: VehicleProfile = Field(description="Profile the status applies to.")
    valid_from: Timestamp
    valid_to: Timestamp
    depth_p50_cm: float = Field(ge=0)
    p_exceed: Probability = Field(description="P(depth > profile threshold) in the window.")
    run_id: str

    @model_validator(mode="after")
    def _window(self) -> RoadCondition:
        if self.valid_to < self.valid_from:
            msg = "valid_to must not be before valid_from"
            raise ValueError(msg)
        return self


__all__ = [
    "AvoidedSegment",
    "Isochrone",
    "ReachMinutes",
    "ReachabilityResponse",
    "RoadCondition",
    "RoadStatus",
    "RouteConfidence",
    "RouteLabel",
    "RouteRequest",
    "RouteResponse",
    "RouteResult",
]
