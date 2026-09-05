"""Replay clock and controls (``GET /v1/replay/clock``, ``POST /v1/replay/{play,pause,seek,speed}``,
``GET /v1/replay/bundles``; CLAUDE.md 7.8, 10.2, 12).
"""

from __future__ import annotations

from pydantic import Field, computed_field, model_validator

from varuna_schemas.models.bundle import BundleLabel
from varuna_schemas.models.common import Timestamp, VarunaModel
from varuna_schemas.models.run import RunMode


class ReplayClock(VarunaModel):
    """The single simulation clock shared by the console and the replay page."""

    bundle_id: str
    sim_time: Timestamp = Field(description="Current simulation instant (IST).")
    playing: bool
    speed: float = Field(gt=0, description="Acceleration factor: 1, 10, 30 or 60.")
    t0: Timestamp
    t1: Timestamp
    cycle_index: int = Field(ge=0, description="Cycles triggered since t0.")
    n_cycles: int | None = Field(default=None, ge=1, description="Total cycles in the bundle.")
    mode: RunMode = Field(description="baked = publish pre-computed runs; live = compute each cycle.")
    last_run_id: str | None = None
    next_cycle_ts: Timestamp | None = None

    @model_validator(mode="after")
    def _within_window(self) -> ReplayClock:
        if self.t1 <= self.t0:
            msg = "t1 must be after t0"
            raise ValueError(msg)
        if not self.t0 <= self.sim_time <= self.t1:
            msg = "sim_time must lie within [t0, t1]"
            raise ValueError(msg)
        return self

    @computed_field  # type: ignore[prop-decorator]
    @property
    def progress(self) -> float:
        """Fraction of the replay window elapsed, 0..1."""
        total = (self.t1 - self.t0).total_seconds()
        return (self.sim_time - self.t0).total_seconds() / total if total > 0 else 0.0


class ReplaySeekRequest(VarunaModel):
    """Body of ``POST /v1/replay/seek``."""

    sim_time: Timestamp


class ReplaySpeedRequest(VarunaModel):
    """Body of ``POST /v1/replay/speed``."""

    speed: float = Field(gt=0, le=600)


class ReplayBundleSummary(VarunaModel):
    """One card on the replay page (``GET /v1/replay/bundles``)."""

    id: str
    city: str
    label: BundleLabel
    t0: Timestamp
    t1: Timestamp
    seed: int
    baked: bool = Field(description="True when every cycle exists under data/runs.")
    baked_cycles: int = Field(default=0, ge=0)
    total_cycles: int = Field(ge=1)
    sources_n: int = Field(default=0, ge=0)
    ground_truth_n: int = Field(default=0, ge=0)
    synthetic_notes: list[str] = Field(default_factory=list)
    description: str | None = None


__all__ = ["ReplayBundleSummary", "ReplayClock", "ReplaySeekRequest", "ReplaySpeedRequest"]
