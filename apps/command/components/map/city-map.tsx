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
import type { CityMapMode } from "./types";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { DUR_MS, FLY_TO_CURVE } from "@/lib/motion";
import { depthRgba } from "@/lib/ramps";

/** One segment's geometry plus the depth series the run gave it. */
export interface SegmentPath {
  id: string;
  path: [number, number][];
  /** Depth in cm at each of the run's steps; empty means the run never wet it. */
  depthCm: number[];
  /** Road class, which sets the drawn width (section 6.7: 2-6 px by class). */
  width: number;
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
  /** `naive` is the dashed grey comparison; `varuna` the tide-coloured route (section 6.7). */
  kind: "naive" | "varuna" | "alternate";
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
}: CityMapProps) {
  const interactive = mode !== "hero";
  const reducedMotion = usePrefersReducedMotion();
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
          getColor: (d) =>
            passableBelowCm === undefined
              ? depthRgba(d.depthCm[step] ?? 0)
              : passabilityRgba(d.depthCm[step] ?? 0, passableBelowCm),
          getWidth: (d) => d.width * 1.15,
          widthUnits: "pixels",
          widthMinPixels: 1.6,
          capRounded: true,
          jointRounded: true,
          pickable: false,
          // A scrub changes one thing, so one accessor is re-run.
          updateTriggers: { getColor: [step, passableBelowCm] },
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
  }, [frames, step, rasterBounds, segments, hotspots, selectedHotspotId, showRaster, showSegments, showHotspots, passableBelowCm]);

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
          data: routes.filter((r) => r.kind !== "naive") as RouteLine[],
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
          getPath: (d) => d.path,
          getColor: (d) => (d.kind === "naive" ? NAIVE_ROUTE : VARUNA_ROUTE),
          getWidth: (d) => (d.kind === "varuna" ? 5 : 3),
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          pickable: false,
          updateTriggers: { getColor: routes.length, getWidth: routes.length },
        }),
      );
    }
    return built;
  }, [routes, isochrones]);

  const layers = useMemo(
    () => [
      ...cityLayers,
      ...streetLayers,
      ...runLayers,
      ...(surchargeLayer ? [surchargeLayer] : []),
      ...routeLayers,
    ],
    [cityLayers, streetLayers, runLayers, surchargeLayer, routeLayers],
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
    </div>
  );
}
