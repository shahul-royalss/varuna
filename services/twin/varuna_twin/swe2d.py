"""The 2D surface: local-inertial shallow water on the conditioned city grid
(CLAUDE.md 11.3, Appendix A).

This is the engine that turns a rain field into water standing on streets. It is the
local-inertial simplification of the shallow-water equations (Bates, Horritt and Fewtrell,
2010): the advective term is dropped, so a face carries a momentum that remembers its previous
value, is pushed by the water-surface slope and is held back by friction. That is enough for
urban pluvial flooding, where flow is slow and thin, and it is stable at a much larger step
than a full dynamic-wave scheme.

**What the caller drives.** :func:`step_surface` takes the three source terms as per-cell
rasters in m/s - effective rain, inlet capture into the pipes and surcharge back onto the
street - because ``varuna_twin.coupling`` owns those numbers (CLAUDE.md 11.5) and this module
must not reach across to compute them. :func:`run_surface` sub-steps to a target time under the
CFL rule and returns the state plus the volume audit, so nothing downstream re-implements the
sub-stepping.

**Conventions, from** ``varuna_twin.types``. ``qx`` is the flux through the **eastern** face of
a cell, positive eastward; ``qy`` is the flux through the **southern** face, positive southward
(toward increasing row). Both therefore point toward increasing index, and the divergence in
:func:`_update_depth` reads the western face as ``qx[i, j - 1]`` and the northern face as
``qy[i - 1, j]``. Row 0 is the northernmost row, matching the GeoTIFFs.

**Boundaries.**

* ``terrain.blocked`` cells are buildings: no flux crosses their faces and they hold no water.
  Rain that falls on one is *not* applied and *not* counted as inflow - a roof is outside this
  kernel's water budget. Routing roof runoff to the adjacent street is a pilot upgrade; the run
  says so in :attr:`SurfaceRun.notes` whenever it mattered (rule 6).
* Domain edges are closed. The eastern face of the last column and the southern face of the
  last row are held at zero, and the western face of column 0 and the northern face of row 0
  are not represented at all, so no water can cross them.
* Cells the caller marks in ``sea_mask`` are the sea/creek boundary. Their level is imposed,
  ``h = max(stage - z, 0)``: the sea floods them when the stage is above their ground, and they
  drain freely to the sea when it is below. Water that crosses that boundary is counted as
  inflow or outflow, never lost - which is what makes the mass-balance audit meaningful at a
  coastal AOI.

**Positivity and conservation.** Volume is conserved to floating-point roundoff by construction
rather than by luck. Before the depth update, each cell's outgoing faces are scaled so the
water they carry away in one step cannot exceed what the cell holds (:func:`_update_depth`,
pass A and B). Each face has exactly one donor cell, so scaling a donor's outflow scales the
matching inflow of its neighbour by the same factor and nothing is created. Without that
limiter a cell would go negative and the clamp back to zero would invent water - the classic
way a flood model quietly gains mass. :attr:`StepTally.volume_created_m3` reports whatever the
clamp still had to invent; it should be exactly zero, and it is reported rather than swallowed
so that a future change to the scheme is caught by the audit instead of hidden by it.

**Determinism** (rule 8). ``prange`` runs over rows and every row writes only its own cells, so
the result does not depend on how many threads ran. Nothing is reduced across threads: the
per-step volume tallies are accumulated into one float per row inside the parallel loop and
summed afterwards, because a parallel float reduction would sum in thread-arrival order and two
runs of ``make bake`` would then differ in the last bits.
"""

from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter
from typing import TYPE_CHECKING

import numpy as np
import structlog
from numba import njit, prange

from varuna_twin.types import GRAVITY, MassBalance, SurfaceState, TerrainGrid

if TYPE_CHECKING:  # pragma: no cover - keeps numpy off the runtime type surface
    from collections.abc import Callable

    from numpy.typing import NDArray

log = structlog.get_logger("varuna.twin.swe2d")

__all__ = [
    "CFL_ALPHA",
    "DRY_DEPTH_M",
    "DT_MAX_S",
    "DT_MIN_S",
    "FRICTION_DEPTH_EXPONENT",
    "KernelTerrain",
    "MassBalanceError",
    "StepTally",
    "SurfaceRun",
    "cfl_dt",
    "dry_state",
    "prepare_terrain",
    "run_surface",
    "step_surface",
]

# ------------------------------------------------------------------ numbers from CLAUDE.md
DRY_DEPTH_M = 0.001
"""Flow depth below which a face carries nothing, in metres.

CLAUDE.md 11.3: ``q = 0 when h_f < 1 mm``. It is not only a speed trick - the friction term
divides by ``h_f`` raised to a power above three, so a film a few microns thick would otherwise
produce a denominator large enough to lose all precision in the numerator."""

