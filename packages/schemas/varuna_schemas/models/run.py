"""Run metadata (``run.json``) and run-id helpers (CLAUDE.md 10.3).

Run id format::

    <CITY>-<cycle_ts UTC compact YYYYMMDDTHHMMZ>-sky<v>-twin<v>-flash<v>-<live|baked>

Example: ``MUM-20190702T1210Z-sky1.0-twin1.0-flash0.3-baked`` is the 17:40 IST cycle
of 2 July 2019 for Mumbai, published from pre-computed (baked) artifacts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from pydantic import Field, computed_field, field_validator

from varuna_schemas.constants import CITY_CODES, IST, N_STEPS, STEP_MIN
from varuna_schemas.models.common import BBox, Timestamp, VarunaModel

RunMode = Literal["baked", "live"]
"""Whether the run's artifacts were pre-computed by ``make bake`` or computed on demand."""

ReplayMode = Literal["replay", "live", "degraded"]
"""Ingestion mode of the cycle that produced the run (the mode banner)."""

_VERSION = r"[0-9]+(?:\.[0-9]+)*(?:[A-Za-z0-9]+)?"
_RUN_ID_RE = re.compile(
    rf"^(?P<city>[A-Z]{{3}})-(?P<ts>\d{{8}}T\d{{4}}Z)"
    rf"-sky(?P<sky>{_VERSION})-twin(?P<twin>{_VERSION})-flash(?P<flash>{_VERSION})"
    r"-(?P<mode>live|baked)$"
)


class RunIdError(ValueError):
    """A string is not a valid VARUNA run id."""


@dataclass(frozen=True, slots=True)
class RunIdParts:
    """The parsed components of a run id. ``cycle_ts`` is timezone-aware (UTC)."""

    city_code: str
    cycle_ts: datetime
    sky_version: str
    twin_version: str
    flash_version: str
    mode: RunMode

    @property
    def cycle_ts_ist(self) -> datetime:
        return self.cycle_ts.astimezone(IST)

    @property
    def city(self) -> str:
        """City slug (``mumbai``) when the code is known, else the code in lower case."""
        for slug, code in CITY_CODES.items():
            if code == self.city_code:
                return slug
        return self.city_code.lower()


def city_code(city: str) -> str:
    """``"mumbai"`` -> ``"MUM"``; a three-letter code passes through upper-cased."""
    key = city.strip()
    if key.lower() in CITY_CODES:
        return CITY_CODES[key.lower()]
    if re.fullmatch(r"[A-Za-z]{3}", key):
        return key.upper()
    msg = f"Unknown city {city!r}; expected one of {sorted(CITY_CODES)} or a three-letter code"
    raise RunIdError(msg)


def _check_version(label: str, version: str) -> str:
    if not re.fullmatch(_VERSION, version):
        msg = f"{label} version must look like 1.0 or 0.3, got {version!r}"
        raise RunIdError(msg)
    return version


def build_run_id(
    city: str,
    cycle_ts: datetime,
    sky_v: str,
    twin_v: str,
    flash_v: str,
    mode: RunMode,
) -> str:
    """Compose a run id. ``cycle_ts`` must be timezone-aware; it is rendered in UTC to the minute."""
    if cycle_ts.tzinfo is None or cycle_ts.utcoffset() is None:
        msg = "cycle_ts must be timezone-aware (IST +05:30 or UTC)"
        raise RunIdError(msg)
    if mode not in ("live", "baked"):
        msg = f"mode must be 'live' or 'baked', got {mode!r}"
        raise RunIdError(msg)
    stamp = cycle_ts.astimezone(UTC).strftime("%Y%m%dT%H%MZ")
    return (
        f"{city_code(city)}-{stamp}"
        f"-sky{_check_version('sky', sky_v)}"
        f"-twin{_check_version('twin', twin_v)}"
        f"-flash{_check_version('flash', flash_v)}"
        f"-{mode}"
    )


def parse_run_id(run_id: str) -> RunIdParts:
    """Split a run id into :class:`RunIdParts`; raises :class:`RunIdError` on any deviation."""
    match = _RUN_ID_RE.match(run_id.strip())
    if match is None:
        msg = (
            f"Invalid run id {run_id!r}; expected "
            "<CITY>-<YYYYMMDDTHHMMZ>-sky<v>-twin<v>-flash<v>-<live|baked>"
        )
        raise RunIdError(msg)
    try:
        ts = datetime.strptime(match["ts"], "%Y%m%dT%H%MZ").replace(tzinfo=UTC)
    except ValueError as exc:
        msg = f"Invalid timestamp in run id {run_id!r}: {exc}"
        raise RunIdError(msg) from exc
    return RunIdParts(
        city_code=match["city"],
        cycle_ts=ts,
        sky_version=match["sky"],
        twin_version=match["twin"],
        flash_version=match["flash"],
        mode=match["mode"],  # type: ignore[arg-type]
    )


