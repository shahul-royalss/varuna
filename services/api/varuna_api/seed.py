"""Seeding a deployment with the demo runs that ship in the repo.

The console is useless without a run: no depth raster, no wet streets, no hotspot rail, just the
honest empty state telling the operator to bake one. On the demo laptop `make bake` does that.
On a hosted deployment nothing can - a cycle takes about three minutes of CPU and the container
would spend its first quarter hour serving 404s.

So a small set of baked cycles is committed under ``demo/runs`` and copied onto the volume at
start-up. They are the same artifacts `make bake` writes, minus ``segment_forecast.parquet``:
that file is the product of record and `services/verify` wants it, but it is 19 MB per cycle and
the console never reads it - the compact ``segments_wet.json`` beside it is what the map draws
(`varuna_products.depth`).

**Re-seeding, and why it needs a marker.** A first version of this only seeded into an *empty*
run directory, which is right for protecting a locally baked cycle and wrong for everything
else: the moment the shipped set gained a product - the pump plan, as it happened - the volume
already held the older copies and would never take the new ones. `/v1/pumps` stayed 404 on a
deployment whose image contained the plan.

So each seeded run carries a ``.seeded`` marker holding a fingerprint of the demo set. A run
with no marker was baked on this machine and is never touched. A run whose marker matches is
already current. A run whose marker differs, or is missing from the volume entirely, is
replaced. The fingerprint is content-derived, so adding a file to the demo set is enough to make
the next boot pick it up; nothing has to be remembered to bump.

This is a copy, not a fallback path in the reader: once seeded the runs are ordinary runs on the
volume, a freshly baked cycle sits beside them, and nothing downstream has to know where they
came from.
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

import structlog
from varuna_schemas.paths import repo_root, runs_dir

log = structlog.get_logger("varuna.api.seed")

__all__ = ["MARKER", "demo_runs_dir", "run_fingerprint", "seed_demo_runs"]

MARKER = ".seeded"
"""File written inside a seeded run, holding the fingerprint of the copy it came from."""


def demo_runs_dir() -> Path:
    """Where the committed demo runs live."""
    return repo_root() / "demo" / "runs"


def run_fingerprint(run: Path) -> str:
    """A short content fingerprint of one demo run: every file's relative path and size.

    Sizes rather than bytes, because the point is to notice that the shipped set has *changed*,
    and re-hashing 2.7 MB of PNGs on every boot to learn that would be an odd way to spend a
    container's first second. A product gained, lost or regenerated all move a size.
    """
    digest = hashlib.sha256()
    for path in sorted(run.rglob("*")):
        if path.is_file() and path.name != MARKER:
            digest.update(path.relative_to(run).as_posix().encode("utf-8"))
            digest.update(str(path.stat().st_size).encode("utf-8"))
    return digest.hexdigest()[:16]


def seed_demo_runs() -> int:
    """Copy the committed demo runs onto the volume. Returns how many were written.

    A run the deployment baked for itself - anything without a :data:`MARKER` - is left alone
    even when a demo run of the same id exists, because that run is the deployment's own work
    and the shipped set is only a fallback for a volume that has none.
    """
    source = demo_runs_dir()
    if not source.is_dir():
        return 0

    target = runs_dir()
    target.mkdir(parents=True, exist_ok=True)

    copied = 0
    skipped_local = 0
    current = 0
    for run in sorted(source.iterdir()):
        if not run.is_dir() or not (run / "run.json").is_file():
            continue

        destination = target / run.name
        fingerprint = run_fingerprint(run)
        marker = destination / MARKER

        if destination.is_dir():
            if not marker.is_file():
                # Baked here. Not ours to replace.
                skipped_local += 1
                continue
            if marker.read_text(encoding="utf-8").strip() == fingerprint:
                current += 1
                continue
            shutil.rmtree(destination)

        shutil.copytree(run, destination)
        marker.write_text(fingerprint + "\n", encoding="utf-8")
        copied += 1

    log.info(
        "api.seeded_demo_runs",
        written=copied,
        already_current=current,
        left_alone=skipped_local,
        source=str(source),
        target=str(target),
    )
    return copied
