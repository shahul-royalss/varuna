"""The STEPS ensemble nowcast (CLAUDE.md 11.1 step 5).

``pysteps.nowcasts.get_method("steps")`` run exactly as CLAUDE.md 11.1 step 5 specifies: 20
members, 5-minute steps, 36 lead times, six cascade levels, AR(2), probability matching on.
:func:`nowcast` is the only entry point the cycle needs; it tries pySTEPS and, if pySTEPS is
missing or raises, hands the same arguments to :mod:`varuna_sky.fallback_steps` (CLAUDE.md 17).
The caller never chooses, and never has to know which ran: ``RainEnsemble.source`` says.

**The dBR conversion.** pySTEPS works on a logarithmic field, not on rain rate: the cascade
decomposition, the AR fit and the nonparametric noise generator all assume something close to
Gaussian. So the analysis goes in as dBR (``10 log10 R`` in mm/h, dry pixels floored at
:data:`~varuna_sky.motion.DBR_ZEROVALUE`), ``precip_thr`` is that floor in dBR, and the output
comes back through :func:`~varuna_sky.motion.from_dbr`, where anything under the floor - and
every ``nan`` pySTEPS leaves outside its precipitation mask - becomes exactly zero rain.

**Step length against frame interval.** The bundles carry radar every 10 minutes but VARUNA
forecasts every 5 (CLAUDE.md 10.2, 10.3). pySTEPS measures lead time in input intervals, so
the request is a list of fractional steps - 0.5, 1.0, 1.5 ... - rather than a rescaled motion
field. Rescaling the motion would have told pySTEPS that the frames were 5 minutes apart and
halved the lifetime of every scale in the AR fit.

Determinism (rule 8): ``seed`` is passed straight to pySTEPS, which seeds its noise and its
velocity perturbations from it, so a re-run of a cycle reproduces the cube.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

import numpy as np
import structlog

from varuna_sky import fallback_steps
from varuna_sky.motion import DBR_THRESHOLD, MAX_RAIN_MM_H, from_dbr, rain_history, to_dbr
from varuna_sky.types import MotionField, RainEnsemble, SkyInputs, ZRParams

if TYPE_CHECKING:  # pragma: no cover - typing only
    from numpy.typing import NDArray

log = structlog.get_logger("varuna.sky.steps")

__all__ = ["AR_ORDER", "N_CASCADE_LEVELS", "nowcast", "steps_nowcast"]

N_CASCADE_LEVELS = 6
"""Scale cascade levels (CLAUDE.md 11.1 step 5)."""

AR_ORDER = 2
"""AR(2) per cascade level (CLAUDE.md 11.1 step 5)."""

PROBMATCHING_METHOD = "cdf"
""""Probability matching on" (CLAUDE.md 11.1 step 5): each member's intensity distribution is
matched to the observed one."""

MASK_METHOD = "incremental"
"""How the precipitation mask is grown with lead time. CLAUDE.md does not fix this; it is the
pySTEPS default and is the one that keeps the wet area from collapsing over three hours."""

VEL_PERT_METHOD = "bps"
"""Velocity perturbations (Bowler et al.), the pySTEPS default: members disagree about where
the storm goes, not only about how hard it rains. A choice, not a CLAUDE.md requirement."""


def _forecast_times(inputs: SkyInputs) -> tuple:
    """Valid time of each step: step ``k`` is ``cycle_ts + (k + 1) * step_min`` (types.py)."""
    return tuple(
        inputs.cycle_ts + timedelta(minutes=inputs.step_min * (step + 1))
        for step in range(int(inputs.n_steps))
    )


def _analysis_history(
    rain_mm_h: NDArray[np.floating],
    inputs: SkyInputs,
    zr: ZRParams,
) -> NDArray[np.floating]:
    """The ``(AR_ORDER + 1, n_px, n_px)`` rain history pySTEPS needs to fit AR(2).

    A 2D ``rain_mm_h`` is the merged analysis alone, so the earlier frames are rebuilt from
    radar through the cycle's Z-R relation (:func:`~varuna_sky.motion.rain_history`).
    """
    analysis = np.asarray(rain_mm_h, dtype=np.float64)
    if analysis.ndim == 2:
        return rain_history(inputs.frames, zr, analysis, n_frames=AR_ORDER + 1)
    if analysis.ndim != 3:
        msg = f"rain_mm_h must be 2D or 3D, got {analysis.shape}"
        raise ValueError(msg)
    if analysis.shape[0] < AR_ORDER + 1:
        pad = np.repeat(analysis[:1], AR_ORDER + 1 - analysis.shape[0], axis=0)
        analysis = np.concatenate([pad, analysis], axis=0)
    return np.ascontiguousarray(analysis[-(AR_ORDER + 1) :], dtype=np.float64)


def steps_nowcast(
    rain_mm_h: NDArray[np.floating],
    motion: MotionField,
    inputs: SkyInputs,
    zr: ZRParams,
) -> RainEnsemble:
    """Run pySTEPS STEPS. Raises if pySTEPS is missing or fails - :func:`nowcast` catches it."""
    from pysteps.nowcasts import get_method

    history = _analysis_history(rain_mm_h, inputs, zr)
    grid = inputs.frames.grid
    interval_min = max(inputs.frames.interval.total_seconds() / 60.0, 1.0)
    step_ratio = float(inputs.step_min) / interval_min
    timesteps = [round((step + 1) * step_ratio, 6) for step in range(int(inputs.n_steps))]
    velocity = np.stack([np.asarray(motion.u), np.asarray(motion.v)])

    cube = get_method("steps")(
        to_dbr(history),
        velocity,
        timesteps,
        n_ens_members=int(inputs.n_members),
        n_cascade_levels=N_CASCADE_LEVELS,
        precip_thr=float(DBR_THRESHOLD),
        kmperpixel=grid.res_m / 1000.0,
        timestep=interval_min,
        ar_order=AR_ORDER,
        probmatching_method=PROBMATCHING_METHOD,
        mask_method=MASK_METHOD,
        vel_pert_method=VEL_PERT_METHOD,
        seed=int(inputs.seed),
        num_workers=1,
    )
    rain = np.minimum(from_dbr(np.asarray(cube, dtype=np.float64)), MAX_RAIN_MM_H)
    expected = (int(inputs.n_members), int(inputs.n_steps), grid.n_px, grid.n_px)
    if rain.shape != expected:
        # pySTEPS short-circuits a domain with no rain above the threshold ("the resulting
        # forecast will contain only zeros") and, when the lead times are fractional, returns
        # that zero field at the wrong length. A dry forecast is still pySTEPS' answer, so it
        # is restated at the requested length rather than being called a fallback.
        if not np.any(rain) and rain.shape[0] == expected[0] and rain.shape[2:] == expected[2:]:
            log.info("steps.dry_forecast", returned=tuple(rain.shape), expected=expected)
            rain = np.zeros(expected, dtype=np.float64)
        else:
            msg = f"pySTEPS returned {rain.shape}, expected {expected}"
            raise ValueError(msg)
    log.info(
        "steps.pysteps",
        members=expected[0],
        steps=expected[1],
        max_mm_h=round(float(rain.max()), 2),
        motion=motion.method,
    )
    return RainEnsemble(
        rain_mm_h=rain,
        times=_forecast_times(inputs),
        grid=grid,
        source="pysteps_steps",
        seed=int(inputs.seed),
        zr=zr,
        motion=motion,
    )


def nowcast(
    rain_mm_h: NDArray[np.floating],
    motion: MotionField,
    inputs: SkyInputs,
    zr: ZRParams,
) -> RainEnsemble:
    """The 20-member, 3-hour rain ensemble for this cycle (CLAUDE.md 11.1 step 5).

    ``rain_mm_h`` is the gauge-merged analysis: either the latest field ``(n_px, n_px)`` or a
    history ``(n_frames, n_px, n_px)`` ending with it. pySTEPS runs if it can; if it cannot,
    :func:`varuna_sky.fallback_steps.nowcast` does, and the returned ``source`` says which, so
    the console can label the run rather than quietly showing a lesser forecast as the real one.
    """
    try:
        return steps_nowcast(rain_mm_h, motion, inputs, zr)
    except Exception as exc:
        log.warning("steps.pysteps_failed", error=str(exc), fallback="fallback_steps")
        return fallback_steps.nowcast(rain_mm_h, motion, inputs, zr)
