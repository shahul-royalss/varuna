"""What-if and attribution on the emulator (CLAUDE.md 11.7, 7.7; tasks P7.7, P7.8).

Two questions an operator asks that the Twin is too slow to answer:

* **What if?** "Clean the fourteen worst pipes at Hindmata - what changes?" Three hours of city
  in milliseconds, so the answer arrives while the question is still on screen.
* **Why?** Attribution needs one run per candidate pipe. Fourteen candidates is fourteen runs;
  on the Twin that is forty minutes, on the emulator it is a fifth of a second.

**What these answers are worth, stated plainly.** Flash-lite reproduces the Twin's *pattern*
well - peak depth correlates at 0.98 across segments - and its *level* poorly: on held-out
storms its CSI at the 30 cm car threshold is 0.085. So:

* **Attribution is a ranking**, and a rank correlation of 0.98 supports it. Which pipes matter
  most for a junction is a question the emulator can answer.
* **A what-if depth is not a forecast.** The delta is reported with the emulator's measured
  error attached, and `physics_check` re-runs the Twin on the same scenario so the number that
  goes on screen as a depth comes from the physics. CLAUDE.md 7.7 requires the disagreement to
  be displayed, never hidden; here it is the point.

**The tide control is refused, not approximated.** The emulator is a perturbation around a base
state measured from Twin runs that all shared one tide series (see :mod:`varuna_flash.model`),
so it has no representation of a different sea level. Returning a plausible number for a tide
offset would be inventing one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import numpy as np
import structlog

from varuna_flash.model import simulate

if TYPE_CHECKING:  # pragma: no cover - typing only
    from numpy.typing import NDArray

    from varuna_flash.model import FlashModel

log = structlog.get_logger("varuna.flash.whatif")

__all__ = [
    "CLEANED_BETA",
    "ScenarioResult",
    "attribute",
    "run_scenario",
]

CLEANED_BETA = 0.05
"""Blockage a desilted pipe is assumed to reach (CLAUDE.md 11.7).

