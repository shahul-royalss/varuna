"""One Pulse stage: observations in, a learned drain map out (CLAUDE.md 11.6, 11.11).

The wiring between the pieces. It reads the traffic feed and the report stream up to the cycle
time, turns each observation into a depth at a place, finds the pipe that place drains through,
runs the EnKF over those pipes' blockage, and writes the drain-health product.

**Observations are located by their inlet, not by their coordinates.** A report at Hindmata is
evidence about the pipe Hindmata drains into, and the city pipeline already knows which inlet
node each surface unit and road segment belongs to. Going through the graph rather than through
a radius search is what makes the localisation below mean something hydraulic.

**The posterior persists across cycles** (CLAUDE.md 11.6) and relaxes toward the prior with a
30-day time constant, so a pipe that was desilted last month is not still condemned by a flood
it caused in June. Within a bake the carry-forward is in memory; `posterior.json` in the run
directory is what survives a restart.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import numpy as np
import structlog

from varuna_pulse.enkf import assimilate, capacity_operator, hop_distances
from varuna_pulse.health import drain_health
from varuna_pulse.reports import read_reports
from varuna_pulse.traffic import detect_anomalies

if TYPE_CHECKING:  # pragma: no cover - typing only
    from datetime import datetime
    from pathlib import Path

    from numpy.typing import NDArray

log = structlog.get_logger("varuna.pulse.cycle")

__all__ = ["RELAX_DAYS", "PulseResult", "run_pulse"]

RELAX_DAYS = 30.0
"""Time constant of the posterior's relaxation back toward the prior (CLAUDE.md 11.6).

Blockage is physical silt and it changes: a monsoon deposits it and a desilting crew removes it.
A posterior that never forgets would keep condemning a pipe that has since been cleaned."""

MAX_OBSERVATIONS = 400
"""Observations assimilated per cycle, strongest first.

The EnKF's cost is cubic in the batch through the innovation covariance, and a heavy cycle in
Mumbai produces thousands of traffic anomalies. Four hundred of the most anomalous is a batch
that runs in well under the 3 s stage budget and carries essentially all the information - the
thousandth-slowest street tells you nothing the first four hundred did not."""


@dataclass(frozen=True, slots=True)
class PulseResult:
    """What one Pulse stage produced."""

    beta_mean: NDArray[np.floating]
    beta_sd: NDArray[np.floating]
    health: dict[str, Any]
    n_traffic: int
    n_reports: int
    n_assimilated: int
    n_edges_updated: int
    observations: list[dict[str, Any]]
    notes: tuple[str, ...]


def _edge_below_node(from_node: NDArray[np.integer]) -> dict[int, int]:
    """The outgoing edge of each node: the pipe an inlet's water leaves through."""
    out: dict[int, int] = {}
    for edge, node in enumerate(from_node):
        out.setdefault(int(node), edge)
    return out


