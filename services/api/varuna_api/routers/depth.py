"""Serving a baked run's depth products to the console (CLAUDE.md 12, P5.7).

Three things the map needs and nothing else:

* ``GET /v1/nowcast/raster`` - the RGBA PNG for one step, straight off disk. The console
  preloads all 36 of a run on ``runs.published`` and swaps them during a scrub, so this must be
  a plain file read: no decoding, no re-ramping, no per-request work (CLAUDE.md 7.2 AC, "no
  network during scrub" - the network happens once, up front).
* ``GET /v1/nowcast/raster/bounds`` - where to put it, in lon/lat.
* ``GET /v1/nowcast/segments`` - the per-segment depth series the streets are coloured by.

Every response carries ``run_id`` and the run's honesty notes, because the console prints them
under the run stamp and a depth map with no provenance is exactly what CLAUDE.md rule 6 exists
to prevent.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Query, Response
from varuna_schemas.paths import run_dir, runs_dir

from varuna_api.state import api_error

log = structlog.get_logger("varuna.api.depth")

router = APIRouter(prefix="/v1", tags=["nowcast"])

BAKE_HINT = (
    "No baked run carries depth products yet. Run `make bake BUNDLE=MUM-2019-07-02`, "
    "or press Compute live on the replay panel."
)


def _latest_run_with_depth() -> Path | None:
    """The newest run directory that actually has depth rasters in it.

    Newest by run id, which sorts chronologically because the id embeds a UTC stamp
    (CLAUDE.md 10.3). A run without a ``depth/`` folder is skipped rather than returned and then
    404'd one request later: a bake in progress leaves earlier complete runs perfectly usable.
    """
    root = runs_dir()
    if not root.is_dir():
        return None
    candidates = [
        p for p in sorted(root.iterdir(), reverse=True)
        if p.is_dir() and not p.name.startswith(".") and (p / "depth" / "bounds.json").is_file()
    ]
    return candidates[0] if candidates else None


def _resolve(run_id: str | None) -> Path:
    """The run directory to serve, or an error that names the command that makes one."""
    if run_id:
        path = run_dir(run_id)
        if not (path / "depth" / "bounds.json").is_file():
            raise api_error(
                404,
                "run_not_found",
                f"Run {run_id} has no depth products. {BAKE_HINT}",
                run_id=run_id,
            )
        return path
    latest = _latest_run_with_depth()
    if latest is None:
        raise api_error(404, "no_baked_runs", BAKE_HINT)
    return latest


def _meta(path: Path) -> dict[str, Any]:
    record = path / "run.json"
    return json.loads(record.read_text(encoding="utf-8")) if record.is_file() else {}


@router.get("/nowcast/raster/bounds", summary="Where a run's depth rasters sit, and what they are")
def raster_bounds(run_id: Annotated[str | None, Query()] = None) -> dict[str, Any]:
    """The lon/lat corners for the BitmapLayer, the step count, and the run's provenance."""
    path = _resolve(run_id)
    meta = _meta(path)
    bounds = json.loads((path / "depth" / "bounds.json").read_text(encoding="utf-8"))
    steps = sorted(p.name for p in (path / "depth").glob("p50_*.png"))
    return {
        "run_id": meta.get("run_id", path.name),
        "cycle_ts": meta.get("cycle_ts"),
        "mode": meta.get("mode"),
        "bundle": meta.get("bundle"),
        "bounds": bounds,
        "n_steps": len(steps),
        "step_min": meta.get("step_min", 5),
        "ensemble_n": meta.get("ensemble_n", 1),
        "mass_balance_err": meta.get("mass_balance_err"),
        "stage_ms": meta.get("stage_ms", {}),
        "notes": meta.get("notes", []),
        "frames": [f"/v1/nowcast/raster?run_id={meta.get('run_id', path.name)}&step={i}" for i in range(len(steps))],
    }


