"""Building ``MUM-2019-07-02``: the calibration, the placement and the honesty (P2.3-P2.6).

The bundle these tests build is a miniature - a 20 km domain, a handful of pins, a chain of
roads - because what has to be checked is not the size of the storm but the claims the
manifest makes about it: that the window accumulation is an inference from a stated share of a
sourced total, that the cells are aimed at where water was reported, that the tide says it is
illustrative, and that two builds with one seed are byte for byte the same file.

One test at the end builds the real bundle from the real research files and the real city
layers, and is skipped when ``make city CITY=mumbai`` has not been run.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from varuna_replay import evidence, streams
from varuna_replay.build import (
    PIN_CLUSTERS,
    ReconstructionInputs,
    allocate_cells,
    build_bundle,
    build_reconstruction_bundle,
    fit_storm_to_pins,
    latitude_clusters,
    load_city,
    load_reconstruction_inputs,
)
from varuna_replay.bundle import BundleLayout, load_manifest
from varuna_replay.domain import StormDomain
from varuna_replay.storm import PEAK_RANGE_MM_H
from varuna_replay.validate import validate_bundle
from varuna_schemas.constants import IST
from varuna_schemas.models.bundle import GroundTruthPin
from varuna_schemas.models.city import CityConfig, RadarDomain
from varuna_schemas.paths import city_dir

BUNDLE_ID = evidence.BUNDLE_ID

PIN_SITES: tuple[tuple[str, float, float, str], ...] = (
    ("MUM19-01", 72.8421396, 19.010099, "2019-07-01T10:44:00+05:30"),
    ("MUM19-07", 72.8868461, 19.0679196, "2019-07-02T08:07:00+05:30"),
    ("MUM19-08", 72.8590161, 19.0325417, "2019-07-02T08:47:00+05:30"),
    ("MUM19-10", 72.8428330, 19.0904503, "2019-07-02T08:47:00+05:30"),
    ("MUM19-18", 72.8577375, 19.0316822, "2019-07-02T09:10:00+05:30"),
    ("MUM19-24", 72.8470336, 19.1192749, "2019-07-02T12:09:00+05:30"),
)
"""Six of the curated pins, keeping their real coordinates and times: two south, two middle,
two north, so the three-cluster fit has something to fit."""


def small_config() -> CityConfig:
    """Mumbai's real bbox and CRS on a 20 km radar domain, so a build takes a second."""
    return load_city("mumbai").model_copy(
        update={
            "radar_domain": RadarDomain(
                center_lon=72.86, center_lat=19.065, size_km=20.0, res_m=500.0
            )
        }
    )


def make_pins() -> list[dict[str, Any]]:
    return [
        {
            "id": pin_id,
            "ts": ts,
            "ts_uncertainty_min": 20,
            "name": f"Sourced pin {pin_id}",
            "lon": lon,
            "lat": lat,
            "depth_cm": None,
            "depth_phrase": None,
            "kind": "log",
            "text": "Civic log entry",
            "source_url": "https://scroll.in/latest/929092",
            "inside_aoi": True,
            "synthetic": False,
        }
        for pin_id, lon, lat, ts in PIN_SITES
    ]


def make_segments(config: CityConfig, pins: list[dict[str, Any]]) -> streams.SegmentTable:
    """Four segments around each pin, so every in-window pin has something to snap to."""
    x, y = streams.project([pin["lon"] for pin in pins], [pin["lat"] for pin in pins], config.crs)
    ids: list[str] = []
    xs: list[float] = []
    ys: list[float] = []
    u: list[int] = []
    v: list[int] = []
    for index in range(len(pins)):
        for step in range(4):
            ids.append(f"S{index:02d}-{step:02d}")
            xs.append(float(x[index]) + step * 60.0)
            ys.append(float(y[index]))
            u.append(index * 10 + step)
            v.append(index * 10 + step + 1)
    count = len(ids)
    return streams.SegmentTable(
        segment_id=np.array(ids, dtype=object),
        road_class=np.array(["primary"] * count, dtype=object),
        free_flow_kmh=np.full(count, 40.0),
        u=np.array(u, dtype=np.int64),
        v=np.array(v, dtype=np.int64),
        x=np.array(xs),
        y=np.array(ys),
    )


