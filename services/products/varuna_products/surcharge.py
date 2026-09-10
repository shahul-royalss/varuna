"""Manholes pushing water back into the street, and pipes running backwards (P5.2, P6.6).

The demo's 1:40 moment (CLAUDE.md 15) is the map showing manholes surcharging and a tide-locked
outfall running in reverse. Both are states the coupled solver already computes every step - this
module is only what turns them into something the console can draw.

**Why only the surcharging nodes are written.** Mumbai's inferred graph has 49,897 nodes and a
run has 36 steps, so a full head-per-node-per-step table is 1.8 million rows to say that almost
all of them are fine. What the map draws is the exception, so the exception is what is stored:
each node that surcharges at least once, its position, and the steps at which it did.

**Backflow** is the same idea on the edges. A negative flow on an edge whose downstream end is a
tidal outfall is the physical signature CLAUDE.md 11.4 asks for - the sea holding the drain shut -
so the edges are tagged with whether they reach one, and the console can draw that subset alone.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import numpy as np
import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pathlib import Path

    from numpy.typing import NDArray
    from varuna_twin.types import DrainNetwork

log = structlog.get_logger("varuna.products.surcharge")

__all__ = ["MAX_NODES", "MIN_SURCHARGE_M3S", "surcharge_product", "write_surcharge"]

MAX_NODES = 500
"""How many surcharging manholes a run stores, worst first.

A heavy Mumbai cycle surcharges 9,524 of the 49,897 nodes, and writing all of them with a
per-step series produced a 17 MB JSON file the console had to download before it could draw
anything. The map cannot show 9,524 markers usefully at any zoom - they merge into a red
smear - so the top 500 by peak discharge is what is kept, and the total is reported beside it
so the count on screen is the true one."""

MIN_SURCHARGE_M3S = 1e-4
"""Below this, a node is not surcharging; it is arithmetic noise.

0.1 litres a second through a manhole is nothing a street would show and nothing an operator
would act on. Drawing it would put a red marker on the map for a number that rounds to zero,
which is the sort of thing rule 6 exists to stop."""


def surcharge_product(
    q_surcharge: NDArray[np.floating],
    edge_flow: NDArray[np.floating],
    network: DrainNetwork,
    transform: tuple[float, float, float, float, float, float],
    crs: str,
    run_id: str,
) -> dict[str, Any]:
    """Which manholes surcharge, when, and how hard; and which pipes run backwards.

    Positions come from each node's own 2D cell, which is the cell it exchanges water with, so a
    marker sits exactly where the water it emits arrives on the street.
    """
    from pyproj import Transformer

    n_steps = int(q_surcharge.shape[0])
    res, _, left, _, _, top = transform
    to_wgs = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    peak = q_surcharge.max(axis=0)
    active = np.flatnonzero(peak > MIN_SURCHARGE_M3S)
    # Worst first: the rail and the map both want the manholes that matter, and a run in a heavy
    # cycle can surcharge thousands of them.
    active = active[np.argsort(-peak[active])]

    nodes: list[dict[str, Any]] = []
    for index in active[:MAX_NODES]:
        row = int(network.cell_row[index])
        col = int(network.cell_col[index])
        if row < 0 or col < 0:
            # A node with no cell exchanges with no street, so it has nowhere to be drawn.
            continue
        lon, lat = to_wgs.transform(left + (col + 0.5) * res, top - (row + 0.5) * res)
        series = q_surcharge[:, index]
        steps = np.flatnonzero(series > MIN_SURCHARGE_M3S)
        nodes.append(
            {
                "node_id": network.node_ids[index],
                "lon": round(float(lon), 6),
                "lat": round(float(lat), 6),
                "peak_q_m3s": round(float(peak[index]), 4),
                "first_step": int(steps[0]),
                "last_step": int(steps[-1]),
                "n_steps": int(steps.size),
                # Two decimals in m3/s: enough to order them, small enough to keep the file
                # something the console can hold for every step of a 3-hour run.
                "q_m3s": [round(float(v), 2) for v in series],
            }
        )

    # Backflow: a negative flow is water moving against the edge's downhill orientation. The ones
    # that matter for the demo end at a tidal outfall, so they are marked rather than filtered -
    # a reversed pipe inland is a real result too, and hiding it would be a choice about physics.
    tidal_node = network.boundary == 1
    reversed_any = (edge_flow < 0.0).any(axis=0)
    edges: list[dict[str, Any]] = []
    for index in np.flatnonzero(reversed_any):
        downstream = int(network.to_node[index])
        edges.append(
            {
                "edge_id": network.edge_ids[index],
                "from_node": network.node_ids[int(network.from_node[index])],
                "to_node": network.node_ids[downstream],
                "tidal": bool(tidal_node[downstream]),
                "steps": [int(s) for s in np.flatnonzero(edge_flow[:, index] < 0.0)],
                "min_q_m3s": round(float(edge_flow[:, index].min()), 4),
            }
        )
    edges.sort(key=lambda e: (not e["tidal"], e["min_q_m3s"]))
    n_reversed_total = len(edges)
    # Counted before the cap, so the number on screen is the run's, not the file's.
    n_tidal_total = sum(1 for e in edges if e["tidal"])
    edges = edges[:MAX_NODES]

    product = {
        "run_id": run_id,
        "n_steps": n_steps,
        "n_nodes_total": int(network.n_nodes),
        "n_surcharging": int(active.size),
        "n_stored": len(nodes),
        "n_reversed_edges": n_reversed_total,
        "n_reversed_at_tidal_outfall": n_tidal_total,
        "min_surcharge_m3s": MIN_SURCHARGE_M3S,
        "nodes": nodes,
        "reversed_edges": edges,
    }
    log.info(
        "products.surcharge",
        run_id=run_id,
        surcharging=int(active.size),
        stored=len(nodes),
        of=int(network.n_nodes),
        reversed_edges=n_reversed_total,
        at_tidal=n_tidal_total,
    )
    return product


def write_surcharge(run_dir: Path, product: dict[str, Any]) -> None:
    """Write ``node_surcharge.json`` into a run directory."""
    (run_dir / "node_surcharge.json").write_text(
        json.dumps(product, indent=2) + "\n", encoding="utf-8"
    )
