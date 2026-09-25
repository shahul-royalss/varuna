"""Attribution with `drain1d` in the loop (CLAUDE.md 11.7, task P7.7).

ADR-0042 retired attribution on Flash-lite for a reason that was measured and is still true:
:func:`varuna_flash.model.simulate` is element-wise per segment, so a pipe that is not under the
target moves it by exactly zero. What that ADR shelved was the fix it named - `drain1d` inside
the loop - on a price of "21,296 candidates at a three-minute Twin-coupled run each".

These tests are about the two claims that make the fix affordable and the one claim that makes it
worth having:

* the candidate set is CLAUDE.md 11.7's five upstream hops, which is tens of pipes;
* running every candidate as a disjoint copy of the same network in **one** solver call gives
  bit-for-bit the same answer as cleaning them one at a time, and
* **the operator sees across segments**: a pipe above the target changes the target, and a pipe
  the same number of hops away down a different branch does not.

That last one is the property ADR-0042 said no operator in the repository had. It is tested on a
network small enough to reason about by hand rather than on Mumbai, so a failure names a
mechanism instead of a city.
"""

from __future__ import annotations

import numpy as np
import pytest
from varuna_flash.whatif import (
    ATTRIBUTION_FLOOR_CM,
    CLEANED_BETA,
    attribute_pipes,
    build_adjacency,
    candidate_pipes,
)
from varuna_twin.drain1d import BOUNDARY_FREE, BOUNDARY_INTERIOR
from varuna_twin.types import DrainNetwork

# --------------------------------------------------------------------------------- fixtures

#: Nodes of the test network, in index order. Two branches meet at the target and drain to an
#: outfall, so "five hops away on another branch" is a place that exists::
#:
#:     A0 -> A1 -> A2 -> A3 -> A4 -> T -> D0 -> OUT
#:                                    ^
#:     B0 -> B1 -> B2 -> B3 -> B4 ----+
#:
#: The target is one node (``T``) so the arithmetic is easy to follow; Mumbai's junctions are
#: tens of nodes and the code takes a set.
_CHAIN_A = ["A0", "A1", "A2", "A3", "A4"]
_CHAIN_B = ["B0", "B1", "B2", "B3", "B4"]
_NODES = [*_CHAIN_A, *_CHAIN_B, "T", "D0", "OUT"]
_EDGES = [
    *[(f"A{i}", f"A{i + 1}") for i in range(4)],
    ("A4", "T"),
    *[(f"B{i}", f"B{i + 1}") for i in range(4)],
    ("B4", "T"),
    ("T", "D0"),
    ("D0", "OUT"),
]


