"""Time-dependent routing around water (CLAUDE.md 11.9, Appendix A; tasks P8.2, P8.5).

**Why the time dependence matters.** A naive router asks "is this street flooded?" and gets an
answer for now. The question an ambulance leaving KEM at 08:40 actually has is "will Hindmata be
flooded *when I get there*, twelve minutes from now" - and on the 2 July storm those are different
answers. So the cost of an edge is evaluated at the arrival time the search has reached:

    c_e(tau, v) = t_e * phi(h_e(tau))    if P(h_e(tau) > theta_v) < p_max
                = infinity                otherwise

with ``phi(h) = 1`` below 5 cm rising linearly to 3x at the profile's threshold - water slows a
vehicle long before it stops it.

**Why plain Dijkstra is still correct here.** Time-dependent shortest paths need the FIFO (no
overtaking) property: leaving later must never arrive earlier. It holds because ``phi >= 1`` and
the edge is either passable or infinite, so waiting at a node can never help - and where it holds,
Dijkstra keyed on arrival time is exact. The test suite asserts FIFO on a synthetic network rather
than trusting the argument.

**Alternates** are the same search with the chosen edges penalised threefold, which is the
standard cheap way to get a genuinely different road rather than a detour of one block.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

import structlog

from varuna_route.forecast import DRY_CM, SegmentDepths, load_depths
from varuna_route.graph import RoadGraph, load_graph
from varuna_route.profiles import Profile, profile

if TYPE_CHECKING:  # pragma: no cover - typing only
    from collections.abc import Iterable

log = structlog.get_logger("varuna.route.router")

__all__ = [
    "MAX_SLOWDOWN",
    "Route",
    "RouteResult",
    "plan",
]

MAX_SLOWDOWN = 3.0
"""Traversal time at the profile's threshold depth, as a multiple of free flow.

