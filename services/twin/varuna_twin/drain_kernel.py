"""The 1D drain step, compiled (CLAUDE.md 11.4, task P4.6).

**Why this file exists.** A three-hour Mumbai cycle was ~115 s against an 8 s budget, and the cost
was not the 2D surface solver - that is already Numba - but `drain1d.step`, called 10,800 times at
a 1 s inner step over 49,770 edges and 50,110 nodes. Vectorised NumPy does that correctly and
slowly: every `np.where`, `np.minimum` and `np.bincount` in the step allocates a fresh array, so
one step walks 50k-element buffers about thirty times and the whole run moves tens of gigabytes
through memory to compute a few hundred megaflops.

This kernel fuses the same arithmetic into three passes - edges, nodes, edges - with no temporaries
at all. The algebra is unchanged, line for line.

**`drain1d.step` stays, and is the specification.** It is the readable statement of CLAUDE.md 11.4
and Appendix A, and `test_kernel_matches_numpy` asserts the two agree to floating-point tolerance
on a network with flap gates, tidal outfalls, pressurised nodes and a supply-limited node. If they
ever disagree, the NumPy one is right and this one has a bug.

**Determinism (rule 8).** Single-threaded on purpose. The node accumulations are scatter-adds -
several edges write the same node - and `prange` over edges would race on them. The parallel
version would need per-thread buffers and a reduction, whose float addition order varies with the
thread count, and `make bake` must be byte-identical across machines.
"""

from __future__ import annotations

import numpy as np
from numba import njit

__all__ = ["step_kernel"]

# Kept in step with `drain1d`; imported there rather than duplicated, but the kernel needs them as
# compile-time constants, so they are passed in as arguments instead of closed over. A literal here
# would go stale silently the day `drain1d` changed one.


