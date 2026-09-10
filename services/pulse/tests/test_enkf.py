"""Can Pulse find a blocked pipe it was not told about? (CLAUDE.md 11.6, task P7.3)

The spec's acceptance test: on a synthetic truth with two blocked pipes and twenty observations,
the posterior mean must rank those two in the top five and cut their spread by at least 40 %.
That is the whole claim of the engine - the city reveals its own drains - so it is tested against
a truth the filter never sees.
"""

from __future__ import annotations

import numpy as np
import pytest
from varuna_pulse.enkf import (
    assimilate,
    capacity_operator,
    hop_distances,
    logit,
    sigmoid,
)

N_EDGES = 200
BLOCKED = (37, 123)
"""The two pipes the synthetic city has actually blocked. The filter is never told."""


def _network() -> tuple[np.ndarray, np.ndarray]:
    """A chain of 200 pipes: edge k joins node k to node k+1.

    Long enough that three hops is a genuine neighbourhood rather than the whole network - on a
    short chain every edge is within reach of some observation, localisation cannot isolate
    anything, and a 50-member ensemble's spurious correlations move the lot.
    """
    return np.arange(N_EDGES, dtype=np.int64), np.arange(1, N_EDGES + 1, dtype=np.int64)


def _truth() -> np.ndarray:
    beta = np.full(N_EDGES, 0.20)
    for edge in BLOCKED:
        beta[edge] = 0.85
    return beta


def _setup(n_obs: int = 20, seed: int = 7):
    """Twenty observations, most on the blocked pipes and the rest spread over clean ones."""
    rng = np.random.default_rng(seed)
    from_node, to_node = _network()

    # Observations sit on edges: ten on each blocked pipe's immediate neighbourhood, the rest
    # scattered, which is what a traffic feed actually gives you - lots of normal streets and a
    # few that stopped.
    # Eight anomalies on each blocked junction and four scattered over clean pipes. A flooded
    # junction does not produce one observation, it produces every vehicle that stopped there.
    watched = list(BLOCKED) * 8 + list(rng.choice(N_EDGES, size=n_obs - 16, replace=False))
    edge_of_observation = np.array(watched[:n_obs], dtype=np.int64)

    # A junction whose pipe is overwhelmed: 30,000 m2 draining through one 0.35 m3/s pipe under
    # 80 mm/h, ponding over about 1,500 m2 - a junction some 40 m across. Blockage then moves the
    # depth by about 42 cm across its range, against an 8 cm observation error: one anomaly still
    # proves nothing, and eight of them are worth listening to. That ratio is the point of the
    # test - a prior tighter than the observations cannot be sharpened by them, however many
    # arrive, and the filter should not pretend otherwise.
    contributing = np.full(n_obs, 30_000.0)
    rain = np.full(n_obs, 80.0)
    ponding = np.full(n_obs, 1_500.0)
    q_full = np.full(n_obs, 0.35)

    operator = capacity_operator(
        edge_of_observation, contributing, rain,
        ponding_area_m2=ponding, q_full_m3s=q_full,
    )

    # The measurements the synthetic city produces, plus observation noise.
    truth_ensemble = _truth()[None, :]
    y = np.asarray(operator(truth_ensemble))[0]
    sd = np.full(n_obs, 8.0)
    y = y + rng.normal(size=n_obs) * sd

    hops = hop_distances(from_node, to_node, edge_of_observation)
    return operator, y, sd, hops, edge_of_observation


def test_the_posterior_finds_the_blocked_pipes(
) -> None:
    operator, y, sd, hops, _edges = _setup()

    prior_mean = np.full(N_EDGES, 0.20)
    prior_sd = np.full(N_EDGES, 0.12)

    result = assimilate(prior_mean, prior_sd, y, sd, operator, hops)

    ranked = np.argsort(-result.beta_mean)[:5]
    for edge in BLOCKED:
        assert edge in ranked, (
            f"pipe {edge} is blocked at 0.85 and did not reach the top five; "
            f"posterior ranks {ranked.tolist()}"
        )

    # The spread must fall where the observations were informative.
    reduction = 1.0 - result.beta_sd[list(BLOCKED)] / prior_sd[list(BLOCKED)]
    assert np.all(reduction >= 0.40), (
        f"observations must cut the blocked pipes' spread by 40 %; got {reduction}"
    )


def test_no_observation_moves_a_pipe_beyond_the_localisation_radius() -> None:
    """CLAUDE.md 11.6: an observation may reach three hydraulic hops, and no further."""
    operator, y, sd, hops, edges = _setup()
    prior_mean = np.full(N_EDGES, 0.20)
    prior_sd = np.full(N_EDGES, 0.12)

    result = assimilate(prior_mean, prior_sd, y, sd, operator, hops)

    reachable = (hops >= 0).any(axis=0)
    moved = np.abs(result.beta_mean - prior_mean) > 1e-4
    assert not np.any(moved & ~reachable), (
        "a pipe more than three hops from every observation was updated"
    )
    assert np.any(moved & reachable), "the filter did not update anything at all"
    assert set(edges.tolist()).issubset(set(np.flatnonzero(reachable).tolist()))


def test_an_empty_batch_leaves_the_posterior_exactly_as_it_was() -> None:
    """A quiet cycle must not perturb what earlier cycles learned."""
    prior_mean = np.linspace(0.1, 0.6, N_EDGES)
    prior_sd = np.full(N_EDGES, 0.1)
    result = assimilate(
        prior_mean,
        prior_sd,
        np.zeros(0),
        np.zeros(0),
        capacity_operator(
            np.zeros(0, dtype=np.int64), np.zeros(0), np.zeros(0),
            ponding_area_m2=np.zeros(0), q_full_m3s=np.zeros(0),
        ),
        np.zeros((0, N_EDGES), dtype=np.int32),
    )
    assert np.array_equal(result.beta_mean, prior_mean)
    assert np.array_equal(result.beta_sd, prior_sd)


def test_the_posterior_stays_a_blockage() -> None:
    """logit/sigmoid round trip: no member may leave [0, 1], however hard the update pushes."""
    operator, y, sd, hops, _edges = _setup()
    # A prior that is nearly certain the pipes are clean, against observations screaming water:
    # the largest innovation the filter can be handed.
    prior_mean = np.full(N_EDGES, 0.02)
    prior_sd = np.full(N_EDGES, 0.30)

    result = assimilate(prior_mean, prior_sd, y * 4.0, sd, operator, hops)

    assert np.all(result.beta_mean >= 0.0) and np.all(result.beta_mean <= 1.0)
    assert np.all(np.isfinite(result.beta_sd))


def test_it_is_deterministic_for_a_seed() -> None:
    """Rule 8: two runs on the same inputs give the same posterior, byte for byte."""
    operator, y, sd, hops, _edges = _setup()
    prior_mean = np.full(N_EDGES, 0.20)
    prior_sd = np.full(N_EDGES, 0.12)

    first = assimilate(prior_mean, prior_sd, y, sd, operator, hops, seed=2019)
    second = assimilate(prior_mean, prior_sd, y, sd, operator, hops, seed=2019)
    assert np.array_equal(first.beta_mean, second.beta_mean)

    other = assimilate(prior_mean, prior_sd, y, sd, operator, hops, seed=7)
    assert not np.array_equal(first.beta_mean, other.beta_mean), (
        "a different seed must draw a different ensemble, or the seed is not being used"
    )


def test_logit_and_sigmoid_invert_each_other() -> None:
    values = np.array([0.001, 0.05, 0.2, 0.5, 0.8, 0.999])
    assert sigmoid(logit(values)) == pytest.approx(values, abs=1e-6)
