"""The drain map VARUNA learned, as a product the console can draw (CLAUDE.md 11.6, task P7.4).

`drain_health.geojson` is the answer to the question a MoES scientist asks first: *where did you
get a drain GIS?* The answer is that we did not have one - the graph is inferred from roads and
terrain (CLAUDE.md 10.1 step 7), every pipe carries a blockage that starts as a prior from land
use, and Pulse moves that blockage using the streets that stopped moving and the people who
reported water.

So every element of this product carries three things the UI must show together: the posterior
mean, its **spread**, and the fact that the geometry itself is inferred. A magenta pipe on the
drain X-ray is not a measurement; it is a belief with a standard deviation, drawn dashed because
we do not know the pipe is there.

**The desilting CSV** (CLAUDE.md 7.3) is the product's point of contact with an actual municipal
workflow: id, street, beta, sd, capacity reduction, hotspots explained. A ward engineer with a
jetting crew and a week can act on a ranked list; that is what the whole engine is for.
"""

from __future__ import annotations

import csv
import io
import json
from typing import TYPE_CHECKING, Any

import numpy as np
import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pathlib import Path

    from numpy.typing import NDArray

    from varuna_pulse.enkf import EnkfResult

log = structlog.get_logger("varuna.pulse.health")

__all__ = [
    "INFERRED_NOTE",
    "desilting_csv",
    "drain_health",
    "write_drain_health",
]

INFERRED_NOTE = (
    "Drain graph inferred from roads and terrain, not a municipal SWD model. Every pipe's "
    "blockage is a posterior with a spread, learned from traffic anomalies and citizen reports."
)

TOP_N = 25
"""How many pipes the drain-health table shows (CLAUDE.md 7.3)."""

MAX_WRITTEN_EDGES = 6_000
"""How many pipes the written product carries, worst blockage first.

The inferred graph has 49,770 edges and each one is a line with coordinates, so writing all of
them produced a 19 MB GeoJSON per cycle - larger than every other product in the run put
together, to say that 44,000 pipes are near their prior. The drain X-ray draws the ones that
matter and the desilting list ranks the top 25; n_edges reports the true total beside what
was written, so nothing on screen mistakes the cap for the network."""


def capacity_reduction_pct(beta: NDArray[np.floating]) -> NDArray[np.floating]:
    """What blockage costs in flow, not in area.

    Manning's capacity goes as ``A * R_h^(2/3)``, and for a pipe running full both the area and
    the hydraulic radius fall with blockage, so ``Q ~ (1 - beta)^(5/3)``. Reporting ``beta``
    itself as "capacity reduction" would understate it: a pipe half blocked by area has lost
    about 68 % of its flow, not 50 %.
    """
    return (1.0 - (1.0 - np.clip(beta, 0.0, 1.0)) ** (5.0 / 3.0)) * 100.0


def drain_health(
    posterior: EnkfResult,
    edge_ids: tuple[str, ...],
    geometry: list[list[list[float]]],
    *,
    diameter_m: NDArray[np.floating],
    street: list[str | None] | None = None,
    explains: dict[str, list[str]] | None = None,
    observation_counts: NDArray[np.integer] | None = None,
    last_update: str | None = None,
    run_id: str = "",
) -> dict[str, Any]:
    """Build ``drain_health.geojson``: every pipe with its posterior, prior and what moved it."""
    beta = np.asarray(posterior.beta_mean, dtype=np.float64)
    sd = np.asarray(posterior.beta_sd, dtype=np.float64)
    prior = np.asarray(posterior.prior_mean, dtype=np.float64)
    reduction = capacity_reduction_pct(beta)
    counts = (
        np.zeros(len(edge_ids), dtype=np.int64)
        if observation_counts is None
        else np.asarray(observation_counts)
    )

    features = []
    for index, edge_id in enumerate(edge_ids):
        if index >= len(geometry):
            break
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": geometry[index]},
                "properties": {
                    "edge_id": edge_id,
                    "street": (street[index] if street and index < len(street) else None),
                    "beta_mean": round(float(beta[index]), 4),
                    "beta_sd": round(float(sd[index]), 4),
                    "beta_prior": round(float(prior[index]), 4),
                    "beta_delta": round(float(beta[index] - prior[index]), 4),
                    "capacity_reduction_pct": round(float(reduction[index]), 1),
                    "diameter_m": round(float(diameter_m[index]), 3),
                    "observations": int(counts[index]) if index < counts.size else 0,
                    "explains": (explains or {}).get(edge_id, []),
                    # Every element, always. The UI draws them dashed because of this field.
                    "confidence": "inferred",
                    "last_update": last_update,
                },
            }
        )

    moved = np.flatnonzero(np.abs(beta - prior) > 1e-4)
    log.info(
        "pulse.drain_health",
        run_id=run_id,
        edges=len(features),
        updated=int(moved.size),
        mean_beta=round(float(beta.mean()), 4),
        max_beta=round(float(beta.max()) if beta.size else 0.0, 4),
        operator=posterior.operator,
    )
    return {
        "type": "FeatureCollection",
        "run_id": run_id,
        "operator": posterior.operator,
        "note": INFERRED_NOTE,
        "n_edges": len(features),
        "n_updated": int(moved.size),
        "notes": list(posterior.notes),
        "features": features,
    }


def desilting_csv(health: dict[str, Any], limit: int = TOP_N) -> str:
    """The desilting priority list, worst pipe first (CLAUDE.md 7.3).

    Sorted by capacity reduction rather than by blockage, because that is the number that says
    how much flow a crew would win back - which is what a desilting budget is spent on.
    """
    rows = sorted(
        (f["properties"] for f in health.get("features", [])),
        key=lambda p: -float(p.get("capacity_reduction_pct") or 0.0),
    )[:limit]

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(
        [
            "rank",
            "edge_id",
            "street",
            "beta_mean",
            "beta_sd",
            "capacity_reduction_pct",
            "observations",
            "hotspots_explained",
            "confidence",
        ]
    )
    for rank, props in enumerate(rows, start=1):
        writer.writerow(
            [
                rank,
                props.get("edge_id"),
                props.get("street") or "",
                props.get("beta_mean"),
                props.get("beta_sd"),
                props.get("capacity_reduction_pct"),
                props.get("observations", 0),
                "; ".join(props.get("explains") or []),
                props.get("confidence", "inferred"),
            ]
        )
    return buffer.getvalue()


def write_drain_health(run_dir: Path, health: dict[str, Any]) -> None:
    """Write ``drain_health.geojson`` and ``desilting.csv`` into a run directory.

    The CSV is built from the **full** product before the geometry is capped, so the desilting
    ranking is over every pipe even though the map only receives the worst few thousand.
    """
    csv_text = desilting_csv(health)

    capped = dict(health)
    features = sorted(
        health.get("features", []),
        key=lambda f: -float(f["properties"].get("beta_mean", 0.0)),
    )[:MAX_WRITTEN_EDGES]
    capped["features"] = features
    capped["n_written"] = len(features)

    (run_dir / "drain_health.geojson").write_text(
        json.dumps(capped, separators=(",", ":")), encoding="utf-8"
    )
    (run_dir / "desilting.csv").write_text(csv_text, encoding="utf-8")
