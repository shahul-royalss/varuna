"""Seeding a fresh deployment with the demo runs that ship in the repo.

The console is useless without a run: no depth raster, no wet streets, no hotspot rail, just the
honest empty state telling the operator to bake one. On the demo laptop `make bake` does that.
On a hosted deployment nothing can - a cycle takes about three minutes of CPU and the container
would spend its first quarter hour serving 404s.

So a small set of baked cycles is committed under ``demo/runs`` and copied into the run
directory the first time the API starts against an empty one. They are the same artifacts
`make bake` writes, minus ``segment_forecast.parquet``: that file is the product of record and
`services/verify` wants it, but it is 19 MB per cycle and the console never reads it - the
compact ``segments_wet.json`` beside it is what the map draws (`varuna_products.depth`).

This is a copy, not a fallback path in the reader: once seeded the runs are ordinary runs on the
volume, a freshly baked cycle sits beside them, and nothing downstream has to know where they
came from.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import structlog
from varuna_schemas.paths import repo_root, runs_dir

log = structlog.get_logger("varuna.api.seed")

__all__ = ["demo_runs_dir", "seed_demo_runs"]


def demo_runs_dir() -> Path:
    """Where the committed demo runs live."""
    return repo_root() / "demo" / "runs"


def seed_demo_runs() -> int:
    """Copy the committed demo runs into the run directory if it holds none. Returns the count.

    Only when the directory is empty. A deployment that has baked its own cycles, or an operator
    who has pressed Compute live, must never have the shipped set reappear underneath them.
    """
    source = demo_runs_dir()
    if not source.is_dir():
        return 0

    target = runs_dir()
    target.mkdir(parents=True, exist_ok=True)
    existing = [p for p in target.iterdir() if p.is_dir() and not p.name.startswith(".")]
    if existing:
        log.info("api.seed_skipped", runs=len(existing), reason="run directory is not empty")
        return 0

    copied = 0
    for run in sorted(source.iterdir()):
        if not run.is_dir() or not (run / "run.json").is_file():
            continue
        shutil.copytree(run, target / run.name, dirs_exist_ok=True)
        copied += 1

    log.info("api.seeded_demo_runs", runs=copied, source=str(source), target=str(target))
    return copied
