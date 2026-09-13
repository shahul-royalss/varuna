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
from typing import TYPE_CHECKING, Annotated, Any

import numpy as np
import pandas as pd
import structlog
from fastapi import APIRouter, Body
from varuna_pulse.join import SegmentBetaError, segment_beta
from varuna_schemas.paths import repo_root, run_dir

from varuna_api.runs_util import latest_run_for
from varuna_api.state import api_error

# **Imported at module scope, unlike `varuna_flash` below, because it costs 0.8 s.** That is the
# process's first `import pandas`, and deferring it to the first request spent the whole of this
# endpoint's 1 s budget on it - 1.1 s cold against 0.1 s once warm. The API is started before the
# judges arrive and the what-if is pressed in front of them, so the second of the two is the one
# that must be fast; a server paying for its dependencies at boot is the ordinary arrangement.

if TYPE_CHECKING:  # pragma: no cover - typing only; varuna_flash is imported lazily below
    from numpy.typing import NDArray
    from varuna_flash.model import FlashModel

log = structlog.get_logger("varuna.api.whatif")

router = APIRouter(prefix="/v1", tags=["whatif"])

MAX_SEGMENTS = 4000
"""Segments returned per scenario, largest change first.

Four thousand because the diff layer draws them: 200 was enough for a table and far too few for a
map, which is why the difference layer looked empty on a scenario that moved 1,687 streets."""

MODEL_PATHS = ("data/train/flash_lite.npz", "demo/flash_lite.npz")
"""Where the fitted emulator is looked for, in order."""

UNMATCHED_NAMED = 5
"""Unmatched ids quoted back in the refusal, before it says how many more there were."""

DRAIN_HEALTH = "drain_health.geojson"
"""Pulse's posterior for the cycle, written per run by `varuna_pulse.health.write_drain_health`."""

PRIOR_BETA = 0.20
"""The flat blockage used where the city has no pipe under a segment to inherit one from.

CLAUDE.md 10.1 step 7 sets the prior's mean by land use - 0.15 arterial, 0.2 residential, 0.35
markets - so 0.2 is the residential middle, and it is what this endpoint used to run *every*
segment at. It is now the last of three sources rather than the only one, and the response counts
the segments it reached instead of absorbing them."""

_BETA_CACHE: dict[tuple[str, str, int, int], tuple[NDArray[np.float64], dict[str, Any]]] = {}
"""One joined beta vector per run, keyed on the posterior's mtime so a re-bake invalidates it.

The join is two merges over Mumbai's 67k segment-edge pairs, about 320 ms measured - affordable
once against the endpoint's 1 s budget, and not per drag of a what-if slider. The vector is a
pure function of the run's posterior and the city's graph, so caching it changes no number."""

MAX_CACHED_RUNS = 8
"""Joined vectors held before the cache is emptied, so scrubbing a replay cannot grow it forever."""


def _resolve_cleaned(requested: set[str], model: FlashModel) -> tuple[set[str], list[str]]:
    """Split the ids asked for into the ones this emulator can clean and the rest.

    **The endpoint used to echo the request back as the answer.** `run_scenario` drops an id it
    does not recognise, so posting drain edge ids returned 200, said "2 pipes cleaned to beta =
    0.05" and reported zero change - a response that named pipes nothing had touched (rule 6).
    Drain edge ids (`MUM-E035757`) and road-segment ids (`S1001383363-000`) are disjoint
    vocabularies: 6,000 edges and 21,296 segments with no overlap, so the mistake is easy to
    make and was invisible.
    """
    known = set(model.segment_ids)
    matched = requested & known
    unmatched = sorted(requested - known)
    if requested and not matched:
        named = ", ".join(unmatched[:UNMATCHED_NAMED])
        extra = (
            f" and {len(unmatched) - UNMATCHED_NAMED} more"
            if len(unmatched) > UNMATCHED_NAMED
            else ""
        )
        raise api_error(
            422,
            "unknown_segments",
            f"None of the ids to clean are road segments in this city: {named}{extra}. "
            "Cleaning is applied to the pipe under a road segment, so this endpoint takes "
            "road-segment ids (S...), not drain edge ids (MUM-E...); the desilting CSV at "
            "/v1/drains/health.csv lists edge ids, which are a different vocabulary. Read "
            "segment ids from /v1/nowcast/segments or the hotspot drawer.",
        )
    return matched, unmatched


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


def _latest_run(city: str | None = None) -> Path:
    """The newest run for a city that carries a segment forecast.

    City-filtered: see `varuna_api.runs_util`, where a second city's runs shadowing the first is
    written up.
    """
    found = latest_run_for(city, lambda p: (p / "segments_wet.json").is_file())
    if found is None:
        raise api_error(404, "no_runs", "No baked run carries a segment forecast yet.")
    return found


