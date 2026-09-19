import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RouteCorridor, RouteLeg, RoutePlan } from "@/lib/api/route";

import { CitizenMap, routeLines, STOPS_AT_CM } from "./citizen-map";

// The fallback path renders the console's own map, which would fetch a run, decode thirty-six
// PNGs and ask for a WebGL context. None of that is what this file is testing.
vi.mock("@/components/map/flood-map", () => ({
  FloodMap: () => <div data-testid="flood-map" />,
}));

const KEY = "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY";

let errors: unknown[][];
let warnings: unknown[][];

beforeEach(() => {
  errors = [];
  warnings = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args);
  });
  // No API in a unit test; the run load refuses and the map draws no water, which is a state the
  // screen already words.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CitizenMap without a Google key", () => {
  it("renders VARUNA's own map and says which map it is", async () => {
    vi.stubEnv(KEY, "");
    render(<CitizenMap profile="car" />);

    expect(await screen.findByTestId("flood-map")).toBeInTheDocument();
    expect(screen.getByText(/showing VARUNA's own map/)).toBeInTheDocument();
  });

  it("logs nothing - an absent key is a configuration, not an error", async () => {
    vi.stubEnv(KEY, "undefined");
    render(<CitizenMap profile="two-wheeler" />);
    await screen.findByTestId("flood-map");

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("STOPS_AT_CM", () => {
  it("uses the same stopping depths the router and the public map use", () => {
    expect(STOPS_AT_CM).toEqual({
      "two-wheeler": 15,
      car: 30,
      bus: 45,
      pedestrian: 30,
    });
  });
});

function leg(path: [number, number][]): RouteLeg {
  return {
    minutes: 20,
    distanceM: 4000,
    maxDepthCm: 10,
    depart: "2019-07-02T08:40:00+05:30",
    arrive: "2019-07-02T09:00:00+05:30",
    safeUntil: null,
    path,
    streets: ["Dr Ambedkar Road"],
  };
}

function corridor(id: string, assigned: boolean): RouteCorridor {
  return {
    id,
    label: id.toUpperCase(),
    route: leg([
      [72.84, 19.01],
      [72.85, 19.02],
    ]),
    share: 0.5,
    assigned,
    capacityScore: 1,
    maxProbability: 0.1,
  };
}

const plan: RoutePlan = {
  runId: "MUM-x",
  profile: "car",
  departAt: "2019-07-02T08:40:00+05:30",
  naive: leg([
    [72.83, 19.0],
    [72.84, 19.01],
  ]),
  varuna: leg([
    [72.83, 19.0],
    [72.86, 19.03],
  ]),
  alternates: [],
  avoided: [
    {
      segmentId: "S-1",
      name: "Dr Ambedkar Road",
      depthCm: 47,
      probability: 0.8,
      at: "2019-07-02T08:20:00+05:30",
      path: [
        [72.841, 19.012],
        [72.842, 19.013],
      ],
    },
  ],
  corridors: [],
  reasons: [],
  tripId: null,
  notes: [],
  ms: 85,
};

describe("routeLines", () => {
  it("draws nothing before a trip is planned", () => {
    expect(routeLines(null, null, null)).toEqual([]);
  });

  it("draws the shortest way, what it avoided and the safe way", () => {
    const kinds = routeLines(plan, null, null).map((l) => l.kind);
    expect(kinds).toEqual(["naive", "avoided", "varuna"]);
  });

  it("puts the chosen corridor in the VARUNA line and dims the others", () => {
    const lines = routeLines(plan, [corridor("a", true), corridor("b", false)], null);
    expect(lines.filter((l) => l.kind === "varuna")).toHaveLength(1);
    expect(lines.filter((l) => l.kind === "alternate").map((l) => l.id)).toEqual(["corridor-b"]);
  });

  it("follows the reader's pick over the assigned corridor", () => {
    const lines = routeLines(plan, [corridor("a", true), corridor("b", false)], "b");
    expect(lines.filter((l) => l.kind === "alternate").map((l) => l.id)).toEqual(["corridor-a"]);
  });

  it("drops a leg the API sent with no geometry rather than drawing an empty path", () => {
    const empty: RoutePlan = { ...plan, naive: leg([]), avoided: [] };
    expect(routeLines(empty, null, null).map((l) => l.kind)).toEqual(["varuna"]);
  });
});
