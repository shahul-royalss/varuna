"""The types VARUNA-Twin's surface, drain and coupling solvers pass to each other
(CLAUDE.md 11.3-11.5, Appendix A).

Twin is two solvers that exchange water every few seconds: a local-inertial shallow-water
model on the 30 m city grid, and a head-driven 1D model on the inferred drain graph. The
structures here are what they hand each other, and they are shaped for the solver, not for
the API: **struct of arrays**, integer indices, no Python objects inside a hot loop, so the
kernels can be compiled with ``numba.njit``. The Pydantic contract surface that leaves the
service lives in ``varuna_schemas.models`` instead.

Layering: Twin depends on ``varuna_schemas`` and nothing else in the workspace. Georeference
and terrain arrive from the city rasters' own affine transform; the drain graph arrives from
``city/<city>/graph/*.parquet``. Neither is guessed.

Units, fixed once here:

* depth ``h`` and head ``H`` are **metres**; the API converts to cm at the boundary;
* elevations ``z`` are metres in the DEM's vertical datum;
* discharge ``Q`` is m3/s, unit-width flux ``q`` is m2/s, rain is m/s inside the solver
  (converted from mm/h once, at the edge);
* time is seconds inside the solver, IST datetimes on the contract surface;
* grids are ``(row, col)`` with row 0 northernmost, matching the GeoTIFFs and ``varuna_city``.

Sign conventions that have bitten this kind of model before, fixed here:

* ``qx`` is the flux through the **eastern** face of a cell, positive eastward;
* ``qy`` is the flux through the **southern** face of a cell, positive southward
  (i.e. toward increasing row), so both fluxes point toward increasing index;
* on a drain edge, ``Q`` is positive when water flows ``from_node -> to_node``. Negative ``Q``
  is backflow, which is exactly what a tide-locked outfall produces and what the console
  draws as a reversed-flow edge (CLAUDE.md 6.2, 7.2).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:  # pragma: no cover - kept off the type surface, as varuna_schemas does
    import numpy as np
    from numpy.typing import NDArray

__all__ = [
    "BoundaryKind",
    "CouplingFluxes",
    "DrainNetwork",
    "DrainState",
    "MassBalance",
    "SurfaceState",
    "TerrainGrid",
    "TideSeries",
    "TwinInputs",
    "TwinResult",
]

GRAVITY = 9.81
"""Acceleration due to gravity in m/s2, used by every formula in Appendix A."""


# ============================================================================ terrain
@dataclass(frozen=True, slots=True)
class TerrainGrid:
    """The hydro-conditioned city grid the 2D solver runs on (CLAUDE.md 10.1 step 4).

    Every array is ``(n_rows, n_cols)`` float32/float64 on the same grid, read from
    ``city/<city>/*.tif``. ``blocked`` cells are buildings: no flux crosses their faces and
    they never hold water.
    """

    z: NDArray[np.floating]
    """Conditioned ground elevation in metres (``dem_conditioned.tif``)."""

    manning_n: NDArray[np.floating]
    """Manning roughness per cell (``roughness.tif``)."""

    blocked: NDArray[np.bool_]
    """True where a building blocks flow (``blocked.tif``)."""

    imperviousness: NDArray[np.floating]
    """Impervious fraction 0-1 (``imperviousness.tif``)."""

    cn: NDArray[np.floating]
    """SCS curve number 90-98 (``cn.tif``)."""

    res_m: float
    """Cell size in metres (30 for the city grid)."""

    crs: str
    """EPSG string of the computation CRS, e.g. ``EPSG:32643``."""

    transform: tuple[float, float, float, float, float, float]
    """North-up affine ``(res, 0, left, 0, -res, top)``, from the GeoTIFF."""

    @property
    def shape(self) -> tuple[int, int]:
        return (int(self.z.shape[0]), int(self.z.shape[1]))

    @property
    def n_rows(self) -> int:
        return int(self.z.shape[0])

    @property
    def n_cols(self) -> int:
        return int(self.z.shape[1])

    @property
    def cell_area_m2(self) -> float:
        return float(self.res_m * self.res_m)


# ============================================================================ surface
@dataclass(slots=True)
class SurfaceState:
    """Mutable state of the 2D solver: depth and the two face fluxes.

    ``h`` is ``(n_rows, n_cols)`` in metres. ``qx`` and ``qy`` are unit-width fluxes in m2/s
    on the eastern and southern faces, so they are also ``(n_rows, n_cols)`` with the last
    column / last row holding the domain-edge face.
    """

    h: NDArray[np.floating]
    qx: NDArray[np.floating]
    qy: NDArray[np.floating]

    def volume_m3(self, cell_area_m2: float) -> float:
        """Water currently stored on the surface."""
        import numpy as np

        return float(np.nansum(self.h) * cell_area_m2)


# ============================================================================ drains
BoundaryKind = Literal["none", "tidal", "free"]
"""How a node exchanges water with the world beyond the model."""


@dataclass(frozen=True, slots=True)
class DrainNetwork:
    """The inferred drain graph as flat arrays, ready for a compiled kernel.

    Nodes and edges are addressed by integer index. ``node_ids`` and ``edge_ids`` keep the
    string ids (``MUM-N000000``) so a product can be joined back to
    ``city/<city>/graph/*.parquet``; the solver itself never sees a string.

    Every element carries ``confidence = "inferred"`` upstream (CLAUDE.md 10.1 step 7), which
    is why the UI must label the graph inferred everywhere it is drawn.
    """

    # --- nodes -------------------------------------------------------------
    node_ids: tuple[str, ...]
    z_ground: NDArray[np.floating]
    """Ground level at the manhole in metres; surcharge begins above it."""

    z_invert: NDArray[np.floating]
    """Pipe invert level in metres."""

    storage_area: NDArray[np.floating]
    """Manhole plan area in m2, the ``A_s`` of ``dH/dt = net Q / A_s``."""

    inlet_length: NDArray[np.floating]
    """Grate length in metres, the ``L`` of the weir term."""

    inlet_area: NDArray[np.floating]
    """Grate opening area in m2, the ``A_o`` of the orifice term."""

    kappa: NDArray[np.floating]
    """Inlet clogging 0-1; ``(1 - kappa)`` scales the captured flow."""

    boundary: NDArray[np.int8]
    """0 = interior, 1 = tidal outfall, 2 = free outfall. See :data:`BoundaryKind`."""

    flap_gate: NDArray[np.bool_]
    """True where a flap gate blocks reverse flow at an outfall."""

    cell_row: NDArray[np.int32]
    """Row of the 2D cell this node exchanges water with; -1 when it has none."""

    cell_col: NDArray[np.int32]

    # --- edges -------------------------------------------------------------
    edge_ids: tuple[str, ...]
    from_node: NDArray[np.int32]
    to_node: NDArray[np.int32]
    length: NDArray[np.floating]
    area: NDArray[np.floating]
    """Full-bore cross-sectional area in m2, before blockage."""

    hydraulic_radius: NDArray[np.floating]
    """``R_h`` in metres at full bore."""

    diameter: NDArray[np.floating]
    """Pipe diameter (or box height) in metres, the ``D`` of the fill fraction."""

    edge_manning_n: NDArray[np.floating]
    q_full: NDArray[np.floating]
    """Manning full-flow capacity in m3/s at beta = 0, from the city pipeline."""

    beta: NDArray[np.floating]
    """Blockage fraction 0-1. ``A_eff = (1 - beta) * area``. Pulse learns this."""

    @property
    def n_nodes(self) -> int:
        return len(self.node_ids)

    @property
    def n_edges(self) -> int:
        return len(self.edge_ids)


@dataclass(slots=True)
class DrainState:
    """Mutable state of the 1D solver: a head per node and a flow per edge."""

    head: NDArray[np.floating]
    """Hydraulic head in metres at each node."""

    flow: NDArray[np.floating]
    """Discharge in m3/s on each edge, positive ``from_node -> to_node``."""

    def volume_m3(self, network: DrainNetwork) -> float:
        """Water stored in the manholes above their inverts."""
        import numpy as np

        depth = np.maximum(self.head - network.z_invert, 0.0)
        return float(np.sum(depth * network.storage_area))


@dataclass(frozen=True, slots=True)
class CouplingFluxes:
    """What crossed between the street and the pipe in one sync interval
    (CLAUDE.md 11.5, Appendix A).

    Both arrays are per node in m3/s and non-negative; they are separate rather than one
    signed array so a product can report capture and surcharge independently, which is what
    the drain X-ray and the surcharge markers show.
    """

    q_inlet: NDArray[np.floating]
    """Street to pipe: ``(1 - kappa) * min(weir, orifice, available)``."""

    q_surcharge: NDArray[np.floating]
    """Pipe to street: ``0.6 * A_m * sqrt(2 g (H - z_g - h))`` when ``H > z_g + h``."""

    @property
    def surcharging(self) -> NDArray[np.bool_]:
        """Nodes pushing water back onto the street this interval."""
        return self.q_surcharge > 0.0


# ============================================================================ boundaries
@dataclass(frozen=True, slots=True)
class TideSeries:
    """Sea stage at the tidal outfalls over the run (CLAUDE.md 10.2, 11.4).

    ``stage_m`` is in the same vertical datum as the DEM. ``source`` is carried so the UI can
    say whether the series came from a public tide table or is labelled illustrative - rule 7
    forbids presenting the second as the first.
    """

    times: tuple[datetime, ...]
    stage_m: NDArray[np.floating]
    source: str

    def at(self, when: datetime) -> float:
        """Linearly interpolated stage; clamped to the ends outside the series."""
        import numpy as np

        if not self.times:
            return 0.0
        xs = np.array([t.timestamp() for t in self.times], dtype=np.float64)
        return float(np.interp(when.timestamp(), xs, np.asarray(self.stage_m, dtype=np.float64)))


# ============================================================================ run
@dataclass(frozen=True, slots=True)
class MassBalance:
    """The conservation audit CLAUDE.md 11.3 requires: error below 0.1 % of inflow.

    Checked every 100 steps during a run and reported once at the end; a run that fails it is
    a bug, not a warning, because every number the console shows is derived from this volume.
    """

    volume_in_m3: float
    volume_out_m3: float
    volume_stored_m3: float
    error_fraction: float
    """``|stored - (in - out)| / in``; the budget is 1e-3."""

    @property
    def ok(self) -> bool:
        return self.error_fraction < 1e-3


@dataclass(frozen=True, slots=True)
class TwinInputs:
    """Everything one Twin run consumes.

    ``rain_mm_h`` is ``(n_steps, n_rows, n_cols)`` already resampled onto the city grid -
    Sky owns that resampling (``varuna_sky.products.resample_to_aoi``), Twin does not
    reach across to it.
    """

    terrain: TerrainGrid
    network: DrainNetwork
    rain_mm_h: NDArray[np.floating]
    t0: datetime
    step_min: int = 5
    tide: TideSeries | None = None
    sync_s: float = 5.0
    """Surface-drain exchange interval in seconds (CLAUDE.md 11.5)."""

    inner_dt_s: float = 1.0
    """Explicit inner step of the 1D solver in seconds (CLAUDE.md 11.4)."""


@dataclass(frozen=True, slots=True)
class TwinResult:
    """One Twin run: a depth field every 5 minutes, the drain state that produced it, and
    the audit trail (CLAUDE.md 10.3, 11.3).
    """

    depth_m: NDArray[np.floating]
    """``(n_steps, n_rows, n_cols)`` surface depth in metres."""

    head_m: NDArray[np.floating]
    """``(n_steps, n_nodes)`` hydraulic head at each drain node."""

    q_surcharge: NDArray[np.floating]
    """``(n_steps, n_nodes)`` surcharge discharge in m3/s."""

    edge_flow: NDArray[np.floating]
    """``(n_steps, n_edges)`` pipe discharge; negative entries are backflow."""

    times: tuple[datetime, ...]
    mass_balance: MassBalance
    stage_ms: dict[str, int] = field(default_factory=dict)
    notes: tuple[str, ...] = ()

    @property
    def n_steps(self) -> int:
        return int(self.depth_m.shape[0])
