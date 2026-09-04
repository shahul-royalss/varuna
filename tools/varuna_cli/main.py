"""`varuna` CLI - every `make` target is also available as `uv run varuna <task>`."""

from __future__ import annotations

import typer

app = typer.Typer(
    help="VARUNA - street-level urban flood nowcasting digital twin.",
    no_args_is_help=True,
    add_completion=False,
)


@app.callback()
def _root() -> None:
    """VARUNA - Every street. Three hours early."""


@app.command()
def hello() -> None:
    """Smoke-test command."""
    typer.echo("VARUNA - Every street. Three hours early.")


if __name__ == "__main__":
    app()