CFL_ALPHA = 0.7
"""The ``alpha`` of ``dt = alpha * dx / sqrt(g * h_max)`` (CLAUDE.md 11.3, Appendix A)."""

DT_MIN_S = 0.5
"""Lower clamp on the CFL step, in seconds (CLAUDE.md 11.3).

Clamping *up* to this value can in principle violate the CFL condition, so it is worth knowing
when it bites: at 30 m cells it needs ``h_max`` above 180 m, and at the 10 m cells the tests
use, above 40 m. Neither happens in a city, but a run that hits the clamp says so in
:attr:`SurfaceRun.notes` rather than failing quietly."""

DT_MAX_S = 10.0
"""Upper clamp on the CFL step, in seconds (CLAUDE.md 11.3). It binds while the grid is dry."""

FRICTION_DEPTH_EXPONENT = 10.0 / 3.0
"""The exponent of ``h_f`` in the friction denominator.

**Taken verbatim from CLAUDE.md 11.3 and Appendix A**, which both write
``1 + g*dt*n^2*abs(q)/h_f^(10/3)``. It is worth being explicit about what that costs, because
the published local-inertial scheme differs: Bates et al. (2010) write the momentum equation for
the unit-width discharge ``q``, whose friction slope term is ``g*n^2*q*abs(q)/h^(7/3)``, and the
semi-implicit form of *that* puts ``7/3`` in this denominator. ``10/3`` is the exponent of the
same term written for the *velocity* rather than the discharge. Using it with ``q`` in the
numerator makes friction stronger by a factor of ``1/h_f``: at a 5 cm street depth it is about
twenty times the published value, so water spreads more slowly and ponds closer to where it
fell. It cannot destabilise the scheme - the friction term sits in a denominator that is always
at least one - and it is the conservative direction for a flood forecast, but it is a real
departure from Bates et al. and the integrator should raise it as an ADR rather than let it
pass as an implementation detail. It is a module constant so that decision changes one line."""

MASS_BALANCE_EVERY = 100
"""Steps between mass-balance audits inside :func:`run_surface` (CLAUDE.md 11.3)."""

MASS_BALANCE_TOLERANCE = 1e-3
"""``|stored - (in - out)| / in`` budget: 0.1 % of inflow (CLAUDE.md 11.3, ``MassBalance``)."""

MASS_BALANCE_MIN_VOLUME_M3 = 1.0
"""Inflow below which the relative audit is meaningless and is skipped.

A design choice, not spec. One cubic metre is a thousandth of the water a single 30 m cell holds
at the 1 mm dry threshold times... no: it is simply small enough that no real cycle sits under
it (5 mm of rain over the Mumbai AOI is about 750 000 m3) and large enough that the first few
steps of a run, when inflow is a handful of litres, do not divide by nearly nothing."""


class MassBalanceError(RuntimeError):
    """Raised when a run loses or invents water beyond :data:`MASS_BALANCE_TOLERANCE`.

    CLAUDE.md 11.3 says the balance is *asserted*, and ``MassBalance``'s own docstring says a
    run that fails it is a bug rather than a warning: every depth the console shows is derived
    from this volume, so publishing a run that does not conserve it would be publishing a
    number that means nothing.
    """


# ============================================================================ kernel inputs
@dataclass(frozen=True, slots=True)
class KernelTerrain:
    """The terrain arrays in the layout the compiled kernels need.

    :class:`~varuna_twin.types.TerrainGrid` holds whatever dtype the city GeoTIFFs were written
    in - usually float32 - while the kernels are compiled for C-contiguous float64. Converting
    on every call would copy a few megabytes 2 000 times in a three-hour run, so the conversion
    is hoisted here and done once: :func:`prepare_terrain` builds this, the coupling holds it,
    and both entry points accept either.
    """

    z: NDArray[np.float64]
    manning_n: NDArray[np.float64]
    blocked: NDArray[np.bool_]
    res_m: float
    cell_area_m2: float

    @property
    def shape(self) -> tuple[int, int]:
        return (int(self.z.shape[0]), int(self.z.shape[1]))


def prepare_terrain(terrain: TerrainGrid | KernelTerrain) -> KernelTerrain:
    """Convert a :class:`~varuna_twin.types.TerrainGrid` into kernel-ready arrays, once."""
    if isinstance(terrain, KernelTerrain):
        return terrain
    return KernelTerrain(
        z=_f64(terrain.z, "terrain.z"),
        manning_n=_f64(terrain.manning_n, "terrain.manning_n"),
        blocked=np.ascontiguousarray(terrain.blocked, dtype=np.bool_),
        res_m=float(terrain.res_m),
        cell_area_m2=float(terrain.cell_area_m2),
    )


