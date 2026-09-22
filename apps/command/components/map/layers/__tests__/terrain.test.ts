import { describe, expect, it } from "vitest";

import { buildTerrainMesh } from "../terrain";

const DECODER = { r_scaler: 256, g_scaler: 1, b_scaler: 1 / 256, offset: -32768 };

/** Terrarium bytes for a height in metres, as `varuna_city.terrain_export` writes them. */
function terrarium(h: number): [number, number, number, number] {
  const units = Math.round((h + 32768) * 256);
  return [(units >> 16) & 0xff, (units >> 8) & 0xff, units & 0xff, 255];
}

describe("buildTerrainMesh", () => {
  // 3 columns x 2 rows; the north row first, as the PNG is written.
  const heights = [
    [0, 1, 2],
    [-1.5, 10, 147.5],
  ];
  const rgba = heights.flat().flatMap(terrarium);
  const bounds: [number, number, number, number] = [72.81, 18.99, 72.84, 19.01];
  const mesh = buildTerrainMesh(rgba, 3, 2, { bounds, decoder: DECODER });

  it("decodes Terrarium and applies the 2x exaggeration", () => {
    const z = mesh.attributes.POSITION.value.filter((_, i) => i % 3 === 2);
    expect(Array.from(z)).toEqual([0, 2, 4, -3, 20, 295]);
  });

  it("puts each vertex at its cell centre, north row at the top", () => {
    const p = mesh.attributes.POSITION.value;
    const dLon = 0.03 / 3;
    const dLat = 0.02 / 2;
    expect(p[0]).toBeCloseTo(0.5 * dLon, 6);
    expect(p[1]).toBeCloseTo(0.02 - 0.5 * dLat, 6);
    // Last vertex: column 2, row 1 (south).
    expect(p[15]).toBeCloseTo(2.5 * dLon, 6);
    expect(p[16]).toBeCloseTo(0.5 * dLat, 6);
  });

  it("maps vertex (row, col) onto texel (row, col) of a depth frame", () => {
    const uv = mesh.attributes.TEXCOORD_0.value;
    expect(uv[0]).toBeCloseTo(0.5 / 3, 6);
    expect(uv[1]).toBeCloseTo(0.25, 6);
    expect(uv[10]).toBeCloseTo(2.5 / 3, 6);
    expect(uv[11]).toBeCloseTo(0.75, 6);
  });

  it("covers the grid with two triangles per cell and reports its own extent", () => {
    expect(mesh.indices.value.length).toBe(2 * 1 * 6);
    expect(Math.max(...mesh.indices.value)).toBe(5);
    expect(mesh.header.boundingBox[0][2]).toBe(-3);
    expect(mesh.header.boundingBox[1][2]).toBe(295);
    expect(mesh.header.boundingBox[1][0]).toBeCloseTo(0.03, 9);
  });
});
