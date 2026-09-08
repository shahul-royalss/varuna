"""The STEPS ensemble and its fallback (CLAUDE.md 11.1 step 5, 17; the P3.7 properties).

The four properties tested here are the ones the spec names: spread grows with lead, a dry
input gives a dry cube, a translating storm is carried along the motion field, and the
fallback is interchangeable with pySTEPS - same shape, same dtype, and deterministic.

Everything runs on a 64 x 64 domain with a handful of members and steps, so the file finishes
in seconds. The production 20 x 36 cube on the 120 x 120 Sky grid is the integrator's problem.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta

import numpy as np
import pytest
from varuna_sky import fallback_steps, steps
from varuna_sky.motion import MAX_RAIN_MM_H, optical_flow
from varuna_sky.types import MotionField, RainEnsemble, SkyInputs, ZRParams

from .test_motion import MP, N_PX, frames_from_rain, inputs_for, translating_rain

Nowcaster = Callable[[np.ndarray, MotionField, SkyInputs, ZRParams], RainEnsemble]

NOWCASTERS: dict[str, Nowcaster] = {
    "pysteps": steps.nowcast,
    "fallback": fallback_steps.nowcast,
}
"""Both must satisfy every property below: CLAUDE.md 17 puts them behind one function."""

SPREAD_MEMBERS = 20
"""Enough members that the across-member standard deviation is not swamped by sampling error.
The standard error of an n-member standard deviation is about sd/sqrt(2(n-1)) - 16 % at 20
members, 32 % at 6 - which is why the monotonicity check below carries a tolerance."""


def storm_setup(
    du: float = 3.0,
    dv: float = 1.0,
    n_members: int = 6,
    n_steps: int = 6,
) -> tuple[np.ndarray, MotionField, SkyInputs]:
    """A translating cell, its measured motion field, and one cycle's inputs."""
    rain = translating_rain(du=du, dv=dv)
    frames = frames_from_rain(rain)
    motion = optical_flow(frames, MP)
    return rain, motion, inputs_for(frames, n_members=n_members, n_steps=n_steps)


def domain_mean_spread(ensemble: RainEnsemble) -> np.ndarray:
    """Across-member standard deviation of the domain-mean rain rate, one value per step."""
    return ensemble.rain_mm_h.mean(axis=(2, 3)).std(axis=0, ddof=1)


def blob_centre(field: np.ndarray) -> tuple[float, float]:
    """Centroid (row, col) of the pixels above half the field's maximum.

    Half-maximum ignores the stratiform background, which otherwise drags every centroid
    towards the middle of the domain and hides the displacement being tested.
    """
    mask = field >= 0.5 * float(field.max())
    rows, cols = np.nonzero(mask)
    weights = field[mask]
    return (
        float(np.average(rows, weights=weights)),
        float(np.average(cols, weights=weights)),
    )


# ============================================================================ shape, labels
@pytest.mark.parametrize("name", list(NOWCASTERS))
def test_the_cube_has_the_shape_and_times_the_contract_promises(name: str) -> None:
    rain, motion, inputs = storm_setup()
    ensemble = NOWCASTERS[name](rain[-1], motion, inputs, MP)

    assert ensemble.rain_mm_h.shape == (inputs.n_members, inputs.n_steps, N_PX, N_PX)
    assert ensemble.rain_mm_h.dtype == np.float64
    assert np.isfinite(ensemble.rain_mm_h).all(), "no nan reaches the products stage"
    assert (ensemble.rain_mm_h >= 0.0).all(), "rain rate is never negative"
    assert ensemble.n_members == inputs.n_members
    assert ensemble.n_steps == inputs.n_steps
    assert ensemble.seed == inputs.seed
    assert ensemble.motion is motion
    assert ensemble.zr is MP
    # Step k is cycle_ts + (k + 1) * step_min: the first step is the first forecast instant.
    assert ensemble.times[0] == inputs.cycle_ts + timedelta(minutes=inputs.step_min)
    assert ensemble.times[-1] == inputs.cycle_ts + timedelta(
        minutes=inputs.step_min * inputs.n_steps
    )


def test_the_source_field_says_which_nowcaster_ran() -> None:
    rain, motion, inputs = storm_setup()
    assert steps.nowcast(rain[-1], motion, inputs, MP).source == "pysteps_steps"
    assert fallback_steps.nowcast(rain[-1], motion, inputs, MP).source == "fallback_steps"


