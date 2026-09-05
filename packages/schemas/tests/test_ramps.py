from __future__ import annotations

import math

import pytest

from varuna_schemas import ramps
from varuna_schemas.tokens import depth_bands, drain_bands

HEX = {b.key: b.hex for b in depth_bands()}
DRAIN_HEX = {b.key: b.hex for b in drain_bands()}


@pytest.mark.parametrize(
    ("cm", "key"),
    [
        (-3.0, "dry"),
        (0.0, "dry"),
        (4.99, "dry"),
        (5.0, "1"),
        (14.99, "1"),
        (15.0, "2"),
        (29.99, "2"),
        (30.0, "3"),
        (44.99, "3"),
        (45.0, "4"),
        (59.99, "4"),
        (60.0, "5"),
        (255.0, "5"),
        (1000.0, "5"),
        (math.nan, "dry"),
    ],
)
def test_depth_band_boundaries(cm: float, key: str) -> None:
    assert ramps.depth_band(cm).key == key
    assert ramps.depth_color_hex(cm) == HEX[key]
    assert ramps.depth_color_rgba(cm) == (*ramps.hex_to_rgb(HEX[key]), 255)


def test_hex_helpers() -> None:
    assert ramps.hex_to_rgb("#3B82F6") == (59, 130, 246)
    assert ramps.hex_to_rgb("3b82f6") == (59, 130, 246)
    assert ramps.hex_to_rgb("#FFF") == (255, 255, 255)
    assert ramps.rgb_to_hex((59, 130, 246)) == "#3B82F6"
    assert ramps.rgb_to_hex(ramps.hex_to_rgba("#B91C1C", 128)) == "#B91C1C"
    assert ramps.hex_to_rgba("#EF4444", 0)[3] == 0
    with pytest.raises(ValueError):
        ramps.hex_to_rgb("#12345")
    with pytest.raises(ValueError):
        ramps.hex_to_rgba("#EF4444", 300)


def test_palette_has_256_entries_with_transparent_dry() -> None:
    palette = ramps.depth_palette_png()
    assert len(palette) == 256
    for i in range(5):
        assert palette[i][3] == 0
    for i in range(5, 256):
        assert palette[i][3] == 255
    assert palette[5][:3] == ramps.hex_to_rgb(HEX["1"])
    assert palette[14][:3] == ramps.hex_to_rgb(HEX["1"])
    assert palette[15][:3] == ramps.hex_to_rgb(HEX["2"])
    assert palette[30][:3] == ramps.hex_to_rgb(HEX["3"])
    assert palette[45][:3] == ramps.hex_to_rgb(HEX["4"])
    assert palette[60][:3] == ramps.hex_to_rgb(HEX["5"])
    assert palette[255][:3] == ramps.hex_to_rgb(HEX["5"])
    rgb, alphas = ramps.depth_palette_bytes()
    assert len(rgb) == 768 and len(alphas) == 256
    assert alphas[:5] == b"\x00" * 5 and alphas[5] == 255


def test_palette_custom_alpha() -> None:
    palette = ramps.depth_palette_png(alpha=140, dry_alpha=20)
    assert palette[0][3] == 20 and palette[100][3] == 140


def test_depth_array_to_rgba_matches_scalar_ramp() -> None:
    np = pytest.importorskip("numpy")
    metres = np.array(
        [[0.0, 0.049, 0.05, 0.149], [0.15, 0.299, 0.30, 0.449], [0.45, 0.599, 0.60, 3.0]],
        dtype=np.float64,
    )
    rgba = ramps.depth_array_to_rgba(metres)
    assert rgba.shape == (3, 4, 4) and rgba.dtype == np.uint8
    for y in range(3):
        for x in range(4):
            cm = metres[y, x] * 100.0
            expected = ramps.depth_color_rgba(cm, 255 if cm >= 5 else 0)
            assert tuple(int(v) for v in rgba[y, x]) == expected, (y, x, cm)
    nan_field = np.full((2, 2), np.nan)
    assert ramps.depth_array_to_rgba(nan_field)[..., 3].max() == 0
    idx = ramps.depth_cm_to_palette_index(np.array([[0.0, 0.055, 9.0]]))
    assert idx.tolist() == [[0, 5, 255]]
    with pytest.raises(ValueError):
        ramps.depth_array_to_rgba(np.zeros(3))


@pytest.mark.parametrize(
    ("beta", "key"),
    [
        (-0.1, "0"),
        (0.0, "0"),
        (0.249, "0"),
        (0.25, "1"),
        (0.499, "1"),
        (0.5, "2"),
        (0.749, "2"),
        (0.75, "3"),
        (1.0, "3"),
        (1.5, "3"),
        (math.nan, "0"),
    ],
)
def test_drain_band_boundaries(beta: float, key: str) -> None:
    assert ramps.drain_band(beta).key == key
    assert ramps.drain_color_hex(beta) == DRAIN_HEX[key]
    assert ramps.drain_color_rgba(beta, 200) == (*ramps.hex_to_rgb(DRAIN_HEX[key]), 200)


def test_probability_opacity_floor_and_status() -> None:
    assert ramps.probability_opacity(0.0) == 0.15
    assert ramps.probability_opacity(0.5) == 0.5
    assert ramps.probability_opacity(1.7) == 1.0
    assert ramps.probability_opacity(math.nan) == 0.15
    assert ramps.status_color_hex("replay") == "#38BDF8"
    with pytest.raises(KeyError):
        ramps.status_color_hex("paused")
