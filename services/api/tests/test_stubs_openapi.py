from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from varuna_api.cli import write_openapi
from varuna_schemas.samples import sample_json

SECTION_12_PATHS = [
    "/healthz",
    "/v1/runs",
    "/v1/runs/{run_id}",
    "/v1/nowcast/segments",
    "/v1/nowcast/raster",
    "/v1/nowcast/hotspots",
    "/v1/nowcast/segments/{segment_id}/series",
    "/v1/drains/health",
    "/v1/drains/health.csv",
    "/v1/observations",
    "/v1/reports",
    "/v1/route",
    "/v1/reachability",
    "/v1/feeds/road-conditions",
    "/v1/alerts",
    "/v1/alerts/{alert_id}.cap",
    "/v1/alerts/{alert_id}/ack",
    "/v1/alerts/{alert_id}/escalate",
    "/v1/pumps",
    "/v1/pumps/optimise",
    "/v1/pumps/dispatch",
    "/v1/whatif",
    "/v1/whatif/physics-check",
    "/v1/replay/bundles",
    "/v1/replay/play",
    "/v1/replay/pause",
    "/v1/replay/seek",
    "/v1/replay/speed",
    "/v1/replay/clock",
    "/v1/cycle/compute",
    "/v1/cycle/status",
    "/v1/onboard",
    "/v1/onboard/{job_id}",
    "/v1/verification",
    "/v1/city/{city}/layers/{name}",
]

STUB_CALLS: list[tuple[str, str, dict[str, object] | None, dict[str, str] | None]] = [
    ("GET", "/v1/nowcast/segments", None, None),
    ("GET", "/v1/nowcast/raster", None, None),
    ("GET", "/v1/nowcast/hotspots", None, None),
    ("GET", "/v1/nowcast/segments/88213/series", None, None),
    ("GET", "/v1/drains/health", None, None),
    ("GET", "/v1/drains/health.csv", None, None),
    ("GET", "/v1/observations", None, None),
    ("POST", "/v1/reports", sample_json("ReportIn"), None),
    ("POST", "/v1/route", sample_json("RouteRequest"), None),
    ("GET", "/v1/reachability", None, {"facility": "kem-hospital"}),
    ("GET", "/v1/feeds/road-conditions", None, None),
    ("GET", "/v1/alerts", None, None),
    ("GET", "/v1/alerts/ALT-1.cap", None, None),
    ("POST", "/v1/alerts/ALT-1/ack", {"user": "ward officer"}, None),
    ("POST", "/v1/alerts/ALT-1/escalate", {"user": "ward officer"}, None),
    ("GET", "/v1/pumps", None, None),
    ("POST", "/v1/pumps/optimise", {}, None),
    ("POST", "/v1/pumps/dispatch", {"plan_id": "plan-1"}, None),
    ("POST", "/v1/whatif", sample_json("WhatIfRequest"), None),
    ("POST", "/v1/whatif/physics-check", sample_json("PhysicsCheckRequest"), None),
    ("GET", "/v1/replay/bundles", None, None),
    ("GET", "/v1/replay/clock", None, None),
    ("POST", "/v1/replay/play", None, None),
    ("POST", "/v1/replay/pause", None, None),
    ("POST", "/v1/replay/seek", sample_json("ReplaySeekRequest"), None),
    ("POST", "/v1/replay/speed", sample_json("ReplaySpeedRequest"), None),
    ("POST", "/v1/cycle/compute", sample_json("ComputeRequest"), None),
    ("POST", "/v1/onboard", {"city": "chennai"}, None),
    ("GET", "/v1/onboard/job-1", None, None),
    ("GET", "/v1/verification", None, {"event": "MUM-2019-07-02"}),
    ("GET", "/v1/city/mumbai/layers/segments", None, None),
]


@pytest.mark.parametrize(("method", "path", "body", "params"), STUB_CALLS)
def test_stub_returns_501_envelope(
    client: TestClient,
    method: str,
    path: str,
    body: dict[str, object] | None,
    params: dict[str, str] | None,
) -> None:
    res = client.request(method, path, json=body, params=params)
    assert res.status_code == 501, res.text
    err = res.json()["error"]
    assert err["code"] == "not_implemented"
    assert "lands in Phase" in err["message"]
    assert err["run_id"] is None


def test_openapi_contains_every_section_12_path(client: TestClient) -> None:
    doc = client.get("/openapi.json").json()
    assert doc["info"]["title"] == "VARUNA API"
    assert doc["info"]["version"] == "0.1.0"
    assert doc["openapi"].startswith("3.1")
    missing = [p for p in SECTION_12_PATHS if p not in doc["paths"]]
    assert not missing, f"missing from OpenAPI: {missing}"
    schemas = doc["components"]["schemas"]
    for name in ("ErrorEnvelope", "RunMeta", "RunList", "CycleStatus", "RouteResponse"):
        assert name in schemas
    assert "501" in doc["paths"]["/v1/route"]["post"]["responses"]
    assert "404" in doc["paths"]["/v1/runs/{run_id}"]["get"]["responses"]
    assert (
        doc["paths"]["/v1/nowcast/raster"]["get"]["responses"]["200"]["content"].get("image/png")
        is not None
    )


def test_write_openapi_is_deterministic(tmp_path: Path) -> None:
    first = write_openapi(tmp_path / "a" / "openapi.json").read_text(encoding="utf-8")
    second = write_openapi(tmp_path / "b" / "openapi.json").read_text(encoding="utf-8")
    assert first == second
    assert first.endswith("\n")
    doc = json.loads(first)
    assert list(doc.keys()) == sorted(doc.keys())
    assert "/v1/runs" in doc["paths"]
