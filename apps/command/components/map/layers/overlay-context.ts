/**
 * What a screen can ask of `CityMap` without threading it through the map component between them.
 *
 * The console hosts `CityMap` inside `FloodMap`, which owns the run load and passes a fixed set of
 * props through. 3D mode, the console's routes layer and the what-if difference layer are three
 * things only the console asks for, so they arrive here, through context, rather than as three
 * more pass-through props on a component every other screen shares. Every screen that provides
 * nothing gets the defaults below and draws exactly what it drew before.
 */

import { createContext, useContext } from "react";

import type { RouteLine } from "./types";

export interface MapOverlay {
  /** Draw the city on its own terrain (CLAUDE.md 6.7, task P6.15). */
  threeD?: boolean;
  /** Whose terrain: the city the screen is showing. */
  city?: string;
  /** Routes to draw over the streets (CLAUDE.md 7.2, the "R" layer). */
  routes?: readonly RouteLine[];
  /**
   * A what-if answer to draw as the difference layer (CLAUDE.md 7.7): change in peak depth per
   * segment, and how far the M13 wipe has reached, 0 to 1.
   */
  diff?: { deltaCm: ReadonlyMap<string, number>; progress: number } | null;
}

const NONE: MapOverlay = {};

export const MapOverlayContext = createContext<MapOverlay>(NONE);

export function useMapOverlay(): MapOverlay {
  return useContext(MapOverlayContext);
}
