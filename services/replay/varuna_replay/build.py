"""Building a bundle on disk: the design storms today (P2.8), the reconstruction next.

``MUM-IDF-25yr`` and ``CHN-IDF-25yr`` need nothing but a city config: a design storm has no
observed event, so it carries a manifest, the two cubes and an empty ground-truth file, and
no gauges, tide, traffic or reports. That makes it the smallest complete exercise of the
bundle contract, which is why :func:`build_design_bundle` is also what proves the writers in
:mod:`varuna_replay.bundle` and the rules in :mod:`varuna_replay.validate` agree.

``MUM-2019-07-02`` is the reconstruction, and it needs the sourced streams that tasks
P2.3-P2.6 curate; :func:`varuna_replay.storm.calibrate` is the piece of it that lives here.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import structlog
from varuna_schemas.constants import CYCLE_PERIOD_MIN, IST
from varuna_schemas.models.bundle import BundleManifest
from varuna_schemas.models.city import CityConfig
from varuna_schemas.paths import bundle_dir, city_config_path

from varuna_replay import bundle as members
from varuna_replay.design import (
    DEFAULT_DURATION_MIN,
    DEFAULT_PEAK_POSITION,
    DEFAULT_STEP_MIN,
    design_bundle_id,
    design_storm,
    design_storm_field,
)
from varuna_replay.domain import StormDomain, step_times_min
from varuna_replay.storm import RadarRender, accumulation_mm, radar_dbz

log = structlog.get_logger("varuna.replay.build")

RADAR_CADENCE_MIN = 10
"""Radar frames every 10 minutes (CLAUDE.md 10.2)."""

TRUTH_CADENCE_MIN = 5
"""The truth rain field every 5 minutes (CLAUDE.md 10.2)."""

NOMINAL_T0 = datetime(2026, 7, 1, 5, 40, tzinfo=IST)
"""A design storm has no date. The clock starts at the same time of day as the demo replay so
the console behaves identically, and the manifest says the date is nominal."""

DESIGN_SEED = 2019
"""The demo seed (rule 8). A design storm uses it only for the radar speckle."""


@dataclass
class BuildResult:
    """What a build wrote, and how long it took."""

    bundle_id: str
    root: Path
    manifest: BundleManifest
    files: list[str] = field(default_factory=list)
    elapsed_s: float = 0.0

    def summary(self) -> str:
        return (
            f"{self.bundle_id} ({self.manifest.label}) -> {self.root}\n"
            + "\n".join(f"  {name}" for name in self.files)
            + f"\n  {len(self.files)} file(s) in {self.elapsed_s:.1f} s"
        )


def load_city(city: str) -> CityConfig:
    """Load ``services/city/configs/<city>.yaml``.

    The replay service reads the city config directly rather than depending on the city
    pipeline: a design storm needs the bbox, the CRS, the radar domain and the design
    intensity, none of which require the city layers to have been built.
    """
    path = city_config_path(city)
    if not path.is_file():
        available = sorted(p.stem for p in path.parent.glob("*.yaml")) if path.parent.is_dir() else []
        msg = f"No city config at {path}. Configured cities: {', '.join(available) or 'none'}."
        raise FileNotFoundError(msg)
    return CityConfig.from_yaml(path)


def build_design_bundle(
    config: CityConfig,
    *,
    intensity_key: str = "upgraded",
    duration_min: int = DEFAULT_DURATION_MIN,
    peak_position_r: float = DEFAULT_PEAK_POSITION,
    t0: datetime | None = None,
    seed: int = DESIGN_SEED,
    out_dir: Path | None = None,
) -> BuildResult:
    """Write a complete design-storm bundle for one city.

    Args:
        config: the city whose ``design_intensity_mm_h`` sets the depth.
        intensity_key: ``"upgraded"`` (50 mm/h) or ``"legacy"`` (25 mm/h).
        duration_min: storm duration; the replay window is exactly this long.
        t0: nominal start; defaults to :data:`NOMINAL_T0`.
        out_dir: write here instead of ``bundles/<id>/`` (used by the tests).
    """
    started = time.perf_counter()
    start = (t0 or NOMINAL_T0).astimezone(IST)
    end = start + timedelta(minutes=duration_min)
    bundle_id = design_bundle_id(config)
    layout = members.BundleLayout(root=(out_dir or bundle_dir(bundle_id)).resolve())
    layout.root.mkdir(parents=True, exist_ok=True)

    domain = StormDomain.from_city_config(config)
    storm = design_storm(
        config,
        intensity_key=intensity_key,
        duration_min=duration_min,
        step_min=DEFAULT_STEP_MIN,
        peak_position_r=peak_position_r,
    )

    truth_times = step_times_min(0.0, float(duration_min), TRUTH_CADENCE_MIN)
    radar_times = step_times_min(0.0, float(duration_min), RADAR_CADENCE_MIN)
    truth = design_storm_field(storm, domain, truth_times)
    radar_rain = design_storm_field(storm, domain, radar_times)
    render = RadarRender(seed=seed)
    frames = radar_dbz(radar_rain, domain, render)
    total_mm = float(accumulation_mm(truth, TRUTH_CADENCE_MIN, rule="left").mean())

    written: list[str] = []
    written.append(
        layout.relative(
            members.write_cube(
                layout.truth,
                truth,
                variable=members.TRUTH_VARIABLE,
                times_min=truth_times,
                domain=domain,
                t0=start,
                step_min=TRUTH_CADENCE_MIN,
                units="mm/h",
                attrs={
                    "bundle": bundle_id,
                    "label": "Design storm",
                    "basis": storm.basis,
                    "integration_rule": "left (each instant holds until the next)",
                },
            )
        )
    )
    written.append(
        layout.relative(
            members.write_cube(
                layout.radar,
                frames,
                variable=members.RADAR_VARIABLE,
                times_min=radar_times,
                domain=domain,
                t0=start,
                step_min=RADAR_CADENCE_MIN,
                units="dBZ",
                attrs={
                    "bundle": bundle_id,
                    "label": "Design storm",
                    "rendering": (
                        f"Marshall-Palmer inverse Z = 200 R^1.6, log-normal speckle sigma "
                        f"{render.speckle_sigma}, {render.coverage_radius_km:.0f} km coverage "
                        f"circle, {render.dbz_class_width:.0f} dBZ classes; NaN means no echo"
                    ),
                },
            )
        )
    )
    written.append(
        layout.relative(
            members.write_ground_truth(
                layout.ground_truth,
                [],
                name=f"{bundle_id} ground truth",
                description=(
                    "Empty on purpose: a design storm is a synthetic scenario, not an event "
                    "that happened, so there is nothing to observe and nothing to source."
                ),
            )
        )
    )

    manifest = BundleManifest(
        id=bundle_id,
        city=config.id,
        label="Design storm",
        t0=start,
        t1=end,
        cadences={
            "radar": RADAR_CADENCE_MIN,
            "truth": TRUTH_CADENCE_MIN,
            "cycle": CYCLE_PERIOD_MIN,
        },
        radar_domain=config.radar_domain,
        aoi=config.bbox,
        sources=[],
        seed=seed,
        synthetic_notes=[
            "Design storm: a synthetic scenario, not a recorded event.",
            f"Rain depth comes from the drainage-norm design intensity "
            f"({storm.intensity_mm_h:.0f} mm/h), not from a published "
            "intensity-duration-frequency curve.",
            "Radar frames are rendered from the rain field, not decoded from an archive.",
            "The clock is nominal: a design storm has no date.",
        ],
        description=(
            f"Chicago hyetograph, {duration_min} minutes, peak at "
            f"{peak_position_r * 100:.0f} % of the duration, "
            f"{storm.total_depth_mm:.0f} mm total over {config.name}."
        ),
        ground_truth_n=0,
        design_storm=storm,
    )
    written.append(layout.relative(members.write_manifest(layout.manifest, manifest)))

    result = BuildResult(
        bundle_id=bundle_id,
        root=layout.root,
        manifest=manifest,
        files=written,
        elapsed_s=time.perf_counter() - started,
    )
    log.info(
        "bundle.built",
        bundle=bundle_id,
        city=config.id,
        total_depth_mm=round(total_mm, 3),
        frames=int(np.asarray(frames).shape[0]),
        elapsed_s=round(result.elapsed_s, 2),
    )
    return result


__all__ = [
    "DESIGN_SEED",
    "NOMINAL_T0",
    "RADAR_CADENCE_MIN",
    "TRUTH_CADENCE_MIN",
    "BuildResult",
    "build_design_bundle",
    "load_city",
]
