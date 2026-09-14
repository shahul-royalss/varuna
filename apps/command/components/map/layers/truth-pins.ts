/**
 * Sourced ground-truth pins and their drop ripple (CLAUDE.md 7.2's 2:40 moment, motion M18).
 */

import { ScatterplotLayer } from "@deck.gl/layers";

import { TRUTH_FILL, TRUTH_RING } from "./palette";
import type { TruthPin } from "./types";

/** Pin radius in metres at full drop, and the ripple it expands to (motion M18). */
export const TRUTH_RADIUS_M = 70;
export const RIPPLE_RADIUS_M = 320;

export interface TruthPinLayerOptions {
  truthPins: readonly TruthPin[];
}

export function truthPinLayers({ truthPins }: TruthPinLayerOptions): unknown[] {
  if (truthPins.length === 0) return [];
  const built: unknown[] = [];
  // Motion M18: the pin drops - scale 0 to 1 on a spring - trailing a ripple that expands and
  // fades over its first 600 ms. Drawn above everything, because a pin under a street is a
  // pin nobody sees, and these are the point of the whole replay.
  const rippling = truthPins.filter((p) => p.age < 1);
  if (rippling.length > 0) {
    built.push(
      new ScatterplotLayer<TruthPin>({
        id: "truth-ripples",
        data: rippling as TruthPin[],
        getPosition: (d) => [d.lon, d.lat],
        getRadius: (d) => TRUTH_RADIUS_M + (RIPPLE_RADIUS_M - TRUTH_RADIUS_M) * d.age,
        radiusUnits: "meters",
        stroked: true,
        filled: false,
        getLineColor: (d) => [TRUTH_RING[0], TRUTH_RING[1], TRUTH_RING[2], Math.round(220 * (1 - d.age))],
        getLineWidth: 2,
        lineWidthUnits: "pixels",
        pickable: false,
        updateTriggers: {
          getRadius: rippling.map((p) => p.age),
          getLineColor: rippling.map((p) => p.age),
        },
      }),
    );
  }
  built.push(
    new ScatterplotLayer<TruthPin>({
      id: "truth-pins",
      data: truthPins as TruthPin[],
      getPosition: (d) => [d.lon, d.lat],
      // The comment here used to say the pin "springs past its final size and settles". It does
      // not: the radius rises from 40 % and clamps at full size, with no overshoot. Motion MO7
      // replaces this with the catalogue spring; until then the comment says what the code does.
      getRadius: (d) => TRUTH_RADIUS_M * Math.min(1, 0.4 + 0.75 * d.age),
      radiusUnits: "meters",
      radiusMinPixels: 4,
      stroked: true,
      filled: true,
      getFillColor: TRUTH_FILL,
      getLineColor: TRUTH_RING,
      getLineWidth: 2,
      lineWidthUnits: "pixels",
      pickable: false,
      updateTriggers: { getRadius: truthPins.map((p) => p.age) },
    }),
  );
  return built;
}