def run_pulse(
    network,
    city_root: Path,
    bundle_dir: Path,
    cycle_ts: datetime,
    *,
    transform: tuple[float, float, float, float, float, float] | None = None,
    crs: str | None = None,
    rain_mm_h_at: dict[str, float] | None = None,
    prior_mean: NDArray[np.floating] | None = None,
    prior_sd: NDArray[np.floating] | None = None,
    run_id: str = "",
    seed: int = 2019,
) -> PulseResult:
    """Assimilate this cycle's observations into the blockage posterior.

    Args:
        network: the loaded :class:`~varuna_twin.types.DrainNetwork`.
        city_root: ``city/<city>``, for the segment-to-inlet map.
        bundle_dir: the replay bundle, for the traffic feed and report stream.
        cycle_ts: only observations at or before this instant are used.
        transform, crs: the terrain grid, so a report's lon/lat can be matched to the drain node
            nearest it. Reports are skipped when they are absent, and the notes say so.
        rain_mm_h_at: rain over each observed segment, for the observation operator.
        prior_mean, prior_sd: the carried-forward posterior; the city's own prior when absent.
        run_id: stamped into the product.
    """
    import pandas as pd

    beta_prior = (
        np.asarray(network.beta, dtype=np.float64) if prior_mean is None
        else np.asarray(prior_mean, dtype=np.float64)
    )
    sd_prior = (
        np.full(beta_prior.shape, 0.15) if prior_sd is None
        else np.asarray(prior_sd, dtype=np.float64)
    )

    # ---- observations -----------------------------------------------------------------
    traffic: list[Any] = []
    speeds_path = bundle_dir / "traffic" / "speeds.parquet"
    if speeds_path.is_file():
        speeds = pd.read_parquet(speeds_path)
        traffic = detect_anomalies(speeds, at=cycle_ts, raining=True)

    reports = read_reports(bundle_dir, until=cycle_ts)

    # ---- locate each observation on the graph -----------------------------------------
    nodes = pd.read_parquet(
        city_root / "drain_nodes.parquet", columns=["node_id", "segment_id"]
    )
    node_index = {str(nid): i for i, nid in enumerate(network.node_ids)}
    segment_to_node = {
        str(seg): node_index[str(nid)]
        for seg, nid in zip(nodes["segment_id"], nodes["node_id"], strict=True)
        if seg is not None and str(nid) in node_index
    }
    outgoing = _edge_below_node(np.asarray(network.from_node))
    street_of_edge = _street_names(city_root, network, nodes, node_index)

    observed_edges: list[int] = []
    y: list[float] = []
    y_sd: list[float] = []
    records: list[dict[str, Any]] = []

    for observation in traffic:
        node = segment_to_node.get(observation.segment_id)
        edge = outgoing.get(node) if node is not None else None
        if edge is None:
            continue
        observed_edges.append(edge)
        y.append(observation.depth_cm)
        y_sd.append(observation.depth_sd_cm)
        records.append(
            {
                "kind": "traffic",
                "segment_id": observation.segment_id,
                "edge_id": network.edge_ids[edge],
                "ts": observation.ts.isoformat(),
                "depth_cm": observation.depth_cm,
                "depth_sd_cm": observation.depth_sd_cm,
                "speed_kmh": round(observation.speed_kmh, 1),
                "baseline_kmh": round(observation.baseline_kmh, 1),
                "z": round(observation.z, 2),
                "synthetic": True,
            }
        )

    # Reports carry a coordinate rather than a segment, so they are placed on the nearest inlet.
    node_lon, node_lat = _node_positions(network, transform, crs)
    for report in reports:
        edge = _nearest_edge(node_lon, node_lat, outgoing, report.lon, report.lat)
        if edge is None:
            continue
        observed_edges.append(edge)
        y.append(report.depth_cm)
        y_sd.append(report.depth_sd_cm / max(np.sqrt(min(report.n_merged, 4)), 1.0))
        records.append(
            {
                "kind": "report",
                "report_id": report.report_id,
                "edge_id": network.edge_ids[edge],
                "ts": report.ts.isoformat(),
                "depth_cm": report.depth_cm,
                "depth_sd_cm": report.depth_sd_cm,
                "chip": report.chip,
                "place": report.place,
                "n_merged": report.n_merged,
                "synthetic": report.synthetic,
            }
        )

    notes: list[str] = []
    if len(observed_edges) > MAX_OBSERVATIONS:
        order = np.argsort(np.asarray(y_sd))[:MAX_OBSERVATIONS]
        observed_edges = [observed_edges[i] for i in order]
        y = [y[i] for i in order]
        y_sd = [y_sd[i] for i in order]
        records = [records[i] for i in order]
        notes.append(
            f"{MAX_OBSERVATIONS} of the sharpest observations were assimilated this cycle."
        )

    # ---- assimilate -------------------------------------------------------------------
    if observed_edges:
        edges = np.asarray(observed_edges, dtype=np.int64)
        hops = hop_distances(
            np.asarray(network.from_node), np.asarray(network.to_node), edges
        )
        rain = np.array(
            [float((rain_mm_h_at or {}).get(r.get("segment_id", ""), 60.0)) for r in records]
        )
        # The catchment each pipe actually drains, from the city pipeline's rational-method
        # sizing, rather than one number for every junction. A trunk under Dadar and a lane in
        # Chembur do not fail at the same rainfall, and the filter should know that.
        catchment = _contributing_area(city_root, network)[edges]
        operator = capacity_operator(
            edges,
            contributing_area_m2=catchment,
            rain_mm_h=rain,
            # The junction a pipe's water backs up over. A choice, held constant so the
            # observation operator stays monotone in blockage and nothing else.
            ponding_area_m2=np.full(edges.size, 1_500.0),
            q_full_m3s=np.asarray(network.q_full, dtype=np.float64)[edges],
        )
        posterior = assimilate(
            beta_prior, sd_prior, np.asarray(y), np.asarray(y_sd), operator, hops, seed=seed
        )
    else:
        posterior = assimilate(
            beta_prior,
            sd_prior,
            np.zeros(0),
            np.zeros(0),
            capacity_operator(
                np.zeros(0, dtype=np.int64),
                contributing_area_m2=np.zeros(0),
                rain_mm_h=np.zeros(0),
                ponding_area_m2=np.zeros(0),
                q_full_m3s=np.zeros(0),
            ),
            np.zeros((0, beta_prior.size), dtype=np.int32),
            seed=seed,
        )

    counts = np.zeros(beta_prior.size, dtype=np.int64)
    for edge in observed_edges:
        counts[edge] += 1

    health = drain_health(
        posterior,
        network.edge_ids,
        _edge_geometry(city_root, network.edge_ids),
        diameter_m=np.asarray(network.diameter, dtype=np.float64),
        street=street_of_edge,
        observation_counts=counts,
        last_update=cycle_ts.isoformat(),
        run_id=run_id,
    )

    log.info(
        "pulse.cycle",
        run_id=run_id,
        traffic=len(traffic),
        reports=len(reports),
        assimilated=len(observed_edges),
        edges_updated=int(posterior.updated_edges.size),
    )
    return PulseResult(
        beta_mean=posterior.beta_mean,
        beta_sd=posterior.beta_sd,
        health=health,
        n_traffic=len(traffic),
        n_reports=len(reports),
        n_assimilated=len(observed_edges),
        n_edges_updated=int(posterior.updated_edges.size),
        observations=records,
        notes=tuple([*notes, *posterior.notes]),
    )