def _posterior_edges(path: Path) -> pd.DataFrame | None:
    """The run's learned blockage per pipe, or None when the run carries no posterior.

    `drain_health.geojson` is capped at the worst `varuna_pulse.health.MAX_WRITTEN_EDGES` pipes,
    so this frame is 6,000 of the graph's 49,770 edges, and the segments it leaves unresolved
    fall through to the city's prior and are counted there.

    **The posterior wins over the prior even when the prior is higher.** A segment whose worst
    *learned* pipe sits at 0.20 can have an unwritten neighbour whose *prior* is 0.35, and taking
    the higher of the two would refuse to learn downward - assimilation moved 366 pipes this
    cycle and some of them fell. Preferring what was learned understates 2 of the 2,517 resolved
    segments on the 09:10 run, by at most 0.025 of blockage; taking the maximum instead would
    overrule Pulse on every pipe it cleared.
    """
    health_path = path / DRAIN_HEALTH
    if not health_path.is_file():
        return None
    health = json.loads(health_path.read_text(encoding="utf-8"))
    features = health.get("features") or []
    if not features:
        return None
    # `capacity_reduction_pct` rides along: the join prefers the caller's column to recomputing
    # it, so the endpoint and the drain X-ray never disagree about which pipe is worst.
    return pd.DataFrame([feature.get("properties", {}) for feature in features])


def _beta_vector(
    path: Path, city: str | None, model: FlashModel
) -> tuple[NDArray[np.float64], dict[str, Any]]:
    """Blockage per road segment for the emulator, and where every value in it came from.

    **This endpoint used to run at a flat 0.20** while the same run directory carried 6,000 pipes
    between 0.20 and 0.68 on the 09:10 cycle - the learned state Pulse exists to produce, sitting
    unread beside the model that needed it (CLAUDE.md 11.7, rule 6). The substitution was silent,
    which is the part that mattered: a what-if answered at a uniform blockage looks exactly like
    one answered at the posterior, and cleaning a pipe that was never blocked reports a benefit
    the city would not get.

    Three sources, in order, each counted in the returned `beta_source`:

    1. the run's own posterior (`drain_health.geojson`), which is what Pulse learned this cycle;
    2. the city's per-pipe prior, for segments whose worst pipe is not in the written cap;
    3. :data:`PRIOR_BETA`, for segments with no inlet link at all - service roads, footways,
       slivers between intersections - which have no pipe to inherit from in either table.

    A city with no drain graph cannot be joined at all; that is the flat-prior fallback, and it
    says so rather than looking like a measurement.
    """
    if not city:
        # Without a city there is no graph to join against, and guessing one would attach another
        # city's learned drains to this run's streets.
        return np.full(model.n_segments, PRIOR_BETA), {
            "kind": "prior_uniform",
            "value": PRIOR_BETA,
            "reason": f"Run {path.name} names no city in run.json, so its drain graph cannot be "
            "identified. Re-bake the cycle.",
        }

    health_path = path / DRAIN_HEALTH
    mtime = health_path.stat().st_mtime_ns if health_path.is_file() else 0
    key = (path.name, city, mtime, model.n_segments)
    cached = _BETA_CACHE.get(key)
    if cached is not None:
        beta, source = cached
        return beta.copy(), dict(source)

    posterior = _posterior_edges(path)
    try:
        prior, _ = segment_beta(city, None, model.segment_ids)
        learned = (
            segment_beta(city, posterior, model.segment_ids)[0]
            if posterior is not None
            else np.full(model.n_segments, np.nan)
        )
    except SegmentBetaError as error:
        # No graph, no join. The flat prior is then the only honest thing left, and the reason
        # travels with it so nobody reads 0.20 as something Pulse measured.
        return np.full(model.n_segments, PRIOR_BETA), {
            "kind": "prior_uniform",
            "value": PRIOR_BETA,
            "reason": str(error),
        }

    from_posterior = np.isfinite(learned)
    from_prior = ~from_posterior & np.isfinite(prior)
    beta = np.where(from_posterior, learned, np.where(from_prior, prior, PRIOR_BETA))
    flat = int(model.n_segments - from_posterior.sum() - from_prior.sum())

    if flat == model.n_segments:
        # Nothing joined at all: the vector is literally uniform, so calling it a posterior would
        # be a label on an empty join. This is what a Chennai run looks like against the
        # Mumbai-fitted emulator - the two segment vocabularies do not meet.
        return beta, {
            "kind": "prior_uniform",
            "value": PRIOR_BETA,
            "reason": f"None of the emulator's {model.n_segments:,} segments has a pipe in "
            f"{city}'s drain graph, so neither the posterior nor the prior could be joined. The "
            "fitted emulator and this run are not the same city.",
        }

    source: dict[str, Any] = {
        "kind": "pulse_posterior" if posterior is not None else "city_prior",
        # The run whose posterior was read. It is the run the what-if is levelled on, so the two
        # cannot drift apart; naming it anyway means a response never leaves that assumed.
        "run_id": path.name,
        "resolved": int(from_posterior.sum()),
        # Everything the posterior did not reach: the city's own prior where a pipe exists,
        # PRIOR_BETA where none does. The second is counted separately because it is weaker.
        "filled_with_prior": int(from_prior.sum()) + flat,
        "filled_with_flat_prior": flat,
        "min": round(float(beta.min()), 4),
        "max": round(float(beta.max()), 4),
    }
    if posterior is not None:
        source["posterior_edges"] = len(posterior)
    else:
        source["reason"] = (
            f"Run {path.name} carries no {DRAIN_HEALTH}, so nothing was learned to join; "
            "blockage is the city's inferred prior per pipe."
        )
    if len(_BETA_CACHE) >= MAX_CACHED_RUNS:
        _BETA_CACHE.clear()
    _BETA_CACHE[key] = (beta, source)
    return beta.copy(), dict(source)