def _network(beta: float = 0.6, diameter_m: float = 0.15) -> DrainNetwork:
    """A two-branch network with enough fall to run, and one free outfall.

    Every pipe is identical, so a difference between two runs can only come from the blockage
    that was changed. The ground slopes 0.5 m per node and the invert sits 1.5 m below it, which
    is CLAUDE.md 10.1 step 7's cover depth.

    **The network is deliberately pipe-limited**, and that had to be arranged. At the city
    pipeline's smallest 450 mm class the answer came back all zeros: 25 cm of street over a
    600 mm-grate inlet cannot deliver enough water for the pipe below to be the constraint, so
    cleaning any of them changed nothing and the test proved only that the fixture was slack.
    That is the same mechanism that refuses Hindmata on the real city (the inlets, not the
    pipes, limit the drain there), so it is worth naming rather than tuning past quietly: these
    pipes are 150 mm at 60 % blocked, with inlets wide enough not to be the bottleneck.
    """
    index = {name: i for i, name in enumerate(_NODES)}
    # Distance to the outfall along the graph, so heads fall the way the water runs.
    fall = {"OUT": 0, "D0": 1, "T": 2}
    for i, name in enumerate(_CHAIN_A):
        fall[name] = 2 + (5 - i)
    for i, name in enumerate(_CHAIN_B):
        fall[name] = 2 + (5 - i)

    z_ground = np.array([2.0 + 0.5 * fall[n] for n in _NODES], dtype=np.float64)
    z_invert = z_ground - 1.5
    n_nodes, n_edges = len(_NODES), len(_EDGES)
    boundary = np.full(n_nodes, BOUNDARY_INTERIOR, dtype=np.int8)
    boundary[index["OUT"]] = BOUNDARY_FREE

    diameter = np.full(n_edges, diameter_m)
    area = np.pi * (diameter / 2.0) ** 2
    r_h = diameter / 4.0
    length = np.full(n_edges, 40.0)
    manning = np.full(n_edges, 0.013)
    slope = 0.5 / 40.0
    q_full = (1.0 / manning) * area * np.cbrt(np.square(r_h)) * np.sqrt(slope)

    return DrainNetwork(
        node_ids=tuple(_NODES),
        z_ground=z_ground,
        z_invert=z_invert,
        storage_area=np.full(n_nodes, 1.5),
        inlet_length=np.full(n_nodes, 3.0),
        inlet_area=np.full(n_nodes, 1.0),
        kappa=np.full(n_nodes, 0.25),
        boundary=boundary,
        flap_gate=np.zeros(n_nodes, dtype=bool),
        cell_row=np.arange(n_nodes, dtype=np.int32),
        cell_col=np.zeros(n_nodes, dtype=np.int32),
        edge_ids=tuple(f"E-{a}-{b}" for a, b in _EDGES),
        from_node=np.array([index[a] for a, _ in _EDGES], dtype=np.int32),
        to_node=np.array([index[b] for _, b in _EDGES], dtype=np.int32),
        length=length,
        area=area,
        hydraulic_radius=r_h,
        diameter=diameter,
        edge_manning_n=manning,
        q_full=q_full,
        beta=np.full(n_edges, beta),
    )


def _rain_on_the_street(
    network: DrainNetwork, steps: int = 12, depth_m: float = 0.25
) -> np.ndarray:
    """A frozen street depth: every node's cell under ``depth_m`` of water for the whole window.

    Frozen is the point - CLAUDE.md 11.6's "surface inflows frozen from the last Twin run". A
    constant field keeps the test about the pipes.
    """
    return np.full((steps, network.n_nodes), depth_m, dtype=np.float64)


def _target(network: DrainNetwork) -> int:
    return network.node_ids.index("T")


# --------------------------------------------------------------------------------- candidates


def test_the_candidate_set_is_five_upstream_hops() -> None:
    network = _network()
    adjacency = build_adjacency(network)
    edges, nodes = candidate_pipes(network, [_target(network)], adjacency=adjacency, hops=5)
    named = {network.edge_ids[e] for e in edges}

    # Five hops up each branch, both branches, and nothing downstream: `T -> D0` is below the
    # target and `D0 -> OUT` is below that.
    assert named == {
        "E-A4-T",
        "E-A3-A4",
        "E-A2-A3",
        "E-A1-A2",
        "E-A0-A1",
        "E-B4-T",
        "E-B3-B4",
        "E-B2-B3",
        "E-B1-B2",
        "E-B0-B1",
    }
    assert "E-T-D0" not in named
    assert {network.node_ids[n] for n in nodes} == {"T", *_CHAIN_A, *_CHAIN_B}


def test_a_shorter_walk_stops_short() -> None:
    network = _network()
    adjacency = build_adjacency(network)
    edges, _ = candidate_pipes(network, [_target(network)], adjacency=adjacency, hops=2)
    assert {network.edge_ids[e] for e in edges} == {
        "E-A4-T",
        "E-A3-A4",
        "E-B4-T",
        "E-B3-B4",
    }


# ------------------------------------------------------------------- the batching is exact