Not zero. A jetted pipe is clear, not new: there is always some residual, and claiming a
perfectly clean pipe would overstate every cleaning benefit the board shows."""


@dataclass(frozen=True, slots=True)
class ScenarioResult:
    """One what-if: the depths it produces and how they differ from the baseline."""

    depth_cm: NDArray[np.floating]
    """``(steps, segments)`` under the scenario."""

    baseline_cm: NDArray[np.floating]
    delta_cm: NDArray[np.floating]
    """Peak change per segment: negative is improvement."""

    n_improved: int
    n_worse: int
    ms: float
    notes: tuple[str, ...]


def run_scenario(
    model: FlashModel,
    rain_mm_h: NDArray[np.floating],
    *,
    beta: NDArray[np.floating],
    rain_scale: float = 1.0,
    cleaned_segments: set[str] | None = None,
    pump_cm_per_step: NDArray[np.floating] | None = None,
    tide_offset_m: float = 0.0,
) -> ScenarioResult:
    """Run one scenario against the unmodified baseline and report the difference.

    Args:
        model: the fitted emulator.
        rain_mm_h: the cycle's rain, ``(steps,)`` or ``(steps, segments)``.
        beta: current blockage per segment - Pulse's posterior, joined onto segments.
        rain_scale: multiplier on the storm (CLAUDE.md 7.7's 0.5x to 2.0x).
        cleaned_segments: segments whose pipe is desilted to :data:`CLEANED_BETA`.
        pump_cm_per_step: extra drawdown per segment from a pump plan.
        tide_offset_m: refused; see the module docstring.

    Raises:
        ValueError: a tide offset was asked for. The emulator cannot represent it and returning
            a number anyway would be an invention (rule 6).
    """
    from time import perf_counter

    if abs(tide_offset_m) > 1e-9:
        msg = (
            "Flash-lite cannot move the tide: it is a perturbation around a base state measured "
            "at one tide series, so a sea level it never saw is outside what it represents. Run "
            "the physics check for a tide scenario."
        )
        raise ValueError(msg)

    started = perf_counter()
    rain = np.asarray(rain_mm_h, dtype=np.float64)
    beta_now = np.asarray(beta, dtype=np.float64)

    baseline = simulate(model, rain, beta=beta_now, pump_cm_per_step=None)

    beta_scenario = beta_now.copy()
    if cleaned_segments:
        index = {sid: i for i, sid in enumerate(model.segment_ids)}
        picked = [index[s] for s in cleaned_segments if s in index]
        beta_scenario[picked] = CLEANED_BETA

    scenario = simulate(
        model,
        rain * rain_scale,
        beta=beta_scenario,
        pump_cm_per_step=pump_cm_per_step,
    )

    delta = scenario.max(axis=0) - baseline.max(axis=0)
    notes = [
        f"Reduced-order emulator calibrated to VARUNA-Twin: RMSE {model.rmse_cm:.1f} cm and "
        f"CSI {model.csi_30cm:.2f} at 30 cm on held-out storms. The ranking is what this "
        f"supports; run the physics check for a depth."
    ]
    if cleaned_segments:
        notes.append(f"{len(cleaned_segments)} pipes cleaned to beta = {CLEANED_BETA}.")
    if abs(rain_scale - 1.0) > 1e-9:
        notes.append(f"Rain scaled to {rain_scale:.2f}x.")

    result = ScenarioResult(
        depth_cm=scenario,
        baseline_cm=baseline,
        delta_cm=delta,
        n_improved=int(np.sum(delta < -0.5)),
        n_worse=int(np.sum(delta > 0.5)),
        ms=(perf_counter() - started) * 1000.0,
        notes=tuple(notes),
    )
    log.info(
        "flash.whatif",
        ms=round(result.ms, 1),
        rain_scale=rain_scale,
        cleaned=len(cleaned_segments or ()),
        improved=result.n_improved,
        worse=result.n_worse,
    )
    return result


def attribute(
    model: FlashModel,
    rain_mm_h: NDArray[np.floating],
    *,
    beta: NDArray[np.floating],
    target_segment: str,
    candidate_segments: list[str],
    top_n: int = 14,
) -> list[dict[str, Any]]:
    """Which pipes are making one junction flood, by cleaning each in turn (CLAUDE.md 11.7).

    A finite-difference sensitivity: clean one candidate, re-run the whole city, and read the
    peak at the target. The candidate that drops it most is the one most responsible. This is
    only affordable because a run is milliseconds - on the Twin it would be three minutes per
    candidate.

    The combined effect of cleaning the whole top ``top_n`` is computed too, and it is *not* the
    sum of the individual effects: drains share capacity, so cleaning two pipes in series buys
    less than cleaning either twice. The demo's "clean these fourteen" number is this one.
    """
    index = {sid: i for i, sid in enumerate(model.segment_ids)}
    if target_segment not in index:
        return []
    target = index[target_segment]

    beta_now = np.asarray(beta, dtype=np.float64)
    base_peak = float(simulate(model, rain_mm_h, beta=beta_now).max(axis=0)[target])

    scored: list[dict[str, Any]] = []
    for candidate in candidate_segments:
        position = index.get(candidate)
        if position is None:
            continue
        trial = beta_now.copy()
        trial[position] = CLEANED_BETA
        peak = float(simulate(model, rain_mm_h, beta=trial).max(axis=0)[target])
        scored.append(
            {
                "segment_id": candidate,
                "beta": round(float(beta_now[position]), 3),
                "depth_explained_cm": round(base_peak - peak, 2),
            }
        )

    scored.sort(key=lambda row: -row["depth_explained_cm"])
    top = scored[:top_n]

    combined = beta_now.copy()
    for row in top:
        combined[index[row["segment_id"]]] = CLEANED_BETA
    combined_peak = float(simulate(model, rain_mm_h, beta=combined).max(axis=0)[target])

    for rank, row in enumerate(top, start=1):
        row["rank"] = rank
        row["depth_before_cm"] = round(base_peak, 1)
    log.info(
        "flash.attribution",
        target=target_segment,
        candidates=len(scored),
        top_n=len(top),
        base_cm=round(base_peak, 1),
        combined_cm=round(combined_peak, 1),
    )
    return [
        *top,
        {
            "rank": 0,
            "segment_id": f"top-{len(top)}-combined",
            "depth_before_cm": round(base_peak, 1),
            "depth_after_cm": round(combined_peak, 1),
            "depth_explained_cm": round(base_peak - combined_peak, 2),
            "combined": True,
        },
    ]