def dry_state(terrain: TerrainGrid | KernelTerrain) -> SurfaceState:
    """A dry surface on this grid: zero depth, zero flux, the dtype the kernels expect."""
    shape = prepare_terrain(terrain).shape
    return SurfaceState(
        h=np.zeros(shape, dtype=np.float64),
        qx=np.zeros(shape, dtype=np.float64),
        qy=np.zeros(shape, dtype=np.float64),
    )


def _f64(array: NDArray[np.floating], name: str) -> NDArray[np.float64]:
    """A C-contiguous float64 view, copying only when the input is not already one."""
    out = np.ascontiguousarray(array, dtype=np.float64)
    if not np.all(np.isfinite(out)):
        raise ValueError(f"{name} contains non-finite values; the solver cannot use it")
    return out


def _source(
    value: NDArray[np.floating] | float | None,
    shape: tuple[int, int],
    name: str,
) -> NDArray[np.float64]:
    """A source-term raster in m/s, from an array, a uniform scalar or nothing.

    Scalars are materialised into a full raster because the kernel takes arrays; that allocation
    is why the hot path (the coupling, which always has real per-cell fluxes) should pass its own
    buffers rather than relying on this convenience.
    """
    if value is None:
        return np.zeros(shape, dtype=np.float64)
    if np.isscalar(value):
        return np.full(shape, float(value), dtype=np.float64)  # type: ignore[arg-type]
    out = _f64(np.asarray(value), name)
    if out.shape != shape:
        raise ValueError(f"{name} has shape {out.shape}, expected {shape}")
    return out


# ============================================================================ step results
@dataclass(frozen=True, slots=True)
class StepTally:
    """What one sub-step moved, in cubic metres, so the run can be audited.

    Every field is a volume over the step, not a rate. ``volume_inlet_m3`` is what the pipes
    *actually* took, which is not always what the coupling asked for: a cell cannot give away
    more water than it holds, so the capture is limited and the limited figure is reported here
    for the coupling's own balance (CLAUDE.md 11.5).
    """

    dt_s: float
    volume_rain_m3: float
    volume_surcharge_m3: float
    volume_inlet_m3: float
    volume_tide_in_m3: float
    volume_tide_out_m3: float
    volume_created_m3: float
    """Water the positivity clamp had to invent. Zero unless the scheme has a bug."""

    @property
    def volume_in_m3(self) -> float:
        return (
            self.volume_rain_m3
            + self.volume_surcharge_m3
            + self.volume_tide_in_m3
            + self.volume_created_m3
        )

    @property
    def volume_out_m3(self) -> float:
        return self.volume_inlet_m3 + self.volume_tide_out_m3


@dataclass(frozen=True, slots=True)
class SurfaceRun:
    """One call to :func:`run_surface`: the state it reached and the volume audit.

    The integrator assembles :class:`~varuna_twin.types.MassBalance` for the whole Twin run,
    which also has to account for the water sitting in the pipes; :meth:`mass_balance` is the
    surface-only view of the same audit, and the test suite uses it.
    """

    state: SurfaceState
    volume_initial_m3: float
    volume_stored_m3: float
    volume_rain_m3: float
    volume_surcharge_m3: float
    volume_inlet_m3: float
    volume_tide_in_m3: float
    volume_tide_out_m3: float
    volume_created_m3: float
    n_steps: int
    dt_min_s: float
    dt_max_s: float
    elapsed_ms: int
    notes: tuple[str, ...] = ()

    @property
    def volume_in_m3(self) -> float:
        """Water that entered the surface during the run, plus what was already on it.

        The initial storage is counted as inflow because ``MassBalance`` compares a *stored*
        volume against ``in - out``, not a change in storage; water present at ``t0`` entered
        the domain before the run and has to appear on the same side of that comparison.
        """
        return (
            self.volume_initial_m3
            + self.volume_rain_m3
            + self.volume_surcharge_m3
            + self.volume_tide_in_m3
            + self.volume_created_m3
        )

    @property
    def volume_out_m3(self) -> float:
        return self.volume_inlet_m3 + self.volume_tide_out_m3

    @property
    def error_fraction(self) -> float:
        """``|stored - (in - out)| / in``; 0 when nothing has entered yet."""
        total_in = self.volume_in_m3
        if total_in <= 0.0:
            return 0.0
        residual = self.volume_stored_m3 - (total_in - self.volume_out_m3)
        return abs(residual) / total_in

    def mass_balance(self) -> MassBalance:
        """The surface half of the run's conservation audit."""
        return MassBalance(
            volume_in_m3=self.volume_in_m3,
            volume_out_m3=self.volume_out_m3,
            volume_stored_m3=self.volume_stored_m3,
            error_fraction=self.error_fraction,
        )


