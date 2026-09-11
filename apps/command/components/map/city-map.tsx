"use client";

/**
 * `CityMap` — the console's one memorable element (CLAUDE.md sections 6.1, 6.7, task P6.1).
 *
 * deck.gl renders standalone here, with **no basemap tile service behind it**. That is a
 * deliberate departure from section 5's "MapLibre + deck.gl" and it is worth stating plainly:
 *
 * 1. MapLibre decodes vector tiles in a web worker, and under this app's bundler the worker does
 *    not load - the style, the sprite and tiles.json all fetch, and then not one `.pbf` is ever
 *    requested, so the basemap is permanently blank. Rendering a map that is reliably empty is
 *    worse than rendering no map.
 * 2. CLAUDE.md 17 requires the finale to run with the venue's network switched off, and a CDN
 *    basemap is the one thing on this screen that cannot. Everything drawn below comes from the
 *    city VARUNA built and the run it computed, so the console works on an aeroplane.
 *
 * What replaces it is not a placeholder, it is the city's own GIS. 39,259 building footprints
 * give Mumbai its texture, 21,296 road segments give it its shape, and the drain graph beneath
 * them is the thing no basemap has. A judge reads the city from the data VARUNA derived, which
 * is the honest version of this map anyway.
 *
 * Layer order follows section 6.7 bottom to top: buildings, depth raster, dry streets, wet
 * streets, drains, surcharging manholes, hotspot rings.
 *
 * **Scrubbing costs nothing.** The run's 36 frames are decoded to ImageBitmaps before the scrub
 * is usable; a step change swaps a texture and re-runs one colour accessor. No fetch, no decode
 * (CLAUDE.md 7.2: "no network during scrub").
 */

