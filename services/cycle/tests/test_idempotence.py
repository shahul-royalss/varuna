"""Baking the same cycle twice produces the same files (P5.9; CLAUDE.md rule 8 and section 14).

Rule 8 asks that "two runs of ``make bake`` on the same inputs produce byte-identical
products" and section 14 lists "idempotent bakes (byte-identical)" under Correctness. Nothing
was checking it, and the ways a bake stops being reproducible are all quiet ones: a timestamp
written into a product rather than only into ``run.json``, a dict iterated in insertion order
that changes with a dependency, an unseeded draw somewhere in the ensemble, a parquet whose
writer stamps its own metadata.

The comparison deliberately excludes ``run.json``: it records ``stage_ms`` and the wall-clock
the run took, which are *supposed* to differ between two runs of the same cycle. Everything
else - the rasters, the segment and node forecasts, the hotspots, the alerts, the pump plan -
is a product and must not.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.slow

# Written per run and expected to differ: timings and the wall clock are provenance, not product.
PROVENANCE = {"run.json"}


def _digest(root: Path) -> dict[str, str]:
    """sha256 of every file under ``root``, keyed by its path relative to it."""
    out: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        key = str(path.relative_to(root)).replace("\\", "/")
        if key in PROVENANCE:
            continue
        out[key] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def _city_is_built(city: str = "mumbai") -> bool:
    from varuna_schemas.paths import city_dir

    return (city_dir(city) / "map" / "segments.geojson").is_file()


@pytest.mark.skipif(
    os.environ.get("VARUNA_SKIP_BAKE") == "1",
    reason="VARUNA_SKIP_BAKE=1 set for a fast run",
)
def test_baking_the_same_cycle_twice_writes_identical_products(tmp_path: Path) -> None:
    """The demo bundle's first cycle, baked twice into two run directories.

    Skipped rather than failed when the city is not built: `make city CITY=mumbai` is a
    ten-minute prerequisite and a clean clone legitimately has not run it. The skip names the
    command, so a reader knows what to run rather than guessing why it is grey.
    """
    if not _city_is_built():
        pytest.skip("city/mumbai is not built; run `make city CITY=mumbai` first")

    from varuna_cycle.twin_cycle import run_cycle

    first = run_cycle(mode="baked", overwrite=True)
    second = run_cycle(mode="baked", overwrite=True)

    assert first.run_id == second.run_id, (
        "the same cycle produced two run ids; the id is built from the city, the cycle "
        f"instant and the engine versions, none of which changed: {first.run_id} then "
        f"{second.run_id}"
    )

    left, right = _digest(first.run_dir), _digest(second.run_dir)
    assert left, f"the bake wrote no products into {first.run_dir}"

    only_left = sorted(set(left) - set(right))
    only_right = sorted(set(right) - set(left))
    assert not only_left and not only_right, (
        f"the two bakes wrote different files; only in the first: {only_left}; "
        f"only in the second: {only_right}"
    )

    differing = sorted(name for name, digest in left.items() if right[name] != digest)
    assert not differing, (
        f"{len(differing)} of {len(left)} products differ between two bakes of the same "
        f"cycle, so the bake is not reproducible (rule 8): {differing[:8]}"
    )


def test_the_cycle_reports_the_numbers_a_rerun_is_allowed_to_change() -> None:
    """`stage_ms` is provenance, and this pins that it is the *only* thing excluded.

    If a future product starts carrying a wall-clock value, the exclusion list above is where
    somebody would be tempted to hide it. Keeping the list to one entry, and asserting it,
    makes that a visible decision rather than a quiet one.
    """
    assert PROVENANCE == {"run.json"}, (
        "something was added to the idempotence exclusion list; a product that cannot be "
        "reproduced is a rule 8 failure, not an exclusion"
    )
