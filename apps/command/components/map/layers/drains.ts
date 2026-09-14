/**
 * The inferred drain graph, coloured by blockage (CLAUDE.md 6.7, task P7.9). Off by default.
 */

import { PathStyleExtension, type PathStyleExtensionProps } from "@deck.gl/extensions";
import { PathLayer } from "@deck.gl/layers";

import { drainColour } from "./palette";
import type { DrainPath, DrainPick } from "./types";

/**
 * The dash that carries "inferred" (section 6.7, task P7.9).
 *
 * Not decoration and not a style choice: every pipe on this map was synthesised from roads and
 * terrain by the city pipeline, none of it from a surveyed drain GIS, and `/drains` says so in
 * words beside the map. Drawing the pipes solid made that sentence false - a solid line reads as
 * a surveyed asset. One instance at module scope: deck.gl's `LayerExtension.equals` compares the
 * constructor and the options rather than the reference, so a fresh instance per render would not
 * rebuild the shaders - it would just be an allocation on every scrub step for nothing.
 */
export const DASHED = new PathStyleExtension({ dash: true });

/** `[dash, gap]` **as multiples of the drawn width**, which is how deck.gl's dash shader reads the
 * array ("solid stroke length, relative to width"). The narrowest pipe the city pipeline emits is
 * 450 mm, drawn 1.9 px wide, so it dashes 7.6 px on and 5.7 px off; a 1500 mm trunk is 4 px and
 * dashes proportionally. The dash stays legible across the whole diameter range. */
export const DRAIN_DASH: [number, number] = [4, 3];

export interface DrainsLayerOptions {
  drains: readonly DrainPath[];
  show: boolean;
  /**
   * Seam for motion M12 (chunk MO10): the before/after cross-fade duration in ms. **Not applied
   * yet** - the pipes still restyle instantly whatever is passed.
   */
  crossFadeMs?: number;
  /** Seam for PU8: hovering a pipe on `/drains`. **Not applied yet** - the pipes stay unpickable. */
  onHover?: (pick: DrainPick | null) => void;
}

export function drainsLayers({ drains, show }: DrainsLayerOptions): unknown[] {
  if (!show || drains.length === 0) return [];
  return [
    new PathLayer<DrainPath, PathStyleExtensionProps<DrainPath>>({
      id: "drains",
      data: drains as DrainPath[],
      getPath: (d) => d.path,
      getColor: (d) => drainColour(d.beta),
      // Section 6.7: width by diameter, 1-4 px.
      getWidth: (d) => Math.min(1 + d.diameter * 2, 4),
      widthUnits: "pixels",
      // The floor never binds on this data and is kept only as a guard: diameters snap to
      // 450-1500 mm, so the narrowest pipe already draws at 1 + 2 x 0.45 = 1.9 px, wide
      // enough for the dash to separate. What the dash cannot survive is the citywide fit
      // both this page and the console open at - a 40 m pipe is about two pixels long there,
      // so the network reads as a wash until the operator zooms in. That is scale, not a
      // style: the dash is drawn at every zoom, and separates once a junction fills the view.
      widthMinPixels: 0.8,
      extensions: [DASHED],
      getDashArray: DRAIN_DASH,
      dashJustified: true,
      pickable: false,
    }),
  ];
}
