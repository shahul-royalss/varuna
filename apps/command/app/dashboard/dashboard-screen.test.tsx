import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CitizenRun } from "@/lib/maps/citizen-run";

import {
  DashboardScreen,
  HONESTY_CHIPS,
  NEARBY_RADIUS_M,
  UNNAMED_ROAD,
  distanceM,
  nearbyStreets,
  runLine,
} from "./dashboard-screen";

// The map is exercised by `components/citizen/citizen-map.test.tsx`; here it would only ask for a
// WebGL context jsdom does not have.
vi.mock("@/components/citizen/citizen-map", async () => {
  const actual = await vi.importActual<typeof import("@/components/citizen/citizen-map")>(
    "@/components/citizen/citizen-map",
  );
  return { ...actual, CitizenMap: () => <div data-testid="citizen-map" /> };
});

const HINDMATA = { lon: 72.841, lat: 19.012 };

/** Two 5-minute steps at 06:45 and 06:50 IST, as a baked cycle writes them. */
const VALID_TS = ["2019-07-02T06:45:00+05:30", "2019-07-02T06:50:00+05:30"];

const segments = [
  {
    id: "S-near-named",
    name: "Dr Ambedkar Road",
    path: [[72.8415, 19.0125]] as [number, number][],
    depthCm: [10, 40],
  },
  {
    id: "S-near-unnamed",
    path: [[72.8412, 19.0121]] as [number, number][],
    depthCm: [35, 50],
  },
  {
    id: "S-near-dry",
    name: "Tulsi Pipe Road",
    path: [[72.8413, 19.0122]] as [number, number][],
    depthCm: [2, 3],
  },
  {
    // About 8 km north: inside the AOI, not inside the radius.
    id: "S-far",
    name: "Milan Subway",
    path: [[72.84, 19.079]] as [number, number][],
    depthCm: [80, 90],
  },
];

describe("distanceM", () => {
  it("measures a tenth of a degree of latitude as about 11 km", () => {
    expect(distanceM({ lon: 72.84, lat: 19.0 }, [72.84, 19.1])).toBeCloseTo(11_132, -2);
  });

  it("shrinks a degree of longitude by the cosine of the latitude", () => {
    const atEquator = distanceM({ lon: 0, lat: 0 }, [1, 0]);
    const atMumbai = distanceM({ lon: 72.84, lat: 19.0 }, [73.84, 19.0]);
    expect(atMumbai).toBeLessThan(atEquator);
    expect(atMumbai / atEquator).toBeCloseTo(Math.cos((19 * Math.PI) / 180), 3);
  });
});

describe("nearbyStreets", () => {
  it("keeps only streets within the radius of the reader", () => {
    const rows = nearbyStreets(segments, VALID_TS, 30, HINDMATA);
    expect(rows.map((r) => r.id)).toEqual(["S-near-unnamed", "S-near-named"]);
    expect(distanceM(HINDMATA, segments[3].path[0])).toBeGreaterThan(NEARBY_RADIUS_M);
  });

  it("falls back to the whole city when there is no position", () => {
    const rows = nearbyStreets(segments, VALID_TS, 30, null);
    expect(rows.map((r) => r.id)).toEqual(["S-far", "S-near-unnamed", "S-near-named"]);
  });

  it("prints the OSM name, or 'Unnamed road' where OSM has none", () => {
    const rows = nearbyStreets(segments, VALID_TS, 30, HINDMATA);
    expect(rows.find((r) => r.id === "S-near-unnamed")?.name).toBe(UNNAMED_ROAD);
    expect(rows.find((r) => r.id === "S-near-named")?.name).toBe("Dr Ambedkar Road");
  });

  it("gives the last passable step, or none when the street is already over the vehicle", () => {
    const rows = nearbyStreets(segments, VALID_TS, 30, HINDMATA);
    // 10 cm then 40 cm: passable at 06:45, over a car by 06:50.
    expect(rows.find((r) => r.id === "S-near-named")?.passableUntil).toBe("06:45");
    // 35 cm at the first step: already impassable.
    expect(rows.find((r) => r.id === "S-near-unnamed")?.passableUntil).toBeNull();
  });

  it("changes with the vehicle, because the threshold is the vehicle's", () => {
    // A bus stops at 45 cm, so a street that peaks at 40 cm never stops it and keeps its
    // passable-until at the end of the run - where a car's 30 cm cut it off at 06:45.
    const forBus = nearbyStreets(segments, VALID_TS, 45, HINDMATA);
    expect(forBus.find((r) => r.id === "S-near-named")?.passableUntil).toBe("06:50");
    // 50 cm crosses 45 cm only at the second step, so the bus has until the first.
    expect(forBus.find((r) => r.id === "S-near-unnamed")?.passableUntil).toBe("06:45");
  });

  it("lists a street a vehicle must think about, at half its stopping depth", () => {
    // The 2-3 cm street is below half of a car's 30 cm and is not worth a row.
    expect(nearbyStreets(segments, VALID_TS, 30, HINDMATA).map((r) => r.id)).not.toContain(
      "S-near-dry",
    );
  });
});