# ============================================================================ compiled core
@njit(parallel=True, fastmath=True, cache=True)
def _update_flux(
    h: NDArray[np.float64],
    z: NDArray[np.float64],
    manning_n: NDArray[np.float64],
    blocked: NDArray[np.bool_],
    qx: NDArray[np.float64],
    qy: NDArray[np.float64],
    dx: float,
    dt: float,
    gravity: float,
    dry_depth: float,
    friction_exponent: float,
) -> None:
    """Advance both face fluxes one step (CLAUDE.md 11.3, Appendix A), in place.

    ``q^{t+dt} = [q^t - g*h_f*dt*d(h+z)/dx] / [1 + g*dt*n^2*|q^t| / h_f^e]`` with
    ``h_f = max(h+z) - max(z)`` over the two cells sharing the face. The scalars are arguments
    rather than module globals on purpose: numba freezes a global into the compiled body and
    ``cache=True`` would then keep serving a stale kernel after the constant was edited.
    """
    n_rows, n_cols = h.shape

    # ---- eastern faces: qx[i, j] joins (i, j) and (i, j + 1), positive eastward
    for i in prange(n_rows):
        for j in range(n_cols - 1):
            if blocked[i, j] or blocked[i, j + 1]:
                qx[i, j] = 0.0
                continue
            wl_here = h[i, j] + z[i, j]
            wl_next = h[i, j + 1] + z[i, j + 1]
            wl_max = wl_here if wl_here > wl_next else wl_next
            z_max = z[i, j] if z[i, j] > z[i, j + 1] else z[i, j + 1]
            h_f = wl_max - z_max
            if h_f < dry_depth:
                qx[i, j] = 0.0
                continue
            q = qx[i, j]
            n_face = 0.5 * (manning_n[i, j] + manning_n[i, j + 1])
            numerator = q - gravity * h_f * dt * (wl_next - wl_here) / dx
            denominator = 1.0 + gravity * dt * n_face * n_face * abs(q) / h_f**friction_exponent
            qx[i, j] = numerator / denominator
        qx[i, n_cols - 1] = 0.0  # closed domain edge

    # ---- southern faces: qy[i, j] joins (i, j) and (i + 1, j), positive southward
    for i in prange(n_rows - 1):
        for j in range(n_cols):
            if blocked[i, j] or blocked[i + 1, j]:
                qy[i, j] = 0.0
                continue
            wl_here = h[i, j] + z[i, j]
            wl_next = h[i + 1, j] + z[i + 1, j]
            wl_max = wl_here if wl_here > wl_next else wl_next
            z_max = z[i, j] if z[i, j] > z[i + 1, j] else z[i + 1, j]
            h_f = wl_max - z_max
            if h_f < dry_depth:
                qy[i, j] = 0.0
                continue
            q = qy[i, j]
            n_face = 0.5 * (manning_n[i, j] + manning_n[i + 1, j])
            numerator = q - gravity * h_f * dt * (wl_next - wl_here) / dx
            denominator = 1.0 + gravity * dt * n_face * n_face * abs(q) / h_f**friction_exponent
            qy[i, j] = numerator / denominator

    for j in range(n_cols):
        qy[n_rows - 1, j] = 0.0  # closed domain edge


