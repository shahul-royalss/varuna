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
 * **This file is the host.** It owns the camera (the fit, the fly-to, who owns the view), the
 * memoised composition and the DOM around the canvas. Every layer is built by one module under
 * `layers/` (task MO1), so a motion or a new layer edits that module rather than this file.
 *
 * Layer order follows section 6.7 bottom to top: basemap, buildings, dry streets, drains, depth
 * raster, wet streets, hotspot rings, reversed-flow edges, inlets, surcharging manholes,
 * isochrones, routes, ground-truth pins, labels.
 *
 * **Scrubbing costs nothing.** The run's 36 frames are decoded to ImageBitmaps before the scrub
 * is usable; a step change swaps a texture and re-runs one colour accessor. No fetch, no decode
 * (CLAUDE.md 7.2: "no network during scrub").
 */

import { FlyToInterpolator, WebMercatorViewport } from "@deck.gl/core";
import DeckGL from "@deck.gl/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { boundsCentre, cityBounds, type Bbox } from "./basemap";
import { buildingsLayers, dryStreetsLayers } from "./layers/base";
import { wipeLongitude } from "./layers/diff";
import { drainsLayers } from "./layers/drains";
import { drawnExtent } from "./layers/frame";
import { hotspotRingsLayers } from "./layers/hotspots";
import { inletLayers } from "./layers/inlets";
import { isochroneLayers, useDisplayedIsochrones } from "./layers/isochrones";
import { useLabelLayers } from "./layers/map-labels";
import { depthRasterLayers } from "./layers/raster";
import { reversedFlowLayers } from "./layers/reversed-flow";
import { routeLayers, useRouteProgress } from "./layers/routes";
import { wetStreetsLayers } from "./layers/streets";
import { deckAnimates, surchargeLayers, useSurchargePulse } from "./layers/surcharge";
import { mapTooltip } from "./layers/tooltip";
import { truthPinLayers } from "./layers/truth-pins";
import type {
  BuildingPolygon,
  DrainPath,
  DrainPick,
  HotspotRing,
  InletPoint,
  Isochrone,
  MapFocus,
  ReversedEdgePath,
  RouteLine,
  SegmentPath,
  SegmentPick,
  SurchargeNode,
  SurchargeStyle,
  TruthPin,
} from "./layers/types";
import type { MapLabel } from "./labels";
import { MAP_ATTRIBUTION, satelliteLayers } from "./satellite";
import type { CityMapMode } from "./types";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { DUR_MS, FLY_TO_CURVE } from "@/lib/motion";

// The data types lived here before the split; importers still find them here.
export type {
  BuildingPolygon,
  DrainPath,
  DrainPick,
  HotspotRing,
  InletPoint,
  Isochrone,
  MapFocus,
  ReversedEdgePath,
  RouteLine,
  SegmentPath,
  SegmentPick,
  SurchargeNode,
  SurchargeStyle,
  TruthPin,
} from "./layers/types";

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
  /** Sourced ground-truth pins the replay clock has reached (CLAUDE.md 7.2's 2:40 moment). */
  truthPins?: readonly TruthPin[];
  /** Called when a wet street is clicked, with the segment and where on screen it was (P6.9).
   * Absent leaves the streets unpickable, which is what the hero and the public map want. */
  onSegmentPick?: (pick: SegmentPick | null) => void;
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

  // ---- Seams (task MO1) ---------------------------------------------------------------------
  // Accepted and handed to their layer module, and **not drawn or applied yet**. Each names the
  // chunk that makes it do something, so that chunk edits `layers/*` and not this file.

  /** The replay is playing, which lets street colours tween between steps (M7, MO5). */
  playing?: boolean;
  /** Drain edges flowing backwards, drawn with an animated dash (M9, MO3). */
  reversedEdges?: readonly ReversedEdgePath[];
  /** The drain before/after cross-fade in ms, set only for a toggle (M12, MO10). */
  drainCrossFadeMs?: number;
  /** Hovering a pipe on `/drains` (PU8). */
  onDrainHover?: (pick: DrainPick | null) => void;
  /** Drain inlets as squares coloured by κ (CLAUDE.md 7.3, PU8). */
  inlets?: readonly InletPoint[];
  /** The console's pulsing manholes or `/drains`' static rings (PU8). */
  surchargeStyle?: SurchargeStyle;
}

const MUMBAI_CENTRE = boundsCentre(cityBounds("mumbai"));

/** Used only until the container has been measured; the fit below replaces it on that frame. */
const INITIAL_VIEW = { ...MUMBAI_CENTRE, zoom: 11.4, bearing: 0, pitch: 0 };

type ViewState = typeof INITIAL_VIEW & {
  transitionDuration?: number;
  transitionInterpolator?: FlyToInterpolator;
};

/** Framing margin in pixels, so the coast and the northern subways are not against the edge.
 *
 * Deliberately small. The layer panel, the legend and the hotspot rail all float *over* the map,
 * so the city already has furniture around it; a wide margin as well leaves it swimming in a
 * panel it is meant to fill. */
