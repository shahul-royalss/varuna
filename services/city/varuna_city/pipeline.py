"""City-in-a-box driver (CLAUDE.md P1.1-P1.12, 10.1) - ``make city CITY=mumbai``.

``run_city()`` walks the eleven steps of section 10.1 in order. Every step

* declares the files it produces, so a step whose outputs are newer than its inputs is
  **skipped** (``make city`` from a warm cache is minutes, not tens of minutes);
* runs a validation check afterwards and records ``ok`` / the reason it is not;
* records its wall time into a ``stage_ms`` dict, exactly like an engine cycle; and
* publishes ``onboard.progress`` on the in-process bus so the Phase 9 wizard streams the
  same pipeline the terminal runs.

The step *implementations* live in the sibling modules (``rasters``, ``osm``, ``landcover``,
``condition``, ``roughness``, ``depressions``, ``segments``, ``units``, ``drains``,
``hotspots``, ``assets``). Those are written by other agents and land at different times, so
every step resolves its callable lazily by name: a module that is not importable yet makes
its step ``skipped`` with the import error as the reason, and the pipeline keeps going.
"""

from __future__ import annotations

import importlib
import inspect
import json
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import structlog
from varuna_schemas.paths import city_dir

from varuna_city.config import CityGrid, city_grid, load_city_config

log = structlog.get_logger("varuna.city.pipeline")

PROGRESS_TOPIC = "onboard.progress"
"""Bus topic the onboarding wizard subscribes to (CLAUDE.md 11.11)."""


class StepFailed(RuntimeError):
    """A step ran and its validation check said the output is not usable."""


@dataclass(slots=True)
class StepSpec:
    """One pipeline step: where its code lives, what it writes, how it is checked."""

    name: str
    title: str
    module: str
    functions: tuple[str, ...]
    outputs: tuple[str, ...] = ()
    required: bool = True

    def output_paths(self, out_dir: Path) -> list[Path]:
        return [out_dir / name for name in self.outputs]


@dataclass(slots=True)
class StepResult:
    """What one step did: cached, ran, skipped (module missing) or failed."""

    name: str
    status: str
    ms: float = 0.0
    detail: str | None = None
    outputs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "step": self.name,
            "status": self.status,
            "ms": round(self.ms, 1),
            "detail": self.detail,
            "outputs": self.outputs,
        }


@dataclass(slots=True)
class CityResult:
    """The whole run: every step, the timings, and where the layers landed."""

    city: str
    out_dir: Path
    grid: dict[str, Any]
    steps: list[StepResult] = field(default_factory=list)
    stage_ms: dict[str, float] = field(default_factory=dict)
    artifacts: dict[str, Any] = field(default_factory=dict)

    @property
    def total_ms(self) -> float:
        return sum(self.stage_ms.values())

    @property
    def ok(self) -> bool:
        return not any(s.status == "failed" for s in self.steps)

    def to_dict(self) -> dict[str, Any]:
        return {
            "city": self.city,
            "out_dir": str(self.out_dir),
            "grid": self.grid,
            "ok": self.ok,
            "total_ms": round(self.total_ms, 1),
            "stage_ms": {k: round(v, 1) for k, v in self.stage_ms.items()},
            "steps": [s.to_dict() for s in self.steps],
        }