@njit(parallel=True, fastmath=True, cache=True)
def _update_depth(
    h: NDArray[np.float64],
    qx: NDArray[np.float64],
    qy: NDArray[np.float64],
    r_eff: NDArray[np.float64],
    q_inlet: NDArray[np.float64],
    q_surcharge: NDArray[np.float64],
    blocked: NDArray[np.bool_],
    scale: NDArray[np.float64],
    row_rain: NDArray[np.float64],
    row_surcharge: NDArray[np.float64],
    row_inlet: NDArray[np.float64],
    row_created: NDArray[np.float64],
    dx: float,
    dt: float,
) -> None:
    """Limit the fluxes, then apply continuity, in place.

    ``h^{t+dt} = h^t + dt*(sum q_in - sum q_out)/dx + dt*(R_eff - Q_inlet/A + Q_surch/A)``
    (CLAUDE.md 11.3). The three passes are separate parallel regions because each needs the
    whole grid from the one before: pass A works out how much every cell can afford to give
    away, pass B scales each face by its donor's affordability, pass C moves the water. The
    tallies come back as one float per row so the sum afterwards is thread-count independent.
    """
    n_rows, n_cols = h.shape
    dt_over_dx = dt / dx

    # ---- pass A: how much of its outflow can each cell actually afford?
    for i in prange(n_rows):
        for j in range(n_cols):
            if blocked[i, j]:
                scale[i, j] = 0.0
                continue
            gained = dt * (r_eff[i, j] + q_surcharge[i, j])
            available = h[i, j] + gained
            wanted = dt * q_inlet[i, j]
            taken = wanted if wanted < available else available
            if taken < 0.0:
                taken = 0.0
            available -= taken
            if available < 0.0:  # only reachable if a caller passed a negative source
                available = 0.0
            outflow = 0.0
            if qx[i, j] > 0.0:
                outflow += qx[i, j]
            if j > 0 and qx[i, j - 1] < 0.0:
                outflow -= qx[i, j - 1]
            if qy[i, j] > 0.0:
                outflow += qy[i, j]
            if i > 0 and qy[i - 1, j] < 0.0:
                outflow -= qy[i - 1, j]
            outflow *= dt_over_dx
            if outflow > available:
                scale[i, j] = available / outflow
            else:
                scale[i, j] = 1.0

    # ---- pass B: every face has exactly one donor, so scaling is consistent on both sides
    for i in prange(n_rows):
        for j in range(n_cols - 1):
            q = qx[i, j]
            if q > 0.0:
                qx[i, j] = q * scale[i, j]
            elif q < 0.0:
                qx[i, j] = q * scale[i, j + 1]
    for i in prange(n_rows - 1):
        for j in range(n_cols):
            q = qy[i, j]
            if q > 0.0:
                qy[i, j] = q * scale[i, j]
            elif q < 0.0:
                qy[i, j] = q * scale[i + 1, j]

    # ---- pass C: continuity
    for i in prange(n_rows):
        rain = 0.0
        surcharge = 0.0
        inlet = 0.0
        created = 0.0
        for j in range(n_cols):
            if blocked[i, j]:
                h[i, j] = 0.0  # a building never holds water
                continue
            gained = dt * (r_eff[i, j] + q_surcharge[i, j])
            available = h[i, j] + gained
            wanted = dt * q_inlet[i, j]
            taken = wanted if wanted < available else available
            if taken < 0.0:
                taken = 0.0
            divergence = -qx[i, j] - qy[i, j]
            if j > 0:
                divergence += qx[i, j - 1]
            if i > 0:
                divergence += qy[i - 1, j]
            depth = h[i, j] + dt_over_dx * divergence + gained - taken
            if depth < 0.0:  # roundoff only; pass A makes the limiter exact
                created -= depth
                depth = 0.0
            h[i, j] = depth
            rain += dt * r_eff[i, j]
            surcharge += dt * q_surcharge[i, j]
            inlet += taken
        row_rain[i] = rain
        row_surcharge[i] = surcharge
        row_inlet[i] = inlet
        row_created[i] = created


# ============================================================================ time step
def cfl_dt(h: NDArray[np.floating], res_m: float, max_dt_s: float = DT_MAX_S) -> float:
    """``dt = 0.7 * dx / sqrt(g * h_max)``, clamped to ``[0.5, max_dt_s]`` (CLAUDE.md 11.3).

    A dry grid has no wave to resolve, so the clamp returns ``max_dt_s``.
    """
    h_max = float(np.max(h)) if h.size else 0.0
    if h_max <= 0.0:
        return float(max_dt_s)
    dt = CFL_ALPHA * float(res_m) / np.sqrt(GRAVITY * h_max)
    return float(min(max(dt, DT_MIN_S), max_dt_s))


# ============================================================================ public step
def step_surface(
    state: SurfaceState,
    terrain: TerrainGrid | KernelTerrain,
    dt_s: float,
    *,
    r_eff_ms: NDArray[np.floating] | float | None = None,
    q_inlet_ms: NDArray[np.floating] | float | None = None,
    q_surcharge_ms: NDArray[np.floating] | float | None = None,
    sea_mask: NDArray[np.bool_] | None = None,
    tide_stage_m: float | None = None,
) -> StepTally:
    """Advance the surface one explicit step of ``dt_s`` seconds, in place.

    Args:
        state: depth and the two face fluxes; **mutated**, because a three-hour city run takes
            tens of thousands of steps and copying 160 000 cells each time is not free.
        terrain: the city grid, or the arrays :func:`prepare_terrain` already converted.
        dt_s: step length in seconds. :func:`cfl_dt` is the caller's source for it; a shorter
            step is always safe, which is how :func:`run_surface` lands exactly on a target time.
        r_eff_ms: effective rain reaching the surface, m/s per cell (CLAUDE.md 11.2). Must be
            non-negative; this kernel does not model evaporation.
        q_inlet_ms: water the drains capture, m/s per cell, positive **out of** the surface.
            Limited per cell to what is actually there; :attr:`StepTally.volume_inlet_m3` is
            what was taken.
        q_surcharge_ms: water the drains push back, m/s per cell, positive **onto** the surface.
        sea_mask: cells on the sea/creek boundary. Blocked cells in the mask are ignored.
        tide_stage_m: sea stage in the DEM's datum. Boundary cells are set to
            ``h = max(stage - z, 0)`` after continuity. Required when ``sea_mask`` is given.

    Returns:
        The step's :class:`StepTally` in cubic metres.
    """
    kernel = prepare_terrain(terrain)
    shape = kernel.shape
    if state.h.shape != shape:
        raise ValueError(f"state.h has shape {state.h.shape}, expected {shape}")
    if dt_s <= 0.0:
        raise ValueError(f"dt_s must be positive, got {dt_s}")

    rain = _source(r_eff_ms, shape, "r_eff_ms")
    inlet = _source(q_inlet_ms, shape, "q_inlet_ms")
    surcharge = _source(q_surcharge_ms, shape, "q_surcharge_ms")
    sea_index = _sea_index(sea_mask, kernel)
    if sea_index is not None and tide_stage_m is None:
        raise ValueError("sea_mask was given without tide_stage_m; the stage sets their level")

    workspace = _Workspace(shape)
    return _step(state, kernel, dt_s, rain, inlet, surcharge, sea_index, tide_stage_m, workspace)


