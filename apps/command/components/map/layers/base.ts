/**
 * The city's own ground: building footprints and the dry street network (CLAUDE.md 6.7).
 *
 * Neither changes with the scrub, which is why `CityMap` memoises them apart from the run's
 * layers - moving the time bar never rebuilds 39,259 building polygons.
 */

import { PathLayer, PolygonLayer } from "@deck.gl/layers";

import { BUILDING_FILL, BUILDING_LINE, DRY_STREET } from "./palette";
import type { BuildingPolygon, SegmentPath } from "./types";

export interface BuildingsLayerOptions {
  buildings: readonly BuildingPolygon[];
  show: boolean;
}

export function buildingsLayers({ buildings, show }: BuildingsLayerOptions): unknown[] {
  if (!show || buildings.length === 0) return [];
  return [
    new PolygonLayer<BuildingPolygon>({
      id: "buildings",
      data: buildings as BuildingPolygon[],
      getPolygon: (d) => d,
      filled: true,
      getFillColor: BUILDING_FILL,
      stroked: true,
      getLineColor: BUILDING_LINE,
      lineWidthMinPixels: 0.4,
      lineWidthUnits: "pixels",
      pickable: false,
    }),
  ];
}

export interface DryStreetsLayerOptions {
  baseSegments: readonly SegmentPath[];
}

/**
 * The whole street network, dim. This is the geography the operator orients by, and it is the
 * same 21,296 segments the city pipeline derived - not a tile service's idea of Mumbai.
 */
export function dryStreetsLayers({ baseSegments }: DryStreetsLayerOptions): unknown[] {
  if (baseSegments.length === 0) return [];
  return [
    new PathLayer<SegmentPath>({
      id: "streets-dry",
      data: baseSegments as SegmentPath[],
      getPath: (d) => d.path,
      getColor: DRY_STREET,
      getWidth: (d) => Math.max(d.width * 0.7, 0.8),
      widthUnits: "pixels",
      widthMinPixels: 0.6,
      capRounded: true,
      jointRounded: true,
      pickable: false,
    }),
  ];
}