STEPS: tuple[StepSpec, ...] = (
    StepSpec(
        name="cache",
        title="Verify the open-data cache",
        module="varuna_city.cache",
        functions=("verify_cache",),
    ),
    StepSpec(
        name="dem",
        title="Mosaic the Copernicus DEM onto the city grid",
        module="varuna_city.rasters",
        functions=("build_dem",),
        outputs=("dem.tif",),
    ),
    StepSpec(
        name="osm",
        title="Extract roads, buildings, waterways and assets from OSM",
        module="varuna_city.osm",
        functions=("build_osm", "fetch_osm"),
        outputs=("osm.gpkg",),
    ),
    StepSpec(
        name="landcover",
        title="Imperviousness and curve number from ESA WorldCover",
        module="varuna_city.landcover",
        functions=("build_landcover", "build_imperviousness", "run"),
        outputs=("imperviousness.tif",),
    ),
    StepSpec(
        name="condition",
        title="Hydro-condition the DEM (burn, carve, breach)",
        module="varuna_city.condition",
        functions=("condition_dem", "build_conditioned_dem", "run"),
        outputs=("dem_conditioned.tif",),
    ),
    StepSpec(
        name="roughness",
        title="Manning roughness raster",
        module="varuna_city.roughness",
        functions=("build_roughness", "run"),
        outputs=("roughness.tif",),
    ),
    StepSpec(
        name="depressions",
        title="Depression map and hotspot candidates",
        module="varuna_city.depressions",
        functions=("build_depressions", "find_depressions", "run"),
        outputs=("depressions.geojson",),
    ),
    StepSpec(
        name="segments",
        title="Road segments split at intersections",
        module="varuna_city.segments",
        functions=("build_segments", "run"),
        outputs=("segments.parquet",),
    ),
    StepSpec(
        name="units",
        title="Surface units draining to each inlet",
        module="varuna_city.units",
        functions=("build_units", "run"),
        outputs=("units.parquet",),
    ),
    StepSpec(
        name="drains",
        title="Synthetic drain graph (inferred)",
        module="varuna_city.drains",
        functions=("build_drains", "build_drain_graph", "run"),
        outputs=("drain_edges.parquet",),
    ),
    StepSpec(
        name="hotspots",
        title="Chronic waterlogging register",
        module="varuna_city.hotspots",
        functions=("build_hotspots",),
        outputs=("hotspots.geojson",),
    ),
    StepSpec(
        name="assets",
        title="Hospitals, fire stations, pumps and tanks",
        module="varuna_city.assets",
        functions=("build_assets",),
        outputs=("assets.geojson",),
    ),
    StepSpec(
        name="export",
        title="GeoParquet, map GeoJSON and the Flash graph tables",
        module="varuna_city.export",
        functions=("export_city",),
        outputs=("export/MANIFEST.json",),
    ),
    StepSpec(
        name="report",
        title="Validation report and maps",
        module="varuna_city.report",
        functions=("write_report",),
        outputs=("REPORT.md",),
    ),
)


def _publish(payload: dict[str, Any]) -> None:
    """Best-effort ``onboard.progress`` publish; never breaks a terminal run."""
    try:
        from varuna_cycle.bus import get_bus

        get_bus().publish_threadsafe(PROGRESS_TOPIC, payload)
    except Exception as exc:  # no loop bound (plain CLI run), or cycle not installed
        log.debug("pipeline.progress_not_published", reason=str(exc))


def resolve_step(spec: StepSpec) -> tuple[Callable[..., Any] | None, str | None]:
    """Import ``spec.module`` and return the first of ``spec.functions`` it defines."""
    try:
        module = importlib.import_module(spec.module)
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
    for name in spec.functions:
        fn = getattr(module, name, None)
        if callable(fn):
            return fn, None
    return None, f"{spec.module} defines none of {', '.join(spec.functions)}"


def call_flexible(fn: Callable[..., Any], /, **kwargs: Any) -> Any:
    """Call ``fn`` with only the keyword arguments its signature accepts.

    The sibling modules are written by different agents with slightly different signatures
    (``config`` vs ``city``, ``out_dir`` vs nothing); this keeps the driver from guessing.
    """
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):  # builtins
        return fn()
    params = sig.parameters
    takes_var_kw = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())
    accepted = {k: v for k, v in kwargs.items() if takes_var_kw or k in params}
    positional = [
        name
        for name, p in params.items()
        if p.default is inspect.Parameter.empty
        and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
    ]
    args: list[Any] = []
    for name in positional:
        if name in accepted:
            args.append(accepted.pop(name))
        elif name in kwargs:
            args.append(kwargs[name])
        else:
            break
    return fn(*args, **accepted)


def outputs_fresh(spec: StepSpec, out_dir: Path, *, newer_than: float) -> bool:
    """True when every declared output exists and is newer than ``newer_than``."""
    paths = spec.output_paths(out_dir)
    if not paths:
        return False
    return all(p.exists() and p.stat().st_mtime >= newer_than for p in paths)


