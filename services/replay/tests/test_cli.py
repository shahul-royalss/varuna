"""``varuna bundle`` and ``varuna replay`` on the command line (task P2.1).

Rule 15 says nobody opens a terminal on stage, but everything before the rehearsal happens
here, so the commands must say what went wrong and exit with a code a Makefile can read.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner
from varuna_replay.cli import app, bundle_app
from varuna_replay.domain import StormDomain

runner = CliRunner()


def test_bare_bundle_still_prints_the_phase_gate() -> None:
    """Generating the reconstruction is P2.3-P2.6, so ``varuna bundle`` says so and exits 2."""
    result = runner.invoke(bundle_app, [], env={"COLUMNS": "160"})
    assert result.exit_code == 2
    assert "Phase 2" in result.stdout
    assert "varuna bundle validate" in result.stdout


def test_validate_passes_a_good_bundle(full_bundle: Path) -> None:
    result = runner.invoke(bundle_app, ["validate", str(full_bundle)], env={"COLUMNS": "160"})
    assert result.exit_code == 0, result.stdout
    assert "Bundle is valid" in result.stdout
    assert "B6  groundtruth.sourced" in result.stdout


def test_validate_fails_and_names_the_rule_and_the_file(full_bundle: Path) -> None:
    (full_bundle / "tide.csv").unlink()
    result = runner.invoke(bundle_app, ["validate", str(full_bundle)], env={"COLUMNS": "160"})
    assert result.exit_code == 1
    assert "fail  B3  members.present" in result.stdout
    assert "tide.csv" in result.stdout
    assert "Bundle is not valid" in result.stdout


def test_validate_of_a_missing_bundle_says_so(tmp_path: Path) -> None:
    result = runner.invoke(bundle_app, ["validate", str(tmp_path / "MUM-GHOST")])
    assert result.exit_code == 1
    assert "no such bundle folder" in result.stdout


def test_list_shows_what_is_on_disk(
    tmp_path: Path, domain: StormDomain, make_bundle: Callable[..., Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VARUNA_BUNDLES_DIR", str(tmp_path))
    empty = runner.invoke(bundle_app, ["list"])
    assert empty.exit_code == 0
    assert "No bundles yet" in empty.stdout

    make_bundle(tmp_path / "MUM-TEST-2019", domain)
    listed = runner.invoke(bundle_app, ["list"], env={"COLUMNS": "160"})
    assert listed.exit_code == 0
    assert "MUM-TEST-2019" in listed.stdout
    assert "Reconstructed replay" in listed.stdout


def test_list_survives_a_broken_manifest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VARUNA_BUNDLES_DIR", str(tmp_path))
    broken = tmp_path / "MUM-BROKEN"
    broken.mkdir()
    (broken / "manifest.json").write_text("{ not json", encoding="utf-8")
    result = runner.invoke(bundle_app, ["list"], env={"COLUMNS": "160"})
    assert result.exit_code == 0
    assert "unreadable manifest" in result.stdout


def test_show_prints_the_honesty_labels(full_bundle: Path) -> None:
    result = runner.invoke(bundle_app, ["show", str(full_bundle)], env={"COLUMNS": "200"})
    assert result.exit_code == 0
    assert "Reconstructed replay" in result.stdout
    assert "synthetic" in result.stdout
    assert "Inferred, not measured" in result.stdout, "the calibration basis must be visible"
    assert "ok           manifest.json" in result.stdout


def test_design_writes_and_validates_a_bundle(tmp_path: Path) -> None:
    out = tmp_path / "MUM-IDF-25yr"
    result = runner.invoke(
        bundle_app, ["design", "--city", "mumbai", "--out-dir", str(out)], env={"COLUMNS": "200"}
    )
    assert result.exit_code == 0, result.stdout
    assert "Bundle is valid" in result.stdout
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["label"] == "Design storm"


def test_design_of_an_unknown_city_says_which_cities_exist(tmp_path: Path) -> None:
    result = runner.invoke(bundle_app, ["design", "--city", "atlantis", "--out-dir", str(tmp_path)])
    assert result.exit_code != 0
    assert isinstance(result.exception, FileNotFoundError)
    assert "mumbai" in str(result.exception)


def test_the_replay_app_mirrors_the_bundle_commands(full_bundle: Path) -> None:
    validated = runner.invoke(app, ["validate", str(full_bundle)], env={"COLUMNS": "160"})
    assert validated.exit_code == 0
    assert "Bundle is valid" in validated.stdout

    storm = runner.invoke(app, ["storm", str(full_bundle)], env={"COLUMNS": "160"})
    assert storm.exit_code == 0
    assert "cell-01" in storm.stdout
    assert "birth" in storm.stdout and "sigma" in storm.stdout


def test_the_storm_table_of_a_design_storm_explains_itself(tmp_path: Path) -> None:
    from varuna_replay.build import build_design_bundle, load_city

    result = build_design_bundle(load_city("mumbai"), out_dir=tmp_path / "MUM-IDF-25yr")
    printed = runner.invoke(app, ["storm", str(result.root)], env={"COLUMNS": "200"})
    assert printed.exit_code == 0
    assert "records no storm design" in printed.stdout
    assert "intensity-duration-frequency" in printed.stdout