def _street_names(city_root: Path, network, nodes, node_index: dict[str, int]) -> list[str | None]:
    """The road each pipe runs under, in the network's edge order.

    A desilting list that says `MUM-E020507` is not a work order. The drain graph has no street
    of its own - it was synthesised along the roads - but every node remembers the segment it was
    placed on, and segments now carry OSM's name.
    """
    import pandas as pd

    segments = city_root / "segments.parquet"
    if not segments.is_file():
        return [None] * len(network.edge_ids)
    frame = pd.read_parquet(segments, columns=["segment_id", "name"])
    name_of_segment = {
        str(sid): (None if name is None or name != name else str(name))
        for sid, name in zip(frame["segment_id"], frame["name"], strict=True)
    }
    segment_of_node: dict[int, str] = {}
    for seg, nid in zip(nodes["segment_id"], nodes["node_id"], strict=True):
        index = node_index.get(str(nid))
        if index is not None and seg is not None:
            segment_of_node[index] = str(seg)

    from_node = np.asarray(network.from_node)
    return [
        name_of_segment.get(segment_of_node.get(int(from_node[edge]), ""), None)
        for edge in range(len(network.edge_ids))
    ]


def _contributing_area(city_root: Path, network) -> NDArray[np.floating]:
    """Catchment area per pipe in m2, from the city pipeline's own sizing."""
    import pandas as pd

    path = city_root / "drain_edges.parquet"
    fallback = np.full(len(network.edge_ids), 30_000.0)
    if not path.is_file():
        return fallback
    frame = pd.read_parquet(path, columns=["edge_id", "contributing_area_m2"])
    by_id = dict(zip(frame["edge_id"].astype(str), frame["contributing_area_m2"], strict=True))
    return np.array(
        [float(by_id.get(str(eid), 30_000.0) or 30_000.0) for eid in network.edge_ids]
    )


