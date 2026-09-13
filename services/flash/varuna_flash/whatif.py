"""What-if and attribution on the emulator (CLAUDE.md 11.7, 7.7; tasks P7.7, P7.8).

Two questions an operator asks that the Twin is too slow to answer:

* **What if?** "Clean the fourteen worst pipes at Hindmata - what changes?" Three hours of city
  in milliseconds, so the answer arrives while the question is still on screen.
* **Why?** Attribution needs one run per candidate pipe. Fourteen candidates is fourteen runs;
  on the Twin that is forty minutes, on the emulator it is a fifth of a second.

**What these answers are worth, stated plainly.** Flash-lite reproduces the Twin's *pattern*
well - peak depth correlates at 0.98 across segments - and its *level* poorly: on held-out
storms its CSI at the 30 cm car threshold is 0.085. So:

* **Attribution mostly cannot be answered here, and says so.** A ranking would only need the
  rank correlation of 0.98 - but this emulator is element-wise per segment (see
  :mod:`varuna_flash.model`: every term in :func:`~varuna_flash.model.simulate` is indexed by
  segment and nothing crosses between them). A pipe that is not under the target moves the
  target's peak by exactly zero, so there is no ranking to read. Measured at Hindmata,
  one of fourteen candidates scored above zero and it was the target's own segment; at the
  deepest street on the same run, none of twenty-nine did. :func:`attribute` therefore drops
  everything under :data:`ATTRIBUTION_FLOOR_CM` and refuses with a reason when nothing
  survives, rather than putting a rank-ordered list of zeros on screen.
* **A what-if depth is not a forecast, and nothing here checks it against the physics.** The
  delta is reported with the emulator's measured error attached, and the level it is added to
  comes from the Twin's own forecast for the run. The physics check of CLAUDE.md 7.7 - re-run
  the Twin on the same scenario, print the disagreement - is specified and unbuilt: there is no
  ``physics_check`` in this package, and ``POST /v1/whatif/physics-check`` answers 501 naming
  why. The reason is cost, not absence: the Twin runs every baked cycle, at 137-174 s per
  full-AOI Mumbai run in six of the seven baked cycles (84 s in the lightest) against section
  14's 10 s budget for the check. A bounded hotspot crop is the route to that budget, and it is
  not built. So the disagreement is not displayed here because it has not been measured - which
  is what the endpoint says rather than leaving the screen implying a button was never pressed.

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
    "ATTRIBUTION_FLOOR_CM",
    "CLEANED_BETA",
    "NO_ATTRIBUTION_REASON",
    "AttributionResult",
    "ScenarioResult",
    "attribute",
    "run_scenario",
]

CLEANED_BETA = 0.05
"""Blockage a desilted pipe is assumed to reach (CLAUDE.md 11.7).

Not zero. A jetted pipe is clear, not new: there is always some residual, and claiming a
perfectly clean pipe would overstate every cleaning benefit the board shows."""

ATTRIBUTION_FLOOR_CM = 0.1
"""Depth a candidate must explain to be named as responsible at all.

A millimetre of street. Below this the emulator has not measured an effect, it has measured
floating-point dust or - far more often here - an exact zero, because it has no coupling between
segments. A row at 0.00 cm on the hotspot drawer reads as "this pipe was evaluated and ranks
fourteenth", which is a claim the number does not make."""

NO_ATTRIBUTION_REASON = (
    "Flash-lite is element-wise per segment: a pipe that is not under the target has exactly "
    "zero effect. Attribution needs drain1d in the loop or the GNN (P7.12)."
)
"""What the drawer says when no candidate clears :data:`ATTRIBUTION_FLOOR_CM`.

CLAUDE.md section 17: a control that cannot do its job names what is missing and what would fix
it. Here the missing piece is a hydraulic operator - either `drain1d` inside the attribution loop
or the GNN surrogate of task P7.12, both of which carry pipe-to-street connectivity that this
cascade folded away into a per-segment capacity term."""


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