import { FlyToInterpolator, WebMercatorViewport } from "@deck.gl/core";
import { BitmapLayer, PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import DeckGL from "@deck.gl/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { boundsCentre, cityBounds, type Bbox } from "./basemap";
import { MAP_ATTRIBUTION, labelLayers, satelliteLayers } from "./satellite";
import {
  labelMarkerLayers,
  labelTextLayers,
  streetLabels,
  visibleLabels,
  type MapLabel,
} from "./labels";
import type { CityMapMode } from "./types";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { DUR_MS, FLY_TO_CURVE } from "@/lib/motion";
import { depthRgba, probabilityRgba } from "@/lib/ramps";

/** One segment's geometry plus the depth series the run gave it. */
export interface SegmentPath {
  id: string;
  path: [number, number][];
  /** Depth in cm at each of the run's steps; empty means the run never wet it. */
  depthCm: number[];
  /** Road class, which sets the drawn width (section 6.7: 2-6 px by class). */
  width: number;
  /** Street name from OSM, where it has one. Drawn as a label at high zoom. */
  name?: string;
  /** Change in peak depth under a what-if, in cm. Negative is an improvement. */
  deltaCm?: number;
}

export interface SurchargeNode {
  id: string;
  lon: number;
  lat: number;
  /** Discharge out of the manhole at the current step, in m³/s; sets the marker's size. */
  q?: number;
}

export interface HotspotRing {
  id: string;
  name: string;
  lon: number;
  lat: number;
}

/** A building footprint ring, in lon/lat. */
export type BuildingPolygon = [number, number][];

/** One inferred drain edge, coloured by its blockage prior. */
export interface DrainPath {
  path: [number, number][];
  /** Blockage 0-1; the magenta ramp of section 6.2. */
  beta: number;
  /** Pipe diameter in metres, which sets the drawn width (section 6.7: 1-4 px). */
  diameter: number;
}

/** One drawn route: the naive shortest path, the VARUNA route, or an alternate. */
export interface RouteLine {
  id: string;
  path: [number, number][];
  /** `naive` is the dashed grey comparison; `varuna` the tide-coloured route (section 6.7);
   * `avoided` is a street the route refused, drawn in the depth ramp's deepest red. */
  kind: "naive" | "varuna" | "alternate" | "avoided";
}

/** One reachability band, drawn as a translucent polygon (section 6.2 `--reach-*`). */
export interface Isochrone {
  minutes: number;
  rings: [number, number][][];
}

/** Where to fly. `key` changes on every request, so clicking the same row twice flies again. */
export interface MapFocus {
  lon: number;
  lat: number;
  key: string;
  /** Zoom to settle at; the flight never zooms out from a closer view the operator chose. */
  zoom?: number;
}

export interface CityMapProps {
  mode?: CityMapMode;
  frames: readonly (ImageBitmap | null)[];
  rasterBounds: [number, number, number, number] | null;
  /** Every road in the city, for context. Drawn once, in the dry colour. */
  baseSegments: readonly SegmentPath[];
  /** The segments this run wetted, coloured by depth at the current step. */
  segments: readonly SegmentPath[];
  surcharge: readonly SurchargeNode[];
  hotspots: readonly HotspotRing[];
  /** Building footprints; the city's texture. Loaded after first paint. */
  buildings?: readonly BuildingPolygon[];
  /** The inferred drain graph, off by default (section 6.7). */
  drains?: readonly DrainPath[];
  /** Routes to draw over everything else (section 6.7's layer order). */
  routes?: readonly RouteLine[];
  /** Reachability bands, under the routes and over the streets. */
  isochrones?: readonly Isochrone[];
  /** Depth in cm at which the audience's vehicle stops. Set it and the wet streets are drawn in
   * the public map's three colours instead of the operator's depth ramp (CLAUDE.md 7.11). */
  passableBelowCm?: number;
  /** The hotspot the rail has selected; drawn as a second, brighter ring (motion M10). */
  selectedHotspotId?: string | null;
  /** Fly the camera here when `key` changes. */
  focus?: MapFocus | null;
  step: number;
  /** The area the camera frames on first paint. Defaults to the city's AOI. */
  bounds?: Bbox;
  showRaster?: boolean;
  showSegments?: boolean;
  showSurcharge?: boolean;
  showHotspots?: boolean;
  showBuildings?: boolean;
  showDrains?: boolean;
  /** Draw Esri's aerial imagery under everything (section 6.7's basemap slot). */
  showSatellite?: boolean;
  /** Probability mode (CLAUDE.md 6.2, task P6.5): the depth-ramp colour at the p50 depth, with
   * opacity set by P(depth > this threshold in cm). Unset draws ordinary depth. */
  probabilityThresholdCm?: number;
  /** Draw `segments` by their `deltaCm` rather than their depth: the what-if diff layer
   * (CLAUDE.md 7.7). Blue is improved, red is worse, grey is unchanged. */
  diffMode?: boolean;
  /** 0 to 1 left-to-right reveal of the diff layer (motion M13). 1 shows all of it. */
  diffProgress?: number;
  /** Place names, street names and facility markers (section 6.7's label layer). */
  showLabels?: boolean;
  /** Facilities and chronic junctions to name on the map, beside the street names. */
  labels?: readonly MapLabel[];
  /** Draw the map credit. Off where `MapSlot` sits behind this map and draws it already. */
  attribution?: boolean;
}

const MUMBAI_CENTRE = boundsCentre(cityBounds("mumbai"));

/** Used only until the container has been measured; the fit below replaces it on that frame. */
const INITIAL_VIEW = { ...MUMBAI_CENTRE, zoom: 11.4, bearing: 0, pitch: 0 };

type ViewState = typeof INITIAL_VIEW & {
  transitionDuration?: number;
  transitionInterpolator?: FlyToInterpolator;
};

/** Section 6.7: the raster sits at 55 % so the streets read through it. */
const RASTER_OPACITY = 0.55;

/** `--depth-dry` #2B3A55: present, and quiet enough that water is the only bright thing. */
const DRY_STREET: [number, number, number, number] = [43, 58, 85, 235];

/** `--deep` #111A2E, the panel colour: buildings are the ground the streets are cut into. */
const BUILDING_FILL: [number, number, number, number] = [17, 26, 46, 235];

/** The public map's three colours (CLAUDE.md 7.11 and `PublicLegend`): go, slow down, do not
 * enter. A commuter does not need six depth bands, they need to know whether to turn around.
 *
 * `--depth-1` #3B82F6, `--depth-3` #F97316, `--depth-5` #B91C1C - the same three the legend on
 * that screen draws, so the swatch and the street are provably the same colour. */
const PASSABLE: [number, number, number, number] = [59, 130, 246, 235];
const CAUTION: [number, number, number, number] = [249, 115, 22, 245];
const IMPASSABLE: [number, number, number, number] = [185, 28, 28, 255];

/** Caution begins at this share of the vehicle's own stopping depth. */
const CAUTION_FRACTION = 0.5;

function passabilityRgba(
  depthCm: number,
  thresholdCm: number,
): [number, number, number, number] {
  if (depthCm >= thresholdCm) return IMPASSABLE;
  if (depthCm >= thresholdCm * CAUTION_FRACTION) return CAUTION;
  return PASSABLE;
}

/** `--naive` #64748B: the shortest path a navigation app would give you today. */
const NAIVE_ROUTE: [number, number, number, number] = [100, 116, 139, 235];

/** `--tide` #2DD4BF: the route VARUNA gives you instead. */
const VARUNA_ROUTE: [number, number, number, number] = [45, 212, 191, 255];

/** The what-if diff ramp (CLAUDE.md 7.7): blue improved, red worse, grey unchanged.
 *
 * `--depth-1` #3B82F6 for water removed and `--depth-4` #EF4444 for water added - the same two
 * ends of the depth ramp an operator already reads, so "blue is better" needs no legend. Grey is
 * `--depth-dry`, and it is deliberately the *majority* colour: most of a city does not change
 * when fourteen pipes are cleaned, and a diff layer that lights up everywhere is lying. */
const DIFF_IMPROVED: [number, number, number] = [59, 130, 246];
const DIFF_WORSE: [number, number, number] = [239, 68, 68];
const DIFF_UNCHANGED: [number, number, number, number] = [43, 58, 85, 190];

/** Change below this is not a change: the emulator's own noise floor is larger than half a cm. */
const DIFF_DEADBAND_CM = 0.5;

/** Change at which the diff colour is fully saturated. Past 20 cm it is "a lot" either way. */
const DIFF_FULL_CM = 20;

/** A segment's diff colour: opacity carries the size of the change, hue carries its sign. */
function diffColour(deltaCm: number | undefined): [number, number, number, number] {
  const delta = deltaCm ?? 0;
  if (Math.abs(delta) < DIFF_DEADBAND_CM) return DIFF_UNCHANGED;
  const strength = Math.min(Math.abs(delta) / DIFF_FULL_CM, 1);
  const [r, g, b] = delta < 0 ? DIFF_IMPROVED : DIFF_WORSE;
  return [r, g, b, Math.round(90 + 165 * strength)];
}

/** `--depth-5` #B91C1C: a street the route refused, so the detour has something to be around. */
const AVOIDED_ROUTE: [number, number, number, number] = [185, 28, 28, 255];

/** Every route line's colour, by what the line is. */
const ROUTE_COLOUR: Record<RouteLine["kind"], [number, number, number, number]> = {
  naive: NAIVE_ROUTE,
  varuna: VARUNA_ROUTE,
  alternate: [45, 212, 191, 150],
  avoided: AVOIDED_ROUTE,
};

/**
 * The first `fraction` of a path, by cumulative length, with the cut edge interpolated.
 *
 * Interpolated rather than truncated to the nearest vertex: a route's legs are hundreds of metres
 * long, so snapping to vertices makes the draw-on jump in visible chunks instead of running
 * smoothly along the road.
 */
function partialPath(path: [number, number][], fraction: number): [number, number][] {
  if (fraction >= 1 || path.length < 2) return path;
  if (fraction <= 0) return path.slice(0, 1);

  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const dx = path[i][0] - path[i - 1][0];
    const dy = path[i][1] - path[i - 1][1];
    const d = Math.hypot(dx, dy);
    lengths.push(d);
    total += d;
  }

  const target = total * fraction;
  const out: [number, number][] = [path[0]];
  let walked = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    if (walked + lengths[i] >= target) {
      const t = lengths[i] > 0 ? (target - walked) / lengths[i] : 0;
      out.push([
        path[i][0] + (path[i + 1][0] - path[i][0]) * t,
        path[i][1] + (path[i + 1][1] - path[i][1]) * t,
      ]);
      break;
    }
    walked += lengths[i];
    out.push(path[i + 1]);
  }
  return out;
}

