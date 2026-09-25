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
from varuna_schemas.paths import run_dir

from varuna_api.runs_util import latest_run_for
from varuna_api.state import api_error

log = structlog.get_logger("varuna.api.depth")

router = APIRouter(prefix="/v1", tags=["nowcast"])

BAKE_HINT = (
    "No baked run carries depth products yet. Run `make bake BUNDLE=MUM-2019-07-02`, "
    "or press Compute live on the replay panel."
)

CityQuery = Annotated[
    str | None,
    Query(
        description="City id, e.g. mumbai. Picks whose newest run answers when run_id is omitted."
    ),
]
"""Which city an endpoint means when the caller named no run.

Runs from every city share ``data/runs/`` and their ids sort chronologically, so ``CHN-`` sorts
after ``MUM-`` for the same instant: without this, a Chennai console asking for "the newest run"
and a Mumbai console asking for "the newest run" got the same answer, and one of them was wrong
(:func:`varuna_api.runs_util.latest_run_for`). Omitted, the settings' city stands, which is what
every Mumbai screen relies on today.
"""


NO_ATTRIBUTION_LABEL = (
    "Not computed on this run: it was baked before attribution moved onto drain1d "
    "(ADR-0071). Re-bake it to rank the pipes."
)
"""Why a hotspot's ``attribution`` is empty on a run that carries no reason of its own.

Since ADR-0071 the cycle ranks pipes on ``drain1d`` and writes a label beside every empty list,
measured at that junction ("51 pipes re-run, the best moves it 0.003 cm"). Runs baked before
that carry an empty list and nothing else; ADR-0042's reason for them - Flash-lite is
element-wise per segment - was true of the operator they were baked with, so this says what
changed and what to do rather than repeating a sentence that is no longer the whole story. It is
not imported from ``varuna_flash`` because the hotspot rail must not pull the emulator in to
answer a file read."""


def _latest_run_with_depth(city: str | None = None) -> Path | None:
    """The newest run directory for a city that actually has depth rasters in it.

    Newest by run id, which sorts chronologically because the id embeds a UTC stamp
    (CLAUDE.md 10.3). A run without a ``depth/`` folder is skipped rather than returned and then
    404'd one request later: a bake in progress leaves earlier complete runs perfectly usable.

    **Filtered by city**, and that is not optional once a second city exists. Onboarding Chennai
    put `CHN-` runs in the same directory, they sort after `MUM-` for the same date, and every
    endpoint that means "the current run" started answering a Mumbai console with Chennai water.
    """
    return latest_run_for(city, lambda p: (p / "depth" / "bounds.json").is_file())


def _resolve(run_id: str | None, city: str | None = None) -> Path:
    """The run directory to serve, or an error that names the command that makes one.

    ``city`` only decides which run is newest; a ``run_id`` names its own city and is served as
    asked, because a run directory already knows which city it belongs to and a second opinion
    from the query string could only disagree with it.
    """
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
    latest = _latest_run_with_depth(city)
    if latest is None:
        raise api_error(404, "no_baked_runs", BAKE_HINT)
    return latest


def _meta(path: Path) -> dict[str, Any]:
    record = path / "run.json"
    return json.loads(record.read_text(encoding="utf-8")) if record.is_file() else {}


@router.get("/nowcast/raster/bounds", summary="Where a run's depth rasters sit, and what they are")
def raster_bounds(
    run_id: Annotated[str | None, Query()] = None, city: CityQuery = None
) -> dict[str, Any]:
    """The lon/lat corners for the BitmapLayer, the step count, and the run's provenance."""
    path = _resolve(run_id, city)
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
        "frames": [
            f"/v1/nowcast/raster?run_id={meta.get('run_id', path.name)}&step={i}"
            for i in range(len(steps))
        ],
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
    city: CityQuery = None,
    stat: Annotated[Literal["p50", "p90"], Query()] = "p50",
) -> Response:
    """The PNG for one 5-minute step, cached hard because a baked run never changes.

    ``immutable`` is honest here in a way it usually is not: the run id contains the cycle time
    and the engine versions, so a given URL's bytes cannot change. That is what lets the console
    preload 36 frames and scrub without touching the network again.
    """
    path = _resolve(run_id, city)
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


def parse_bbox(bbox: str | None) -> tuple[float, float, float, float] | None:
    """``minlon,minlat,maxlon,maxlat`` in WGS84, or a 400 that says which part is wrong."""
    if not bbox:
        return None
    parts = bbox.replace(" ", "").split(",")
    try:
        if len(parts) != 4:
            raise ValueError
        minlon, minlat, maxlon, maxlat = (float(p) for p in parts)
    except ValueError:
        raise api_error(
            400,
            "bad_bbox",
            f"bbox {bbox!r} is not four numbers: give minlon,minlat,maxlon,maxlat in WGS84.",
        ) from None
    if minlon > maxlon or minlat > maxlat:
        raise api_error(
            400,
            "bad_bbox",
            "bbox corners are the wrong way round: give minlon,minlat,maxlon,maxlat.",
        )
    return (minlon, minlat, maxlon, maxlat)