def make_hotspots() -> list[dict[str, Any]]:
    return [
        {
            "hotspot_id": f"MUM-HS-{index:02d}",
            "name": name,
            "lon": lon,
            "lat": lat,
        }
        for index, (name, lon, lat) in enumerate(
            [
                ("Hindmata junction", 72.8421396, 19.010099),
                ("King's Circle", 72.8558265, 19.0272742),
                ("Sion Circle", 72.863491, 19.0427327),
                ("Milan Subway", 72.842833, 19.0904503),
            ],
            start=1,
        )
    ]


def make_gauges() -> list[streams.GaugeSite]:
    return [
        streams.GaugeSite(
            id="IMD-SCZ-43003",
            name="IMD Mumbai-Santacruz observatory",
            lon=72.868,
            lat=19.089,
            operator="IMD",
            source_url="https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv",
            in_aoi=True,
        ),
        streams.GaugeSite(
            id="BMC-WARD-FN",
            name="F North ward office (Matunga / Sion / Wadala)",
            lon=72.8542714,
            lat=19.0265628,
            operator="BMC",
            source_url="https://www.mumbairain.org/",
            in_aoi=True,
        ),
    ]


@pytest.fixture
def inputs() -> ReconstructionInputs:
    config = small_config()
    pins = make_pins()
    return ReconstructionInputs(
        config=config,
        pins=pins,
        gauge_sites=make_gauges(),
        segments=make_segments(config, pins),
        hotspots=make_hotspots(),
    )


def digest(root: Path, member: str) -> str:
    return hashlib.sha256((root / BUNDLE_ID / member).read_bytes()).hexdigest()


# ============================================================================ the fit
def test_clusters_are_deterministic_and_run_south_to_north() -> None:
    values = np.array([0.0, 100.0, 5_000.0, 5_100.0, 12_000.0])
    labels = latitude_clusters(values, 3)
    assert labels.tolist() == [0, 0, 1, 1, 2]
    assert latitude_clusters(values, 3).tolist() == labels.tolist()


def test_cells_are_shared_out_in_proportion_to_the_pins() -> None:
    assert allocate_cells([8, 15, 6], 8) == [2, 4, 2]
    assert sum(allocate_cells([8, 15, 6], 8)) == 8
    assert allocate_cells([1, 1, 30], 8) == [1, 1, 6]
    assert min(allocate_cells([0, 1, 30], 8)) >= 1, "an empty cluster still gets a cell"


def test_the_storm_is_aimed_at_the_pins(inputs: ReconstructionInputs) -> None:
    """The pins are the record of where water was, so the heaviest rain has to fall on them."""
    from varuna_replay.domain import step_times_min
    from varuna_replay.storm import accumulation_mm, calibrate, rain_field

    domain = StormDomain.from_city_config(inputs.config)
    mask = domain.aoi_mask(inputs.config.bbox)
    design = fit_storm_to_pins(domain, inputs.pins, seed=2019, window_min=240.0)
    assert len(design.cells) == 8
    assert any("fitted to the ground truth" in note for note in design.notes)

    calibrated = calibrate(
        design,
        domain,
        mask=mask,
        target_mm=evidence.window_target_mm(),
        t0_min=0.0,
        t1_min=240.0,
        step_min=5.0,
        window_label=evidence.WINDOW_LABEL,
    ).design
    times = step_times_min(0.0, 240.0, 5.0)
    accumulation = accumulation_mm(rain_field(calibrated, domain, times), 5.0)
    x, y = streams.project(
        [pin["lon"] for pin in inputs.pins],
        [pin["lat"] for pin in inputs.pins],
        domain.crs,
    )
    row, col = streams.pixel_index(domain, x, y)
    assert accumulation[row, col].mean() > accumulation[mask].mean()


# ============================================================================ the build
def test_the_bundle_validates_against_the_contract(
    tmp_path: Path, inputs: ReconstructionInputs
) -> None:
    result = build_reconstruction_bundle(inputs, bundles_root=tmp_path)
    report = validate_bundle(result.root)
    assert report.ok, report.render()
    assert not report.warnings, report.render()
    assert set(result.files) == {
        "truth/rain.zarr",
        "radar/frames.zarr",
        "gauges.csv",
        "tide.csv",
        "traffic/speeds.parquet",
        "reports.jsonl",
        "ground_truth.geojson",
        "manifest.json",
    }


