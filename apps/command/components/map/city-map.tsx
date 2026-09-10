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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

/** Used only until the container has been measured; the fit below replaces it immediately. */
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

/** Framing margin in pixels, so the coast and the northern subways are not against the edge. */
const FIT_PADDING = 28;

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
  // The AOI is 9.5 km by 15.5 km - far taller than it is wide - so a fixed zoom either crops
  // the north or leaves the panel half empty at every other window size. Fitting the bounds to
  // the measured container is the only way the city fills the space it is given, on a 1366 x 768
  // laptop and on a 4K wall alike (CLAUDE.md 6.11).
  //
  // Fitted **once**, when the container is first measured: refitting on every resize would yank
  // the camera back from wherever the operator had panned to.
  const [fitted, setFitted] = useState<ViewState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const aoi = bounds ?? cityBounds("mumbai");

  const fit = useCallback(
    (width: number, height: number): ViewState | null => {
      if (width < 2 || height < 2) return null;
      const [[west, south], [east, north]] = aoi;
      const view = new WebMercatorViewport({ width, height }).fitBounds(
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
    },
    [aoi],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      // Only the first measurement sets the camera; the rest are ordinary window resizes and
      // deck.gl handles those itself without moving the centre.
      setFitted((current) => current ?? fit(box.width, box.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);

  // Motion M10: a 900 ms flight to the selected hotspot, a jump cut under reduced motion.
  //
  // The camera is deck.gl's to own, not React's. Handing it a new `initialViewState` is deck's
  // documented way to move an uncontrolled view - it diffs the object and runs the transition
  // itself - so panning and zooming never round-trip through a React render, and the fly-to
  // needs no effect and no mirrored copy of the view state that could drift from the real one.
  //
  // Keyed on `focus.key` rather than the coordinates, so selecting the same row twice flies
  // again: after panning away, "show me Hindmata" should still take you back.
  const focusKey = focus?.key ?? null;
  const viewState = useMemo<ViewState>(() => {
    const base = fitted ?? INITIAL_VIEW;
    if (!focus) return base;
    return {
      ...base,
      longitude: focus.lon,
      latitude: focus.lat,
      zoom: focus.zoom ?? 14,
      transitionDuration: reducedMotion ? 0 : DUR_MS.flight,
      transitionInterpolator: reducedMotion
        ? undefined
        : new FlyToInterpolator({ curve: FLY_TO_CURVE }),
    };
    // `focus` is a fresh object each render; `focusKey` is the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, reducedMotion, fitted]);

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
          getColor: (d) => depthRgba(d.depthCm[step] ?? 0),
          getWidth: (d) => d.width * 1.15,
          widthUnits: "pixels",
          widthMinPixels: 1.6,
          capRounded: true,
          jointRounded: true,
          pickable: false,
          // A scrub changes one thing, so one accessor is re-run.
          updateTriggers: { getColor: step },
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
  }, [frames, step, rasterBounds, segments, hotspots, selectedHotspotId, showRaster, showSegments, showHotspots]);

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

  const layers = useMemo(
    () => [...cityLayers, ...streetLayers, ...runLayers, ...(surchargeLayer ? [surchargeLayer] : [])],
    [cityLayers, streetLayers, runLayers, surchargeLayer],
  );

  return (
    <div ref={containerRef} className="absolute inset-0 bg-[var(--ink)]">
      <DeckGL
        initialViewState={viewState as never}
        controller={interactive}
        layers={layers as never}
      />
    </div>
  );
}
