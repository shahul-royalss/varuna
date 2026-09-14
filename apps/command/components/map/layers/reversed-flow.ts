/**
 * Reversed-flow drain edges (CLAUDE.md 6.7, motion M9): the tide-locked outfall pushing water
 * back up the trunk.
 *
 * **A seam, not a layer yet.** Chunk MO3 draws these with an animated dash once the surcharge
 * product carries edge geometry; until then this returns nothing, and `CityMap` keeps its slot in
 * the section 6.7 order (after the streets, under the surcharge markers) so MO3 edits only this
 * file.
 */

import type { ReversedEdgePath } from "./types";

export interface ReversedFlowLayerOptions {
  edges: readonly ReversedEdgePath[];
  show: boolean;
  step: number;
  reducedMotion: boolean;
}

export function reversedFlowLayers(options: ReversedFlowLayerOptions): unknown[] {
  void options;
  return [];
}
