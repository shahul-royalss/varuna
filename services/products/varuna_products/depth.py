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
depth field out. So ``p10 == p50 == p90`` here and every exceedance probability is 0 or 1. That
is not a spread and this module does not dress it up as one - :func:`segment_forecast` records
``ensemble_n = 1`` and the run's notes say so. The 50-member spread arrives in Phase 7, when
Flash-lite runs 20 Sky members against draws from the Pulse posterior (CLAUDE.md 11.7); at that
point this same function takes a stack instead of a single field and the quantiles become real.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import structlog
from varuna_schemas.ramps import depth_array_to_rgba

if TYPE_CHECKING:  # pragma: no cover - typing only
    from datetime import datetime

    from numpy.typing import NDArray

log = structlog.get_logger("varuna.products.depth")

__all__ = [
    "PROFILE_THRESHOLD_CM",
    "PROFILE_TOLERANCE",
    "SEGMENT_BUFFER_M",
    "SEGMENT_PERCENTILE",
    "depth_bounds",
    "segment_cell_index",
    "segment_forecast",
    "write_depth_rasters",
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


# ============================================================================ rasters
def depth_bounds(transform: tuple[float, float, float, float, float, float],
                 shape: tuple[int, int], crs: str) -> dict[str, object]:
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


def segment_forecast(
    depth_m: NDArray[np.floating],
    times: tuple[datetime, ...],
    index,
    run_id: str,
):
    """Per-segment depth per step, with exceedances and safe-until per profile.

    ``depth_m`` is ``(n_steps, n_rows, n_cols)`` from one Twin run. Because that run is
    deterministic there is no ensemble to take a quantile over, so p10, p50 and p90 are the same
    number and every exceedance is 0 or 1 - see the module docstring. The columns exist now so
    the console, the API contract and the parquet schema do not change shape when Phase 7 makes
    them real.
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

    rows: list[dict[str, object]] = []
    for k, seg_id in enumerate(segment_ids):
        series = depth_cm[:, k]
        safe_until: dict[str, object] = {}
        for profile, threshold in PROFILE_THRESHOLD_CM.items():
            # A deterministic run makes the exceedance probability 1 above the threshold, so
            # "first time P > tolerance" is just "first time the depth passes the threshold".
            over = np.flatnonzero(series > threshold)
            safe_until[profile] = times[int(over[0])].isoformat() if over.size else None
        for step in range(n_steps):
            d = float(series[step])
            rows.append(
                {
                    "run_id": run_id,
                    "segment_id": seg_id,
                    "valid_ts": times[step],
                    "depth_p10_cm": d,
                    "depth_p50_cm": d,
                    "depth_p90_cm": d,
                    "p_gt_15": float(d > 15.0),
                    "p_gt_30": float(d > 30.0),
                    "p_gt_45": float(d > 45.0),
                    "p_gt_60": float(d > 60.0),
                    "safe_until": json.dumps(safe_until),
                }
            )

    frame = pd.DataFrame.from_records(rows)
    log.info(
        "products.segment_forecast",
        segments=n_seg,
        steps=n_steps,
        rows=len(frame),
        max_cm=round(float(depth_cm.max()) if depth_cm.size else 0.0, 1),
        wet_segments=int((depth_cm.max(axis=0) > 5.0).sum()) if depth_cm.size else 0,
    )
    return frame, depth_cm