def _ids_within(box: tuple[float, float, float, float], city: str) -> set[str]:
    """The city's segments whose midpoint falls inside ``box``."""
    from varuna_products.depth import segment_points
    from varuna_schemas.paths import city_dir

    minlon, minlat, maxlon, maxlat = box
    return {
        sid
        for sid, (lon, lat) in segment_points(city_dir(city)).items()
        if minlon <= lon <= maxlon and minlat <= lat <= maxlat
    }


def _within_bbox(
    product: dict[str, Any], box: tuple[float, float, float, float], city: str
) -> dict[str, Any]:
    """``segments_wet.json`` cut to the segments inside ``box``; every per-segment map is cut."""
    inside = _ids_within(box, city)
    depth = {sid: v for sid, v in (product.get("depth_cm") or {}).items() if sid in inside}
    p_gt = {
        threshold: {sid: v for sid, v in series.items() if sid in inside}
        for threshold, series in (product.get("p_gt") or {}).items()
    }
    return {**product, "depth_cm": depth, "p_gt": p_gt, "n_segments_wet": len(depth)}


@router.get("/nowcast/segments", summary="Per-segment depth series for the street layer")
def segments(
    run_id: Annotated[str | None, Query()] = None,
    city: CityQuery = None,
    min_depth_cm: Annotated[float, Query(ge=0)] = 5.0,
    bbox: Annotated[
        str | None,
        Query(
            description="minlon,minlat,maxlon,maxlat (WGS84): only segments whose midpoint is inside."
        ),
    ] = None,
) -> dict[str, Any]:
    """Every segment that gets wet in this run, with its depth at each step.

    Only segments reaching ``min_depth_cm`` at some point are returned, and the default is the
    5 cm the depth ramp calls dry (CLAUDE.md 6.2). Mumbai has 21,296 segments and a storm cycle
    wets several thousand of them, so this is the difference between a response the console can
    hold and a 20 MB one it cannot. The dry remainder is drawn from the city layer, in the dry
    colour, and needs no per-step data at all.

    ``bbox`` is section 12's "segments in bbox": a navigation app asking about the streets on its
    screen gets those and not the whole AOI. It filters on each segment's midpoint - the same
    point the alerts and the pump board put a pin on - so a street is either in or out, never
    split. The console omits it, because it preloads the whole run for a scrub that must make no
    requests (P6.3).
    """
    path = _resolve(run_id, city)
    box = parse_bbox(bbox)

    # The fast path, and the only one a baked run ever takes: the cycle already wrote exactly
    # this shape at bake time. Reading the 19 MB parquet, filtering it and re-serialising it
    # per request was most of the console's time-to-first-map.
    compact = path / "segments_wet.json"
    if compact.is_file():
        product = json.loads(compact.read_text(encoding="utf-8"))
        meta = _meta(path)
        if box is not None:
            product = _within_bbox(product, box, str(meta.get("city") or city or "mumbai"))
        log.info(
            "api.segments",
            run_id=path.name,
            wet=product.get("n_segments_wet"),
            cached=True,
            bbox=bbox,
        )
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
    if box is not None:
        inside = _ids_within(box, str(meta.get("city") or city or "mumbai"))
        wet_ids = [sid for sid in wet_ids if str(sid) in inside]
    wet = frame[frame["segment_id"].isin(wet_ids)].sort_values(["segment_id", "valid_ts"])

    times = [str(t) for t in sorted(frame["valid_ts"].unique())]
    series: dict[str, list[float]] = {}
    safe_until: dict[str, Any] = {}
    for seg_id, group in wet.groupby("segment_id", sort=True):
        series[str(seg_id)] = [round(float(v), 1) for v in group["depth_p50_cm"]]
        first = group.iloc[0]
        if isinstance(first.get("safe_until"), str):
            safe_until[str(seg_id)] = json.loads(first["safe_until"])

    log.info(
        "api.segments", run_id=path.name, wet=len(series), of=int(frame["segment_id"].nunique())
    )
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


def _with_attribution(row: dict[str, Any]) -> dict[str, Any]:
    """One hotspot with the attribution pair section 10.3 promises, ranked or labelled.

    Nothing is synthesised: the list is whatever the artifact carries. The cycle's own label wins
    whenever there is one - including beside an empty list, where it is a measured refusal - and
    :data:`NO_ATTRIBUTION_LABEL` fills in only for runs baked before the cycle wrote any.
    """
    rows = row.get("attribution") or []
    label = row.get("attribution_label") or (None if rows else NO_ATTRIBUTION_LABEL)
    return {**row, "attribution": rows, "attribution_label": label}