const FIT_PADDING = 12;

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
  truthPins = [],
  onSegmentPick,
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
  playing = false,
  reversedEdges = [],
  drainCrossFadeMs,
  onDrainHover,
  inlets = [],
  surchargeStyle = "pulse",
}: CityMapProps) {
  const interactive = mode !== "hero";
  const reducedMotion = usePrefersReducedMotion();

  const routeProgress = useRouteProgress(routes, reducedMotion);
  const pulse = useSurchargePulse(showSurcharge && surcharge.length > 0 && !reducedMotion);
  const shownIsochrones = useDisplayedIsochrones(isochrones, reducedMotion);

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

  const frame = useMemo<Bbox>(
    () => drawnExtent({ routes, baseSegments, segments, drains, hotspots, fallback: aoi }),
    [routes, baseSegments, segments, drains, hotspots, aoi],
  );

  const wipeLon = useMemo(
    () => wipeLongitude(diffMode, diffProgress, frame),
    [diffMode, diffProgress, frame],
  );

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
  // Memoised in groups by what changes them, so moving the time bar rebuilds only the run's
  // layers and never 39,259 building polygons, the drain graph or the routes.

  // The basemap, under everything. Rebuilt only when it is toggled or the raster comes and goes:
  // `TileLayer` keeps its own tile cache, and handing deck a new instance every render would
  // throw that cache away on every scrub.
  const basemapLayers = useMemo(
    () => satelliteLayers({ enabled: showSatellite, dimmed: showRaster }),
    [showSatellite, showRaster],
  );

  const cityLayers = useMemo(
    () => buildingsLayers({ buildings, show: showBuildings }),
    [buildings, showBuildings],
  );

  const streetLayers = useMemo(
    () => [
      ...dryStreetsLayers({ baseSegments }),
      ...drainsLayers({
        drains,
        show: showDrains,
        crossFadeMs: drainCrossFadeMs,
        onHover: onDrainHover,
      }),
    ],
    [baseSegments, drains, showDrains, drainCrossFadeMs, onDrainHover],
  );

  const runLayers = useMemo(
    () => [
      ...depthRasterLayers({ frame: frames[step] ?? null, bounds: rasterBounds, show: showRaster }),
      ...wetStreetsLayers({
        segments,
        step,
        show: showSegments,
        diffMode,
        wipeLon,
        probabilityThresholdCm,
        passableBelowCm,
        pickable: Boolean(onSegmentPick),
        playing,
        reducedMotion,
      }),
      ...hotspotRingsLayers({
        hotspots,
        selectedHotspotId,
        show: showHotspots,
        reducedMotion,
      }),
    ],
    [frames, step, rasterBounds, segments, hotspots, selectedHotspotId, showRaster, showSegments, showHotspots, passableBelowCm, diffMode, wipeLon, probabilityThresholdCm, onSegmentPick, playing, reducedMotion],
  );

  const drainFlowLayers = useMemo(
    () => [
      ...reversedFlowLayers({ edges: reversedEdges, show: showSurcharge, step, reducedMotion }),
      ...inletLayers({ inlets, show: showDrains }),
    ],
    [reversedEdges, showSurcharge, step, reducedMotion, inlets, showDrains],
  );

  // Rebuilt on every pulse frame, so kept on its own: a pulse re-uploads nothing but the markers.
  const markerLayers = useMemo(
    () => surchargeLayers({ surcharge, show: showSurcharge, pulse, style: surchargeStyle }),
    [showSurcharge, surcharge, pulse, surchargeStyle],
  );

  // Reachability under the routes, routes over everything (section 6.7's order), pins above both.
  // All are small - three polygons and four paths - so they share one memo.
  const overlayLayers = useMemo(
    () => [
      ...isochroneLayers({ isochrones: shownIsochrones }),
      ...routeLayers({ routes, progress: routeProgress }),
      ...truthPinLayers({ truthPins }),
    ],
    [routes, shownIsochrones, routeProgress, truthPins],
  );

  const labelDrawLayers = useLabelLayers({
    baseSegments,
    segments,
    labels,
    showLabels,
    showSatellite,
    view: viewState,
    size,
  });

  const layers = useMemo(
    () => [
      ...basemapLayers,
      ...cityLayers,
      ...streetLayers,
      ...runLayers,
      ...drainFlowLayers,
      ...markerLayers,
      ...overlayLayers,
      // Labels last: a street name the depth ramp paints over is a name nobody can read.
      ...labelDrawLayers,
    ],
    [basemapLayers, cityLayers, streetLayers, runLayers, drainFlowLayers, markerLayers, overlayLayers, labelDrawLayers],
  );

  const animate = deckAnimates({
    reducedMotion,
    surchargeVisible: showSurcharge ? surcharge.length : 0,
    reversedVisible: showSurcharge ? reversedEdges.length : 0,
  });

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
        pickingRadius={6}
        _animate={animate}
        getTooltip={mapTooltip({ step, streetsPickable: Boolean(onSegmentPick) }) as never}
        onClick={
          onSegmentPick
            ? (({ object, x, y }: { object?: SegmentPath; x: number; y: number }) => {
                onSegmentPick(object ? { segment: object, x, y } : null);
              }) as never
            : undefined
        }
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