@dataclass(frozen=True, slots=True)
class AttributionResult:
    """Which pipes explain one junction's peak - or a refusal naming why none can be.

    ``rows`` is empty exactly when ``reason`` is set. A caller renders one or the other; there is
    no third state where both an empty ranking and no explanation reach the screen."""

    target_segment: str
    depth_before_cm: float
    rows: tuple[dict[str, Any], ...]
    """Surviving candidates, deepest first, each with ``rank``, ``beta`` and
    ``depth_explained_cm``."""

    combined: dict[str, Any] | None
    """Cleaning every surviving row at once, or ``None`` when none survived."""

    reason: str | None
    """Why the list is empty, when it is. :data:`NO_ATTRIBUTION_REASON` in the usual case."""


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
        cleaned_segments: segments whose pipe is desilted to :data:`CLEANED_BETA`. An id this
            fit has no segment for is dropped, and the returned note counts only what was
            actually cleaned - the caller is expected to have told the user about the rest.
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
    picked: list[int] = []
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
    if picked:
        # Counted from what was cleaned, not from what was asked for: an id this fit has no
        # segment for is dropped above, and a note saying otherwise would name pipes the run
        # never touched (rule 6).
        notes.append(
            f"{len(picked)} pipe{'' if len(picked) == 1 else 's'} cleaned to beta = {CLEANED_BETA}."
        )
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
        cleaned=len(picked),
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
) -> AttributionResult:
    """Which pipes are making one junction flood, by cleaning each in turn (CLAUDE.md 11.7).

    A finite-difference sensitivity: clean one candidate, re-run the whole city, and read the
    peak at the target. The candidate that drops it most is the one most responsible. This is
    only affordable because a run is milliseconds - on the Twin it would be three minutes per
    candidate.

    **On this emulator the measurement almost always comes back empty, and it says so.**
    :func:`~varuna_flash.model.simulate` is element-wise per segment, so cleaning a pipe that is
    not under the target moves the target's peak by *exactly* zero - the two do not interact at
    all. The only candidate that can score is the target's own segment, and then the combined
    figure equals that one candidate rather than exceeding it. Candidates below
    :data:`ATTRIBUTION_FLOOR_CM` are dropped, and when that leaves nothing the result carries
    :data:`NO_ATTRIBUTION_REASON` instead of a ranking, because a rank-ordered column of 0.00 cm
    on the hotspot drawer would read as a computed ranking of responsible pipes. What would make
    the ranking real is a hydraulic operator - `drain1d` inside this loop, or the GNN of P7.12.
    """
    index = {sid: i for i, sid in enumerate(model.segment_ids)}
    if target_segment not in index:
        # Not a refusal about the physics: the caller named a segment this fit does not contain.
        return AttributionResult(
            target_segment=target_segment,
            depth_before_cm=0.0,
            rows=(),
            combined=None,
            reason=(
                f"Segment {target_segment} is not in the fitted emulator, so there is no peak "
                f"to attribute. Refit Flash-lite on the current city layers."
            ),
        )
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
        explained = base_peak - peak
        if explained < ATTRIBUTION_FLOOR_CM:
            continue
        scored.append(
            {
                "segment_id": candidate,
                "beta": round(float(beta_now[position]), 3),
                "depth_explained_cm": round(explained, 2),
                "depth_before_cm": round(base_peak, 1),
            }
        )

    if not scored:
        log.info(
            "flash.attribution.refused",
            target=target_segment,
            candidates=len(candidate_segments),
            base_cm=round(base_peak, 1),
            floor_cm=ATTRIBUTION_FLOOR_CM,
        )
        return AttributionResult(
            target_segment=target_segment,
            depth_before_cm=round(base_peak, 1),
            rows=(),
            combined=None,
            reason=NO_ATTRIBUTION_REASON,
        )

    scored.sort(key=lambda row: -row["depth_explained_cm"])
    top = scored[:top_n]
    for rank, row in enumerate(top, start=1):
        row["rank"] = rank

    cleaned = beta_now.copy()
    for row in top:
        cleaned[index[row["segment_id"]]] = CLEANED_BETA
    combined_peak = float(simulate(model, rain_mm_h, beta=cleaned).max(axis=0)[target])

    log.info(
        "flash.attribution",
        target=target_segment,
        candidates=len(candidate_segments),
        above_floor=len(scored),
        top_n=len(top),
        base_cm=round(base_peak, 1),
        combined_cm=round(combined_peak, 1),
    )
    return AttributionResult(
        target_segment=target_segment,
        depth_before_cm=round(base_peak, 1),
        rows=tuple(top),
        combined={
            "segment_id": f"top-{len(top)}-combined",
            "n_cleaned": len(top),
            "depth_before_cm": round(base_peak, 1),
            "depth_after_cm": round(combined_peak, 1),
            "depth_explained_cm": round(base_peak - combined_peak, 2),
        },
        reason=None,
    )
