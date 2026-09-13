"""What the emulator can and cannot attribute (CLAUDE.md 11.7, task P7.7).

`attribute` exists to answer "why does this junction flood?" by cleaning each candidate pipe in
turn. On Flash-lite that question has no answer for all but one candidate, because
:func:`varuna_flash.model.simulate` is element-wise per segment: every term is indexed by segment
and nothing crosses between them. These three cases pin that down on a three-segment model built
by hand, so the arithmetic is readable rather than inferred from a 21,296-segment fit:

* cleaning a pipe that is not under the target moves the target by *exactly* zero;
* cleaning the target's own pipe does move it, so the operator is not simply inert;
* so `attribute` over non-target candidates returns the refusal and its reason, not a
  rank-ordered list of zeros (rule 6).
"""

from __future__ import annotations

import numpy as np
from varuna_flash.model import FlashModel
from varuna_flash.whatif import NO_ATTRIBUTION_REASON, attribute, run_scenario

SEGMENTS = ("A-target", "B-neighbour", "C-neighbour")
TARGET = SEGMENTS[0]
N_STEPS = 12
RAIN_MM_H = 10.0
"""Steady rain, so the peak is the last step and no timing subtlety enters the comparison."""


def _model() -> FlashModel:
    """Three identical segments, each with a pipe that can be desilted.

    ``k = 1`` step makes the cascade deliver within two steps, which keeps a twelve-step run long
    enough to pond visibly. The drainage term is deliberately smaller than the inflow, so the
    street fills at every blockage and cleaning a pipe changes the peak rather than the shape of
    a dry series. The skill numbers are the measured ones from `docs/verification/flash_lite.json`
    so nothing here implies a better emulator than the one that ships.
    """
    return FlashModel(
        segment_ids=SEGMENTS,
        k_steps=np.ones(3),
        gain=np.ones(3),
        drain_cm_per_step=np.full(3, 4.0),
        beta_ref=np.full(3, 0.5),
        baseline_cm=np.zeros((N_STEPS, 3)),
        n_training_runs=6,
        rmse_cm=5.7,
        csi_30cm=0.085,
        fitted_segments=3,
    )


def _rain() -> np.ndarray:
    return np.full(N_STEPS, RAIN_MM_H)


def test_cleaning_a_neighbour_moves_the_target_by_exactly_zero() -> None:
    """Not "a small amount" - zero, to the bit. That is what makes attribution unanswerable."""
    model = _model()
    result = run_scenario(
        model,
        _rain(),
        beta=model.beta_ref,
        cleaned_segments={"B-neighbour", "C-neighbour"},
    )

    assert result.delta_cm[0] == 0.0
    # The neighbours themselves did improve, so the run was not a no-op that trivially passes.
    assert result.delta_cm[1] < 0.0
    assert result.delta_cm[2] < 0.0


def test_cleaning_the_target_lowers_its_own_peak() -> None:
    """The one candidate the emulator can score: the pipe under the street being asked about."""
    model = _model()
    result = run_scenario(model, _rain(), beta=model.beta_ref, cleaned_segments={TARGET})

    assert model.drain_cm_per_step[0] > 0.0
    assert result.delta_cm[0] < 0.0


def test_attribution_over_neighbours_refuses_with_its_reason() -> None:
    """Candidates that all score zero produce the refusal, not fourteen rows of 0.00 cm."""
    model = _model()
    result = attribute(
        model,
        _rain(),
        beta=model.beta_ref,
        target_segment=TARGET,
        candidate_segments=["B-neighbour", "C-neighbour"],
    )

    assert result.rows == ()
    assert result.combined is None
    assert result.reason == NO_ATTRIBUTION_REASON
    # The depth it could not explain is still reported: the drawer has a number to show above
    # the refusal.
    assert result.depth_before_cm > 0.0
