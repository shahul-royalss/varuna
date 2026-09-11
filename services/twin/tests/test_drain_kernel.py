"""The compiled drain kernel must be the NumPy step, exactly (task P4.6).

`drain1d.step` is the readable statement of CLAUDE.md 11.4 and Appendix A; `drain_kernel` is the
same arithmetic fused into three passes so a three-hour city run fits its budget. A fused kernel is
only worth having if it is the *same* solver, so these tests run both paths over the same forcing
and assert the heads, the flows and every reported volume agree - on a network that exercises the
three reductions the step applies in order: flap gates, the stability limiter and the supply check.
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest

# The same linear network the rest of the drain tests use, with the knobs this file needs.
from tests.test_drain1d import _init_state, _simple_network  # type: ignore[import-not-found]
from varuna_twin.drain1d import (
    DrainNetwork,
    DrainState,
    prepare,
    simulate,
)

TOLERANCE_M = 1e-9
"""Heads agree to a nanometre. The two paths do the same float operations in the same order, so
the only difference should be whether an intermediate stayed in a register."""


def _both_paths(network: DrainNetwork, **kwargs: object) -> tuple[DrainState, DrainState, object, object]:
    """Run `simulate` twice over the same inputs: NumPy, then the kernel."""
    numpy_state = _init_state(network)
    kernel_state = _init_state(network)
    numpy_solver = prepare(network)
    kernel_solver = prepare(network)

    numpy_report = simulate(numpy_solver, numpy_state, compiled=False, **kwargs)  # type: ignore[arg-type]
    kernel_report = simulate(kernel_solver, kernel_state, compiled=True, **kwargs)  # type: ignore[arg-type]
    return numpy_state, kernel_state, numpy_report, kernel_report


def _assert_same(numpy_state: DrainState, kernel_state: DrainState, numpy_report, kernel_report) -> None:
    np.testing.assert_allclose(kernel_state.head, numpy_state.head, atol=TOLERANCE_M, rtol=0)
    np.testing.assert_allclose(kernel_state.flow, numpy_state.flow, atol=TOLERANCE_M, rtol=0)
    for field in ("inlet_m3", "surcharge_m3", "sink_m3", "boundary_m3", "stored_end_m3"):
        assert getattr(kernel_report, field) == pytest.approx(
            getattr(numpy_report, field), abs=1e-9
        ), field
    assert kernel_report.limited_edges == numpy_report.limited_edges
    assert kernel_report.n_steps == numpy_report.n_steps


def test_kernel_matches_numpy_on_a_free_draining_network() -> None:
    network = _simple_network(n_nodes=6)
    inlet = np.zeros(network.n_nodes)
    inlet[0] = 0.05  # 50 l/s into the head of the line
    _assert_same(*_both_paths(network, duration_s=60.0, dt_s=1.0, q_inlet=inlet))


def test_kernel_matches_numpy_with_a_tide_locked_outfall() -> None:
    """The demo's reversed-flow case: the sea above the trunk invert pushes water back inland."""
    network = _simple_network(n_nodes=6, has_tidal_outfall=True)
    inlet = np.zeros(network.n_nodes)
    inlet[0] = 0.02
    # Well above the outfall invert, so the last edge runs backwards.
    stage = float(network.z_invert[-1]) + 1.2
    _assert_same(
        *_both_paths(network, duration_s=90.0, dt_s=1.0, q_inlet=inlet, tide_stage_m=stage)
    )


def test_kernel_matches_numpy_with_a_flap_gate() -> None:
    network = _simple_network(n_nodes=5, has_tidal_outfall=True, flap_gate=True)
    inlet = np.zeros(network.n_nodes)
    inlet[0] = 0.02
    stage = float(network.z_invert[-1]) + 1.2
    _assert_same(
        *_both_paths(network, duration_s=60.0, dt_s=1.0, q_inlet=inlet, tide_stage_m=stage)
    )


def test_kernel_matches_numpy_when_a_node_runs_out_of_water() -> None:
    """The supply check: a node asked to surcharge more than it holds scales every outflow."""
    network = _simple_network(n_nodes=5)
    surcharge = np.zeros(network.n_nodes)
    # Far more than a 1 m2 manhole with a few centimetres in it can give.
    surcharge[1] = 5.0
    inlet = np.zeros(network.n_nodes)
    inlet[0] = 0.01
    _assert_same(
        *_both_paths(network, duration_s=30.0, dt_s=1.0, q_inlet=inlet, q_surcharge=surcharge)
    )


def test_kernel_matches_numpy_when_nodes_pressurise() -> None:
    """Above the crown the Preissmann slot takes over, on both the storage curve and dH/dt."""
    network = _simple_network(n_nodes=5, beta=0.6)  # blocked, so it backs up
    inlet = np.zeros(network.n_nodes)
    inlet[0] = 0.4  # enough to fill and pressurise
    _assert_same(*_both_paths(network, duration_s=120.0, dt_s=1.0, q_inlet=inlet))


def test_kernel_conserves_what_the_numpy_path_conserves() -> None:
    """A closed network gains exactly what is put into it (CLAUDE.md 11.4's conservation test)."""
    network = _simple_network(n_nodes=5)
    # No outfall: make the last node an ordinary manhole so nothing can leave.
    boundary = np.zeros(network.n_nodes, dtype=np.int8)
    closed = replace(network, boundary=boundary)

    inlet = np.zeros(closed.n_nodes)
    inlet[0] = 0.01
    state = _init_state(closed)
    solver = prepare(closed)
    report = simulate(solver, state, duration_s=120.0, dt_s=1.0, q_inlet=inlet, compiled=True)

    gained = report.stored_end_m3 - report.stored_start_m3
    assert gained == pytest.approx(report.inlet_m3, rel=1e-6)
    assert report.boundary_m3 == pytest.approx(0.0, abs=1e-12)


def test_the_compiled_path_is_the_default() -> None:
    """`simulate` compiles unless asked not to: the budget is the reason the kernel exists."""
    network = _simple_network(n_nodes=4)
    state = _init_state(network)
    solver = prepare(network)
    # Would raise if the default dispatched to a path that did not exist.
    report = simulate(solver, state, duration_s=5.0, dt_s=1.0)
    assert report.n_steps == 5