# ============================================================================ public driver
def run_surface(
    state: SurfaceState,
    terrain: TerrainGrid | KernelTerrain,
    duration_s: float,
    *,
    r_eff_ms: NDArray[np.floating] | float | None = None,
    q_inlet_ms: NDArray[np.floating] | float | None = None,
    q_surcharge_ms: NDArray[np.floating] | float | None = None,
    sea_mask: NDArray[np.bool_] | None = None,
    tide_stage_m: float | Callable[[float], float] | None = None,
    max_dt_s: float = DT_MAX_S,
    audit_every: int = MASS_BALANCE_EVERY,
) -> SurfaceRun:
    """Sub-step the surface to ``duration_s`` under the CFL rule and audit the volume.

    The source rasters are held constant across the call, which is exactly how the cycle uses
    it: Sky delivers rain on a 5-minute cadence and the coupling re-computes the exchange every
    ``sync_s`` seconds (CLAUDE.md 11.5), so each call covers one interval over which they do not
    change. ``tide_stage_m`` may instead be a callable taking seconds since the start of the
    call, for a standalone run long enough for the sea to move; it is evaluated once per
    sub-step, outside the compiled kernel.

    The mass balance is checked every ``audit_every`` steps as CLAUDE.md 11.3 requires and
    raises :class:`MassBalanceError` rather than returning a bad run.

    Args:
        state: **mutated** in place, and also returned inside the result.
        duration_s: how far to advance, in seconds. Zero returns immediately.
        max_dt_s: upper clamp on the sub-step; the coupling passes its sync interval so a step
            never straddles an exchange.

    Returns:
        A :class:`SurfaceRun` with the state, the volume audit and the run's honesty notes.
    """
    started = perf_counter()
    kernel = prepare_terrain(terrain)
    shape = kernel.shape
    if state.h.shape != shape:
        raise ValueError(f"state.h has shape {state.h.shape}, expected {shape}")

    rain = _source(r_eff_ms, shape, "r_eff_ms")
    inlet = _source(q_inlet_ms, shape, "q_inlet_ms")
    surcharge = _source(q_surcharge_ms, shape, "q_surcharge_ms")
    sea_index = _sea_index(sea_mask, kernel)
    if sea_index is not None and tide_stage_m is None:
        raise ValueError("sea_mask was given without tide_stage_m; the stage sets their level")
    stage_at = _stage_function(tide_stage_m)

    initial = state.volume_m3(kernel.cell_area_m2)
    totals = dict.fromkeys(("rain", "surcharge", "inlet", "tide_in", "tide_out", "created"), 0.0)
    workspace = _Workspace(shape)
    elapsed_s = 0.0
    n_steps = 0
    dt_seen_min = float("inf")
    dt_seen_max = 0.0
    n_clamped_low = 0

    while elapsed_s < duration_s - _TIME_EPS_S:
        dt = cfl_dt(state.h, kernel.res_m, max_dt_s)
        if dt <= DT_MIN_S + _TIME_EPS_S:
            n_clamped_low += 1
        remaining = duration_s - elapsed_s
        if dt > remaining:
            dt = remaining
        tally = _step(
            state,
            kernel,
            dt,
            rain,
            inlet,
            surcharge,
            sea_index,
            stage_at(elapsed_s) if stage_at is not None else None,
            workspace,
        )
        totals["rain"] += tally.volume_rain_m3
        totals["surcharge"] += tally.volume_surcharge_m3
        totals["inlet"] += tally.volume_inlet_m3
        totals["tide_in"] += tally.volume_tide_in_m3
        totals["tide_out"] += tally.volume_tide_out_m3
        totals["created"] += tally.volume_created_m3
        elapsed_s += dt
        n_steps += 1
        dt_seen_min = min(dt_seen_min, dt)
        dt_seen_max = max(dt_seen_max, dt)
        if audit_every > 0 and n_steps % audit_every == 0:
            _audit(state, kernel, initial, totals, n_steps)

    run = SurfaceRun(
        state=state,
        volume_initial_m3=initial,
        volume_stored_m3=state.volume_m3(kernel.cell_area_m2),
        volume_rain_m3=totals["rain"],
        volume_surcharge_m3=totals["surcharge"],
        volume_inlet_m3=totals["inlet"],
        volume_tide_in_m3=totals["tide_in"],
        volume_tide_out_m3=totals["tide_out"],
        volume_created_m3=totals["created"],
        n_steps=n_steps,
        dt_min_s=0.0 if n_steps == 0 else dt_seen_min,
        dt_max_s=dt_seen_max,
        elapsed_ms=round((perf_counter() - started) * 1000.0),
        notes=_notes(kernel, rain, sea_index, n_clamped_low, totals),
    )
    if (
        run.error_fraction >= MASS_BALANCE_TOLERANCE
        and run.volume_in_m3 > MASS_BALANCE_MIN_VOLUME_M3
    ):
        raise MassBalanceError(
            f"surface run lost {run.error_fraction:.3%} of {run.volume_in_m3:.1f} m3 "
            f"over {n_steps} steps; the budget is {MASS_BALANCE_TOLERANCE:.1%}"
        )
    log.debug(
        "surface.run",
        n_steps=n_steps,
        duration_s=round(duration_s, 3),
        dt_min_s=round(run.dt_min_s, 3),
        dt_max_s=round(run.dt_max_s, 3),
        stored_m3=round(run.volume_stored_m3, 3),
        error_fraction=run.error_fraction,
        elapsed_ms=run.elapsed_ms,
    )
    return run