def test_a_pysteps_failure_falls_back_and_is_labelled(monkeypatch: pytest.MonkeyPatch) -> None:
    """CLAUDE.md 17: the caller never chooses, and the run is never quietly downgraded."""
    rain, motion, inputs = storm_setup()

    def explode(*_args: object, **_kwargs: object) -> RainEnsemble:
        raise RuntimeError("pysteps is not installed")

    monkeypatch.setattr(steps, "steps_nowcast", explode)
    ensemble = steps.nowcast(rain[-1], motion, inputs, MP)
    assert ensemble.source == "fallback_steps"
    assert ensemble.rain_mm_h.shape == (inputs.n_members, inputs.n_steps, N_PX, N_PX)


def test_the_analysis_may_arrive_as_a_history_or_as_a_single_field() -> None:
    """The merge hands over one field; a caller with its own history may pass the stack."""
    rain, motion, inputs = storm_setup()
    from_field = steps.nowcast(rain[-1], motion, inputs, MP)
    from_stack = steps.nowcast(rain, motion, inputs, MP)
    assert from_field.rain_mm_h.shape == from_stack.rain_mm_h.shape
    assert np.allclose(from_field.rain_mm_h, from_stack.rain_mm_h)


# ============================================================================ spread
@pytest.mark.parametrize("name", list(NOWCASTERS))
def test_ensemble_spread_grows_with_lead_time(name: str) -> None:
    """Members must agree at +5 min and disagree at +40: that is what a nowcast ensemble is for."""
    rain, motion, inputs = storm_setup(n_members=SPREAD_MEMBERS, n_steps=8)
    spread = domain_mean_spread(NOWCASTERS[name](rain[-1], motion, inputs, MP))

    assert spread[-1] > 1.5 * spread[0], f"spread barely grew: {spread}"
    # A finite ensemble estimates its own spread with sampling error, so a single step may dip
    # while the underlying spread rises. The tolerance is a quarter of the largest spread,
    # which is comfortably above the ~16 % standard error at SPREAD_MEMBERS members.
    tolerance = 0.25 * float(spread.max())
    assert np.all(np.diff(spread) >= -tolerance), f"spread is not rising: {spread}"


# ============================================================================ dry
@pytest.mark.parametrize("name", list(NOWCASTERS))
def test_a_dry_input_yields_a_dry_cube(name: str) -> None:
    dry = np.zeros((3, N_PX, N_PX))
    frames = frames_from_rain(dry)
    motion = optical_flow(frames, MP)
    inputs = inputs_for(frames, n_members=4, n_steps=4)

    ensemble = NOWCASTERS[name](dry[-1], motion, inputs, MP)
    assert ensemble.rain_mm_h.shape == (4, 4, N_PX, N_PX)
    assert float(ensemble.rain_mm_h.max()) == 0.0, "no rain may be invented from a dry sky"
    assert motion.method == "zero"


# ============================================================================ advection
@pytest.mark.parametrize("name", list(NOWCASTERS))
def test_a_translating_storm_moves_along_the_motion_field(name: str) -> None:
    """The cell moves 3 px east and 1 px south per 10-minute frame, so over eight 5-minute
    steps its centre must travel about 12 px east and 4 px south.

    Measured as the *median of the members' own centroids*, not the centroid of the ensemble
    mean, and on :data:`SPREAD_MEMBERS` members rather than a handful. Transport and dispersion
    are different things and the mean field confounds them: pySTEPS perturbs each member's
    advection velocity (its ``bps`` perturbator), so by step eight the members' centroids here
    are genuinely 10-18 px apart, and superposing them puts the half-maximum contour wherever
    the brightest member happens to be. On six members that measured a row displacement of
    +8.4 px against a true +4.0; on twenty members the median reads +2.9. The fallback, whose
    members share one velocity field, sits at +3.9 either way - which is what told us the
    disagreement was in the measurement and not in pySTEPS' advection.
    """
    rain, motion, inputs = storm_setup(du=3.0, dv=1.0, n_members=SPREAD_MEMBERS, n_steps=8)
    ensemble = NOWCASTERS[name](rain[-1], motion, inputs, MP)

    start_row, start_col = blob_centre(rain[-1])
    centres = np.array([blob_centre(member) for member in ensemble.rain_mm_h[:, -1]])
    end_row, end_col = float(np.median(centres[:, 0])), float(np.median(centres[:, 1]))
    steps_per_interval = inputs.step_min / (inputs.frames.interval.total_seconds() / 60.0)
    expected_col = 3.0 * steps_per_interval * inputs.n_steps
    expected_row = 1.0 * steps_per_interval * inputs.n_steps

    assert end_col - start_col == pytest.approx(expected_col, abs=4.0)
    assert end_row - start_row == pytest.approx(expected_row, abs=4.0)
    assert end_col > start_col, "the storm must travel east, the way the wind blew it"