function run(cycleTs: string | null): CitizenRun {
  return {
    provenance: {
      runId: "MUM-20190702T0640Z-sky1.0-twin1.0-flash0.3-baked",
      cycleTs,
      mode: "replay",
      bundle: "MUM-2019-07-02",
      nSteps: 36,
      ensembleN: 20,
    },
    bounds: [72.815, 18.995, 72.905, 19.135],
    segments: [],
    baseSegments: [],
    depthCm: new Map(),
    validTs: VALID_TS,
  };
}

describe("runLine", () => {
  it("names the run and the time it is for", () => {
    const line = runLine(run("2019-07-02T06:40:00+05:30"), false);
    expect(line).toContain("06:40 IST");
    expect(line).toContain("MUM-");
  });

  it("says the load failed rather than claiming a run is still coming", () => {
    expect(runLine(null, true)).toMatch(/did not load/);
    expect(runLine(null, false)).toMatch(/Loading/);
  });

  it("does not invent a time for a run that carries none", () => {
    expect(runLine(run(null), true)).toMatch(/did not load/);
  });
});

describe("DashboardScreen", () => {
  it("renders the honest empty rail before a trip is planned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    render(<DashboardScreen />);

    expect(await screen.findAllByText("No trip yet")).not.toHaveLength(0);
    expect(
      screen.getAllByText(/Choose where you are and where you are going/).length,
    ).toBeGreaterThan(0);
    // No route, so no ETA is claimed anywhere on the screen.
    expect(screen.queryByText(/Shortest way/)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("carries the three honesty chips verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    render(<DashboardScreen />);
    for (const chip of HONESTY_CHIPS) {
      expect(await screen.findByText(chip)).toBeInTheDocument();
    }
    vi.unstubAllGlobals();
  });

  /**
   * The entry used to sit inside an opaque `bg-ink absolute inset-0 z-30` div that carried
   * `hidden={introDone}`. That div had to be hidden, or it covered the map for ever; being hidden
   * the moment `onDone` fired cut M27's 900 ms cross-fade to nothing, and together with the
   * hydration defect fixed in `globe-entry.tsx` it hid the globe for its whole four seconds. The
   * overlay is its own `fixed` layer and removes itself, so it needs nothing around it.
   */
  it("mounts the entry with no hidden wrapper over it", () => {
    window.sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    render(<DashboardScreen />);

    const overlay = document.querySelector('[data-slot="dashboard-intro"]');
    expect(overlay).not.toBeNull();
    for (let node = overlay?.parentElement; node; node = node.parentElement) {
      expect(node.hasAttribute("hidden")).toBe(false);
      expect(node.getAttribute("aria-hidden")).not.toBe("true");
    }
    // The pane the entry hands over to is mounted and still waiting for it.
    expect(
      document.querySelector('[data-slot="dashboard-stage"]')?.getAttribute("data-handover"),
    ).toBe("playing");
    vi.unstubAllGlobals();
  });
});