/** Motion M14's duration: the VARUNA route draws itself over 1.2 s (CLAUDE.md 8). */
const ROUTE_DRAW_MS = 1200;

/**
 * 0 to 1 over {@link ROUTE_DRAW_MS} whenever the drawn route changes; 1 at once under reduced
 * motion, where CLAUDE.md 8 asks for both routes shown together rather than drawn.
 */
function useRouteDraw(key: string, reducedMotion: boolean): number {
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    if (!key || reducedMotion) {
      // Reduced motion wants the finished route immediately. Setting it on the next frame rather
      // than synchronously keeps this out of the cascading-render path the lint rule guards, and a
      // frame is imperceptible for something whose whole point is that it does not animate.
      const settle = requestAnimationFrame(() => setProgress(1));
      return () => cancelAnimationFrame(settle);
    }
    let frame = 0;
    const started = performance.now();
    const tick = () => {
      const elapsed = performance.now() - started;
      const t = Math.min(elapsed / ROUTE_DRAW_MS, 1);
      // The same ease as every other motion in the catalogue (CLAUDE.md 8): fast out of the
      // origin, settling into the destination.
      setProgress(1 - (1 - t) ** 3);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [key, reducedMotion]);

  return progress;
}

/** `--ink` #0A1020: the casing that lifts the route off whatever it crosses (section 6.7). */
const ROUTE_CASING: [number, number, number, number] = [10, 16, 32, 235];