def test_the_window_accumulation_hits_the_evidence_target(
    tmp_path: Path, inputs: ReconstructionInputs
) -> None:
    """75.0 mm is 20 % of IMD's 375.2 mm, and the manifest has to reach it and say so."""
    manifest = build_reconstruction_bundle(inputs, bundles_root=tmp_path).manifest
    calibration = manifest.calibration
    assert calibration["santacruz_24h_total_mm"] == 375.2
    assert calibration["window_share_of_daily_total"] == 0.20
    assert calibration["window_target_mm"] == pytest.approx(75.04)
    assert calibration["window_achieved_mm"] == pytest.approx(75.04, rel=0.05)
    assert calibration["window_relative_error"] <= evidence.CALIBRATION_TOLERANCE_FRAC
    assert calibration["pin_accumulation_ratio"] > 1.0
    assert calibration["uniform_share_mm"] < calibration["window_target_mm"]
    assert calibration["persistence_share_mm"] < calibration["window_target_mm"]
    assert calibration["burst_share_mm"] > calibration["window_target_mm"]


def test_the_manifest_separates_what_was_measured_from_what_was_inferred(
    tmp_path: Path, inputs: ReconstructionInputs
) -> None:
    manifest = build_reconstruction_bundle(inputs, bundles_root=tmp_path).manifest
    basis = manifest.calibration_basis or ""
    assert "Inferred, not measured" in basis
    assert evidence.IMD_SANTACRUZ_CHART_URL in basis
    assert "no gauge measured it" in basis
    assert "hyetograph" in basis
    assert "0.20 x 375.2" in basis, "the arithmetic behind the share has to be on the page"
    assert "TIDE." in basis and "Illustrative, not measured" in basis
    assert manifest.tide_source == "illustrative"
    assert manifest.label == "Reconstructed replay"
    assert manifest.seed == 2019
    assert manifest.event_date is not None and manifest.event_date.isoformat() == "2019-07-02"

    assert manifest.sources, "a reconstruction must cite its sources"
    assert all(source.used_for for source in manifest.sources)
    assert any(source.url == evidence.IMD_SANTACRUZ_CHART_URL for source in manifest.sources), (
        "the one IMD-primary source has to be named"
    )
    joined = " ".join(manifest.synthetic_notes)
    for word in ("Radar frames", "Tide", "Traffic", "Citizen reports", "Ground truth"):
        assert word in joined


def test_the_window_is_the_one_adr_0007_chose(tmp_path: Path, inputs: ReconstructionInputs) -> None:
    manifest = build_reconstruction_bundle(inputs, bundles_root=tmp_path).manifest
    assert manifest.t0 == datetime(2019, 7, 2, 5, 40, tzinfo=IST)
    assert manifest.t1 == datetime(2019, 7, 2, 9, 40, tzinfo=IST)
    assert manifest.duration_min == 240
    assert evidence.CYCLE_OPENS > manifest.t0


def test_the_streams_are_flagged_and_the_pins_are_not(
    tmp_path: Path, inputs: ReconstructionInputs
) -> None:
    import pandas as pd

    root = build_reconstruction_bundle(inputs, bundles_root=tmp_path).root
    layout = BundleLayout(root=root)

    gauges = pd.read_csv(layout.gauges)
    assert bool(gauges["synthetic"].all())
    assert set(gauges["station_id"]) == {site.id for site in inputs.gauge_sites}
    assert "IMD Mumbai-Santacruz observatory" in set(gauges["name"])

    tide = pd.read_csv(layout.tide)
    assert set(tide["source"]) == {"illustrative"}

    traffic = pd.read_parquet(layout.traffic)
    assert bool(traffic["synthetic"].all())
    assert len(traffic) == len(inputs.segments) * 49

    reports = [json.loads(line) for line in layout.reports.read_text(encoding="utf-8").splitlines()]
    sourced = [row for row in reports if not row["synthetic"]]
    assert sourced, "the pins inside the window must reach the report stream"
    assert all(row["depth_hint"] is None for row in sourced)
    assert all(row["source_url"] for row in sourced)
    assert all(
        row["depth_hint"] in {"ankle", "knee", "waist"} for row in reports if row["synthetic"]
    )

    payload = json.loads(layout.ground_truth.read_text(encoding="utf-8"))
    assert len(payload["features"]) == len(inputs.pins)
    known = set(GroundTruthPin.model_fields)
    for feature in payload["features"]:
        properties = feature["properties"]
        assert properties["depth_cm"] is None, "no source states a depth in centimetres"
        assert properties["synthetic"] is False
        GroundTruthPin.model_validate(
            {key: value for key, value in properties.items() if key in known}
        )


