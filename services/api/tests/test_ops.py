"""The authority write path (task D-07; TECH_SPEC 3.6).

Four things are worth a test here and they are not the CRUD.

1. **The gate.** Unset passphrase, missing header, wrong header, spent rate limit - each refused
   with the section 12 envelope, and each leaving nothing behind.
2. **Rule 8.** The sha256 of every file in a baked run, taken before and after a closure, a pump
   status change and a dispatch. An authority edit is an overlay read at request time; if it
   ever became a rewrite, a bake would stop being byte-identical and P5.9 would find out days
   later on someone else's branch. This finds out here.
3. **The loop.** Close a street, ask for a route that used it, and see the route go round it
   with the officer's own reason attached. That is the whole point of the desk.
4. **The optimiser honours a status.** Marking a lorry unavailable has to take it out of the
   next plan, which it did not do before this task.

Every test runs against a temporary ``VARUNA_DATA_DIR`` and ``VARUNA_CITY_DIR``: the ops log is
a file on disk, and a test that wrote into the repository's own ``data/ops`` would leave a
closure behind for the next person who ran the demo.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from varuna_api.routers import ops
from varuna_schemas.constants import IST

RUN_ID = "MUM-20190702T1200Z-sky1.0-twin1.0-flash0.1-baked"
"""A run id that sorts after the seven demo cycles the app seeds on startup.

`seed_demo_runs` copies `demo/runs` into whatever `VARUNA_DATA_DIR` points at, so a test run
that sorted before them would never be the one "latest" resolves to, and every test here would
be quietly measuring the shipped 09:10 cycle instead of its own fixture."""
PASSPHRASE = "monsoon desk 2026"
AUTH = {ops.OPS_HEADER: PASSPHRASE}
T0 = datetime(2019, 7, 2, 8, 45, tzinfo=IST)
ALERT_ID = "VARUNA-MUM-TEST-HINDMATA-SEVERE"

HINDMATA = (72.841, 19.012)
"""The chronic spot the demo is about, used here as a candidate the optimiser can reach."""


def _times(n: int = 36) -> list[str]:
    return [(T0 + timedelta(minutes=5 * k)).isoformat() for k in range(n)]


def _flooding_series() -> list[float]:
    """Six steps dry, two hours above 45 cm, then draining - 120 minutes for a pump to attack."""
    return [10.0] * 6 + [52.0] * 24 + [10.0] * 6


def _alert(alert_id: str, level: str = "severe") -> dict[str, Any]:
    return {
        "id": alert_id,
        "run_id": RUN_ID,
        "scope": "hotspot",
        "level": level,
        "threshold_cm": 45,
        "headline": "Hindmata junction: depth above 45 cm from 09:15 to 11:15",
        "area_desc": "Ward F/South, Hindmata",
        "trigger_p": 1.0,
        "state": "raised",
        "raised_ts": T0.isoformat(),
        "cap_status": "Exercise",
    }


def _seed_run(data: Path) -> Path:
    """A run directory carrying exactly the products the ops endpoints read."""
    run = data / "runs" / RUN_ID
    (run / "depth").mkdir(parents=True)
    (run / "depth" / "bounds.json").write_text("{}", encoding="utf-8")
    (run / "run.json").write_text(
        json.dumps(
            {
                "run_id": RUN_ID,
                "city": "mumbai",
                "cycle_ts": "2019-07-02T08:40:00+05:30",
                "notes": ["Reconstructed replay", "Inferred drain graph"],
                "rain_aoi_mm_h": [31.7, 26.3, 21.2] + [8.0] * 33,
            }
        ),
        encoding="utf-8",
    )
    (run / "alerts.json").write_text(
        json.dumps(
            {"alerts": [_alert(ALERT_ID), _alert("VARUNA-MUM-TEST-SION-MODERATE", "moderate")]}
        ),
        encoding="utf-8",
    )
    (run / "hotspots.json").write_text(
        json.dumps(
            [
                {
                    "hotspot_id": "MUM-HS-01",
                    "name": "Hindmata junction",
                    "lon": HINDMATA[0],
                    "lat": HINDMATA[1],
                    "segment_ids": ["S-NOT-IN-THE-EMULATOR"],
                    "exposure": {"weight": 0.9},
                    "depth_cm": _flooding_series(),
                },
                {
                    "hotspot_id": "MUM-HS-02",
                    "name": "King's Circle",
                    "lon": 72.857,
                    "lat": 19.027,
                    "segment_ids": ["S-NOT-IN-THE-EMULATOR-EITHER"],
                    "exposure": {"weight": 0.6},
                    "depth_cm": _flooding_series(),
                },
            ]
        ),
        encoding="utf-8",
    )
    (run / "segments_wet.json").write_text(
        json.dumps(
            {
                "run_id": RUN_ID,
                "valid_ts": _times(),
                "min_depth_cm": 5.0,
                "n_segments_total": 4,
                "n_segments_wet": 0,
                "depth_cm": {},
                "p_gt": {},
            }
        ),
        encoding="utf-8",
    )
    return run


def _seed_fleet(city: Path) -> None:
    """Two synthetic pumps within lorry range of the seeded candidates."""
    pumps = [
        ("P-01", 2400.0, "Parel depot", 72.838, 19.005),
        ("P-02", 2400.0, "Dadar depot", 72.848, 19.020),
    ]
    city.mkdir(parents=True, exist_ok=True)
    (city / "assets.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {
                            "asset_id": pump_id,
                            "kind": "mobile_pump",
                            "capacity_m3_per_h": capacity,
                            "depot": depot,
                            "status": "available",
                            "synthetic": True,
                        },
                    }
                    for pump_id, capacity, depot, lon, lat in pumps
                ],
            }
        ),
        encoding="utf-8",
    )


@pytest.fixture
def desk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A writable data dir, a city with a fleet, a seeded run and a passphrase."""
    data = tmp_path / "data"
    city = tmp_path / "city"
    monkeypatch.setenv("VARUNA_DATA_DIR", str(data))
    monkeypatch.setenv("VARUNA_CITY_DIR", str(city))
    monkeypatch.setenv(ops.PASSPHRASE_ENV, PASSPHRASE)
    ops.reset_rate_limit()
    _seed_run(data)
    _seed_fleet(city / "mumbai")
    yield tmp_path
    ops.reset_rate_limit()