@njit(fastmath=True, cache=True)
def step_kernel(
    # --- topology -------------------------------------------------------------------------
    from_node: np.ndarray,
    to_node: np.ndarray,
    length: np.ndarray,
    # --- per-edge constants ---------------------------------------------------------------
    conveyance: np.ndarray,
    q_cap: np.ndarray,
    inv_diameter: np.ndarray,
    # --- per-node constants ---------------------------------------------------------------
    z_invert: np.ndarray,
    storage_base: np.ndarray,
    slot_area: np.ndarray,
    crown_depth: np.ndarray,
    fixed_head: np.ndarray,
    flap_gate: np.ndarray,
    boundary: np.ndarray,
    # --- state ----------------------------------------------------------------------------
    head: np.ndarray,
    flow_out: np.ndarray,
    # --- forcing --------------------------------------------------------------------------
    inlet: np.ndarray,
    surch: np.ndarray,
    draw: np.ndarray,
    dt_s: float,
    tide_stage: np.ndarray,
    have_tide: bool,
    # --- constants ------------------------------------------------------------------------
    min_head_gradient_m: float,
    min_flow_depth_m: float,
    boundary_free: int,
    boundary_tidal: int,
    # --- scratch (allocated once by the caller, reused every step) ------------------------
    q: np.ndarray,
    q_out: np.ndarray,
    scale: np.ndarray,
    net_edge: np.ndarray,
    applied_surch: np.ndarray,
    applied_draw: np.ndarray,
) -> np.ndarray:
    """One explicit step, in place on ``head`` and ``flow_out``.

    Returns the six report scalars as an array: inlet, surcharge, sink and boundary volumes in
    m3, the stored volume in m3, and the count of edges the stability limiter caught.
    """
    n_nodes = head.shape[0]
    n_edges = from_node.shape[0]

    # ---- pin boundaries ------------------------------------------------------------------
    for j in range(n_nodes):
        if boundary[j] == boundary_free:
            head[j] = z_invert[j]
        elif boundary[j] == boundary_tidal:
            if have_tide:
                stage = tide_stage[j]
                head[j] = stage if stage > z_invert[j] else z_invert[j]
            else:
                head[j] = z_invert[j]

    # ---- pass 1: the constitutive law, the flap gates and the stability limiter -----------
    limited = 0
    for j in range(n_nodes):
        q_out[j] = 0.0

    for e in range(n_edges):
        a = from_node[e]
        b = to_node[e]
        dh = head[a] - head[b]
        forward = dh >= 0.0

        # Fill fraction at whichever end is currently upstream.
        if forward:
            fill_depth = head[a] - z_invert[a]
        else:
            fill_depth = head[b] - z_invert[b]

        abs_dh = dh if dh >= 0.0 else -dh
        if abs_dh < min_head_gradient_m or fill_depth < min_flow_depth_m:
            q[e] = 0.0
            continue

        fill = fill_depth * inv_diameter[e]
        if fill < 0.0:
            fill = 0.0
        elif fill > 1.0:
            fill = 1.0

        run = length[e]
        if run < min_head_gradient_m:
            run = min_head_gradient_m
        friction = conveyance[e] * fill * np.sqrt(abs_dh / run)
        magnitude = friction if friction < q_cap[e] else q_cap[e]
        value = magnitude if forward else -magnitude

        # Flap gates, at outfalls only: no flow *into* the network from a gated node.
        if flap_gate[b] and fixed_head[b] and value < 0.0:
            value = 0.0
        if flap_gate[a] and fixed_head[a] and value > 0.0:
            value = 0.0

        # Stability limiter: cap at the exchange that would just level the two heads.
        inv_a = 0.0
        if not fixed_head[a]:
            depth_a = head[a] - z_invert[a]
            area_a = storage_base[a] + (slot_area[a] if depth_a > crown_depth[a] else 0.0)
            inv_a = 1.0 / area_a
        inv_b = 0.0
        if not fixed_head[b]:
            depth_b = head[b] - z_invert[b]
            area_b = storage_base[b] + (slot_area[b] if depth_b > crown_depth[b] else 0.0)
            inv_b = 1.0 / area_b
        share = inv_a + inv_b
        if share > 0.0:
            q_limit = abs_dh / (dt_s * share)
            magnitude_now = value if value >= 0.0 else -value
            if magnitude_now > q_limit:
                limited += 1
                value = q_limit if value >= 0.0 else -q_limit

        q[e] = value
        # Accumulate what each node gives away, for the supply check.
        if value > 0.0:
            q_out[a] += value
        elif value < 0.0:
            q_out[b] += -value

    # ---- pass 2: the supply check ---------------------------------------------------------
    for j in range(n_nodes):
        if fixed_head[j]:
            scale[j] = 1.0  # an outfall is never short of water
            continue
        demand = dt_s * (q_out[j] + surch[j] + draw[j])
        depth = head[j] - z_invert[j]
        if depth < 0.0:
            depth = 0.0
        crown = crown_depth[j]
        below = depth if depth < crown else crown
        above = depth - crown
        if above < 0.0:
            above = 0.0
        supply = storage_base[j] * below + (storage_base[j] + slot_area[j]) * above
        if demand > supply and demand > 0.0:
            scale[j] = supply / demand
        else:
            scale[j] = 1.0

    # ---- pass 3: scale the flows, accumulate the node balance, integrate ------------------
    for j in range(n_nodes):
        net_edge[j] = 0.0

    for e in range(n_edges):
        value = q[e]
        if value == 0.0:
            continue
        # Scaled by whichever end is *giving* the water.
        value *= scale[from_node[e]] if value >= 0.0 else scale[to_node[e]]
        q[e] = value
        net_edge[to_node[e]] += value
        net_edge[from_node[e]] -= value

    inlet_m3 = 0.0
    surcharge_m3 = 0.0
    sink_m3 = 0.0
    boundary_m3 = 0.0
    stored_m3 = 0.0

    for j in range(n_nodes):
        applied_surch[j] = surch[j] * scale[j]
        applied_draw[j] = draw[j] * scale[j]
        sink_m3 += dt_s * applied_draw[j]

        if fixed_head[j]:
            boundary_m3 += dt_s * net_edge[j]
            continue

        inlet_m3 += dt_s * inlet[j]
        surcharge_m3 += dt_s * applied_surch[j]

        # Volume now, on the piecewise-linear storage curve.
        depth = head[j] - z_invert[j]
        if depth < 0.0:
            depth = 0.0
        crown = crown_depth[j]
        below = depth if depth < crown else crown
        above = depth - crown
        if above < 0.0:
            above = 0.0
        volume = storage_base[j] * below + (storage_base[j] + slot_area[j]) * above

        volume += dt_s * (net_edge[j] + inlet[j] - applied_surch[j] - applied_draw[j])
        if volume < 0.0:
            volume = 0.0

        # ... and back to a head.
        v_crown = storage_base[j] * crown
        if volume <= v_crown:
            new_depth = volume / storage_base[j]
        else:
            new_depth = crown + (volume - v_crown) / (storage_base[j] + slot_area[j])
        head[j] = z_invert[j] + new_depth

        # The stored volume is audited *after* the update, as the NumPy step does.
        depth2 = head[j] - z_invert[j]
        if depth2 < 0.0:
            depth2 = 0.0
        below2 = depth2 if depth2 < crown else crown
        above2 = depth2 - crown
        if above2 < 0.0:
            above2 = 0.0
        stored_m3 += storage_base[j] * below2 + (storage_base[j] + slot_area[j]) * above2

    # ---- pin boundaries again, and publish the flows --------------------------------------
    for j in range(n_nodes):
        if boundary[j] == boundary_free:
            head[j] = z_invert[j]
        elif boundary[j] == boundary_tidal:
            if have_tide:
                stage = tide_stage[j]
                head[j] = stage if stage > z_invert[j] else z_invert[j]
            else:
                head[j] = z_invert[j]

    for e in range(n_edges):
        flow_out[e] = q[e]

    report = np.empty(6, dtype=np.float64)
    report[0] = inlet_m3
    report[1] = surcharge_m3
    report[2] = sink_m3
    report[3] = boundary_m3
    report[4] = stored_m3
    report[5] = float(limited)
    return report
