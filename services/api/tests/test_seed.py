"""What the demo-run seeding is allowed to overwrite (ADR-0024)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from varuna_api import seed


def _demo_run(root: Path, name: str, extra: dict[str, str] | None = None) -> Path:
    run = root / name
    (run / "depth").mkdir(parents=True)
    (run / "run.json").write_text(json.dumps({"run_id": name}), encoding="utf-8")
    (run / "depth" / "bounds.json").write_text("{}", encoding="utf-8")
    for filename, content in (extra or {}).items():
        (run / filename).write_text(content, encoding="utf-8")
    return run


@pytest.fixture
def dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """A demo source and a run target, both isolated from the repo."""
    source = tmp_path / "demo" / "runs"
    source.mkdir(parents=True)
    target = tmp_path / "data" / "runs"
    monkeypatch.setattr(seed, "demo_runs_dir", lambda: source)
    monkeypatch.setattr(seed, "runs_dir", lambda: target)
    return source, target


def test_an_empty_volume_gets_the_whole_shipped_set(dirs: tuple[Path, Path]) -> None:
    source, target = dirs
    _demo_run(source, "RUN-A")
    _demo_run(source, "RUN-B")

    assert seed.seed_demo_runs() == 2
    assert (target / "RUN-A" / "run.json").is_file()
    assert (target / "RUN-B" / "depth" / "bounds.json").is_file()


def test_seeding_twice_writes_nothing_the_second_time(dirs: tuple[Path, Path]) -> None:
    source, _target = dirs
    _demo_run(source, "RUN-A")

    assert seed.seed_demo_runs() == 1
    assert seed.seed_demo_runs() == 0, "an unchanged set must not be recopied every boot"


def test_a_changed_demo_set_replaces_what_it_seeded(dirs: tuple[Path, Path]) -> None:
    """The bug this marker exists for: a shipped set that gains a product must land.

    `/v1/pumps` stayed 404 on a deployment whose image already carried `pump_plan.json`,
    because the volume was merely non-empty and the first version of this seeded only into an
    empty one.
    """
    source, target = dirs
    _demo_run(source, "RUN-A")
    assert seed.seed_demo_runs() == 1
    assert not (target / "RUN-A" / "pump_plan.json").exists()

    (source / "RUN-A" / "pump_plan.json").write_text('{"assignments":[]}', encoding="utf-8")

    assert seed.seed_demo_runs() == 1
    assert (target / "RUN-A" / "pump_plan.json").is_file()


def test_a_locally_baked_run_is_never_replaced(dirs: tuple[Path, Path]) -> None:
    """A cycle this deployment computed is its own work, whatever the shipped set holds.

    A baked run is recognised by being complete: it has everything the shipped set has and the
    19 MB `segment_forecast.parquet` besides, which the shipped set deliberately omits.
    """
    source, target = dirs
    _demo_run(source, "RUN-A", {"note.txt": "from the repo"})

    baked = _demo_run(target.parent / "runs", "RUN-A", {"note.txt": "baked here"})
    (baked / "segment_forecast.parquet").write_text("the product of record", encoding="utf-8")

    assert seed.seed_demo_runs() == 0
    assert (target / "RUN-A" / "note.txt").read_text(encoding="utf-8") == "baked here"


def test_a_copy_seeded_before_markers_existed_is_brought_up_to_date(
    dirs: tuple[Path, Path],
) -> None:
    """The migration this whole mechanism exists for.

    The volume already held runs copied by the first version of this function, which wrote no
    marker. Reading "no marker" as "baked here" left `/v1/pumps` 404 on a deployment whose image
    already carried the plan. An unmarked copy that is *missing* something the shipped set has
    is an old seed, and is replaced.
    """
    source, target = dirs
    _demo_run(source, "RUN-A", {"pump_plan.json": '{"assignments":[]}'})

    # What the old seeder left: the same run, without the product added since.
    _demo_run(target.parent / "runs", "RUN-A")

    assert seed.seed_demo_runs() == 1
    assert (target / "RUN-A" / "pump_plan.json").is_file()
    assert (target / "RUN-A" / seed.MARKER).is_file()


def test_no_demo_directory_is_not_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A checkout without `demo/` still boots; the console just shows its empty state."""
    monkeypatch.setattr(seed, "demo_runs_dir", lambda: tmp_path / "absent")
    monkeypatch.setattr(seed, "runs_dir", lambda: tmp_path / "runs")
    assert seed.seed_demo_runs() == 0