def test_one_run_of_many_copies_equals_cleaning_them_one_at_a_time() -> None:
    """The speed trick must not be an approximation.

    `attribute_pipes` tiles the local network once per candidate and makes a single solver call,
    because a call per candidate measured 0.36 s on a 136-node Mumbai subgraph - eleven minutes
    across the register. The copies share no node and no edge, so the answer should be identical
    to the honest loop. This compares them at full float precision, not to a tolerance.
    """
    from varuna_flash.whatif import _local_network, _removed_series, _replicate

    network = _network()
    adjacency = build_adjacency(network)
    seeds = [_target(network)]
    candidates, reached = candidate_pipes(network, seeds, adjacency=adjacency, hops=5)
    sub, nmap, node_list, edge_list, _ = _local_network(network, reached, adjacency=adjacency)
    emap = {e: i for i, e in enumerate(edge_list)}
    local = [emap[e] for e in candidates]
    surface = _rain_on_the_street(network)[:, np.asarray(node_list)]
    seed_local = np.array([nmap[s] for s in seeds])

    base_beta = np.asarray(sub.beta, dtype=np.float64)
    betas = np.tile(base_beta, (len(local) + 1, 1))
    for c, edge in enumerate(local, start=1):
        betas[c, edge] = CLEANED_BETA

    kwargs = {"step_s": 300.0, "sync_s": 5.0, "cell_area_m2": 900.0, "tide_stage_m": None}
    batched = _removed_series(
        _replicate(sub, betas), np.tile(surface, (1, len(local) + 1)), **kwargs
    )
    at_end = batched[-1].reshape(len(local) + 1, sub.n_nodes)[:, seed_local].sum(axis=1)

    for c in range(len(local) + 1):
        alone = _removed_series(_replicate(sub, betas[c][None, :]), surface, **kwargs)
        assert alone[-1][seed_local].sum() == at_end[c], f"copy {c} drifted from its own run"


# --------------------------------------------------------- the operator crosses segments


def test_cleaning_a_pipe_above_the_target_moves_the_target() -> None:
    """The property ADR-0042 measured as absent on Flash-lite.

    On the emulator this difference is exactly zero for every pipe that is not the target's own
    segment. Here the pipes above the junction control how much water reaches it and how much
    head it has to push against, so cleaning one changes what the junction's inlets can take.
    """
    network = _network()
    result = attribute_pipes(
        network,
        _rain_on_the_street(network),
        target_nodes=[_target(network)],
        peak_step=11,
        target_label="T",
        depth_before_cm=25.0,
        floor_cm=0.0,
    )
    assert result.reason is None, result.reason
    moved = {row["pipe_id"]: row["depth_explained_cm"] for row in result.rows}
    assert moved, "no candidate moved the target at all - the operator is still element-wise"
    # The pipe that feeds the junction is the one that moves it, and it moves it the *wrong*
    # way: the target is already surcharging, so a clear pipe above delivers more water than the
    # cleaning takes off. A ranking of reductions alone would have dropped exactly this pipe,
    # which is why `attribute_pipes` ranks by magnitude and keeps the sign.
    assert moved["E-A4-T"] < 0
    assert abs(moved["E-A4-T"]) == max(abs(v) for v in moved.values())
    # And the effect decays with hop distance rather than being an artefact of the cut: five
    # hops up, the same cleaning does nothing the solver can resolve.
    assert abs(moved.get("E-A0-A1", 0.0)) < abs(moved["E-A4-T"]) / 100.0