def run_city(
    city: str = "mumbai",
    *,
    cache_only: bool = False,
    force: bool = False,
    out_dir: Path | None = None,
    only: Iterable[str] | None = None,
) -> CityResult:
    """Run the city-in-a-box pipeline and return every step's status and timing.

    Args:
        city: city slug with a config under ``services/city/configs/``.
        cache_only: stop after the cache check (``make city CITY=chennai --cache-only``).
        force: ignore cached step outputs and recompute everything.
        out_dir: city folder (default ``city/<city>/``).
        only: run just these step names (debugging; validation still runs).
    """
    config = load_city_config(city)
    grid = city_grid(config)
    target = out_dir or city_dir(config.id)
    target.mkdir(parents=True, exist_ok=True)
    config_mtime = _config_mtime(city)
    result = CityResult(city=config.id, out_dir=target, grid=grid.to_dict())
    wanted = set(only) if only is not None else None
    specs = STEPS[:1] if cache_only else STEPS
    log.info("city.start", city=config.id, steps=len(specs), out_dir=str(target), force=force)
    _publish({"city": config.id, "event": "started", "steps": [s.name for s in specs]})

    for index, spec in enumerate(specs):
        if wanted is not None and spec.name not in wanted:
            continue
        _publish(
            {
                "city": config.id,
                "event": "step_started",
                "step": spec.name,
                "title": spec.title,
                "index": index,
                "total": len(specs),
            }
        )
        step = _run_step(
            spec,
            config=config,
            grid=grid,
            out_dir=target,
            force=force,
            config_mtime=config_mtime,
            artifacts=result.artifacts,
        )
        result.steps.append(step)
        result.stage_ms[spec.name] = step.ms
        _publish(
            {
                "city": config.id,
                "event": "step_finished",
                "step": spec.name,
                "status": step.status,
                "ms": round(step.ms, 1),
                "detail": step.detail,
                "index": index,
                "total": len(specs),
            }
        )
        log.info(
            "city.step",
            city=config.id,
            step=spec.name,
            status=step.status,
            ms=round(step.ms, 1),
            detail=step.detail,
        )

    summary = target / "pipeline.json"
    summary.write_text(
        json.dumps(result.to_dict(), indent=1) + "\n", encoding="utf-8", newline="\n"
    )
    _publish({"city": config.id, "event": "finished", "ok": result.ok, "ms": result.total_ms})
    log.info("city.done", city=config.id, ok=result.ok, total_ms=round(result.total_ms, 1))
    return result


def _config_mtime(city: str) -> float:
    from varuna_schemas.paths import city_config_path

    path = city_config_path(city)
    return path.stat().st_mtime if path.is_file() else 0.0


def _run_step(
    spec: StepSpec,
    *,
    config: Any,
    grid: CityGrid,
    out_dir: Path,
    force: bool,
    config_mtime: float,
    artifacts: dict[str, Any],
) -> StepResult:
    if not force and outputs_fresh(spec, out_dir, newer_than=config_mtime):
        paths = [str(p) for p in spec.output_paths(out_dir)]
        return StepResult(spec.name, "cached", 0.0, "outputs newer than the config", paths)
    fn, reason = resolve_step(spec)
    if fn is None:
        status = "failed" if spec.required and spec.module.endswith(("hotspots", "assets")) else "skipped"
        return StepResult(spec.name, status, 0.0, reason)
    started = time.perf_counter()
    try:
        value = call_flexible(
            fn,
            config=config,
            city=config.id,
            grid=grid,
            out_dir=out_dir,
            force=force,
            artifacts=artifacts,
            metric_crs=grid.crs,
            bbox=_bbox(config),
        )
    except Exception as exc:
        ms = (time.perf_counter() - started) * 1000.0
        log.warning("city.step_failed", step=spec.name, error=str(exc), exc_info=True)
        return StepResult(spec.name, "failed", ms, f"{type(exc).__name__}: {exc}")
    ms = (time.perf_counter() - started) * 1000.0
    artifacts[spec.name] = value
    missing = [str(p) for p in spec.output_paths(out_dir) if not p.exists()]
    if missing:
        return StepResult(spec.name, "failed", ms, f"declared output missing: {missing[0]}")
    return StepResult(spec.name, "ok", ms, _detail(value), [str(p) for p in spec.output_paths(out_dir)])


def _bbox(config: Any) -> tuple[float, float, float, float] | None:
    bbox = getattr(config, "bbox", None)
    if bbox is None:
        return None
    if hasattr(bbox, "as_tuple"):
        return tuple(bbox.as_tuple())  # type: ignore[return-value]
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        return (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
    parts = [getattr(bbox, k, None) for k in ("minlon", "minlat", "maxlon", "maxlat")]
    if all(p is not None for p in parts):
        return tuple(float(p) for p in parts)  # type: ignore[return-value]
    return None


def _detail(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, Path):
        return value.name
    if isinstance(value, (list, tuple)):
        return f"{len(value)} item(s)"
    if hasattr(value, "to_dict"):
        return None
    return None


__all__ = [
    "PROGRESS_TOPIC",
    "STEPS",
    "CityResult",
    "StepFailed",
    "StepResult",
    "StepSpec",
    "call_flexible",
    "outputs_fresh",
    "resolve_step",
    "run_city",
]