/** `--tide` at the section 6.2 opacities for the 5, 10 and 15-minute bands. */
const REACH_FILL: Record<number, [number, number, number, number]> = {
  5: [45, 212, 191, 115],
  10: [45, 212, 191, 71],
  15: [45, 212, 191, 36],
};

/** `--line` #24314F: a hairline so a block reads as blocks rather than one grey mass. */
const BUILDING_LINE: [number, number, number, number] = [36, 49, 79, 170];

/** The magenta blockage ramp of section 6.2, `--drain-0` through `--drain-3`. */
const DRAIN_RAMP: [number, number, number][] = [
  [62, 76, 110],
  [124, 58, 237],
  [192, 38, 211],
  [232, 121, 249],
];

function drainColour(beta: number): [number, number, number, number] {
  const band = beta > 0.75 ? 3 : beta > 0.5 ? 2 : beta > 0.25 ? 1 : 0;
  const [r, g, b] = DRAIN_RAMP[band];
  return [r, g, b, 200];
}

/** Framing margin in pixels, so the coast and the northern subways are not against the edge.
 *
 * Deliberately small. The layer panel, the legend and the hotspot rail all float *over* the map,
 * so the city already has furniture around it; a wide margin as well leaves it swimming in a
 * panel it is meant to fill. */
const FIT_PADDING = 12;

/**
 * Phase 0-1 of the surcharge pulse, or a fixed 0 when it should not run (motion M8).
 *
 * The loop runs every display frame but the phase it publishes is quantised, and the setter
 * bails when the value has not changed - so React re-renders `PULSE_FRAMES` times per cycle
 * (12.5 a second) rather than 60. Quantising also makes the pulse the same size on a 60 Hz and
 * a 144 Hz display.
 *
 * The surcharge markers are the only looping thing on the console, and CLAUDE.md 8 allows it
 * because a pulsing manhole is data - it is the drain failing - not decoration.
 */
function useSurchargePulse(active: boolean): number {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const next =
        Math.round(
          (((now - started) % DUR_MS.surchargePulse) / DUR_MS.surchargePulse) * PULSE_FRAMES,
        ) / PULSE_FRAMES;
      setPhase((current) => (current === next ? current : next));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // Read through `active` rather than resetting the state when the loop stops: a phase left over
  // from the last pulse would otherwise freeze the ring mid-expansion under reduced motion.
  return active ? phase : 0;
}

/** Steps the pulse is quantised to over its 1.6 s: 20 is smooth and costs 12 renders a second. */
const PULSE_FRAMES = 20;