def test_the_branch_a_pipe_is_on_decides_whether_it_matters() -> None:
    """Cleaning a pipe five hops up a *dead* branch cannot move a target the branch does not feed.

    The two branches in the fixture are symmetric, so this is checked by breaking the symmetry:
    branch B is given no street water at all, which leaves its pipes carrying nothing. Cleaning
    one of them is then a change to a dry pipe, and the target must not notice. Branch A, which
    does carry water, must.
    """
    network = _network()
    surface = _rain_on_the_street(network)
    dry = [network.node_ids.index(n) for n in _CHAIN_B]
    surface[:, dry] = 0.0

    result = attribute_pipes(
        network,
        surface,
        target_nodes=[_target(network)],
        peak_step=11,
        target_label="T",
        depth_before_cm=25.0,
        floor_cm=0.0,
    )
    scored = {row["pipe_id"]: row["depth_explained_cm"] for row in result.rows}
    # Every pipe of the dry branch is either absent from the ranking or scores exactly nothing.
    for name in ("E-B0-B1", "E-B1-B2", "E-B2-B3", "E-B3-B4", "E-B4-T"):
        assert scored.get(name, 0.0) == 0.0, f"{name} moved a target it delivers no water to"
    assert scored.get("E-A4-T", 0.0) != 0.0, (
        "the wet branch moved nothing either - the test network is not exercising the pipes"
    )


# ------------------------------------------------------------------------- refusals and shape


def test_a_junction_whose_pipes_explain_nothing_is_refused_with_its_measurement() -> None:
    """A floor of 1 m of street is unreachable here, so the refusal must carry the number.

    ADR-0042's objection to a ranking of zeros stands whatever the operator is: a row reading
    0.00 cm claims the pipe was evaluated *and ranked*. The refusal names how many pipes were
    tried and what the best of them managed, so the reader can tell "nothing matters here" from
    "nobody looked".
    """
    network = _network()
    result = attribute_pipes(
        network,
        _rain_on_the_street(network),
        target_nodes=[_target(network)],
        peak_step=11,
        target_label="T",
        depth_before_cm=25.0,
        floor_cm=100.0,
    )
    assert result.rows == ()
    assert result.combined is None
    assert result.reason is not None
    assert "10 pipes within 5 upstream hops" in result.reason
    assert "100.00 cm" in result.reason


def test_a_junction_with_no_drain_node_says_so_rather_than_ranking_nothing() -> None:
    network = _network()
    result = attribute_pipes(
        network,
        _rain_on_the_street(network),
        target_nodes=[],
        peak_step=0,
        target_label="nowhere",
    )
    assert result.rows == ()
    assert result.reason is not None
    assert "No drain node sits inside this junction" in result.reason
    assert result.n_candidates == 0


def test_the_ranking_is_deterministic() -> None:
    """Rule 8: two bakes of the same inputs produce byte-identical products."""
    network = _network()
    surface = _rain_on_the_street(network)
    runs = [
        attribute_pipes(
            network,
            surface,
            target_nodes=[_target(network)],
            peak_step=11,
            target_label="T",
            depth_before_cm=25.0,
            floor_cm=0.0,
        )
        for _ in range(2)
    ]
    assert runs[0].rows == runs[1].rows
    assert runs[0].combined == runs[1].combined


def test_the_floor_is_the_one_the_module_publishes() -> None:
    """The default must be the documented constant, not a number typed into the signature."""
    network = _network()
    result = attribute_pipes(
        network,
        _rain_on_the_street(network),
        target_nodes=[_target(network)],
        peak_step=11,
        target_label="T",
        depth_before_cm=25.0,
    )
    if result.reason is not None:
        assert f"{ATTRIBUTION_FLOOR_CM:.2f} cm" in result.reason
    else:
        assert all(abs(row["depth_explained_cm"]) >= ATTRIBUTION_FLOOR_CM for row in result.rows)


@pytest.mark.parametrize("hops", [0, 1])
def test_no_candidates_within_the_walk_is_its_own_refusal(hops: int) -> None:
    network = _network()
    result = attribute_pipes(
        network,
        _rain_on_the_street(network),
        target_nodes=[network.node_ids.index("A0")],
        peak_step=11,
        target_label="A0",
        hops=hops,
    )
    assert result.rows == ()
    assert result.reason is not None
    assert "upstream hops" in result.reason
