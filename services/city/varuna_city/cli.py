"""``varuna city`` - the city-in-a-box CLI (CLAUDE.md 4.3, P1.1-P1.12).

``uv run varuna city --city mumbai`` runs every step of :mod:`varuna_city.pipeline` from the
open-data cache and prints a per-step timing table. Steps whose outputs are newer than their
inputs are loaded from ``city/<city>/`` instead of recomputed, so a second run is seconds.

Sub-commands cover the pieces on their own: ``varuna city cache`` checks the tiles,
``varuna city report`` re-renders ``REPORT.md`` from what is already on disk, and
``varuna city layers`` lists what the API can serve.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

DEFAULT_CITY = "mumbai"

app = typer.Typer(
    name="city",
    help="Build the city-in-a-box layers (terrain, roads, drains, exports).",
    no_args_is_help=False,
    add_completion=False,
)


def _echo_table(text: str) -> None:
    for line in text.splitlines():
        typer.echo(line)


@app.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    city: Annotated[
        str, typer.Option("--city", help="City slug: mumbai or chennai.")
    ] = DEFAULT_CITY,
    cache_only: Annotated[
        bool, typer.Option("--cache-only", help="Only verify the open-data cache and stop.")
    ] = False,
    force: Annotated[
        bool, typer.Option("--force", help="Recompute every step, ignoring cached outputs.")
    ] = False,
    only: Annotated[
        str | None,
        typer.Option("--only", help="Comma-separated step names to rebuild (others load cached)."),
    ] = None,
    seed: Annotated[int, typer.Option("--seed", help="Seed for every random draw.")] = 2019,
    out_dir: Annotated[
        Path | None, typer.Option("--out-dir", help="Write to this folder instead of city/<city>/.")
    ] = None,
) -> None:
    """Run the whole pipeline (this is ``make city CITY=<city>``)."""
    if ctx.invoked_subcommand is not None:
        return
    from varuna_city.pipeline import run_city, timing_table

    result = run_city(
        city,
        cache_only=cache_only,
        force=force,
        out_dir=out_dir,
        only=[s.strip() for s in only.split(",")] if only else None,
        seed=seed,
    )
    typer.echo("")
    _echo_table(timing_table(result))
    typer.echo("")
    typer.echo(f"city/{result.city}: {result.out_dir}")
    failed = [s for s in result.steps if s.status == "failed"]
    for step in failed:
        typer.echo(f"failed: {step.name} - {step.detail}")
    if failed:
        raise typer.Exit(code=1)


@app.command("cache")
def cache(
    city: Annotated[str, typer.Option("--city", help="City slug.")] = DEFAULT_CITY,
) -> None:
    """Check that every DEM and land-cover tile the city needs is in city/cache/."""
    from varuna_city.cache import verify_cache
    from varuna_city.config import load_city_config

    rows = verify_cache(load_city_config(city))
    for row in rows:
        state = "ok" if row.ok else f"MISSING ({row.detail})"
        typer.echo(f"{row.key:70s} {state}")
    bad = [r for r in rows if not r.ok]
    typer.echo(f"{len(rows)} tile(s), {len(bad)} problem(s).")
    if bad:
        raise typer.Exit(code=1)


@app.command("report")
def report(
    city: Annotated[str, typer.Option("--city", help="City slug.")] = DEFAULT_CITY,
) -> None:
    """Re-render REPORT.md and its maps from the layers already in city/<city>/."""
    from varuna_city.pipeline import run_city, timing_table

    result = run_city(city, only=["report"])
    _echo_table(timing_table(result))
    step = result.step("report")
    if step is not None and step.status == "failed":
        typer.echo(f"failed: {step.detail}")
        raise typer.Exit(code=1)


@app.command("layers")
def layers(
    city: Annotated[str, typer.Option("--city", help="City slug.")] = DEFAULT_CITY,
) -> None:
    """List the map layers ``GET /v1/city/{city}/layers/{name}`` can serve."""
    from varuna_schemas.paths import city_dir

    from varuna_city.export import MAP_LAYERS

    root = city_dir(city) / "map"
    for name in MAP_LAYERS:
        path = root / f"{name}.geojson"
        size = f"{path.stat().st_size / 1e6:.1f} MB" if path.is_file() else "not built"
        typer.echo(f"{name:14s} {size}")


__all__ = ["app"]