Three, from CLAUDE.md 11.9. A car in 25 cm of water is not stopped, it is crawling behind
everybody else who is also crawling; three times is what the traffic baselines in the replay
bundle show at that depth."""

ALTERNATE_PENALTY = 3.0
"""Cost multiplier on edges the previous route used, when searching for an alternate."""

MAX_ALTERNATES = 2


def _phi(depth_cm: float, threshold_cm: float) -> float:
    """Slowdown factor for water on an edge: 1 when dry, :data:`MAX_SLOWDOWN` at the threshold."""
    if depth_cm <= DRY_CM:
        return 1.0
    span = max(threshold_cm - DRY_CM, 1.0)
    return 1.0 + (MAX_SLOWDOWN - 1.0) * min((depth_cm - DRY_CM) / span, 1.0)


def _exceedance(depth_cm: float, threshold_cm: float) -> float:
    """P(depth > threshold) on a deterministic run: 1 or 0.

    Not a placeholder for a probability - it *is* the probability this run supports, because it
    has one member. When Phase 7's 50-member products land this reads their `p_gt_*` column and
    nothing else in the router changes.
    """
    return 1.0 if depth_cm > threshold_cm else 0.0


@dataclass(frozen=True, slots=True)
class Leg:
    """One edge of a route, with the water on it at the moment the vehicle gets there."""

    segment_id: str
    name: str
    length_m: float
    seconds: float
    depth_cm: float
    arrive: datetime


@dataclass(frozen=True, slots=True)
class Avoided:
    """A street the route did not take because it is predicted impassable."""

    segment_id: str
    name: str
    depth_cm: float
    probability: float
    at: datetime


@dataclass(frozen=True, slots=True)
class Route:
    """One path from origin to destination."""

    legs: tuple[Leg, ...]
    seconds: float
    distance_m: float
    max_depth_cm: float
    depart: datetime
    arrive: datetime
    path: tuple[tuple[float, float], ...]
    """Node coordinates along the route, for the map."""

    safe_until: datetime | None
    """Last departure time for which this exact path is still passable, or None if it is not."""

    @property
    def minutes(self) -> float:
        return self.seconds / 60.0


@dataclass
class RouteResult:
    """The answer to one routing request: what a naive router does, and what VARUNA does."""

    run_id: str
    profile: str
    depart: datetime
    naive: Route | None
    varuna: Route | None
    alternates: list[Route] = field(default_factory=list)
    avoided: list[Avoided] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    ms: float = 0.0


def _search(
    graph: RoadGraph,
    depths: SegmentDepths,
    *,
    source: int,
    target: int,
    depart: datetime,
    vehicle: Profile,
    avoid_water: bool,
    penalised: set[int] | None = None,
    record_blocked: dict[int, tuple[float, float, datetime]] | None = None,
) -> list[int] | None:
    """Time-dependent Dijkstra from ``source``, returning the out-edge indices of the path.

    ``avoid_water`` off is the naive router: shortest by dry-weather time, water ignored. That is
    the comparison the screen makes, and it is what a navigation app does today.
    """
    n = graph.n_nodes
    best = [float("inf")] * n
    best[source] = 0.0
    came: list[int] = [-1] * n
    heap: list[tuple[float, int]] = [(0.0, source)]
    speed = max(vehicle.speed_scale, 0.05)

    while heap:
        elapsed, node = heapq.heappop(heap)
        if elapsed > best[node] + 1e-9:
            continue
        if node == target:
            break
        arrive_here = depart + timedelta(seconds=elapsed)
        step = depths.step_at(arrive_here)

        for e in range(int(graph.indptr[node]), int(graph.indptr[node + 1])):
            segment_id = graph.edge_segment[e]
            free = float(graph.edge_time_s[e]) / speed
            cost = free

            if avoid_water:
                depth = depths.depth_at(segment_id, step)
                p = _exceedance(depth, vehicle.depth_cm)
                if p >= vehicle.risk_tolerance:
                    if record_blocked is not None and e not in record_blocked:
                        record_blocked[e] = (depth, p, arrive_here)
                    continue
                cost = free * _phi(depth, vehicle.depth_cm)

            if penalised and e in penalised:
                cost *= ALTERNATE_PENALTY

            nxt = int(graph.head[e])
            candidate = elapsed + cost
            if candidate < best[nxt] - 1e-9:
                best[nxt] = candidate
                came[nxt] = e
                heapq.heappush(heap, (candidate, nxt))

    if best[target] == float("inf"):
        return None

    # Walk the predecessor edges back to the source.
    edges: list[int] = []
    node = target
    while node != source:
        e = came[node]
        if e < 0:
            return None
        edges.append(e)
        node = int(graph.edge_tail[e])
    edges.reverse()
    return edges


def _build_route(
    graph: RoadGraph,
    depths: SegmentDepths,
    edges: Iterable[int],
    *,
    depart: datetime,
    vehicle: Profile,
    source: int,
) -> Route:
    legs: list[Leg] = []
    coords: list[tuple[float, float]] = [(float(graph.lon[source]), float(graph.lat[source]))]
    elapsed = 0.0
    distance = 0.0
    speed = max(vehicle.speed_scale, 0.05)
    worst = 0.0
    # Times and lengths come out of numpy arrays; float() at the boundary keeps numpy scalars out
    # of the dataclass and therefore out of the JSON encoder, which cannot serialise them.

    for e in edges:
        arrive_at_edge = depart + timedelta(seconds=elapsed)
        step = depths.step_at(arrive_at_edge)
        segment_id = graph.edge_segment[e]
        depth = depths.depth_at(segment_id, step)
        seconds = float(graph.edge_time_s[e] / speed) * _phi(depth, vehicle.depth_cm)
        elapsed += seconds
        distance += float(graph.edge_length_m[e])
        worst = max(worst, depth)
        head = int(graph.head[e])
        coords.append((float(graph.lon[head]), float(graph.lat[head])))
        legs.append(
            Leg(
                segment_id=segment_id,
                name=graph.edge_name[e],
                length_m=float(graph.edge_length_m[e]),
                seconds=seconds,
                depth_cm=depth,
                arrive=depart + timedelta(seconds=elapsed),
            )
        )

    return Route(
        legs=tuple(legs),
        seconds=elapsed,
        distance_m=distance,
        max_depth_cm=worst,
        depart=depart,
        arrive=depart + timedelta(seconds=elapsed),
        path=tuple(coords),
        safe_until=_safe_until(graph, depths, legs, vehicle, depart),
    )


def _safe_until(
    graph: RoadGraph,
    depths: SegmentDepths,
    legs: list[Leg],
    vehicle: Profile,
    depart: datetime,
) -> datetime | None:
    """The last departure time at which every street on this path is still passable.

    Answers the dispatcher's real question - "how long is this route good for?" - by walking the
    forecast forward and stopping at the first step where any segment on the path exceeds the
    profile's threshold. Each segment is checked at the time the vehicle would reach *it*, not at
    the departure time, so a route whose last mile floods late stays good longer than one whose
    first mile floods soon.
    """
    del graph
    if not legs:
        return None
    offsets = [(leg.segment_id, (leg.arrive - depart).total_seconds()) for leg in legs]
    last_good: datetime | None = None
    for step in range(depths.n_steps):
        candidate = depths.time_of(step)
        if candidate < depart:
            continue
        blocked = False
        for segment_id, offset in offsets:
            at = depths.step_at(candidate + timedelta(seconds=offset))
            if depths.depth_at(segment_id, at) > vehicle.depth_cm:
                blocked = True
                break
        if blocked:
            break
        last_good = candidate
    return last_good


def plan(
    origin: tuple[float, float],
    destination: tuple[float, float],
    *,
    depart_at: datetime | None = None,
    vehicle: str = "ambulance",
    risk_tolerance: float | None = None,
    city: str = "mumbai",
    run_id: str | None = None,
) -> RouteResult:
    """Route from one point to another, naively and around the forecast water.

    Args:
        origin: ``(lon, lat)``.
        destination: ``(lon, lat)``.
        depart_at: when the vehicle leaves; defaults to the run's first forecast step.
        vehicle: a key of :data:`varuna_route.profiles.PROFILES`.
        risk_tolerance: override the profile's default acceptance of exceedance probability.
        city: which built city to route on.
        run_id: which run's forecast to route against; defaults to the newest baked one.
    """
    from time import perf_counter

    started = perf_counter()
    graph = load_graph(city)
    depths = load_depths(run_id)
    base = profile(vehicle)
    if risk_tolerance is not None:
        base = Profile(
            base.key,
            base.label,
            base.depth_cm,
            float(risk_tolerance),
            base.speed_scale,
            base.hazard_rule,
        )

    depart = depart_at or depths.valid_ts
    source = graph.nearest_node(*origin)
    target = graph.nearest_node(*destination)

    notes: list[str] = []
    if depths.ensemble_n <= 1:
        notes.append(
            "This run is deterministic (one member), so a street is either predicted impassable "
            "or it is not, and the risk tolerance has nothing to weigh. It is carried through for "
            "when the 50-member products land."
        )

    if source == target:
        notes.append("Origin and destination snap to the same junction; there is nothing to route.")
        return RouteResult(
            run_id=depths.run_id,
            profile=base.key,
            depart=depart,
            naive=None,
            varuna=None,
            notes=notes,
            ms=(perf_counter() - started) * 1000.0,
        )

    naive_edges = _search(
        graph, depths, source=source, target=target, depart=depart, vehicle=base, avoid_water=False
    )
    blocked: dict[int, tuple[float, float, datetime]] = {}
    varuna_edges = _search(
        graph,
        depths,
        source=source,
        target=target,
        depart=depart,
        vehicle=base,
        avoid_water=True,
        record_blocked=blocked,
    )

    naive = (
        _build_route(graph, depths, naive_edges, depart=depart, vehicle=base, source=source)
        if naive_edges
        else None
    )
    varuna = (
        _build_route(graph, depths, varuna_edges, depart=depart, vehicle=base, source=source)
        if varuna_edges
        else None
    )

    if varuna_edges is None and naive_edges is not None:
        notes.append(
            f"Every route to this destination crosses water deeper than {base.depth_cm:.0f} cm "
            f"for a {base.label.lower()}. The shortest way is shown; it is not passable."
        )

    # What the naive route walks into and VARUNA does not: the honest content of "avoided".
    avoided: list[Avoided] = []
    if naive is not None:
        chosen = {leg.segment_id for leg in (varuna.legs if varuna else ())}
        seen: set[str] = set()
        for leg in naive.legs:
            if leg.segment_id in chosen or leg.segment_id in seen:
                continue
            if leg.depth_cm > base.depth_cm:
                seen.add(leg.segment_id)
                avoided.append(
                    Avoided(
                        segment_id=leg.segment_id,
                        name=leg.name or "Unnamed road",
                        depth_cm=leg.depth_cm,
                        probability=_exceedance(leg.depth_cm, base.depth_cm),
                        at=leg.arrive,
                    )
                )
        avoided.sort(key=lambda a: -a.depth_cm)

    alternates: list[Route] = []
    if varuna_edges:
        used = set(varuna_edges)
        for _ in range(MAX_ALTERNATES):
            more = _search(
                graph,
                depths,
                source=source,
                target=target,
                depart=depart,
                vehicle=base,
                avoid_water=True,
                penalised=used,
            )
            if not more or set(more) == used:
                break
            alternates.append(
                _build_route(graph, depths, more, depart=depart, vehicle=base, source=source)
            )
            used |= set(more)

    ms = (perf_counter() - started) * 1000.0
    log.info(
        "route.planned",
        run_id=depths.run_id,
        profile=base.key,
        ms=round(ms, 1),
        naive_min=round(naive.minutes, 1) if naive else None,
        varuna_min=round(varuna.minutes, 1) if varuna else None,
        avoided=len(avoided),
        blocked_edges=len(blocked),
    )
    return RouteResult(
        run_id=depths.run_id,
        profile=base.key,
        depart=depart,
        naive=naive,
        varuna=varuna,
        alternates=alternates,
        avoided=avoided,
        notes=notes,
        ms=ms,
    )


def as_dict(result: RouteResult) -> dict[str, Any]:
    """The API's shape for a route result (CLAUDE.md 12)."""

    def route(r: Route | None) -> dict[str, Any] | None:
        if r is None:
            return None
        return {
            "minutes": round(float(r.minutes), 1),
            "distance_m": round(float(r.distance_m), 1),
            "max_depth_cm": round(float(r.max_depth_cm), 1),
            "depart": r.depart.isoformat(),
            "arrive": r.arrive.isoformat(),
            "safe_until": r.safe_until.isoformat() if r.safe_until else None,
            "path": [[round(x, 6), round(y, 6)] for x, y in r.path],
            "streets": _street_names(r),
        }

    return {
        "run_id": result.run_id,
        "profile": result.profile,
        "depart_at": result.depart.isoformat(),
        "naive": route(result.naive),
        "varuna": route(result.varuna),
        "alternates": [route(r) for r in result.alternates],
        "avoided": [
            {
                "segment_id": a.segment_id,
                "name": a.name,
                "depth_cm": round(float(a.depth_cm), 1),
                "probability": a.probability,
                "at": a.at.isoformat(),
            }
            for a in result.avoided
        ],
        "notes": result.notes,
        "ms": round(result.ms, 1),
    }


def _street_names(route: Route, limit: int = 12) -> list[str]:
    """The named streets a route uses, in order, without repeating consecutive names."""
    out: list[str] = []
    for leg in route.legs:
        if leg.name and (not out or out[-1] != leg.name):
            out.append(leg.name)
        if len(out) >= limit:
            break
    return out
