"""What-if on a baked run (CLAUDE.md 7.7, 12; task P7.8).

**The level comes from the Twin, the sensitivity from the emulator.** A baked run already holds
the coupled solver's answer for this storm, per segment, per step. Flash-lite is not accurate
enough to replace that - its CSI at the 30 cm threshold is 0.085 on held-out storms
(`varuna_flash.model`) - but it is fast enough to answer *how the answer moves* when the scenario
changes. So a what-if is the run's own depths plus the difference between two emulator runs:

    scenario = twin_depth + (emulator(scenario) - emulator(baseline))

Which is a delta-correction, and the standard way to use a cheap surrogate beside an expensive
model: the surrogate's systematic error largely cancels in the difference, and the level anybody
reads off the screen is still the physics'.

The response says all of this in `method` and `notes`, and carries the emulator's measured skill,
because a number whose provenance is two models deserves to say so (rule 6).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any

import numpy as np
import structlog
from fastapi import APIRouter, Body
from varuna_schemas.paths import repo_root, run_dir, runs_dir

from varuna_api.state import api_error

log = structlog.get_logger("varuna.api.whatif")

router = APIRouter(prefix="/v1", tags=["whatif"])

MODEL_PATHS = ("data/train/flash_lite.npz", "demo/flash_lite.npz")
"""Where the fitted emulator is looked for, in order."""


def _model():
    from varuna_flash.model import load

    for candidate in MODEL_PATHS:
        path = repo_root() / candidate
        if path.is_file():
            return load(path)
    raise api_error(
        503,
        "no_emulator",
        "Flash-lite has not been fitted. Run `make train` to fit it from Twin runs.",
    )


def _latest_run() -> Path:
    root = runs_dir()
    if not root.is_dir():
        raise api_error(404, "no_runs", "No baked run to run a what-if against.")
    runs = [
        p for p in sorted(root.iterdir(), reverse=True)
        if p.is_dir() and (p / "segments_wet.json").is_file()
    ]
    if not runs:
        raise api_error(404, "no_runs", "No baked run carries a segment forecast yet.")
    return runs[0]


@router.post("/whatif", summary="What-if via the emulator, levelled on the run's own physics")
def whatif(body: Annotated[dict[str, Any], Body()]) -> dict[str, Any]:
    """Scale the rain, clean pipes or run pumps, and report what changes.

    Body: ``{run_id?, rain_scale?, cleaned_segments?, tide_offset_m?}``.

    A tide offset is refused: the emulator is a perturbation around a base state measured at one
    tide series, so it has no representation of a different sea level, and returning a number
    anyway would be inventing one.
    """
    from time import perf_counter

    from varuna_flash.whatif import run_scenario

    started = perf_counter()
    run_id = body.get("run_id")
    path = run_dir(str(run_id)) if run_id else _latest_run()
    if not (path / "segments_wet.json").is_file():
        raise api_error(404, "run_not_found", f"Run {path.name} has no segment forecast.")

    meta = json.loads((path / "run.json").read_text(encoding="utf-8"))
    rain = meta.get("rain_aoi_mm_h")
    if not rain:
        raise api_error(
            409,
            "no_rain_series",
            f"Run {path.name} predates the stored rain series, so there is no storm to scale. "
            "Re-bake the cycle.",
        )

    model = _model()
    wet = json.loads((path / "segments_wet.json").read_text(encoding="utf-8"))
    baseline_by_id = wet.get("depth_cm", {})

    rain_scale = float(body.get("rain_scale", 1.0))
    cleaned = set(body.get("cleaned_segments") or [])
    tide = float(body.get("tide_offset_m", 0.0))

    beta = np.full(model.n_segments, 0.20)
    try:
        scenario = run_scenario(
            model,
            np.asarray(rain, dtype=np.float64),
            beta=beta,
            rain_scale=rain_scale,
            cleaned_segments=cleaned,
            tide_offset_m=tide,
        )
    except ValueError as error:
        raise api_error(422, "unsupported_scenario", str(error)) from error

    # Delta-correct the run's own depths with the emulator's sensitivity.
    index = {sid: i for i, sid in enumerate(model.segment_ids)}
    rows: list[dict[str, Any]] = []
    for segment_id, series in baseline_by_id.items():
        position = index.get(segment_id)
        if position is None:
            continue
        before = max(series)
        delta = float(scenario.delta_cm[position])
        rows.append(
            {
                "segment_id": segment_id,
                "before_cm": round(before, 1),
                "after_cm": round(max(before + delta, 0.0), 1),
                "delta_cm": round(delta, 1),
            }
        )
    rows.sort(key=lambda r: r["delta_cm"])

    ms = (perf_counter() - started) * 1000.0
    log.info(
        "api.whatif",
        run_id=path.name,
        ms=round(ms, 1),
        rain_scale=rain_scale,
        cleaned=len(cleaned),
        improved=scenario.n_improved,
        worse=scenario.n_worse,
    )
    return {
        "run_id": meta.get("run_id", path.name),
        "method": "twin_level_emulator_delta",
        "emulator": {
            "rmse_cm": round(model.rmse_cm, 2),
            "csi_30cm": round(model.csi_30cm, 3),
            "n_training_runs": model.n_training_runs,
        },
        "rain_scale": rain_scale,
        "cleaned_segments": sorted(cleaned),
        "n_improved": scenario.n_improved,
        "n_worse": scenario.n_worse,
        "ms": round(ms, 1),
        "segments": rows[:200],
        "worst_after": sorted(rows, key=lambda r: -r["after_cm"])[:20],
        "notes": [
            *scenario.notes,
            "The level is the Twin's own forecast for this run; the emulator supplies only the "
            "difference the scenario makes. Run the physics check for a scenario the Twin has "
            "solved end to end.",
        ],
    }