export function CityMap({
  mode = "console",
  frames,
  rasterBounds,
  baseSegments,
  segments,
  surcharge,
  hotspots,
  buildings = [],
  drains = [],
  routes = [],
  isochrones = [],
  passableBelowCm,
  selectedHotspotId = null,
  focus = null,
  step,
  bounds,
  showRaster = true,
  showSegments = true,
  showSurcharge = true,
  showHotspots = true,
  showBuildings = true,
  showDrains = false,
  probabilityThresholdCm,
  diffMode = false,
  diffProgress = 1,
  showSatellite = true,
  showLabels = true,
  labels = [],
  attribution = true,
}: CityMapProps) {
  const interactive = mode !== "hero";
  const reducedMotion = usePrefersReducedMotion();

  // A new route draws itself in (motion M14). Keyed on the drawn geometry, so re-planning the
  // same trip after a profile change animates again and a scrub does not.
  const routeKey = useMemo(
    () => routes.map((r) => `${r.kind}:${r.path.length}:${r.path[0]?.join(",") ?? ""}`).join("|"),
    [routes],
  );
  const drawProgress = useRouteDraw(routeKey, reducedMotion);
  const pulse = useSurchargePulse(showSurcharge && surcharge.length > 0 && !reducedMotion);

  // ---- Framing --------------------------------------------------------------------------
  // **The camera is controlled.** It used to be handed to deck.gl as `initialViewState` on the
  // theory that deck would notice a changed object and move itself. It does not: `initialViewState`
  // is read once, when the view is created, and the fit computed from the first `ResizeObserver`
  // callback arrives a frame *after* that. So the map stayed at the placeholder zoom for ever -
  // the city sat in a corner of the console with the panel half empty, and on `/drains` the pipes
  // rendered as a thumbnail in the middle of nothing.
  //
  // The fit is **derived, not stored**. Only two things are state: the measured container and the
  // camera once somebody moves it. Everything else is computed during render, which is what makes
  // a resize or a data load re-frame on its own - no effect, no stale copy of the view.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [camera, setCamera] = useState<ViewState | null>(null);
  // Whether the operator has taken the camera. deck reports *every* view-state change through
  // `onViewStateChange`, including ones it makes itself when the canvas is resized, so "camera is
  // not null" is not the same question as "somebody moved it" - treating them as the same left
  // `/route` framed on the whole city after a resize instead of on the trip it had just drawn.
  // Only a drag, a zoom, a rotate or a fly-to sets this; until then the fit owns the view.
  const [owned, setOwned] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const aoi = bounds ?? cityBounds("mumbai");

  // **What the camera frames: what is actually drawn, not the city's configured AOI.** `/drains`
  // draws the drain graph, the console draws the street network, and those cover different ground.
  // The AOI is the fallback for a map with nothing on it yet.
  const frame = useMemo<Bbox>(() => {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    const eat = (lon: number, lat: number) => {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    };
    // A drawn route wins: on `/route` the whole city is loaded for context, but the answer on
    // screen is one trip and the camera should be on it.
    for (const line of routes) for (const [lon, lat] of line.path) eat(lon, lat);
    if (Number.isFinite(west)) {
      // A little air around a route, which is a thin thing in a wide panel.
      const padLon = Math.max((east - west) * 0.35, 0.004);
      const padLat = Math.max((north - south) * 0.35, 0.004);
      return [
        [west - padLon, south - padLat],
        [east + padLon, north + padLat],
      ] as Bbox;
    }

    // Streets next: when the city layer is loaded it is the widest thing on the map, and it is
    // the extent the console should sit at.
    for (const segment of baseSegments) for (const [lon, lat] of segment.path) eat(lon, lat);
    if (!Number.isFinite(west)) {
      for (const segment of segments) for (const [lon, lat] of segment.path) eat(lon, lat);
    }
    if (!Number.isFinite(west)) {
      for (const drain of drains) for (const [lon, lat] of drain.path) eat(lon, lat);
    }
    if (!Number.isFinite(west)) for (const ring of hotspots) eat(ring.lon, ring.lat);
    // Nothing drawn, or an extent too small to fit against (one point, a single street).
    if (!Number.isFinite(west) || east - west < 1e-3 || north - south < 1e-3) return aoi;
    return [
      [west, south],
      [east, north],
    ] as Bbox;
  }, [routes, baseSegments, segments, drains, hotspots, aoi]);

  // Where the diff wipe has reached, as a longitude. Derived from the drawn extent rather than
  // from a screen-space mask, so the wipe follows the city and not the window.
  const wipeLon = useMemo(() => {
    if (!diffMode || diffProgress >= 1) return Number.POSITIVE_INFINITY;
    const [[west], [east]] = frame;
    return west + (east - west) * diffProgress;
  }, [diffMode, diffProgress, frame]);

  const fitted = useMemo<ViewState>(() => {
    if (!size || size.width < 2 || size.height < 2) return INITIAL_VIEW;
    const [[west, south], [east, north]] = frame;
    const view = new WebMercatorViewport({ width: size.width, height: size.height }).fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: FIT_PADDING },
    );
    return {
      longitude: view.longitude,
      latitude: view.latitude,
      zoom: view.zoom,
      bearing: 0,
      pitch: 0,
    };
  }, [size, frame]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setSize((current) =>
        current && Math.abs(current.width - box.width) < 1 &&
        Math.abs(current.height - box.height) < 1
          ? current
          : { width: box.width, height: box.height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Motion M10: a 900 ms flight to the selected hotspot, a jump cut under reduced motion.
  //
  // Keyed on `focus.key` rather than the coordinates, so selecting the same row twice flies
  // again: after panning away, "show me Hindmata" should still take you back. A flight counts as
  // moving the camera, so the fit stops claiming it afterwards.
  const focusKey = focus?.key ?? null;
  useEffect(() => {
    if (!focus) return;
    // Everything the flight does not name it inherits from wherever the camera already is - and
    // when it has never been moved, from `INITIAL_VIEW`, whose bearing and pitch are the zero the
    // fit produces anyway. So the fallback costs nothing and a rotated camera keeps its rotation.
    //
    // `set-state-in-effect` is disabled here, and only here, with a reason. The rule exists to
    // stop effects being used to recompute state that could have been derived, and the fit above
    // takes that advice - it is derived, not stored. This is the other thing entirely: `focus` is
    // an imperative command from the hotspot rail ("fly here now"), and deck.gl's camera is the
    // external system it commands. Deriving it instead would pin the camera to the focus and the
    // operator could never pan away from a selected hotspot. One render per click is the cost.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOwned(true);
    setCamera((current) => ({
      ...(current ?? INITIAL_VIEW),
      longitude: focus.lon,
      latitude: focus.lat,
      zoom: focus.zoom ?? 14,
      transitionDuration: reducedMotion ? 0 : DUR_MS.flight,
      transitionInterpolator: reducedMotion
        ? undefined
        : new FlyToInterpolator({ curve: FLY_TO_CURVE }),
    }));
    // `focus` is a fresh object each render; `focusKey` is the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, reducedMotion]);

  const viewState = owned ? (camera ?? fitted) : fitted;

  // ---- Layers ---------------------------------------------------------------------------
  // Everything that does not change with the scrub, memoised apart from the things that do, so
  // moving the time bar never rebuilds 39,259 building polygons.
  const cityLayers = useMemo(() => {
    const built: unknown[] = [];

    if (showBuildings && buildings.length > 0) {
      built.push(
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
      );
    }
    return built;
  }, [buildings, showBuildings]);

  const streetLayers = useMemo(() => {
    const built: unknown[] = [];

    // The whole street network, dim. This is the geography the operator orients by, and it is
    // the same 21,296 segments the city pipeline derived - not a tile service's idea of Mumbai.
    if (baseSegments.length > 0) {
      built.push(
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
      );
    }

    if (showDrains && drains.length > 0) {
      built.push(
        new PathLayer<DrainPath>({
          id: "drains",
          data: drains as DrainPath[],
          getPath: (d) => d.path,
          getColor: (d) => drainColour(d.beta),
          // Section 6.7: width by diameter, 1-4 px.
          getWidth: (d) => Math.min(1 + d.diameter * 2, 4),
          widthUnits: "pixels",
          widthMinPixels: 0.8,
          pickable: false,
        }),
      );
    }
    return built;
  }, [baseSegments, drains, showDrains]);

  const runLayers = useMemo(() => {
    const built: unknown[] = [];

    const frame = frames[step] ?? null;
    if (showRaster && frame && rasterBounds) {
      built.push(
        new BitmapLayer({
          id: "depth-raster",
          bounds: rasterBounds,
          image: frame,
          opacity: RASTER_OPACITY,
          pickable: false,
          // Nearest on magnify: a 30 m cell is a real measurement and smoothing it across the
          // screen would imply a resolution the model does not have.
          textureParameters: { minFilter: "linear", magFilter: "nearest" },
        }),
      );
    }

    if (showSegments && segments.length > 0) {
      built.push(
        new PathLayer<SegmentPath>({
          id: "streets-wet",
          data: segments as SegmentPath[],
          getPath: (d) => d.path,
          getColor: (d) => {
            if (diffMode) {
              // Motion M13: the diff wipes in left to right. A segment east of the wipe is drawn
              // unchanged rather than hidden, so the network stays whole while the answer arrives -
              // hiding it would read as "these streets were deleted".
              const lon = d.path[0]?.[0] ?? 0;
              return lon <= wipeLon ? diffColour(d.deltaCm) : DIFF_UNCHANGED;
            }
            const depth = d.depthCm[step] ?? 0;
            if (probabilityThresholdCm !== undefined) {
              // **P is 0 or 1 on a one-member run**, and that is not an approximation: a
              // deterministic forecast either puts the street over the threshold or it does not.
              // The 15 % floor of CLAUDE.md 6.2 keeps a below-threshold street visible rather
              // than vanishing, and the legend says which kind of run this is.
              return probabilityRgba(depth, depth > probabilityThresholdCm ? 1 : 0);
            }
            return passableBelowCm === undefined
              ? depthRgba(depth)
              : passabilityRgba(depth, passableBelowCm);
          },
          getWidth: (d) =>
            // A changed street is drawn thicker, so the answer reads from across a room.
            diffMode && Math.abs(d.deltaCm ?? 0) >= DIFF_DEADBAND_CM ? d.width * 1.8 : d.width * 1.15,
          widthUnits: "pixels",
          widthMinPixels: 1.6,
          capRounded: true,
          jointRounded: true,
          pickable: false,
          // A scrub changes one thing, so one accessor is re-run.
          updateTriggers: {
            getColor: [step, passableBelowCm, diffMode, wipeLon, probabilityThresholdCm],
            getWidth: [diffMode],
          },
        }),
      );
    }

    if (showHotspots && hotspots.length > 0) {
      built.push(
        new ScatterplotLayer<HotspotRing>({
          id: "hotspot-rings",
          data: hotspots as HotspotRing[],
          getPosition: (d) => [d.lon, d.lat],
          // 120 m (section 6.7), so it reads as a place rather than a pin.
          getRadius: 120,
          radiusUnits: "meters",
          radiusMinPixels: 4,
          filled: false,
          stroked: true,
          // Unselected rings sit back; the selected one is the only glow on the map
          // (section 6.4), which is what makes the rail's click legible from a distance.
          getLineColor: (d) =>
            d.id === selectedHotspotId ? [45, 212, 191, 255] : [45, 212, 191, 130], // --tide
          getLineWidth: (d) => (d.id === selectedHotspotId ? 3 : 1.2),
          lineWidthUnits: "pixels",
          lineWidthMinPixels: 1,
          pickable: false,
          updateTriggers: {
            getLineColor: selectedHotspotId,
            getLineWidth: selectedHotspotId,
          },
        }),
      );
    }
    return built;
  }, [frames, step, rasterBounds, segments, hotspots, selectedHotspotId, showRaster, showSegments, showHotspots, passableBelowCm, diffMode, wipeLon, probabilityThresholdCm]);

  // Motion M8, rebuilt on every pulse frame and therefore kept on its own so that a pulse
  // re-uploads nothing but the markers.
  const surchargeLayer = useMemo(() => {
    if (!showSurcharge || surcharge.length === 0) return null;
    const grow = 1 + 1.4 * pulse;
    const fade = Math.round(200 * (1 - pulse));
    return new ScatterplotLayer<SurchargeNode>({
      id: "surcharge",
      data: surcharge as SurchargeNode[],
      getPosition: (d) => [d.lon, d.lat],
      // Radius by discharge, so a manhole shifting 0.4 m³/s reads bigger than one at 0.01.
      // Square root because the eye compares areas, and the marker's area is what it is.
      getRadius: (d) => 40 + 110 * Math.sqrt(Math.min(d.q ?? 0, 1)),
      radiusUnits: "meters",
      radiusMinPixels: 3,
      radiusMaxPixels: 16,
      radiusScale: grow,
      filled: true,
      getFillColor: [239, 68, 68, Math.max(fade, 70)], // --surcharge
      stroked: true,
      getLineColor: [239, 68, 68, 240],
      lineWidthMinPixels: 1,
      pickable: false,
      updateTriggers: { getRadius: surcharge, getFillColor: fade },
    });
  }, [showSurcharge, surcharge, pulse]);

  // Reachability under the routes, routes over everything (section 6.7's order). Both are small -
  // three polygons and four paths - so they rebuild on every change without a memo of their own
  // costing less than it saves.
  const routeLayers = useMemo(() => {
    const built: unknown[] = [];

    if (isochrones.length > 0) {
      built.push(
        new PolygonLayer<Isochrone>({
          id: "isochrones",
          // Largest band first, so the 5-minute core reads as the darkest patch rather than
          // being painted over by the 15-minute one.
          data: [...isochrones].sort((a, b) => b.minutes - a.minutes) as Isochrone[],
          getPolygon: (d) => d.rings[0] ?? [],
          getFillColor: (d) => REACH_FILL[d.minutes] ?? REACH_FILL[15],
          getLineColor: [45, 212, 191, 140],
          getLineWidth: 1,
          lineWidthUnits: "pixels",
          stroked: true,
          filled: true,
          pickable: false,
        }),
      );
    }

    if (routes.length > 0) {
      // The casing is a wider, darker path drawn first: without it the route disappears wherever
      // it crosses a street of a similar tone, which on this map is most of them.
      built.push(
        new PathLayer<RouteLine>({
          id: "route-casing",
          data: routes.filter((r) => r.kind === "varuna" || r.kind === "alternate") as RouteLine[],
          getPath: (d) => d.path,
          getColor: ROUTE_CASING,
          getWidth: 7,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          pickable: false,
        }),
        new PathLayer<RouteLine>({
          id: "routes",
          data: routes as RouteLine[],
          // Motion M14: the VARUNA route draws itself over 1.2 s. `drawProgress` runs 0 to 1 and
          // the path is truncated to that fraction of its length, so the line grows from the
          // origin rather than fading in - which is what makes it read as *a route being found*
          // instead of a shape appearing.
          getPath: (d) => (d.kind === "varuna" ? partialPath(d.path, drawProgress) : d.path),
          getColor: (d) => ROUTE_COLOUR[d.kind],
          getWidth: (d) => (d.kind === "varuna" ? 5 : d.kind === "avoided" ? 4 : 3),
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          pickable: false,
          updateTriggers: {
            getPath: [routes.length, drawProgress],
            getColor: routes.length,
            getWidth: routes.length,
          },
        }),
      );
    }
    return built;
  }, [routes, isochrones, drawProgress]);

  // The basemap, under everything. Rebuilt only when it is toggled or the raster comes and goes:
  // `TileLayer` keeps its own tile cache, and handing deck a new instance every render would
  // throw that cache away on every scrub.
  const basemapLayers = useMemo(
    () => satelliteLayers({ enabled: showSatellite, dimmed: showRaster }),
    [showSatellite, showRaster],
  );

  // **Labels are computed from what is on screen, at the zoom that is on screen.** That is why
  // the camera being controlled matters beyond framing: `viewState` is a React value, so the
  // label set is an ordinary derivation of it. An uncontrolled camera would have needed deck to
  // report its zoom back through an event before any of this could be decided.
  const named = useMemo(
    () => [...streetLabels(baseSegments), ...streetLabels(segments), ...labels],
    [baseSegments, segments, labels],
  );

  // **Quantised, not exact.** `viewState` is a new object on every frame of a pan or a fly-to, and
  // a label set derived from it recomputes sixty times a second - which rebuilds the layer array
  // sixty times a second, and the tile layers underneath spend their time being reconciled instead
  // of drawing. Rounding the camera to a tenth of a zoom level and ~100 m of position gives the
  // same labels and recomputes only when the view has meaningfully moved.
  const cameraKey = useMemo(
    () =>
      [
        Math.round(viewState.zoom * 10),
        Math.round(viewState.longitude * 1000),
        Math.round(viewState.latitude * 1000),
      ].join(":"),
    [viewState.zoom, viewState.longitude, viewState.latitude],
  );

  const drawnLabels = useMemo(() => {
    if (!showLabels || named.length === 0) return [];
    const zoom = viewState.zoom;
    // The viewport in lon/lat, so only labels the operator can actually see count against the cap.
    let visibleBounds: Bbox | null = null;
    if (size) {
      try {
        const viewport = new WebMercatorViewport({
          width: size.width,
          height: size.height,
          longitude: viewState.longitude,
          latitude: viewState.latitude,
          zoom,
        });
        const [[west, south], [east, north]] = viewport.getBounds() as unknown as [
          [number, number],
          [number, number],
        ];
        visibleBounds = [
          [west, south],
          [east, north],
        ];
      } catch {
        visibleBounds = null;
      }
    }
    return visibleLabels({ labels: named, zoom, bounds: visibleBounds });
    // `cameraKey` is the identity that matters; `viewState` is read for its exact values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLabels, named, cameraKey, size]);

  const labelDrawLayers = useMemo(
    () => [
      ...labelLayers({ enabled: showSatellite && showLabels }),
      ...labelMarkerLayers(drawnLabels),
      ...labelTextLayers(drawnLabels),
    ],
    [showSatellite, showLabels, drawnLabels],
  );

  const layers = useMemo(
    () => [
      ...basemapLayers,
      ...cityLayers,
      ...streetLayers,
      ...runLayers,
      ...(surchargeLayer ? [surchargeLayer] : []),
      ...routeLayers,
      // Labels last: a street name the depth ramp paints over is a name nobody can read.
      ...labelDrawLayers,
    ],
    [basemapLayers, cityLayers, streetLayers, runLayers, surchargeLayer, routeLayers, labelDrawLayers],
  );

  return (
    <div ref={containerRef} className="absolute inset-0 bg-[var(--ink)]">
      <DeckGL
        viewState={viewState as never}
        onViewStateChange={
          interactive
            ? // deck reports every camera change here, and a controlled view only moves because
              // this writes it back. `interactionState` is what separates the operator's own
              // drags and zooms from deck's internal adjustments; only the former take the camera.
              ((({
                viewState: next,
                interactionState: how,
              }: {
                viewState: ViewState;
                interactionState?: {
                  isDragging?: boolean;
                  isPanning?: boolean;
                  isZooming?: boolean;
                  isRotating?: boolean;
                };
              }) => {
                if (how?.isDragging || how?.isPanning || how?.isZooming || how?.isRotating) {
                  setOwned(true);
                }
                setCamera(next);
              }) as never)
            : undefined
        }
        controller={interactive}
        layers={layers as never}
      />

      {showSatellite ? (
        // The scrim. The imagery is already drawn dim; this takes the last of its contrast out of
        // the midtones so the depth ramp has the only saturated colour on the screen. It is
        // `pointer-events-none` because the map underneath still has to be draggable.
        //
        // Lighter in hero mode: the landing page lays its own wash across the left of this map
        // for the headline to sit on, and the full scrim on top of that left the imagery
        // invisible. The hero wants the city to look like somewhere; the console wants it to
        // stay out of the water's way.
        <div
          aria-hidden="true"
          className={
            interactive
              ? "pointer-events-none absolute inset-0 bg-[var(--ink)]/30"
              : "pointer-events-none absolute inset-0 bg-[var(--ink)]/15"
          }
        />
      ) : null}

      {/* Esri's imagery is free to use and requires the credit while it is on screen. The console
          mounts `MapSlot` behind this map and that draws the same line; `attribution={false}`
          there keeps it from appearing twice. */}
      {attribution ? (
        <p className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 py-2 type-micro text-text-3">
          {MAP_ATTRIBUTION}
        </p>
      ) : null}
    </div>
  );
}
