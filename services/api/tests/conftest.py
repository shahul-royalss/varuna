from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from varuna_api.main import create_app
from varuna_api.state import AppState
from varuna_cycle.bus import Bus
from varuna_cycle.registry import RunRegistry
from varuna_schemas.models import RunMeta
from varuna_schemas.samples import sample
from varuna_schemas.settings import Settings


@pytest.fixture
def settings() -> Settings:
    return Settings(
        varuna_city="mumbai",
        varuna_bundle="MUM-2019-07-02",
        varuna_mode="replay",
        varuna_offline=True,
        cors_origins=["http://localhost:3000"],
        _env_file=None,  # type: ignore[call-arg]
    )


@pytest.fixture
def registry(tmp_path: Path) -> RunRegistry:
    return RunRegistry(tmp_path / "runs")


@pytest.fixture
def bus() -> Bus:
    return Bus()


@pytest.fixture
def state(settings: Settings, registry: RunRegistry, bus: Bus) -> AppState:
    return AppState(settings=settings, registry=registry, bus=bus, ws_heartbeat_s=0.2)


@pytest.fixture
def app(state: AppState) -> FastAPI:
    return create_app(state=state)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def run_meta() -> RunMeta:
    meta = sample("RunMeta")
    assert isinstance(meta, RunMeta)
    return meta


@pytest.fixture
def baked_run(registry: RunRegistry, run_meta: RunMeta) -> RunMeta:
    registry.write_meta(run_meta)
    return run_meta
