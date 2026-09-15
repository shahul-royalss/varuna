"""The verification sweep is scored once per set of inputs (routers/verify.py)."""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from varuna_api.routers import verify

EVENT = "MUM-2019-07-02"


@pytest.fixture
def scratch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Path, list[str]]]:
    bundles = tmp_path / "bundles"
    (bundles / EVENT).mkdir(parents=True)
    (bundles / EVENT / "ground_truth.geojson").write_text('{"features": []}', encoding="utf-8")
    runs = tmp_path / "data" / "runs"
    (runs / "MUM-20190702T0310Z-sky1.0-twin1.0-flash0.1-baked").mkdir(parents=True)
    (runs / "MUM-20190702T0310Z-sky1.0-twin1.0-flash0.1-baked" / "segments_wet.json").write_text(
        "{}", encoding="utf-8"
    )
    monkeypatch.setenv("VARUNA_BUNDLES_DIR", str(bundles))
    monkeypatch.setenv("VARUNA_DATA_DIR", str(tmp_path / "data"))

    calls: list[str] = []

    def fake_sweep(event: str) -> dict[str, Any]:
        calls.append(event)
        return {"event": event, "calls": len(calls)}

    import varuna_verify.event

    monkeypatch.setattr(varuna_verify.event, "sweep", fake_sweep)
    verify.clear_cache()
    yield runs, calls
    verify.clear_cache()


def test_a_second_request_with_unchanged_inputs_is_not_rescored(
    scratch: tuple[Path, list[str]],
) -> None:
    _, calls = scratch
    first = verify.scored_sweep(EVENT)
    second = verify.scored_sweep(EVENT)
    assert calls == [EVENT]
    assert second == first


def test_a_new_run_is_scored_again(scratch: tuple[Path, list[str]]) -> None:
    runs, _ = scratch
    verify.scored_sweep(EVENT)
    newer = runs / "MUM-20190702T0340Z-sky1.0-twin1.0-flash0.1-baked"
    newer.mkdir()
    (newer / "segments_wet.json").write_text("{}", encoding="utf-8")
    assert verify.scored_sweep(EVENT)["calls"] == 2


def test_a_rewritten_run_is_scored_again(scratch: tuple[Path, list[str]]) -> None:
    runs, calls = scratch
    verify.scored_sweep(EVENT)
    wet = runs / "MUM-20190702T0310Z-sky1.0-twin1.0-flash0.1-baked" / "segments_wet.json"
    wet.write_text('{"rewritten": true}', encoding="utf-8")
    later = time.time_ns() + 5_000_000_000
    os.utime(wet, ns=(later, later))
    assert verify.scored_sweep(EVENT)["calls"] == 2
    assert len(calls) == 2
