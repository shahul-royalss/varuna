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
 * **This file is the host.** It owns the memoised composition, the props and the DOM around the
 * canvas. Every layer is built by one module under `layers/` (task MO1), and the camera (the fit,
 * the fly-to, who owns the view) by `layers/camera.ts`, so a motion or a new layer edits that
 * module rather than this file.
 *
 * Layer order follows section 6.7 bottom to top: basemap, buildings, dry streets, drains, depth
 * raster, wet streets, hotspot rings, reversed-flow edges, inlets, surcharging manholes,
 * isochrones, routes, ground-truth pins, labels.
 *
 * **Scrubbing costs nothing.** The run's 36 frames are decoded to ImageBitmaps before the scrub
 * is usable; a step change swaps a texture and re-runs one colour accessor. No fetch, no decode
 * (CLAUDE.md 7.2: "no network during scrub").
 */

import DeckGL from "@deck.gl/react";
import { useMemo } from "react";

import { cityBounds, type Bbox } from "./basemap";
import { buildingsLayers, dryStreetsLayers } from "./layers/base";
import { useCityCamera } from "./layers/camera";
import { wipeLongitude } from "./layers/diff";
import { drainsLayers } from "./layers/drains";
import { drawnExtent } from "./layers/frame";
import { hotspotRingsLayers } from "./layers/hotspots";
import { inletLayers } from "./layers/inlets";
import { isochroneLayers, useDisplayedIsochrones } from "./layers/isochrones";
import { useLabelLayers } from "./layers/map-labels";
import { depthRasterLayers } from "./layers/raster";
import { pointsInView, useReversedFlowLayers, viewBounds } from "./layers/reversed-flow";
import { routeLayers, useRouteProgress } from "./layers/routes";
import { wetStreetsLayers } from "./layers/streets";
import { deckAnimates, surchargeLayers } from "./layers/surcharge";
import {
  TERRAIN_PITCH,
  hiddenLayers,
  onTerrain,
  terrainLayers,
  useTerrain,
} from "./layers/terrain";
import { mapTooltip } from "./layers/tooltip";
import { truthPinLayers } from "./layers/truth-pins";
import { useMapOverlay } from "./layers/overlay-context";
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

// The data types lived here before the split; importers still find them here.
export type * from "./layers/types";

/** Stable empty default, so a screen that passes no routes never changes the routes memo. */
const NO_ROUTES: readonly RouteLine[] = [];

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
  /** Drain edges flowing backwards at `step`, drawn with an animated dash (M9): tidal edges at
   * every zoom, inland edges from zoom 14 and in view. */
  reversedEdges?: readonly ReversedEdgePath[];
  /** The drain before/after cross-fade in ms, set only for a toggle (M12, MO10). */
  drainCrossFadeMs?: number;
  /** Hovering a pipe on `/drains` (PU8). */
  onDrainHover?: (pick: DrainPick | null) => void;
  /** Drain inlets as squares coloured by κ (CLAUDE.md 7.3, PU8). */
  inlets?: readonly InletPoint[];
  /** The console's pulsing manholes or `/drains`' static rings (PU8). */
  surchargeStyle?: SurchargeStyle;
  /**
   * Per-layer opacity, 0 to 1, for the onboarding wizard's layer stack (motion M19, task D-21).
   *
   * The wizard is the one screen where layers arrive one at a time, as the pipeline writes them,
   * and M19 asks each to fade in over 400 ms as its step completes. Every other screen leaves
   * this unset and every layer draws at 1, exactly as before. Drive it with `useLayerFade`, which
   * holds the catalogue's duration and its reduced-motion branch.
   */
  layerFade?: { streets?: number; buildings?: number; drains?: number; raster?: number };
}