# ============================================================================ internals
_TIME_EPS_S = 1e-9
"""Slack on the sub-stepping loop, in seconds: a target time is reached, not overshot."""


class _Workspace:
    """Scratch arrays reused across sub-steps, so a long run does not allocate per step."""

    __slots__ = ("row_created", "row_inlet", "row_rain", "row_surcharge", "scale")

    def __init__(self, shape: tuple[int, int]) -> None:
        n_rows = shape[0]
        self.scale = np.ones(shape, dtype=np.float64)
        self.row_rain = np.zeros(n_rows, dtype=np.float64)
        self.row_surcharge = np.zeros(n_rows, dtype=np.float64)
        self.row_inlet = np.zeros(n_rows, dtype=np.float64)
        self.row_created = np.zeros(n_rows, dtype=np.float64)


def _sea_index(
    sea_mask: NDArray[np.bool_] | None, kernel: KernelTerrain
) -> tuple[NDArray[np.intp], NDArray[np.intp]] | None:
    """Row and column indices of the sea/creek boundary cells, buildings excluded."""
    if sea_mask is None:
        return None
    mask = np.ascontiguousarray(sea_mask, dtype=np.bool_)
    if mask.shape != kernel.shape:
        raise ValueError(f"sea_mask has shape {mask.shape}, expected {kernel.shape}")
    rows, cols = np.nonzero(mask & ~kernel.blocked)
    if rows.size == 0:
        return None
    return rows, cols


def _stage_function(
    tide_stage_m: float | Callable[[float], float] | None,
) -> Callable[[float], float] | None:
    """Normalise a constant stage or a stage(t) callable into one callable, or nothing."""
    if tide_stage_m is None:
        return None
    if callable(tide_stage_m):
        return tide_stage_m
    constant = float(tide_stage_m)
    return lambda _elapsed_s: constant


def _step(
    state: SurfaceState,
    kernel: KernelTerrain,
    dt_s: float,
    rain: NDArray[np.float64],
    inlet: NDArray[np.float64],
    surcharge: NDArray[np.float64],
    sea_index: tuple[NDArray[np.intp], NDArray[np.intp]] | None,
    tide_stage_m: float | None,
    workspace: _Workspace,
) -> StepTally:
    """One step with everything already converted: the sea boundary, flux, continuity, then
    the sea boundary again.

    The level is imposed **twice**, and the first time is the one that matters. A Dirichlet
    boundary has to be standing at its level *before* the fluxes are computed, or there is no
    head difference across the shoreline face for the flux to see: applied only after
    continuity, a tide rising onto a dry coast sets the boundary cells wet and moves nothing
    inland until the following step. That is a one-step lag on every stage change, and the
    tide-locked outfall of the demo (CLAUDE.md 15, the 1:40 beat) is exactly a stage change.
    The second application re-clamps the cells after continuity has run over them, which is
    what keeps them AT the stage rather than merely starting there, and it is where the tide
    exchange volume is measured for the mass balance.
    """
    area_pre = kernel.cell_area_m2
    tide_in_pre = 0.0
    tide_out_pre = 0.0
    if sea_index is not None and tide_stage_m is not None:
        tide_in_pre, tide_out_pre = _apply_tide(
            state.h, kernel.z, sea_index, tide_stage_m, area_pre
        )
    _update_flux(
        state.h,
        kernel.z,
        kernel.manning_n,
        kernel.blocked,
        state.qx,
        state.qy,
        kernel.res_m,
        dt_s,
        GRAVITY,
        DRY_DEPTH_M,
        FRICTION_DEPTH_EXPONENT,
    )
    _update_depth(
        state.h,
        state.qx,
        state.qy,
        rain,
        inlet,
        surcharge,
        kernel.blocked,
        workspace.scale,
        workspace.row_rain,
        workspace.row_surcharge,
        workspace.row_inlet,
        workspace.row_created,
        kernel.res_m,
        dt_s,
    )
    area = kernel.cell_area_m2
    tide_in = 0.0
    tide_out = 0.0
    if sea_index is not None and tide_stage_m is not None:
        tide_in, tide_out = _apply_tide(state.h, kernel.z, sea_index, tide_stage_m, area)
    return StepTally(
        dt_s=dt_s,
        volume_rain_m3=float(np.sum(workspace.row_rain)) * area,
        volume_surcharge_m3=float(np.sum(workspace.row_surcharge)) * area,
        volume_inlet_m3=float(np.sum(workspace.row_inlet)) * area,
        volume_tide_in_m3=tide_in + tide_in_pre,
        volume_tide_out_m3=tide_out + tide_out_pre,
        volume_created_m3=float(np.sum(workspace.row_created)) * area,
    )


