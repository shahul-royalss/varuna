"""Depth products: the rasters the map draws and the per-segment forecast it colours streets by
(CLAUDE.md 11.8, 10.3).

Two things come out of a Twin run and both are consumed by the console:

* **rasters** - one PNG per 5-minute step per statistic, through the *shared* depth ramp in
  ``varuna_schemas.ramps``, with a world file and a ``bounds.json``. The ramp is shared on
  purpose (CLAUDE.md 6.7): a map pixel and a UI chip showing "45 cm" have to be the same orange,
  and they are only guaranteed to be if both read ``tokens.json``. Nothing here defines a colour.
* **segment forecast** - depth per road segment per step, with exceedance probabilities and a
  safe-until time per vehicle profile, written as GeoParquet for the console to preload.

**Sampling a street from a raster.** CLAUDE.md 11.8 fixes the rule: a segment's depth is the
90th percentile of the cell depths within a 15 m buffer of it. The buffer matters because a 30 m
grid cell is wider than most roads, so a centreline sample would take whatever the cell's average
happens to be; the percentile matters because the maximum would latch onto one wet corner of one
cell and never let go. Which cells belong to which segment is fixed geometry, so it is computed
once and cached beside the city (:func:`segment_cell_index`) rather than per run.

**Honesty about the ensemble** (rule 6). A Twin run is deterministic: one rain field in, one
depth field out. So with the Twin alone ``p10 == p50 == p90`` and every exceedance probability
is 0 or 1, and this module does not dress that up as a spread - the caller records
``ensemble_n = 1`` and the run's notes say so. The spread CLAUDE.md 11.7 asks for arrives as a
*second* argument: :func:`segment_forecast` takes an optional ``member_depth_cm`` stack from
Flash-lite, one street depth field per Sky member, and turns it into real quantiles and real
exceedance fractions.

The two are combined rather than swapped, and the reason is ADR-0025: the emulator is calibrated
to the Twin but its held-out RMSE is 5.7 cm and its level is visibly low (it peaked at 106 cm on
a 2 July cycle where the Twin peaked at 252 cm), so it cannot be the depth on screen. What it
*can* say is how much the answer moves between members. So the level stays the Twin's and only
each member's deviation from the member mean is carried across. The member mean of the resulting
stack is then the Twin depth exactly - bar the streets where a member would have gone below zero
and was clipped to dry - which is what makes "Flash supplies the spread and never the level" a
statement about the file rather than a slogan.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import structlog
from varuna_schemas.ramps import depth_array_to_rgba

if TYPE_CHECKING:  # pragma: no cover - typing only
    from datetime import datetime

    from numpy.typing import NDArray

log = structlog.get_logger("varuna.products.depth")

__all__ = [
    "EXCEEDANCE_CM",
    "PROFILE_THRESHOLD_CM",
    "PROFILE_TOLERANCE",
    "SEGMENT_BUFFER_M",
    "SEGMENT_PERCENTILE",
    "WET_THRESHOLD_CM",
    "depth_bounds",
    "segment_cell_index",
    "segment_forecast",
    "segment_names",
    "write_depth_rasters",
    "write_wet_segments",
]

SEGMENT_BUFFER_M = 15.0
"""Half-width of the strip around a segment centreline that is sampled, in metres.

CLAUDE.md 11.8 states it. It is half a cell either side of the line on the 30 m grid, so a
segment always samples the cells it actually runs through even where it clips a corner."""

SEGMENT_PERCENTILE = 90.0
"""Which percentile of the sampled cells becomes the segment's depth (CLAUDE.md 11.8).

The spec calls this a documented choice, and the reason is failure asymmetry: a road is
impassable at its worst point, not its average, but a maximum over a 30 m grid latches onto a
single wet cell - often the kerb of a neighbouring plot - and never releases it. The 90th
percentile tracks the wet end without being hostage to one cell."""

PROFILE_THRESHOLD_CM: dict[str, float] = {
    "two_wheeler": 15.0,
    "car": 30.0,
    "bus": 45.0,
    "truck": 45.0,
    "ambulance": 60.0,
    "pedestrian": 30.0,
}
"""Depth at which each vehicle stops being able to pass, in cm (CLAUDE.md 11.8).