def is_run_id(value: str) -> bool:
    """True when :func:`parse_run_id` would accept ``value`` (format and a real calendar time)."""
    try:
        parse_run_id(value)
    except RunIdError:
        return False
    return True


class EngineVersions(VarunaModel):
    """Engine versions that produced a run; the first three appear in the run id."""

    sky: str = Field(description="VARUNA-Sky version, e.g. 1.0")
    twin: str = Field(description="VARUNA-Twin version")
    flash: str = Field(description="VARUNA-Flash version (0.x = reduced-order emulator)")
    pulse: str = Field(description="VARUNA-Pulse version")
    products: str = Field(description="Products version")


class GridSpec(VarunaModel):
    """The computational grid of the 2D solver (CLAUDE.md 3.3)."""

    dx_m: float = Field(gt=0, description="Cell size in metres (30 for the city grid).")
    nx: int = Field(gt=0, description="Columns.")
    ny: int = Field(gt=0, description="Rows.")
    crs: str = Field(description="Computation CRS, e.g. EPSG:32643 (UTM 43N).")
    bounds: BBox = Field(description="WGS84 extent of the grid for the map BitmapLayer.")
    transform: tuple[float, float, float, float, float, float] | None = Field(
        default=None,
        description="Affine (a, b, c, d, e, f) in CRS units for raster writers; optional.",
    )

    @field_validator("crs", mode="before")
    @classmethod
    def _epsg_int(cls, value: object) -> object:
        if isinstance(value, int) and not isinstance(value, bool):
            return f"EPSG:{value}"
        return value

    @property
    def n_cells(self) -> int:
        return self.nx * self.ny


class RunMeta(VarunaModel):
    """``run.json``: provenance for one cycle's artifacts (CLAUDE.md 10.3, blueprint 9.1 ``run``)."""

    run_id: str = Field(description="See build_run_id().")
    city: str = Field(description="City slug, e.g. mumbai.")
    cycle_ts: Timestamp = Field(description="Cycle time (IST).")
    radar_frame_ts: Timestamp | None = Field(
        default=None, description="Timestamp of the latest radar frame used, if any."
    )
    versions: EngineVersions
    mode: RunMode = Field(description="baked = pre-computed by make bake; live = computed now.")
    replay_mode: ReplayMode = Field(default="replay", description="Ingestion mode of the cycle.")
    ensemble_n: int = Field(ge=1, description="Street-forecast members (50 in the prototype).")
    stage_ms: dict[str, int] = Field(
        default_factory=dict, description="Wall-clock per stage in ms (decode, sky, twin, ...)."
    )
    mass_balance_err: float = Field(
        ge=0, description="Relative mass-balance error of the Twin run (fraction, target < 0.001)."
    )
    bundle: str | None = Field(default=None, description="Replay bundle id, None when live.")
    created_at: Timestamp = Field(description="When the run directory was written (IST).")
    grid: GridSpec
    degraded_feeds: list[str] = Field(
        default_factory=list, description="Feeds missing in this cycle, e.g. ['radar', 'traffic']."
    )
    step_min: int = Field(default=STEP_MIN, gt=0, description="Forecast step in minutes.")
    n_steps: int = Field(default=N_STEPS, gt=0, description="Number of forecast steps.")
    notes: list[str] = Field(
        default_factory=list,
        description="Honesty notes shown in the run stamp, e.g. 'reconstructed replay'.",
    )

    @field_validator("run_id")
    @classmethod
    def _valid_run_id(cls, value: str) -> str:
        parse_run_id(value)
        return value

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_ms(self) -> int:
        """Sum of stage timings in ms."""
        return int(sum(self.stage_ms.values()))

    @computed_field  # type: ignore[prop-decorator]
    @property
    def lead_max_min(self) -> int:
        """Longest lead time in minutes (180 for 36 steps of 5 min)."""
        return self.step_min * self.n_steps

    @property
    def parts(self) -> RunIdParts:
        return parse_run_id(self.run_id)

    @property
    def is_degraded(self) -> bool:
        return self.replay_mode == "degraded" or bool(self.degraded_feeds)


__all__ = [
    "EngineVersions",
    "GridSpec",
    "ReplayMode",
    "RunIdError",
    "RunIdParts",
    "RunMeta",
    "RunMode",
    "build_run_id",
    "city_code",
    "is_run_id",
    "parse_run_id",
]