def _apply_tide(
    h: NDArray[np.float64],
    z: NDArray[np.float64],
    sea_index: tuple[NDArray[np.intp], NDArray[np.intp]],
    stage_m: float,
    cell_area_m2: float,
) -> tuple[float, float]:
    """Impose ``h = max(stage - z, 0)`` on the boundary cells and account what crossed.

    The clamp at zero is the whole boundary condition in one expression: above the cell's ground
    the sea holds it at the stage, below it the cell drains freely to the sea. Both directions
    are volume that crossed the model edge, so both are returned rather than discarded - a
    coastal run whose outflow is not counted cannot be audited (CLAUDE.md 11.3).
    """
    rows, cols = sea_index
    target = np.maximum(stage_m - z[rows, cols], 0.0)
    delta = target - h[rows, cols]
    h[rows, cols] = target
    inflow = float(np.sum(np.maximum(delta, 0.0))) * cell_area_m2
    outflow = -float(np.sum(np.minimum(delta, 0.0))) * cell_area_m2
    return inflow, outflow


def _audit(
    state: SurfaceState,
    kernel: KernelTerrain,
    initial_m3: float,
    totals: dict[str, float],
    n_steps: int,
) -> None:
    """The every-100-steps conservation assertion of CLAUDE.md 11.3."""
    total_in = (
        initial_m3 + totals["rain"] + totals["surcharge"] + totals["tide_in"] + totals["created"]
    )
    if total_in <= MASS_BALANCE_MIN_VOLUME_M3:
        return
    total_out = totals["inlet"] + totals["tide_out"]
    stored = state.volume_m3(kernel.cell_area_m2)
    error = abs(stored - (total_in - total_out)) / total_in
    if error >= MASS_BALANCE_TOLERANCE:
        raise MassBalanceError(
            f"surface mass balance broke at step {n_steps}: stored {stored:.3f} m3 against "
            f"in {total_in:.3f} m3 minus out {total_out:.3f} m3, error {error:.3%}"
        )


def _notes(
    kernel: KernelTerrain,
    rain: NDArray[np.float64],
    sea_index: tuple[NDArray[np.intp], NDArray[np.intp]] | None,
    n_clamped_low: int,
    totals: dict[str, float],
) -> tuple[str, ...]:
    """Honesty labels this run earned (rule 6), each one true of *this* run's numbers."""
    notes: list[str] = []
    roofs = int(np.count_nonzero(kernel.blocked & (rain > 0.0)))
    if roofs:
        share = 100.0 * roofs / kernel.blocked.size
        notes.append(
            f"Rain on {roofs} building cells ({share:.1f} % of the grid) is outside the surface "
            "water budget: blocked cells hold no water and roof runoff is not routed to the "
            "street in the prototype."
        )
    if sea_index is not None:
        notes.append(
            f"Sea boundary imposed on {sea_index[0].size} cells: {totals['tide_in']:.0f} m3 in, "
            f"{totals['tide_out']:.0f} m3 out."
        )
    if n_clamped_low:
        notes.append(
            f"The CFL step was clamped up to the {DT_MIN_S} s floor on {n_clamped_low} steps; "
            "the step may not resolve the fastest wave on the grid."
        )
    if totals["created"] > 0.0:
        notes.append(
            f"The positivity clamp invented {totals['created']:.3e} m3: the flux limiter should "
            "make this exactly zero, so treat it as a defect rather than a rounding artefact."
        )
    return tuple(notes)