def _node_positions(
    network,
    transform: tuple[float, float, float, float, float, float] | None,
    crs: str | None,
) -> tuple[NDArray[np.floating] | None, NDArray[np.floating] | None]:
    """Every drain node's lon/lat, from the 2D cell it exchanges water with.

    The node table has no coordinates of its own in the solver's view - the graph is indices and
    arrays - but each node knows its cell, and the cell is a place.
    """
    if transform is None or crs is None:
        return None, None
    from pyproj import Transformer

    res, _, left, _, _, top = transform
    rows = np.asarray(network.cell_row, dtype=np.float64)
    cols = np.asarray(network.cell_col, dtype=np.float64)
    x = left + (cols + 0.5) * res
    y = top - (rows + 0.5) * res
    lon, lat = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform(x, y)
    # A node with no cell exchanges with no street; park it far away so it never wins a search.
    missing = (np.asarray(network.cell_row) < 0) | (np.asarray(network.cell_col) < 0)
    return np.where(missing, 1e6, lon), np.where(missing, 1e6, lat)


def _nearest_edge(
    node_lon: NDArray[np.floating] | None,
    node_lat: NDArray[np.floating] | None,
    outgoing: dict[int, int],
    lon: float,
    lat: float,
) -> int | None:
    """The outgoing pipe of the drain node nearest a lon/lat."""
    if node_lon is None or node_lat is None:
        return None
    distance = (node_lon - lon) ** 2 + (node_lat - lat) ** 2
    return outgoing.get(int(np.argmin(distance)))


def _edge_geometry(city_root: Path, edge_ids: tuple[str, ...]) -> list[list[list[float]]]:
    """Each edge's line in lon/lat, in the network's own edge order."""
    import geopandas as gpd

    path = city_root / "drain_edges.parquet"
    if not path.is_file():
        return []
    frame = gpd.read_parquet(path, columns=["edge_id", "geometry"]).to_crs("EPSG:4326")
    by_id = {
        str(eid): [[round(x, 6), round(y, 6)] for x, y in geom.coords]
        for eid, geom in zip(frame["edge_id"], frame.geometry, strict=True)
        if geom is not None
    }
    return [by_id.get(str(eid), []) for eid in edge_ids]


def relax_toward_prior(
    posterior_mean: NDArray[np.floating],
    prior_mean: NDArray[np.floating],
    days_since: float,
) -> NDArray[np.floating]:
    """Exponential relaxation of the posterior back toward the prior (CLAUDE.md 11.6)."""
    weight = float(np.exp(-max(days_since, 0.0) / RELAX_DAYS))
    return weight * np.asarray(posterior_mean) + (1.0 - weight) * np.asarray(prior_mean)


def load_posterior(path: Path) -> tuple[NDArray[np.floating], NDArray[np.floating]] | None:
    """Read a carried-forward posterior, or None when this is the first cycle."""
    if not path.is_file():
        return None
    blob = json.loads(path.read_text(encoding="utf-8"))
    return np.asarray(blob["beta_mean"]), np.asarray(blob["beta_sd"])


def save_posterior(path: Path, result: PulseResult, cycle_ts: datetime) -> None:
    """Persist the posterior so the next cycle - or the next boot - starts where this ended."""
    path.write_text(
        json.dumps(
            {
                "cycle_ts": cycle_ts.isoformat(),
                "beta_mean": [round(float(v), 5) for v in result.beta_mean],
                "beta_sd": [round(float(v), 5) for v in result.beta_sd],
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