@router.get("/nowcast/hotspots", summary="Ranked hotspots for the rail")
def hotspots(
    run_id: Annotated[str | None, Query()] = None,
    city: CityQuery = None,
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

    ``attribution`` and ``attribution_label`` are in the contract section 10.3 asks for: the pipes
    ranked on ``drain1d`` (ADR-0071), or an empty list with the measured reason it is empty. The
    field is present rather than absent so the drawer reads a refusal it can print instead of a
    missing key it has to guess at.
    """
    path = _resolve(run_id, city)
    record = path / "hotspots.json"
    if not record.is_file():
        raise api_error(
            404,
            "no_hotspots",
            f"Run {path.name} predates hotspot ranking. {BAKE_HINT}",
            run_id=path.name,
        )

    ranked = [_with_attribution(row) for row in json.loads(record.read_text(encoding="utf-8"))]
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
def surcharge(
    run_id: Annotated[str | None, Query()] = None, city: CityQuery = None
) -> dict[str, Any]:
    """The run's surcharging manholes and reversed edges (CLAUDE.md 11.4, 11.5; P6.6).

    This is the demo's 1:40 moment made drawable: red markers where the drain is pushing water
    back up into the street, and the edges where the sea is holding a trunk shut. Only the nodes
    that actually surcharge are stored, so this stays a small file over a 49,897-node graph.
    """
    path = _resolve(run_id, city)
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
    # The product's own notes (reversed edges the city export gave no line to) sit after the
    # run's; replacing them with the run's would hide an edge the map silently cannot draw.
    return {**product, "notes": [*meta.get("notes", []), *product.get("notes", [])]}


@router.get("/alerts", tags=["alerts"], summary="Alerts raised by a run")
def alerts(
    run_id: Annotated[str | None, Query()] = None,
    city: CityQuery = None,
    level: Annotated[Literal["severe", "moderate", "watch"] | None, Query()] = None,
) -> dict[str, Any]:
    """The alert queue for a run, worst level first (CLAUDE.md 11.10, P8.7).

    Computed once when the cycle ran, so the queue, the map and the hotspot rail are all reading
    the same forecast. Every alert on a replay carries CAP ``status=Exercise``.

    **The desk's state is folded in at read time.** The queue itself is the cycle's product and
    is never edited, but whether an officer has *seen* an alert is not a forecast - it lives in
    the ops log, and a console showing "raised" beside a desk showing "acknowledged" is one alert
    described two ways. ``apply_alert_state`` is the same call ``GET /v1/ops/alerts`` makes, with
    the city resolved the same way, so the two cannot disagree. With no ops log it returns the
    product untouched, which is every run on a fresh clone.
    """
    from varuna_api.routers.ops import apply_alert_state

    path = _resolve(run_id, city)
    record = path / "alerts.json"
    if not record.is_file():
        raise api_error(
            404, "no_alerts", f"Run {path.name} has no alert product. {BAKE_HINT}", run_id=path.name
        )

    body = json.loads(record.read_text(encoding="utf-8"))
    queue = apply_alert_state(body.get("alerts", []), city)
    if level:
        queue = [a for a in queue if a.get("level") == level]
    meta = _meta(path)
    record = body.get("hysteresis")
    notes = list(meta.get("notes", []))
    if not isinstance(record, dict):
        # Written before the cross-cycle rule (CLAUDE.md 11.10): the queue decided on one cycle's
        # forecast and `persists_cycles` counts forecast steps. Said, not hidden, until re-baked.
        notes.append(
            "This run's queue was written before alerts needed two consecutive cycles: it raised "
            "on this cycle alone, and its persistence is counted in forecast steps. Re-bake it "
            "to apply the cross-cycle rule."
        )
    log.info("api.alerts", run_id=path.name, n=len(queue), level=level)
    return {
        "run_id": meta.get("run_id", path.name),
        "cycle_ts": meta.get("cycle_ts"),
        "n_total": len(body.get("alerts", [])),
        "alerts": queue,
        # The cross-cycle state beside the queue: what raises next cycle if it holds, and what
        # this cycle cleared. The per-situation record itself stays in the file - it is the next
        # cycle's input, not the screen's.
        "pending": body.get("pending", []),
        "n_pending": body.get("n_pending", len(body.get("pending", []))),
        "cleared": body.get("cleared", []),
        "n_cleared": body.get("n_cleared", len(body.get("cleared", []))),
        "hysteresis": (
            {
                "rule": record.get("rule"),
                "previous_run_id": record.get("previous_run_id"),
                "previous_legacy": record.get("previous_legacy", False),
            }
            if isinstance(record, dict)
            else None
        ),
        "notes": notes,
    }


@router.get(
    "/alerts/{alert_id}.cap",
    tags=["alerts"],
    response_class=Response,
    responses={200: {"content": {"application/xml": {}}, "description": "CAP 1.2"}},
    summary="CAP 1.2 XML document for one alert",
)
def alert_cap(
    alert_id: str, run_id: Annotated[str | None, Query()] = None, city: CityQuery = None
) -> Response:
    """One alert as a CAP 1.2 document, exactly as it was written into the run directory."""
    path = _resolve(run_id, city)
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
def pumps(run_id: Annotated[str | None, Query()] = None, city: CityQuery = None) -> dict[str, Any]:
    """The greedy assignment of the synthetic pump fleet to the hotspots that flood.

    The inventory is synthetic and the response says so in `inventory`; the benefit is a
    documented reduced model, labelled in `benefit_label` and printed beside every number the
    board shows (CLAUDE.md rule 6, 11.10).
    """
    path = _resolve(run_id, city)
    record = path / "pump_plan.json"
    if not record.is_file():
        raise api_error(
            404, "no_pump_plan", f"Run {path.name} has no pump plan. {BAKE_HINT}", run_id=path.name
        )
    plan = json.loads(record.read_text(encoding="utf-8"))
    meta = _meta(path)
    log.info("api.pumps", run_id=path.name, assigned=len(plan.get("assignments", [])))
    return {**plan, "cycle_ts": meta.get("cycle_ts"), "notes": meta.get("notes", [])}


@router.get("/drains/health", tags=["drains"], summary="The drain map Pulse learned")
def drains_health(
    run_id: Annotated[str | None, Query()] = None,
    city: CityQuery = None,
    min_beta: Annotated[float, Query(ge=0.0, le=1.0)] = 0.0,
    limit: Annotated[int, Query(ge=1, le=50_000)] = 4_000,
) -> dict[str, Any]:
    """Every pipe with its posterior blockage, its spread and what moved it (CLAUDE.md 11.6).

    Mumbai's inferred graph has 49,770 edges and the drain X-ray draws the ones that matter, so
    the response is capped and ordered worst-first. `n_edges` is the true total; the cap is what
    was sent. Each feature carries `confidence: "inferred"`, which is why the map draws them
    dashed - the geometry is a synthesis from roads and terrain, not a municipal record.
    """
    path = _resolve(run_id, city)
    record = path / "drain_health.geojson"
    if not record.is_file():
        raise api_error(
            404,
            "no_drain_health",
            f"Run {path.name} has no drain-health product. {BAKE_HINT}",
            run_id=path.name,
        )

    health = json.loads(record.read_text(encoding="utf-8"))
    features = health.get("features", [])
    if min_beta > 0.0:
        features = [f for f in features if float(f["properties"].get("beta_mean", 0)) >= min_beta]
    features = sorted(features, key=lambda f: -float(f["properties"].get("beta_mean", 0.0)))[:limit]

    log.info("api.drain_health", run_id=path.name, sent=len(features), of=health.get("n_edges"))
    return {**health, "features": features, "n_sent": len(features)}


@router.get(
    "/drains/health.csv",
    tags=["drains"],
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "Desilting priority"}},
    summary="Desilting priority list as CSV",
)
def drains_health_csv(
    run_id: Annotated[str | None, Query()] = None, city: CityQuery = None
) -> Response:
    """The ranked desilting list a ward engineer can hand to a jetting crew (CLAUDE.md 7.3)."""
    path = _resolve(run_id, city)
    csv_path = path / "desilting.csv"
    if not csv_path.is_file():
        raise api_error(
            404,
            "no_desilting_csv",
            f"Run {path.name} has no desilting list. {BAKE_HINT}",
            run_id=path.name,
        )
    return Response(
        content=csv_path.read_text(encoding="utf-8"),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="desilting-{path.name}.csv"'},
    )


@router.get("/observations", tags=["observations"], summary="What Pulse assimilated this cycle")
def observations(
    run_id: Annotated[str | None, Query()] = None, city: CityQuery = None
) -> dict[str, Any]:
    """The traffic anomalies and citizen reports that moved the drain map (CLAUDE.md 7.3).

    This is the assimilation timeline on the drain X-ray: each observation with its time, place,
    the depth it implied and the pipe it was about. Synthetic observations are flagged, because
    the replay's traffic and report streams are synthetic and the screen must say so (rule 7).
    """
    path = _resolve(run_id, city)
    record = path / "observations.json"
    if not record.is_file():
        raise api_error(
            404,
            "no_observations",
            f"Run {path.name} assimilated nothing. {BAKE_HINT}",
            run_id=path.name,
        )
    body = json.loads(record.read_text(encoding="utf-8"))
    meta = _meta(path)
    log.info("api.observations", run_id=path.name, n=len(body.get("observations", [])))
    return {**body, "cycle_ts": meta.get("cycle_ts")}