def test_the_traffic_feed_collapses_where_a_pin_says_the_water_was(
    tmp_path: Path, inputs: ReconstructionInputs
) -> None:
    import pandas as pd

    root = build_reconstruction_bundle(inputs, bundles_root=tmp_path).root
    traffic = pd.read_parquet(BundleLayout(root=root).traffic)
    collapsed = traffic[traffic["kmh"] < 5.0]
    assert not collapsed.empty, "a pin inside the window has to show up as a speed collapse"
    in_window = [
        pin
        for pin in inputs.pins
        if 0
        <= (datetime.fromisoformat(pin["ts"]) - evidence.T0).total_seconds() / 60.0
        <= evidence.WINDOW_MIN
    ]
    stamps = {str(value)[11:16] for value in collapsed["ts"]}
    for pin in in_window:
        moment = datetime.fromisoformat(pin["ts"])
        near = {(moment + timedelta(minutes=offset)).strftime("%H:%M") for offset in range(-10, 11)}
        assert stamps & near, f"{pin['id']} left no anomaly in the feed"


def test_two_builds_with_the_same_seed_are_byte_identical(
    tmp_path: Path, inputs: ReconstructionInputs
) -> None:
    """Rule 8. The streams and the manifest are what a reader compares, so they are what is
    compared here; the cubes are covered by the same seeded field that produced them."""
    first, second = tmp_path / "first", tmp_path / "second"
    build_reconstruction_bundle(inputs, bundles_root=first)
    build_reconstruction_bundle(inputs, bundles_root=second)
    for member in (
        "gauges.csv",
        "tide.csv",
        "reports.jsonl",
        "ground_truth.geojson",
        "manifest.json",
    ):
        assert digest(first, member) == digest(second, member), member


def test_a_different_seed_moves_the_storm_but_not_the_pins(
    tmp_path: Path, inputs: ReconstructionInputs
) -> None:
    first = build_reconstruction_bundle(inputs, bundles_root=tmp_path / "a").manifest
    other = build_reconstruction_bundle(inputs, bundles_root=tmp_path / "b", seed=7).manifest
    assert first.storm is not None and other.storm is not None
    assert first.storm.cells[0].start_x_m != other.storm.cells[0].start_x_m
    assert first.ground_truth_n == other.ground_truth_n
    assert digest(tmp_path / "a", "ground_truth.geojson") == digest(
        tmp_path / "b", "ground_truth.geojson"
    ), "the sourced pins are evidence; no seed may move them"


# ============================================================================ dispatch
def test_build_bundle_dispatches_the_design_storms(tmp_path: Path) -> None:
    result = build_bundle("CHN-IDF-25yr", bundles_root=tmp_path)
    assert result.manifest.label == "Design storm"
    assert result.manifest.city == "chennai"


def test_build_bundle_names_the_bundles_it_knows(tmp_path: Path) -> None:
    with pytest.raises(KeyError) as error:
        build_bundle("MUM-1900-01-01", bundles_root=tmp_path)
    assert BUNDLE_ID in str(error.value)
    assert "MUM-IDF-25yr" in str(error.value)


# ============================================================================ the real thing
@pytest.mark.skipif(
    not (city_dir("mumbai") / "segments.parquet").is_file(),
    reason="needs the Mumbai city layers: run 'make city CITY=mumbai'",
)
def test_the_real_bundle_builds_from_the_real_evidence(tmp_path: Path) -> None:
    """The demo artefact itself: 29 sourced pins, 10 gauge sites, and a valid bundle."""
    result = build_reconstruction_bundle(
        load_reconstruction_inputs(load_city(evidence.CITY)), bundles_root=tmp_path
    )
    manifest = load_manifest(result.root)
    assert manifest.id == BUNDLE_ID
    assert manifest.ground_truth_n == 29
    assert manifest.calibration["window_relative_error"] <= evidence.CALIBRATION_TOLERANCE_FRAC
    assert manifest.storm is not None
    assert len(manifest.storm.cells) == 8
    assert f"{PIN_CLUSTERS} latitudinal clusters" in (manifest.calibration_basis or "")

    low, high = PEAK_RANGE_MM_H
    peaks = [cell.peak_mm_h * manifest.storm.intensity_scale for cell in manifest.storm.cells]
    assert low <= min(peaks) and max(peaks) <= high, (
        "the calibrated cell peaks must stay inside the 40-120 mm/h range CLAUDE.md 10.2 "
        "states for the designer; if they do not, the manifest carries a note saying so"
    )
    report = validate_bundle(result.root)
    assert report.ok, report.render()