The pedestrian rule is really ``h >= 30 cm or h*v >= 0.5 m2/s``; the velocity half needs the
flux field and is applied by the route service, so 30 cm is the depth half of it here."""

PROFILE_TOLERANCE: dict[str, float] = {
    "two_wheeler": 0.5,
    "car": 0.5,
    "bus": 0.5,
    "truck": 0.5,
    "ambulance": 0.2,
    "pedestrian": 0.5,
}
"""Exceedance probability each profile will accept before it calls a street unsafe.

An ambulance is the cautious one at 0.2 (CLAUDE.md 7.4): it turns back on a one-in-five chance,
because the cost of being wrong is a stranded ambulance rather than a longer drive."""

EXCEEDANCE_CM: tuple[float, ...] = (15.0, 30.0, 45.0, 60.0)
"""Depths the parquet carries an exceedance probability for (CLAUDE.md 11.8, 10.3).

They are the depth ramp's own band edges, so ``p_gt_30`` answers exactly the question the map's
probability mode asks when the operator picks 30 cm."""


# ============================================================================ rasters
def depth_bounds(
    transform: tuple[float, float, float, float, float, float], shape: tuple[int, int], crs: str
) -> dict[str, object]:
    """The lon/lat bounds a deck.gl ``BitmapLayer`` needs, plus the metric ones it does not.

    The console places the raster by lon/lat, so the metric grid is reprojected here rather than
    in the browser: doing it in the browser would need the CRS definition shipped to the client
    and would put a projection library in the map's hot path.
    """
    from pyproj import Transformer

    n_rows, n_cols = shape
    res, _, left, _, _, top = transform
    right = left + n_cols * res
    bottom = top - n_rows * res

    to_wgs = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    west, south = to_wgs.transform(left, bottom)
    east, north = to_wgs.transform(right, top)
    return {
        "crs": crs,
        "metric": [left, bottom, right, top],
        "wgs84": [west, south, east, north],
        "shape": [n_rows, n_cols],
        "res_m": res,
    }


def write_depth_rasters(
    run_dir: Path,
    depth_m: NDArray[np.floating],
    transform: tuple[float, float, float, float, float, float],
    crs: str,
    *,
    stat: str = "p50",
) -> list[Path]:
    """One PNG per step through the shared ramp, each with its world file.

    The PNG is RGBA with the dry band fully transparent, so the basemap shows through where
    there is no water rather than the city being covered by a grey sheet. The world file (.pgw)
    carries the metric georeference for anything that reads the PNG as a GIS raster; the console
    uses ``bounds.json`` instead, because a BitmapLayer wants corners in lon/lat.
    """
    from PIL import Image

    out = run_dir / "depth"
    out.mkdir(parents=True, exist_ok=True)
    res, _, left, _, _, top = transform
    written: list[Path] = []

    for step in range(depth_m.shape[0]):
        rgba = depth_array_to_rgba(depth_m[step], alpha=255, dry_alpha=0)
        path = out / f"{stat}_{step:02d}.png"
        Image.fromarray(rgba, mode="RGBA").save(path, optimize=True)
        # World file: pixel size, rotation terms, then the CENTRE of the top-left pixel, which
        # is half a cell in from the grid's corner. Writing the corner instead is the classic
        # half-pixel shift and would put every street 15 m north-west of where it is.
        (out / f"{stat}_{step:02d}.pgw").write_text(
            f"{res}\n0.0\n0.0\n{-res}\n{left + res / 2.0}\n{top - res / 2.0}\n", encoding="utf-8"
        )
        written.append(path)

    (out / "bounds.json").write_text(
        json.dumps(depth_bounds(transform, depth_m.shape[1:], crs), indent=2) + "\n",
        encoding="utf-8",
    )
    log.info("products.rasters", stat=stat, steps=len(written), dir=str(out))
    return written


# ============================================================================ segments
def segment_cell_index(city_root: Path, transform, shape: tuple[int, int], crs: str):
    """Map each road segment to the flat cell indices within :data:`SEGMENT_BUFFER_M` of it.

    Pure geometry, so it is computed once and cached at ``city/<city>/segment_cells.npz``. On
    Mumbai that is 21,296 segments over a 522 x 323 grid and takes a few seconds; doing it per
    run - 49 cycles in a bake - would dominate the bake.

    Returns ``(segment_ids, offsets, cells)`` in CSR form: segment ``k``'s cells are
    ``cells[offsets[k]:offsets[k+1]]``. Flat form rather than a list of arrays because the
    sampler indexes a flattened depth field once per step.
    """
    import geopandas as gpd

    cache = city_root / "segment_cells.npz"
    if cache.is_file():
        data = np.load(cache, allow_pickle=True)
        return (tuple(data["segment_ids"].tolist()), data["offsets"], data["cells"])

    from rasterio.features import rasterize
    from rasterio.transform import Affine

    segments = gpd.read_parquet(city_root / "segments.parquet").to_crs(crs)
    n_rows, n_cols = shape
    affine = Affine(*transform)

    offsets = np.zeros(len(segments) + 1, dtype=np.int64)
    chunks: list[NDArray[np.int64]] = []
    for i, geom in enumerate(segments.geometry):
        # rasterize one buffered segment at a time: `all_touched` so a road that only clips a
        # cell still claims it, which is what the 15 m buffer is for in the first place.
        mask = rasterize(
            [(geom.buffer(SEGMENT_BUFFER_M), 1)],
            out_shape=(n_rows, n_cols),
            transform=affine,
            fill=0,
            all_touched=True,
            dtype="uint8",
        )
        flat = np.flatnonzero(mask.ravel()).astype(np.int64)
        chunks.append(flat)
        offsets[i + 1] = offsets[i] + flat.size

    cells = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int64)
    segment_ids = tuple(segments["segment_id"].astype(str))
    np.savez_compressed(
        cache, segment_ids=np.array(segment_ids, dtype=object), offsets=offsets, cells=cells
    )
    log.info(
        "products.segment_index_built",
        segments=len(segment_ids),
        cells=int(cells.size),
        mean_cells=round(float(cells.size / max(len(segment_ids), 1)), 1),
        cache=str(cache),
    )
    return (segment_ids, offsets, cells)


def _member_levels(
    depth_cm: NDArray[np.floating], member_depth_cm: NDArray[np.floating]
) -> NDArray[np.float32]:
    """Twin depth per segment per step, re-centred into one field per ensemble member.

    ``member_depth_cm`` is ``(n_members, n_steps, n_segments)`` of *absolute* emulator depth,
    aligned to the same segment order as ``depth_cm``. Only its deviation from the member mean
    is used, so whatever bias the emulator carries cancels exactly and the member mean of the
    result is the Twin field (ADR-0025, and the module docstring).

    float32 because the stack is the largest array a cycle holds - 20 x 36 x 21,296 is 122 MB in
    float64 - and these are centimetres of water read to two decimals.

    Raises:
        ValueError: if the member stack is not 3-D or its segment axis does not match the Twin's.
            The caller guarantees the alignment by construction, so a mismatch here means a
            member array from another city, and every street would silently get the wrong spread.
    """
    members = np.asarray(member_depth_cm, dtype=np.float32)
    n_steps, n_seg = depth_cm.shape
    if members.ndim != 3 or members.shape[2] != n_seg:
        raise ValueError(
            f"member_depth_cm must be (n_members, n_steps, {n_seg}) to match the Twin's segment "
            f"axis; got {members.shape}."
        )

    level = np.broadcast_to(depth_cm.astype(np.float32), (members.shape[0], n_steps, n_seg)).copy()
    # A shorter member stack than the Twin's horizon is possible when Sky keeps fewer per-member
    # steps than the Twin ran; the steps it does not cover keep the Twin's single value rather
    # than borrowing a spread from a neighbouring step.
    shared = min(n_steps, int(members.shape[1]))
    head = members[:, :shared]
    level[:, :shared] += head - head.mean(axis=0, keepdims=True)
    # Depth below zero is not a depth. Re-centring can push a dry street negative where the
    # members disagree by more than the Twin's own level, and the console draws these numbers.
    np.maximum(level, 0.0, out=level)
    return level


def segment_forecast(
    depth_m: NDArray[np.floating],
    times: tuple[datetime, ...],
    index,
    run_id: str,
    member_depth_cm: NDArray[np.floating] | None = None,
):
    """Per-segment depth per step, with exceedances and safe-until per profile.

    ``depth_m`` is ``(n_steps, n_rows, n_cols)`` from one Twin run and fixes the *level*: it is
    the Twin's depth the band is centred on (exactly, bar the zero clip). With members
    ``depth_p50_cm`` is their median rather than their mean, so it can sit a little off the Twin
    where they are skewed; how far is measured into ``max_p50_shift_cm`` on every run rather than
    asserted (2.7 cm at worst on the 2 July 09:10 cycle, against a 251.7 cm peak).

    ``member_depth_cm`` is the optional Flash-lite stack, ``(n_members, n_steps, n_segments)`` in
    centimetres, in the segment order of ``index``. Given it, the quantiles are taken across the
    members (:func:`_member_levels`) and each exceedance is the fraction of members above the
    threshold, so safe-until becomes what CLAUDE.md 11.8 actually asks for - the first step where
    ``P(h > threshold)`` passes the profile's tolerance - rather than the first step the single
    deterministic depth crosses it. Without it every quantile is the same number and every
    exceedance is 0 or 1, which is what a run of one member honestly has to say.
    """
    import pandas as pd

    segment_ids, offsets, cells = index
    n_steps = depth_m.shape[0]
    n_seg = len(segment_ids)
    flat = depth_m.reshape(n_steps, -1)

    depth_cm = np.zeros((n_steps, n_seg), dtype=np.float64)
    for k in range(n_seg):
        lo, hi = int(offsets[k]), int(offsets[k + 1])
        if hi <= lo:
            continue
        picked = flat[:, cells[lo:hi]]
        depth_cm[:, k] = np.percentile(picked, SEGMENT_PERCENTILE, axis=1) * 100.0

    # Every profile's threshold is asked of the probability field too, so a profile added at a
    # depth the parquet does not carry a column for still gets a probabilistic safe-until.
    thresholds = sorted(set(EXCEEDANCE_CM) | set(PROFILE_THRESHOLD_CM.values()))
    if member_depth_cm is None:
        n_members = 1
        p10 = p50 = p90 = depth_cm
        prob = {t: (depth_cm > t).astype(np.float64) for t in thresholds}
    else:
        level = _member_levels(depth_cm, member_depth_cm)
        n_members = int(level.shape[0])
        p10, p50, p90 = np.percentile(level, (10.0, 50.0, 90.0), axis=0)
        prob = {t: (level > t).mean(axis=0, dtype=np.float64) for t in thresholds}

    rows: list[dict[str, object]] = []
    for k, seg_id in enumerate(segment_ids):
        safe_until: dict[str, object] = {}
        for profile, threshold in PROFILE_THRESHOLD_CM.items():
            # On a single-member run the probability is 1 above the threshold and 0 below it, so
            # this reduces to "first step the depth crosses" and reproduces the old answer.
            risky = np.flatnonzero(prob[threshold][:, k] > PROFILE_TOLERANCE[profile])
            safe_until[profile] = times[int(risky[0])].isoformat() if risky.size else None
        blob = json.dumps(safe_until)
        for step in range(n_steps):
            rows.append(
                {
                    "run_id": run_id,
                    "segment_id": seg_id,
                    "valid_ts": times[step],
                    "depth_p10_cm": float(p10[step, k]),
                    "depth_p50_cm": float(p50[step, k]),
                    "depth_p90_cm": float(p90[step, k]),
                    "p_gt_15": float(prob[15.0][step, k]),
                    "p_gt_30": float(prob[30.0][step, k]),
                    "p_gt_45": float(prob[45.0][step, k]),
                    "p_gt_60": float(prob[60.0][step, k]),
                    "safe_until": blob,
                }
            )

    frame = pd.DataFrame.from_records(rows)
    log.info(
        "products.segment_forecast",
        segments=n_seg,
        steps=n_steps,
        rows=len(frame),
        members=n_members,
        max_cm=round(float(depth_cm.max()) if depth_cm.size else 0.0, 1),
        wet_segments=int((depth_cm.max(axis=0) > 5.0).sum()) if depth_cm.size else 0,
        # Measured, not claimed (rule 6): how wide the band actually is, and how far the member
        # median sits from the Twin level the band is centred on.
        max_band_cm=round(float((p90 - p10).max()) if n_seg else 0.0, 1),
        max_p50_shift_cm=round(float(np.abs(p50 - depth_cm).max()) if n_seg else 0.0, 2),
    )
    return frame, depth_cm


WET_THRESHOLD_CM = 5.0
"""Below this a street is not wet, it is damp (CLAUDE.md 6.2's `--depth-dry` band)."""


def _exceedance_from_record(
    run_dir: Path, segment_ids: tuple[str, ...], n_steps: int
) -> dict[float, NDArray[np.float64]] | None:
    """Read the exceedance columns back out of the ``segment_forecast.parquet`` beside the JSON.

    The cycle writes the parquet immediately before the compact layer and hands this writer only
    the Twin level, so the record of product is where the probabilities are. They are re-keyed
    positionally - the parquet is written one segment block of ``n_steps`` rows at a time, in the
    order of ``index[0]`` - and that order is *checked* against ``segment_ids`` rather than
    assumed: a positional array from a different ordering would give every street someone else's
    probability, which is worse than giving it none.
    """
    path = run_dir / "segment_forecast.parquet"
    if not path.is_file():
        return None
    import pandas as pd

    columns = {t: f"p_gt_{t:g}" for t in EXCEEDANCE_CM}
    frame = pd.read_parquet(path, columns=["segment_id", *columns.values()])
    n_seg = len(segment_ids)
    ids = frame["segment_id"].to_numpy()
    aligned = len(frame) == n_seg * n_steps and bool(
        (ids.reshape(n_seg, n_steps) == np.asarray(segment_ids, dtype=object)[:, None]).all()
    )
    if not aligned:
        log.warning(
            "products.wet_segments.exceedance_misaligned",
            rows=len(frame),
            expected=n_seg * n_steps,
        )
        return None
    return {
        t: frame[col].to_numpy(dtype=np.float64).reshape(n_seg, n_steps).T
        for t, col in columns.items()
    }


def _probability(value: float) -> float | int:
    """Two decimals, as ``depth_cm`` gets one - and a certain 0 or 1 written as an integer.

    Most of a run's exceedances are certain (a dry street is 0 at every threshold), and ``0``
    against ``0.0`` is what keeps the added key near double the payload rather than four times
    it. JSON and the browser read the two as the same number."""
    rounded = round(float(value), 2)
    return int(rounded) if rounded in (0.0, 1.0) else rounded


def write_wet_segments(
    run_dir: Path,
    depth_cm: NDArray[np.floating],
    segment_ids: tuple[str, ...],
    times: tuple[datetime, ...],
    run_id: str,
    p_gt: dict[float, NDArray[np.floating]] | None = None,
) -> dict[str, Any]:
    """Write the console's segment layer as a small JSON, once, at bake time.

    The parquet beside it is the product of record - every segment, every step, every profile's
    safe-until, 19 MB of it - and it is the right thing for `services/verify` and for anyone
    who wants the numbers. It is the wrong thing to put on the wire: the API was reading all
    19 MB with pandas, filtering it and re-serialising it **on every request**, which is most of
    why the console took so long to show a map.

    So the shape the map actually draws is computed once here: the segments that get wet, their
    depth at each step, one decimal, and nothing else. On a heavy Mumbai cycle that is about
    6,500 of 21,296 segments and lands near 1 MB - a file the API can stream straight off disk.

    **Exceedance** (CLAUDE.md 6.2, 7.2, task P7.6). Probability mode draws opacity as
    ``P(depth > threshold)``, and without this key the console can only compute that from the
    depth itself, which makes it 0 or 1 by construction. So each wet segment's ``p_gt`` series
    at 15/30/45/60 cm goes on the wire as ``{"15": {segment_id: [per step]}, ...}``, taken from
    ``p_gt`` (``{threshold_cm: (n_steps, n_segments)}``) or, when the caller passes none, from
    the parquet beside this file. It is written **only when some value lies strictly between 0
    and 1**: a single-member run's exceedances are the depth comparison the console already
    makes, and shipping them would double the file to say nothing new (rule 6 - the key's
    presence is itself the claim that the run measured a spread).
    """
    depth_cm = np.asarray(depth_cm)
    n_steps = depth_cm.shape[0]
    peak = depth_cm.max(axis=0)
    wet = np.flatnonzero(peak >= WET_THRESHOLD_CM)
    series = {str(segment_ids[k]): [round(float(v), 1) for v in depth_cm[:, k]] for k in wet}
    product: dict[str, Any] = {
        "run_id": run_id,
        "valid_ts": [t.isoformat() for t in times],
        "min_depth_cm": WET_THRESHOLD_CM,
        "n_segments_total": len(segment_ids),
        "n_segments_wet": len(series),
        "depth_cm": series,
    }

    if p_gt is None:
        p_gt = _exceedance_from_record(run_dir, segment_ids, n_steps)
    uncertain = 0
    if p_gt is not None:
        missing = [t for t in EXCEEDANCE_CM if t not in p_gt]
        if missing:
            raise ValueError(f"p_gt has no series for {missing} cm; the console reads all four.")
        fields = {t: np.asarray(p_gt[t])[:, wet] for t in EXCEEDANCE_CM}
        for t, field in fields.items():
            if field.shape != (n_steps, wet.size):
                raise ValueError(
                    f"p_gt[{t:g}] is {np.asarray(p_gt[t]).shape}; expected (n_steps, n_segments)"
                    f" = {depth_cm.shape}."
                )
        # Counted over what is written, not over the city: a spread on a street that never
        # gets wet is not one the map can draw.
        uncertain = int(
            sum(int(((f > 0.0) & (f < 1.0)).any(axis=0).sum()) for f in fields.values())
        )
        if uncertain:
            product["p_gt"] = {
                f"{t:g}": {
                    str(segment_ids[k]): [_probability(v) for v in field[:, j]]
                    for j, k in enumerate(wet)
                }
                for t, field in fields.items()
            }

    text = json.dumps(product, separators=(",", ":"))
    (run_dir / "segments_wet.json").write_text(text, encoding="utf-8")
    log.info(
        "products.wet_segments",
        run_id=run_id,
        wet=len(series),
        of=len(segment_ids),
        p_gt="p_gt" in product,
        # Segment-threshold series with at least one step strictly between 0 and 1: the number
        # of places probability mode draws something a deterministic run could not.
        uncertain_series=uncertain,
        bytes=len(text),
    )
    return product


def segment_names(city_root: Path) -> dict[str, str]:
    """Segment id to the street's OSM name, for products that have to say *where*.

    Only named ways. A road with no name in OSM is left out rather than given a placeholder, so
    nothing downstream has to decide whether "Unnamed road" came from the map or from us.
    """
    import pandas as pd

    table = city_root / "segments.parquet"
    if not table.is_file():
        return {}
    frame = pd.read_parquet(table, columns=["segment_id", "name"])
    named = frame[frame["name"].notna()]
    return {str(k): str(v) for k, v in zip(named["segment_id"], named["name"], strict=True)}


def segment_points(city_root: Path) -> dict[str, tuple[float, float]]:
    """Segment id to a representative lon/lat, for products that must put a pin somewhere.

    The midpoint of the segment's line rather than its bounding-box centre, so the point is on
    the road even where it bends. Used by alerts (the CAP area circle) and by the pump board,
    which has to dispatch a lorry to a place rather than to an id.
    """
    import geopandas as gpd

    table = city_root / "segments.parquet"
    if not table.is_file():
        return {}
    frame = gpd.read_parquet(table, columns=["segment_id", "geometry"]).to_crs("EPSG:4326")
    points = frame.geometry.interpolate(0.5, normalized=True)
    return {
        str(sid): (float(p.x), float(p.y))
        for sid, p in zip(frame["segment_id"], points, strict=True)
    }