export function CityMap({
  mode = "console",
  frames,
  rasterBounds,
  baseSegments,
  segments: segmentsProp,
  surcharge,
  hotspots,
  buildings = [],
  drains = [],
  routes: routesProp = NO_ROUTES,
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
  diffMode: diffModeProp = false,
  diffProgress: diffProgressProp = 1,
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
  layerFade,
}: CityMapProps) {
  const interactive = mode !== "hero";
  const reducedMotion = usePrefersReducedMotion();

  // What the console asks for beyond these props: 3D, its routes layer and the what-if
  // difference layer (`layers/overlay-context.ts`). Every other screen provides nothing.
  const overlay = useMapOverlay();
  const terrain = useTerrain(overlay.city, Boolean(overlay.threeD) && interactive);
  // 3D is drawn only once the ground exists; until then the flat map stays exactly as it was.
  const threeD = terrain.kind === "ready";

  const overlayRoutes = overlay.routes;
  const routes = useMemo(
    () =>
      overlayRoutes && overlayRoutes.length > 0 ? [...routesProp, ...overlayRoutes] : routesProp,
    [routesProp, overlayRoutes],
  );

  // The what-if answer joined onto the city's own geometry: only the segments it moved, as the
  // lab does, so 21,296 unchanged paths never go through the diff accessor.
  const overlayDiff = overlay.diff ?? null;
  const diffDelta = overlayDiff?.deltaCm ?? null;
  const diffSegments = useMemo(() => {
    if (!diffDelta) return null;
    return baseSegments
      .filter((s) => diffDelta.has(s.id))
      .map((s) => ({ ...s, deltaCm: diffDelta.get(s.id) ?? 0 }));
  }, [baseSegments, diffDelta]);
  const segments = diffSegments ?? segmentsProp;
  const diffMode = diffSegments ? true : diffModeProp;
  const diffProgress = diffSegments && overlayDiff ? overlayDiff.progress : diffProgressProp;

  const routeProgress = useRouteProgress(routes, reducedMotion);
  const shownIsochrones = useDisplayedIsochrones(isochrones, reducedMotion);

  // ---- Framing --------------------------------------------------------------------------
  // The camera (fit, fly-to, ownership) lives in `layers/camera.ts`; it frames what is drawn.
  const aoi = bounds ?? cityBounds("mumbai");

  const frame = useMemo<Bbox>(
    () => drawnExtent({ routes, baseSegments, segments, drains, hotspots, fallback: aoi }),
    [routes, baseSegments, segments, drains, hotspots, aoi],
  );

  const wipeLon = useMemo(
    () => wipeLongitude(diffMode, diffProgress, frame),
    [diffMode, diffProgress, frame],
  );

  const { containerRef, size, viewState, onViewStateChange } = useCityCamera({
    frame,
    focus,
    reducedMotion,
    interactive,
    threeD,
    pitch3d: TERRAIN_PITCH,
  });

  // ---- Layers ---------------------------------------------------------------------------
  // Memoised in groups by what changes them, so moving the time bar rebuilds only the run's
  // layers and never 39,259 building polygons, the drain graph or the routes.

  // The basemap, under everything. Rebuilt only when it is toggled or the raster comes and goes:
  // `TileLayer` keeps its own tile cache, and handing deck a new instance every render would
  // throw that cache away on every scrub.
  //
  // Not in 3D: the imagery is flat and the ground stands above it, so every tile would be drawn
  // and then hidden. The terrain carries the city's shape there instead.
  const imagery = showSatellite && !threeD;
  const basemapLayers = useMemo(
    () => satelliteLayers({ enabled: showSatellite, dimmed: showRaster }),
    [showSatellite, showRaster],
  );

  // The ground, with the current step's water draped on it (task P6.15). A scrub swaps a cached
  // texture, as the flat raster swaps a bitmap.
  const currentFrame = frames[step] ?? null;
  const groundLayers = useMemo(
    () =>
      threeD && overlay.city
        ? terrainLayers({ city: overlay.city, terrain, frame: currentFrame, showRaster })
        : [],
    [threeD, overlay.city, terrain, currentFrame, showRaster],
  );

  // Each layer's M19 opacity, read out here so the memos below depend on a number rather than on
  // an object identity a parent would recreate every render.
  const fadeStreets = layerFade?.streets ?? 1;
  const fadeBuildings = layerFade?.buildings ?? 1;
  const fadeDrains = layerFade?.drains ?? 1;
  const fadeRaster = layerFade?.raster ?? 1;

  const cityLayers = useMemo(
    () => buildingsLayers({ buildings, show: showBuildings, fade: fadeBuildings }),
    [buildings, showBuildings, fadeBuildings],
  );

  const streetLayers = useMemo(
    () => [
      ...dryStreetsLayers({ baseSegments, fade: fadeStreets }),
      ...drainsLayers({
        drains,
        show: showDrains,
        crossFadeMs: drainCrossFadeMs,
        onHover: onDrainHover,
        fade: fadeDrains,
      }),
    ],
    [baseSegments, drains, showDrains, drainCrossFadeMs, onDrainHover, fadeStreets, fadeDrains],
  );

  const runLayers = useMemo(
    () => [
      ...depthRasterLayers({
        frame: frames[step] ?? null,
        bounds: rasterBounds,
        // In 3D the frame is the terrain's texture, and this flat copy is hidden with the rest
        // of the flat map (see `hiddenLayers`) rather than removed.
        show: showRaster,
        fade: fadeRaster,
      }),
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
    [
      frames,
      step,
      rasterBounds,
      segments,
      hotspots,
      selectedHotspotId,
      showRaster,
      showSegments,
      showHotspots,
      passableBelowCm,
      diffMode,
      wipeLon,
      probabilityThresholdCm,
      onSegmentPick,
      playing,
      reducedMotion,
      fadeRaster,
    ],
  );

  // What the camera can see, for the reversed-flow zoom gate and the redraw gate (M8, M9).
  const visible = viewBounds(viewState, size);
  const reversedFlow = useReversedFlowLayers({
    edges: reversedEdges,
    show: showSurcharge,
    reducedMotion,
    zoom: viewState.zoom,
    bounds: visible,
  });

  const drainFlowLayers = useMemo(
    () => [...reversedFlow.layers, ...inletLayers({ inlets, show: showDrains })],
    [reversedFlow.layers, inlets, showDrains],
  );

  // The pulse runs on deck's clock (a shader uniform), so the markers rebuild only with their data.
  const markerLayers = useMemo(
    () => surchargeLayers({ surcharge, show: showSurcharge, reducedMotion, style: surchargeStyle }),
    [showSurcharge, surcharge, reducedMotion, surchargeStyle],
  );

  // Reachability under the routes, routes over everything (section 6.7's order), pins above both.
  // All are small - three polygons and four paths - so they share one memo.
  const overlayLayers = useMemo(
    () => [
      ...isochroneLayers({ isochrones: shownIsochrones }),
      ...routeLayers({ routes, progress: routeProgress }),
      ...truthPinLayers({ truthPins, reducedMotion }),
    ],
    [routes, shownIsochrones, routeProgress, truthPins, reducedMotion],
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

  const layers = useMemo(() => {
    const above = [
      ...cityLayers,
      ...streetLayers,
      ...runLayers,
      ...drainFlowLayers,
      ...markerLayers,
      ...overlayLayers,
      // Labels last: a street name the depth ramp paints over is a name nobody can read.
      ...labelDrawLayers,
    ];
    // In 3D everything above the ground is laid on it: streets, rings and markers are drawn at
    // z = 0, which would put them under a ground that averages 20 m up once exaggerated.
    //
    // The flat layers stay in the list, hidden, rather than being dropped: dropped, deck
    // finalises them, and re-creating them on the way out of 3D ran into the terrain effect being
    // torn down in the same frame - an assertion per layer and a wave of WebGL errors. Hidden,
    // they are never re-initialised, and the satellite keeps its tile cache.
    return threeD
      ? [...hiddenLayers([...basemapLayers, ...above]), ...groundLayers, ...onTerrain(above)]
      : [...basemapLayers, ...above];
  }, [
    threeD,
    groundLayers,
    basemapLayers,
    cityLayers,
    streetLayers,
    runLayers,
    drainFlowLayers,
    markerLayers,
    overlayLayers,
    labelDrawLayers,
  ]);

  const animate = deckAnimates({
    reducedMotion,
    surchargeVisible: showSurcharge ? pointsInView(surcharge, visible) : 0,
    reversedVisible: reversedFlow.inView,
  });

  return (
    <div ref={containerRef} className="absolute inset-0 bg-[var(--ink)]">
      <DeckGL
        viewState={viewState as never}
        onViewStateChange={onViewStateChange as never}
        controller={interactive}
        layers={layers as never}
        pickingRadius={6}
        _animate={animate}
        getTooltip={mapTooltip({ step, streetsPickable: Boolean(onSegmentPick) }) as never}
        onClick={
          onSegmentPick
            ? ((({ object, x, y }: { object?: SegmentPath; x: number; y: number }) => {
                onSegmentPick(object ? { segment: object, x, y } : null);
              }) as never)
            : undefined
        }
      />

      {imagery ? (
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