def _log_lines(data_root: Path, city: str = "mumbai") -> list[str]:
    path = data_root / "data" / "ops" / f"{city}.jsonl"
    return path.read_text(encoding="utf-8").splitlines() if path.is_file() else []


# ---- the gate ----------------------------------------------------------------------------
def test_writes_are_refused_when_the_passphrase_is_not_configured(
    desk: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(ops.PASSPHRASE_ENV)

    res = client.post(
        "/v1/ops/closures",
        json={"segment_id": "S1-000", "reason": "Water main burst", "city": "mumbai"},
        headers=AUTH,
    )

    assert res.status_code == 503, res.text
    error = res.json()["error"]
    assert error["code"] == "ops_writes_disabled"
    assert ops.PASSPHRASE_ENV in error["message"], "the refusal has to name the variable"
    assert not _log_lines(desk), "a refused write appends nothing"


def test_a_write_without_the_header_is_refused_and_a_wrong_one_too(
    desk: Path, client: TestClient
) -> None:
    body = {"segment_id": "S1-000", "reason": "Water main burst", "city": "mumbai"}

    bare = client.post("/v1/ops/closures", json=body)
    wrong = client.post("/v1/ops/closures", json=body, headers={ops.OPS_HEADER: "guess"})

    assert bare.status_code == 401, bare.text
    assert bare.json()["error"]["code"] == "ops_passphrase_required"
    assert ops.OPS_HEADER in bare.json()["error"]["message"]
    assert wrong.status_code == 403, wrong.text
    assert wrong.json()["error"]["code"] == "ops_passphrase_rejected"
    assert not _log_lines(desk), "neither refusal wrote a line"


def test_the_rate_limit_stops_the_thirty_first_write_in_a_minute(
    desk: Path, client: TestClient
) -> None:
    for i in range(ops.WRITES_PER_MINUTE):
        allowed = client.post(
            "/v1/ops/closures",
            json={"segment_id": f"S{i:03d}-000", "reason": "Water", "city": "mumbai"},
            headers=AUTH,
        )
        assert allowed.status_code == 200, allowed.text

    refused = client.post(
        "/v1/ops/closures",
        json={"segment_id": "S999-000", "reason": "Water", "city": "mumbai"},
        headers=AUTH,
    )

    assert refused.status_code == 429, refused.text
    assert refused.json()["error"]["code"] == "rate_limited"
    assert len(_log_lines(desk)) == ops.WRITES_PER_MINUTE, "the refused write appended nothing"


def test_a_refused_passphrase_does_not_spend_the_window(desk: Path, client: TestClient) -> None:
    """Otherwise anyone who can reach the API can lock the real desk out of it for a minute."""
    for _ in range(ops.WRITES_PER_MINUTE + 5):
        client.post(
            "/v1/ops/closures", json={"segment_id": "S1-000"}, headers={ops.OPS_HEADER: "x"}
        )

    allowed = client.post(
        "/v1/ops/closures",
        json={"segment_id": "S1-000", "reason": "Water main burst", "city": "mumbai"},
        headers=AUTH,
    )
    assert allowed.status_code == 200, allowed.text


def test_the_log_says_when_the_api_is_read_only(
    desk: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(ops.PASSPHRASE_ENV)

    body = client.get("/v1/ops/log", params={"city": "mumbai"}).json()

    assert body["writes_enabled"] is False
    assert body["passphrase_env"] == ops.PASSPHRASE_ENV
    assert any("read-only" in note for note in body["notes"])


# ---- closures ----------------------------------------------------------------------------
def test_a_closure_is_appended_read_back_and_lifted_by_a_reopen(
    desk: Path, client: TestClient
) -> None:
    made = client.post(
        "/v1/ops/closures",
        json={
            "segment_id": "S1-000",
            "reason": "Manhole cover lifted",
            "user": "ward officer F/S",
            "city": "mumbai",
        },
        headers=AUTH,
    )
    assert made.status_code == 200, made.text
    assert made.json()["entry"]["id"]
    assert made.json()["n_closed"] == 1

    live = client.get("/v1/ops/closures", params={"city": "mumbai"}).json()
    assert [c["segment_id"] for c in live["closures"]] == ["S1-000"]
    assert live["closures"][0]["reason"] == "Manhole cover lifted"
    assert live["closures"][0]["user"] == "ward officer F/S"

    lifted = client.post(
        "/v1/ops/closures",
        json={"segment_id": "S1-000", "city": "mumbai", "reopen": True},
        headers=AUTH,
    )
    assert lifted.status_code == 200, lifted.text
    assert lifted.json()["n_closed"] == 0
    assert len(_log_lines(desk)) == 2, "a reopen appends; it does not delete"


def test_an_expiry_is_applied_at_the_time_asked_about(desk: Path, client: TestClient) -> None:
    """A closure until noon is a closure at eleven and an open road at one."""
    now = datetime.now(IST)
    until = now + timedelta(hours=1)
    made = client.post(
        "/v1/ops/closures",
        json={
            "segment_id": "S1-000",
            "reason": "Water main burst",
            "city": "mumbai",
            "until": until.isoformat(),
        },
        headers=AUTH,
    )
    assert made.status_code == 200, made.text
    assert made.json()["n_closed"] == 1

    later = client.get(
        "/v1/ops/closures",
        params={"city": "mumbai", "at": (now + timedelta(hours=2)).isoformat()},
    ).json()
    assert later["n_closed"] == 0
    assert later["n_entries"] == 1, "the entry is still in the log; it is the closure that lapsed"


def test_a_closure_that_has_already_expired_is_refused(desk: Path, client: TestClient) -> None:
    """Accepting it would print '0 closed' beside the officer's own entry."""
    res = client.post(
        "/v1/ops/closures",
        json={
            "segment_id": "S1-000",
            "reason": "Water main burst",
            "city": "mumbai",
            "until": "2019-07-02T12:00:00+05:30",
        },
        headers=AUTH,
    )

    assert res.status_code == 422, res.text
    assert res.json()["error"]["code"] == "closure_already_expired"
    assert not _log_lines(desk)


def test_a_closure_without_a_reason_is_refused(desk: Path, client: TestClient) -> None:
    res = client.post(
        "/v1/ops/closures", json={"segment_id": "S1-000", "city": "mumbai"}, headers=AUTH
    )

    assert res.status_code == 422, res.text
    assert res.json()["error"]["code"] == "closure_needs_a_reason"
    assert not _log_lines(desk)


# ---- alerts ------------------------------------------------------------------------------
def test_an_acknowledgement_survives_a_reload(desk: Path, client: TestClient, app: FastAPI) -> None:
    acked = client.post(
        f"/v1/alerts/{ALERT_ID}/ack",
        json={"user": "control room", "note": "Traffic police informed", "city": "mumbai"},
        headers=AUTH,
    )

    assert acked.status_code == 200, acked.text
    alert = acked.json()["alert"]
    assert alert["state"] == "acknowledged"
    assert alert["acknowledged_by"] == "control room"
    assert alert["acknowledged_ts"]

    # A second client is a reload: nothing is held in memory, the state is in the log on disk.
    with TestClient(app) as reloaded:
        queue = reloaded.get("/v1/ops/alerts", params={"city": "mumbai", "run_id": RUN_ID}).json()[
            "alerts"
        ]
    states = {a["id"]: a["state"] for a in queue}
    assert states[ALERT_ID] == "acknowledged"
    assert states["VARUNA-MUM-TEST-SION-MODERATE"] == "raised", "only the one acted on changed"


def test_escalation_records_the_step_and_keeps_the_acknowledgement(
    desk: Path, client: TestClient
) -> None:
    client.post(
        f"/v1/alerts/{ALERT_ID}/ack", json={"user": "ward officer", "city": "mumbai"}, headers=AUTH
    )
    res = client.post(
        f"/v1/alerts/{ALERT_ID}/escalate",
        json={"user": "ward officer", "escalate_to": "police_traffic", "city": "mumbai"},
        headers=AUTH,
    )

    assert res.status_code == 200, res.text
    alert = res.json()["alert"]
    assert alert["state"] == "escalated"
    assert alert["escalated_to"] == "police_traffic"
    assert alert["acknowledged_by"] == "ward officer", "the earlier acknowledgement is not lost"
    assert [h["state"] for h in alert["history"]] == ["acknowledged", "escalated"]


def test_acknowledging_an_alert_the_run_never_raised_is_a_404(
    desk: Path, client: TestClient
) -> None:
    res = client.post(
        "/v1/alerts/VARUNA-MUM-INVENTED/ack",
        json={"user": "control room", "city": "mumbai"},
        headers=AUTH,
    )

    assert res.status_code == 404, res.text
    assert res.json()["error"]["code"] == "alert_not_found"
    assert not _log_lines(desk), "nothing is recorded against an alert that does not exist"


# ---- pumps -------------------------------------------------------------------------------
def test_the_optimiser_assigns_the_fleet_and_prices_it_honestly(
    desk: Path, client: TestClient
) -> None:
    res = client.post("/v1/pumps/optimise", json={"city": "mumbai"}, headers=AUTH)

    assert res.status_code == 200, res.text
    plan = res.json()
    assert plan["n_pumps"] == 2
    assert plan["n_assignable"] == 2
    assert plan["withheld"] == []
    assert {a["pump_id"] for a in plan["assignments"]} == {"P-01", "P-02"}
    assert all(a["minutes_saved"] > 0 for a in plan["assignments"])
    assert plan["inventory"] == "synthetic"
    assert plan["benefit_label"], "every benefit carries the label of the model that made it"
    assert any("not written into the run" in note for note in plan["notes"])


def test_a_pump_the_desk_marked_unavailable_is_not_assigned(desk: Path, client: TestClient) -> None:
    before = client.post("/v1/pumps/optimise", json={"city": "mumbai"}, headers=AUTH).json()
    assert "P-01" in {a["pump_id"] for a in before["assignments"]}

    marked = client.post(
        "/v1/ops/pumps/P-01/status",
        json={"status": "unavailable", "user": "depot", "city": "mumbai"},
        headers=AUTH,
    )
    assert marked.status_code == 200, marked.text
    assert marked.json()["pumps"]["P-01"]["status"] == "unavailable"

    after = client.post("/v1/pumps/optimise", json={"city": "mumbai"}, headers=AUTH).json()
    assert "P-01" not in {a["pump_id"] for a in after["assignments"]}
    assert after["n_assignable"] == 1
    assert after["withheld"] == [{"pump_id": "P-01", "status": "unavailable"}]
    assert any("P-01" in note for note in after["notes"]), "the plan says which lorry it withheld"
    assert [p["pump_id"] for p in after["pumps"]] == ["P-01", "P-02"], (
        "a withheld pump stays on the board with its status; it is not silently dropped"
    )


def test_a_moved_pump_is_still_assignable_from_its_new_depot(
    desk: Path, client: TestClient
) -> None:
    """``moved`` carries a point, which would be pointless if the lorry could not be sent."""
    client.post(
        "/v1/ops/pumps/P-01/status",
        json={"status": "moved", "user": "depot", "city": "mumbai", "lon": 72.840, "lat": 19.011},
        headers=AUTH,
    )

    plan = client.post("/v1/pumps/optimise", json={"city": "mumbai"}, headers=AUTH).json()

    moved = next(p for p in plan["pumps"] if p["pump_id"] == "P-01")
    assert moved["assignable"] is True
    assert moved["moved"] is True
    assert (moved["lon"], moved["lat"]) == (72.840, 19.011)
    assert "P-01" in {a["pump_id"] for a in plan["assignments"]}


def test_the_milp_solver_is_refused_by_name(desk: Path, client: TestClient) -> None:
    res = client.post("/v1/pumps/optimise", json={"city": "mumbai", "solver": "milp"}, headers=AUTH)

    assert res.status_code == 501, res.text
    assert "P8.9" in res.json()["error"]["message"]


def test_dispatch_records_a_plain_language_order(desk: Path, client: TestClient) -> None:
    res = client.post(
        "/v1/pumps/dispatch",
        json={"city": "mumbai", "user": "control room", "pump_ids": ["P-01"]},
        headers=AUTH,
    )

    assert res.status_code == 202, res.text
    body = res.json()
    assert body["n_dispatched"] == 1
    order = body["orders"][0]
    assert order["order_text"].startswith("Move P-01 from Parel depot to ")
    assert "ETA" in order["order_text"] and "min above 45 cm" in order["order_text"]
    assert any("synthetic" in note for note in body["notes"])

    logged = client.get("/v1/ops/log", params={"city": "mumbai", "kind": "dispatch"}).json()
    assert logged["n_entries"] == 1
    assert logged["entries"][0]["pump_id"] == "P-01"
    assert logged["entries"][0]["user"] == "control room"


def test_dispatching_a_pump_the_plan_did_not_assign_is_refused(
    desk: Path, client: TestClient
) -> None:
    res = client.post(
        "/v1/pumps/dispatch",
        json={"city": "mumbai", "user": "control room", "pump_ids": ["P-99"]},
        headers=AUTH,
    )

    assert res.status_code == 422, res.text
    assert res.json()["error"]["code"] == "pump_not_in_plan"
    assert not _log_lines(desk), "nothing is dispatched when part of the order is unknown"


def test_optimise_without_a_built_city_says_which_command_builds_one(
    desk: Path, client: TestClient
) -> None:
    res = client.post("/v1/pumps/optimise", json={"city": "chennai"}, headers=AUTH)

    assert res.status_code == 503, res.text
    assert "make city CITY=chennai" in res.json()["error"]["message"]


# ---- rule 8 ------------------------------------------------------------------------------
def _digest(folder: Path) -> dict[str, str]:
    return {
        str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(folder.rglob("*"))
        if p.is_file()
    }


def test_no_authority_edit_changes_a_byte_of_a_baked_run(desk: Path, client: TestClient) -> None:
    """CLAUDE.md rule 8 and P5.9: the desk overlays a run, it never rewrites one.

    A closure, a pump status change and a dispatch - the three writes that could plausibly want
    to touch a product - taken against the sha256 of every file the cycle wrote.
    """
    run = desk / "data" / "runs" / RUN_ID
    before = _digest(run)
    assert before, "there is something to compare"

    closed = client.post(
        "/v1/ops/closures",
        json={"segment_id": "S1-000", "reason": "Manhole cover lifted", "city": "mumbai"},
        headers=AUTH,
    )
    marked = client.post(
        "/v1/ops/pumps/P-02/status",
        json={"status": "unavailable", "user": "depot", "city": "mumbai"},
        headers=AUTH,
    )
    dispatched = client.post(
        "/v1/pumps/dispatch", json={"city": "mumbai", "user": "control room"}, headers=AUTH
    )
    acked = client.post(
        f"/v1/alerts/{ALERT_ID}/ack", json={"user": "control room", "city": "mumbai"}, headers=AUTH
    )
    assert [closed.status_code, marked.status_code, dispatched.status_code, acked.status_code] == [
        200,
        200,
        202,
        200,
    ], "all four writes were accepted, so all four had the chance to rewrite something"

    after = _digest(run)
    assert after == before, "an authority edit rewrote a product; it must only append an overlay"
    assert len(_log_lines(desk)) >= 4, "the edits landed somewhere - in the ops log, beside the run"
