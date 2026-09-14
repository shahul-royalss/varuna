/**
 * The seams MO1 pre-wired for later chunks are inert: setting every one of them changes nothing
 * deck draws. Each seam names the chunk that makes it do something (MO3, MO5, MO8, MO9, MO10, PU8);
 * when that chunk lands it updates the fixture scenario it changes, and this test with it.
 */

import { render, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { drainsLayers } from "../drains";
import { hotspotRingsLayers } from "../hotspots";
import { inletLayers } from "../inlets";
import { isochroneLayers, useDisplayedIsochrones } from "../isochrones";
import { reversedFlowLayers } from "../reversed-flow";
import { wetStreetsLayers } from "../streets";
import { deckAnimates, surchargeLayers } from "../surcharge";
import type { InletPoint, ReversedEdgePath } from "../types";
import * as fx from "./fixture";
import { serializeLayers } from "./serialize";

const renders: { layers: unknown[]; animate: unknown }[] = [];

vi.mock("@deck.gl/react", () => ({
  default: (props: Record<string, unknown>) => {
    renders.push({ layers: props.layers as unknown[], animate: props._animate ?? false });
    return null;
  },
}));

const { CityMap } = await import("../../city-map");

const FIXTURE = path.resolve(__dirname, "../__fixtures__/monolith-layers.json");

const reversedEdges: ReversedEdgePath[] = [
  {
    edgeId: "E-outfall",
    path: [
      [72.838, 19.019],
      [72.84, 19.02],
    ],
    minQ: -0.3,
    tidal: true,
  },
];

const inlets: InletPoint[] = [{ lon: 72.841, lat: 19.012, kappa: 0.4, learned: true }];

beforeEach(() => {
  renders.length = 0;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

describe("MO1 seams draw nothing yet", () => {
  it("CityMap with every seam set renders the monolith's console layers", () => {
    render(
      <CityMap
        {...fx.consoleProps({
          playing: true,
          reversedEdges,
          drainCrossFadeMs: 300,
          onDrainHover: () => {},
          inlets,
          surchargeStyle: "ring",
        })}
      />,
    );
    const recorded = renders.at(-1);
    if (!recorded) throw new Error("CityMap never rendered DeckGL");
    const expected = (
      JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, { layers: unknown }>
    ).console.layers;
    expect(JSON.parse(JSON.stringify(serializeLayers(recorded.layers)))).toEqual(expected);
    expect(recorded.animate).toBe(false);
  });

  it("each builder ignores its seam argument", () => {
    const same = (a: unknown[], b: unknown[]) =>
      expect(serializeLayers(a)).toEqual(serializeLayers(b));

    same(
      drainsLayers({ drains: fx.drains, show: true, crossFadeMs: 300, onHover: () => {} }),
      drainsLayers({ drains: fx.drains, show: true }),
    );
    const streets = {
      segments: fx.segments,
      step: 1,
      show: true,
      diffMode: false,
      wipeLon: Number.POSITIVE_INFINITY,
      pickable: true,
    };
    same(
      wetStreetsLayers({ ...streets, playing: true, reducedMotion: true }),
      wetStreetsLayers(streets),
    );
    const rings = { hotspots: fx.hotspots, selectedHotspotId: "H-sion", show: true };
    same(hotspotRingsLayers({ ...rings, reducedMotion: true }), hotspotRingsLayers(rings));
    same(
      surchargeLayers({ surcharge: fx.surcharge, show: true, pulse: 0.5, style: "ring" }),
      surchargeLayers({ surcharge: fx.surcharge, show: true, pulse: 0.5 }),
    );
    expect(inletLayers({ inlets, show: true })).toEqual([]);
    expect(reversedFlowLayers({ edges: reversedEdges, show: true, step: 2, reducedMotion: false }))
      .toEqual([]);
    expect(deckAnimates({ reducedMotion: false, surchargeVisible: 2, reversedVisible: 1 })).toBe(
      false,
    );
  });

  it("the isochrone tween hands back the slice it was given", () => {
    const { result } = renderHook(() => useDisplayedIsochrones(fx.isochrones, false));
    expect(result.current).toBe(fx.isochrones);
    expect(serializeLayers(isochroneLayers({ isochrones: result.current }))).toEqual(
      serializeLayers(isochroneLayers({ isochrones: fx.isochrones })),
    );
  });
});