@router.get(
    "/nowcast/raster",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}, "description": "Depth PNG"}},
    summary="One step's depth raster as RGBA PNG",
)
def raster(
    step: Annotated[int, Query(ge=0)] = 0,
    run_id: Annotated[str | None, Query()] = None,
    stat: Annotated[Literal["p50", "p90"], Query()] = "p50",
) -> Response:
    """The PNG for one 5-minute step, cached hard because a baked run never changes.

    ``immutable`` is honest here in a way it usually is not: the run id contains the cycle time
    and the engine versions, so a given URL's bytes cannot change. That is what lets the console
    preload 36 frames and scrub without touching the network again.
    """
    path = _resolve(run_id)
    png = path / "depth" / f"{stat}_{step:02d}.png"
    if not png.is_file():
        available = len(list((path / "depth").glob(f"{stat}_*.png")))
        raise api_error(
            404,
            "step_not_found",
            f"Step {step} has no {stat} raster in this run; it has {available} steps (0-{available - 1}).",
            run_id=path.name,
        )
    return Response(
        content=png.read_bytes(),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/nowcast/segments", summary="Per-segment depth series for the street layer")
def segments(
    run_id: Annotated[str | None, Query()] = None,
    min_depth_cm: Annotated[float, Query(ge=0)] = 5.0,
) -> dict[str, Any]:
    """Every segment that gets wet in this run, with its depth at each step.

    Only segments reaching ``min_depth_cm`` at some point are returned, and the default is the
    5 cm the depth ramp calls dry (CLAUDE.md 6.2). Mumbai has 21,296 segments and a storm cycle
    wets about 1,900 of them, so this is the difference between a 200 KB response the console can
    hold and a 20 MB one it cannot. The dry remainder is drawn from the city layer, in the dry
    colour, and needs no per-step data at all.
    """
    path = _resolve(run_id)

    # The fast path, and the only one a baked run ever takes: the cycle already wrote exactly
    # this shape at bake time. Reading the 19 MB parquet, filtering it and re-serialising it
    # per request was most of the console's time-to-first-map.
    compact = path / "segments_wet.json"
    if compact.is_file():
        product = json.loads(compact.read_text(encoding="utf-8"))
        meta = _meta(path)
        log.info("api.segments", run_id=path.name, wet=product.get("n_segments_wet"), cached=True)
        return {
            **product,
            "step_min": meta.get("step_min", 5),
            "ensemble_n": meta.get("ensemble_n", 1),
            "safe_until": {},
            "notes": meta.get("notes", []),
        }

    parquet = path / "segment_forecast.parquet"
    if not parquet.is_file():
        raise api_error(404, "no_segment_forecast", BAKE_HINT, run_id=path.name)

    import pandas as pd

    frame = pd.read_parquet(parquet)
    meta = _meta(path)
    wet_ids = frame.loc[frame["depth_p50_cm"] >= min_depth_cm, "segment_id"].unique()
    wet = frame[frame["segment_id"].isin(wet_ids)].sort_values(["segment_id", "valid_ts"])

    times = [str(t) for t in sorted(frame["valid_ts"].unique())]
    series: dict[str, list[float]] = {}
    safe_until: dict[str, Any] = {}
    for seg_id, group in wet.groupby("segment_id", sort=True):
        series[str(seg_id)] = [round(float(v), 1) for v in group["depth_p50_cm"]]
        first = group.iloc[0]
        if isinstance(first.get("safe_until"), str):
            safe_until[str(seg_id)] = json.loads(first["safe_until"])

    log.info("api.segments", run_id=path.name, wet=len(series), of=int(frame["segment_id"].nunique()))
    return {
        "run_id": meta.get("run_id", path.name),
        "valid_ts": times,
        "step_min": meta.get("step_min", 5),
        "ensemble_n": meta.get("ensemble_n", 1),
        "min_depth_cm": min_depth_cm,
        "n_segments_total": int(frame["segment_id"].nunique()),
        "n_segments_wet": len(series),
        "depth_cm": series,
        "safe_until": safe_until,
        "notes": meta.get("notes", []),
    }


@router.get("/nowcast/hotspots", summary="Ranked hotspots for the rail")
def hotspots(
    run_id: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
) -> dict[str, Any]:
    """The run's ranked chronic spots, deepest first (CLAUDE.md 11.8, P5.4).

    Read straight off the run directory: ``hotspots.json`` was computed once when the cycle ran,
    and re-deriving it per request would let the rail and the map disagree about the same run.

    Every entry carries the register's ``source_url``, so the claim "this junction floods" stays
    traceable to the report it was verified against (rule 7). ``ranking`` says out loud which
    score ordered the list, because on a deterministic run it is **not** the spec's
    ``P x exposure_weight`` - that product is reported per hotspot and is 0 or 1 until Flash
    brings a real ensemble in Phase 7.
    """
    path = _resolve(run_id)
    record = path / "hotspots.json"
    if not record.is_file():
        raise api_error(
            404,
            "no_hotspots",
            f"Run {path.name} predates hotspot ranking. {BAKE_HINT}",
            run_id=path.name,
        )

    ranked = json.loads(record.read_text(encoding="utf-8"))
    meta = _meta(path)
    log.info("api.hotspots", run_id=path.name, n=len(ranked), limit=limit)
    return {
        "run_id": meta.get("run_id", path.name),
        "cycle_ts": meta.get("cycle_ts"),
        "step_min": meta.get("step_min", 5),
        "ensemble_n": meta.get("ensemble_n", 1),
        "ranking": "peak depth",
        "impassable_threshold_cm": 30,
        "n_total": len(ranked),
        "hotspots": ranked[:limit],
        "notes": meta.get("notes", []),
    }


@router.get("/nowcast/surcharge", summary="Manholes surcharging and pipes running backwards")
def surcharge(run_id: Annotated[str | None, Query()] = None) -> dict[str, Any]:
    """The run's surcharging manholes and reversed edges (CLAUDE.md 11.4, 11.5; P6.6).

    This is the demo's 1:40 moment made drawable: red markers where the drain is pushing water
    back up into the street, and the edges where the sea is holding a trunk shut. Only the nodes
    that actually surcharge are stored, so this stays a small file over a 49,897-node graph.
    """
    path = _resolve(run_id)
    record = path / "node_surcharge.json"
    if not record.is_file():
        raise api_error(
            404,
            "no_surcharge_product",
            f"Run {path.name} predates the surcharge product. {BAKE_HINT}",
            run_id=path.name,
        )
    product = json.loads(record.read_text(encoding="utf-8"))
    meta = _meta(path)
    log.info(
        "api.surcharge",
        run_id=path.name,
        surcharging=product.get("n_surcharging"),
        reversed_edges=product.get("n_reversed_edges"),
    )
    return {**product, "notes": meta.get("notes", [])}


@router.get("/alerts", tags=["alerts"], summary="Alerts raised by a run")
def alerts(
    run_id: Annotated[str | None, Query()] = None,
    level: Annotated[Literal["severe", "moderate", "watch"] | None, Query()] = None,
) -> dict[str, Any]:
    """The alert queue for a run, worst level first (CLAUDE.md 11.10, P8.7).

    Computed once when the cycle ran, so the queue, the map and the hotspot rail are all reading
    the same forecast. Every alert on a replay carries CAP ``status=Exercise``.
    """
    path = _resolve(run_id)
    record = path / "alerts.json"
    if not record.is_file():
        raise api_error(404, "no_alerts", f"Run {path.name} has no alert product. {BAKE_HINT}",
                        run_id=path.name)

    body = json.loads(record.read_text(encoding="utf-8"))
    queue = body.get("alerts", [])
    if level:
        queue = [a for a in queue if a.get("level") == level]
    meta = _meta(path)
    log.info("api.alerts", run_id=path.name, n=len(queue), level=level)
    return {
        "run_id": meta.get("run_id", path.name),
        "cycle_ts": meta.get("cycle_ts"),
        "n_total": len(body.get("alerts", [])),
        "alerts": queue,
        "notes": meta.get("notes", []),
    }


@router.get(
    "/alerts/{alert_id}.cap",
    tags=["alerts"],
    response_class=Response,
    responses={200: {"content": {"application/xml": {}}, "description": "CAP 1.2"}},
    summary="CAP 1.2 XML document for one alert",
)
def alert_cap(alert_id: str, run_id: Annotated[str | None, Query()] = None) -> Response:
    """One alert as a CAP 1.2 document, exactly as it was written into the run directory."""
    path = _resolve(run_id)
    document = path / "alerts" / f"{alert_id}.cap.xml"
    if not document.is_file():
        raise api_error(
            404,
            "alert_not_found",
            f"No CAP document {alert_id} in run {path.name}.",
            run_id=path.name,
        )
    return Response(content=document.read_text(encoding="utf-8"), media_type="application/xml")


@router.get("/pumps", tags=["pumps"], summary="The run's pump inventory and dispatch plan")
def pumps(run_id: Annotated[str | None, Query()] = None) -> dict[str, Any]:
    """The greedy assignment of the synthetic pump fleet to the hotspots that flood.

    The inventory is synthetic and the response says so in `inventory`; the benefit is a
    documented reduced model, labelled in `benefit_label` and printed beside every number the
    board shows (CLAUDE.md rule 6, 11.10).
    """
    path = _resolve(run_id)
    record = path / "pump_plan.json"
    if not record.is_file():
        raise api_error(
            404, "no_pump_plan", f"Run {path.name} has no pump plan. {BAKE_HINT}", run_id=path.name
        )
    plan = json.loads(record.read_text(encoding="utf-8"))
    meta = _meta(path)
    log.info("api.pumps", run_id=path.name, assigned=len(plan.get("assignments", [])))
    return {**plan, "cycle_ts": meta.get("cycle_ts"), "notes": meta.get("notes", [])}
