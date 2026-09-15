import { describe, expect, it } from "vitest";

import { UNNAMED_ROAD, honestyLine, nearbyStreets } from "./map-screen";

const run = {
  // Two 5-minute steps at 06:45 and 06:50 IST.
  validTs: ["2019-07-02T06:45:00+05:30", "2019-07-02T06:50:00+05:30"],
  depthCm: new Map<string, number[]>([
    ["S-named", [10, 40]],
    ["S-unnamed", [35, 50]],
    ["S-dry", [2, 3]],
  ]),
};

describe("nearbyStreets", () => {
  it("prints the OSM name, or 'Unnamed road' where OSM has none", () => {
    const rows = nearbyStreets(run, 30, new Map([["S-named", "Dr Ambedkar Road"]]));
    expect(rows.map((r) => [r.id, r.name])).toEqual([
      ["S-unnamed", UNNAMED_ROAD],
      ["S-named", "Dr Ambedkar Road"],
    ]);
  });

  it("claims no name at all while the names are still loading", () => {
    const rows = nearbyStreets(run, 30, null);
    expect(rows.every((r) => r.name === null)).toBe(true);
  });

  it("gives the last passable step, or none when the street is already over the vehicle", () => {
    const rows = nearbyStreets(run, 30, new Map());
    expect(rows.find((r) => r.id === "S-named")?.passableUntil).toBe("06:45");
    expect(rows.find((r) => r.id === "S-unnamed")?.passableUntil).toBeNull();
  });
});

describe("honestyLine", () => {
  it("times the line from the run the map drew", () => {
    expect(honestyLine("2019-07-02T06:40:00+05:30")).toBe(
      "Forecast from the last VARUNA run at 06:40; updates every 5 minutes",
    );
  });

  it("does not name a time before a run has loaded", () => {
    expect(honestyLine(null)).not.toMatch(/\d/);
  });
});