def _beta_note(source: dict[str, Any]) -> str:
    """One sentence naming which blockage the answer was computed at (CLAUDE.md 6.8)."""
    if source["kind"] == "prior_uniform":
        return (
            f"Blockage is a flat {source['value']} on every street: {source['reason']} "
            "Pulse's learned drain state was not used."
        )
    tail = (
        f"{source['filled_with_flat_prior']:,} of them at a flat {PRIOR_BETA} because no pipe "
        f"drains the street. Blockage spans {source['min']} to {source['max']}."
    )
    if source["kind"] == "city_prior":
        return f"{source['reason']} All {source['filled_with_prior']:,} segments took it, {tail}"
    return (
        f"Blockage is Pulse's posterior from run {source['run_id']}: "
        f"{source['resolved']:,} segments from the learned state and "
        f"{source['filled_with_prior']:,} from the city's inferred prior, {tail}"
    )


@router.post("/whatif", summary="What-if via the emulator, levelled on the run's own physics")
def whatif(body: Annotated[dict[str, Any], Body()]) -> dict[str, Any]:
    """Scale the rain, clean pipes or run pumps, and report what changes.

    Body: ``{run_id?, rain_scale?, cleaned_segments?, tide_offset_m?}``.

    A tide offset is refused: the emulator is a perturbation around a base state measured at one
    tide series, so it has no representation of a different sea level, and returning a number
    anyway would be inventing one.

    ``cleaned_segments`` are road-segment ids. Ids this city has no segment for are reported in
    ``cleaned_unmatched`` and never counted as cleaned; a request where *none* of them match is
    refused with 422 ``unknown_segments`` rather than answered for a scenario nobody asked for.
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
    cleaned, unmatched = _resolve_cleaned(set(body.get("cleaned_segments") or []), model)
    tide = float(body.get("tide_offset_m", 0.0))

    beta, beta_source = _beta_vector(path, meta.get("city"), model)
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
    # **Sorted by how much the scenario moved a street, not by the sign of the move.** Sorting
    # ascending and taking the first 200 returned the 200 *most improved* - and when a scenario
    # only makes things worse, as scaling the rain up does, that is 200 segments whose delta is
    # exactly zero. The diff layer drew nothing and the table listed nothing, on a scenario that
    # had in fact moved 1,687 streets. Largest absolute change first is what a difference is.
    rows.sort(key=lambda r: -abs(r["delta_cm"]))

    ms = (perf_counter() - started) * 1000.0
    log.info(
        "api.whatif",
        run_id=path.name,
        ms=round(ms, 1),
        rain_scale=rain_scale,
        cleaned=len(cleaned),
        unmatched=len(unmatched),
        beta_kind=beta_source["kind"],
        beta_resolved=beta_source.get("resolved"),
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
        # Which blockage the emulator ran at, and how much of it Pulse actually learned. The
        # scenario is a difference between two runs at this vector, so it is as much a part of
        # the answer's provenance as the emulator's own skill.
        "beta_source": beta_source,
        "rain_scale": rain_scale,
        # Only what was actually cleaned. `cleaned_unmatched` carries the ids this city has no
        # segment for, so a partly wrong request is visible rather than absorbed.
        "cleaned_segments": sorted(cleaned),
        "cleaned_unmatched": unmatched,
        "n_improved": scenario.n_improved,
        "n_worse": scenario.n_worse,
        "ms": round(ms, 1),
        # Enough for the map to draw a difference and the table to rank one. The count of what
        # moved is reported separately, so a truncated list never reads as the whole answer.
        "segments": rows[:MAX_SEGMENTS],
        "n_changed": sum(1 for r in rows if abs(r["delta_cm"]) >= 0.5),
        "worst_after": sorted(rows, key=lambda r: -r["after_cm"])[:20],
        "notes": [
            *scenario.notes,
            _beta_note(beta_source),
            *(
                [
                    f"{len(unmatched)} of the ids asked for are not road segments in this city "
                    f"and were not cleaned; they are listed in cleaned_unmatched."
                ]
                if unmatched
                else []
            ),
            "The level is the Twin's own forecast for this run; the emulator supplies only the "
            "difference the scenario makes. Run the physics check for a scenario the Twin has "
            "solved end to end.",
        ],
    }