def test_a_zero_motion_field_leaves_the_storm_where_it_is() -> None:
    """With no measured flow the fallback must not invent a direction to drift in.

    The storm is *still* as well as the field being zero. A translating history read through a
    zero motion field is a contradiction - it says "nothing moved" about frames in which
    something plainly did - and it is tested one case below, where what matters is that the
    nowcast stays finite rather than where it lands.
    """
    rain, _, inputs = storm_setup(du=0.0, dv=0.0, n_members=4, n_steps=6)
    still = MotionField(
        u=np.zeros((N_PX, N_PX)),
        v=np.zeros((N_PX, N_PX)),
        interval=timedelta(minutes=10),
        res_m=500.0,
        method="zero",
    )
    ensemble = fallback_steps.nowcast(rain[-1], still, inputs, MP)
    start = blob_centre(rain[-1])
    end = blob_centre(ensemble.rain_mm_h[:, -1].mean(axis=0))
    assert end[0] == pytest.approx(start[0], abs=2.0)
    assert end[1] == pytest.approx(start[1], abs=2.0)


# ============================================================================ ill-conditioned
@pytest.mark.parametrize("name", list(NOWCASTERS))
def test_frames_the_motion_field_does_not_explain_still_give_physical_rain(name: str) -> None:
    """A history the motion field cannot align must not be nowcast into impossible rain.

    Telling a nowcaster the storm is stationary while handing it frames in which the storm
    moved 3 px per interval is the worst case optical flow can hand downstream: the lag-2
    correlation of every cascade level collapses, and an AR(2) fitted to that lands on complex
    roots of modulus ~0.99 - a barely damped ringing. Before
    :func:`~varuna_sky.fallback_steps._yule_walker` guarded against it, six steps of that
    reached 10,589 mm/h, roughly 340 times the 31 mm/h that went in.

    The cycle cannot afford that: CLAUDE.md 11.11 expects Sky to degrade rather than fail, and
    rule 6 says every number VARUNA publishes has to be one it can defend.
    """
    rain, _, inputs = storm_setup(du=3.0, dv=1.0, n_members=4, n_steps=6)
    still = MotionField(
        u=np.zeros((N_PX, N_PX)),
        v=np.zeros((N_PX, N_PX)),
        interval=timedelta(minutes=10),
        res_m=500.0,
        method="zero",
    )
    ensemble = NOWCASTERS[name](rain[-1], still, inputs, MP)

    assert np.isfinite(ensemble.rain_mm_h).all()
    assert ensemble.rain_mm_h.max() <= MAX_RAIN_MM_H
    # Well inside the ceiling, too: the guard should keep the fit sane, not lean on the clip.
    assert ensemble.rain_mm_h.max() < 10.0 * float(rain[-1].max())


# ============================================================================ determinism
def test_the_fallback_is_deterministic_for_a_fixed_seed() -> None:
    rain, motion, inputs = storm_setup()
    first = fallback_steps.nowcast(rain[-1], motion, inputs, MP)
    second = fallback_steps.nowcast(rain[-1], motion, inputs, MP)
    assert np.array_equal(first.rain_mm_h, second.rain_mm_h), "rule 8: same inputs, same cube"


def test_the_fallback_seed_actually_changes_the_members() -> None:
    rain, motion, inputs = storm_setup()
    other = inputs_for(inputs.frames, n_members=inputs.n_members, n_steps=inputs.n_steps, seed=7)
    first = fallback_steps.nowcast(rain[-1], motion, inputs, MP)
    second = fallback_steps.nowcast(rain[-1], motion, other, MP)
    assert not np.array_equal(first.rain_mm_h, second.rain_mm_h)


def test_pysteps_is_deterministic_for_a_fixed_seed() -> None:
    rain, motion, inputs = storm_setup(n_members=4, n_steps=4)
    first = steps.nowcast(rain[-1], motion, inputs, MP)
    second = steps.nowcast(rain[-1], motion, inputs, MP)
    assert np.array_equal(first.rain_mm_h, second.rain_mm_h)
