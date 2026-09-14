/**
 * Reachability bands as translucent polygons, under the routes and over the streets
 * (CLAUDE.md 6.7, 7.4, motion M15).
 */

import { PolygonLayer } from "@deck.gl/layers";

import { REACH_FILL, REACH_LINE } from "./palette";
import type { Isochrone } from "./types";

/**
 * The bands to draw this frame. Seam for motion M15 (chunk MO9), which holds the displayed rings
 * here and morphs them to a new slice over 300 ms. **Today it returns its input**: a new slice
 * swaps in at once.
 */
export function useDisplayedIsochrones(
  isochrones: readonly Isochrone[],
  reducedMotion: boolean,
): readonly Isochrone[] {
  void reducedMotion;
  return isochrones;
}

export interface IsochroneLayerOptions {
  isochrones: readonly Isochrone[];
}

export function isochroneLayers({ isochrones }: IsochroneLayerOptions): unknown[] {
  if (isochrones.length === 0) return [];
  return [
    new PolygonLayer<Isochrone>({
      id: "isochrones",
      // Largest band first, so the 5-minute core reads as the darkest patch rather than
      // being painted over by the 15-minute one.
      data: [...isochrones].sort((a, b) => b.minutes - a.minutes) as Isochrone[],
      getPolygon: (d) => d.rings[0] ?? [],
      getFillColor: (d) => REACH_FILL[d.minutes] ?? REACH_FILL[15],
      getLineColor: REACH_LINE,
      getLineWidth: 1,
      lineWidthUnits: "pixels",
      stroked: true,
      filled: true,
      pickable: false,
    }),
  ];
}
