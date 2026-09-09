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
 * What replaces it is not a placeholder. The city's own 21,296 road segments are the geography:
 * drawn dim where they are dry, and through the depth ramp where the run says water is standing.
 * A judge reads the shape of Mumbai from its streets, which is the level the forecast is at
 * anyway - this is a street-level model, and the streets are the subject.
 *
 * Layer order follows section 6.7 bottom to top: depth raster, dry streets, wet streets,
 * surcharging manholes, hotspot rings.
 *
 * **Scrubbing costs nothing.** The run's 36 frames are decoded to ImageBitmaps before the scrub
 * is usable; a step change swaps a texture and re-runs one colour accessor. No fetch, no decode
 * (CLAUDE.md 7.2: "no network during scrub").
 */

import { FlyToInterpolator } from "@deck.gl/core";
import { BitmapLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import DeckGL from "@deck.gl/react";
import { useMemo } from "react";

import { boundsCentre, cityBounds } from "./basemap";
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
}

export interface HotspotRing {
  id: string;
  name: string;
  lon: number;
  lat: number;
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
  /** The hotspot the rail has selected; drawn as a second, brighter ring (motion M10). */
  selectedHotspotId?: string | null;
  /** Fly the camera here when `key` changes. */
  focus?: MapFocus | null;
  step: number;
  showRaster?: boolean;
  showSegments?: boolean;
  showSurcharge?: boolean;
  showHotspots?: boolean;
}

const MUMBAI_CENTRE = boundsCentre(cityBounds("mumbai"));

const INITIAL_VIEW = {
  ...MUMBAI_CENTRE,
  zoom: 11.4,
  bearing: 0,
  pitch: 0,
};

/** Section 6.7: the raster sits at 55 % so the streets read through it. */
const RASTER_OPACITY = 0.55;

/** `--depth-dry` #2B3A55: present, and quiet enough that water is the only bright thing. */
const DRY_STREET: [number, number, number, number] = [43, 58, 85, 210];

export function CityMap({
  mode = "console",
  frames,
  rasterBounds,
  baseSegments,
  segments,
  surcharge,
  hotspots,
  selectedHotspotId = null,
  focus = null,
  step,
  showRaster = true,
  showSegments = true,
  showSurcharge = true,
  showHotspots = true,
}: CityMapProps) {
  const interactive = mode !== "hero";
  const reducedMotion = usePrefersReducedMotion();

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
  const viewState = useMemo(() => {
    if (!focus) return INITIAL_VIEW;
    return {
      ...INITIAL_VIEW,
      longitude: focus.lon,
      latitude: focus.lat,
      zoom: focus.zoom ?? 13.5,
      transitionDuration: reducedMotion ? 0 : DUR_MS.flight,
      transitionInterpolator: reducedMotion
        ? undefined
        : new FlyToInterpolator({ curve: FLY_TO_CURVE }),
    };
    // `focus` is a fresh object each render; `focusKey` is the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, reducedMotion]);

  const layers = useMemo(() => {
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
          getWidth: (d) => Math.max(d.width * 0.55, 0.6),
          widthUnits: "pixels",
          widthMinPixels: 0.5,
          pickable: false,
        }),
      );
    }

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
          getWidth: (d) => d.width,
          widthUnits: "pixels",
          widthMinPixels: 1.5,
          capRounded: true,
          jointRounded: true,
          pickable: false,
          // A scrub changes one thing, so one accessor is re-run.
          updateTriggers: { getColor: step },
        }),
      );
    }

    if (showSurcharge && surcharge.length > 0) {
      built.push(
        new ScatterplotLayer<SurchargeNode>({
          id: "surcharge",
          data: surcharge as SurchargeNode[],
          getPosition: (d) => [d.lon, d.lat],
          getRadius: 80,
          radiusUnits: "meters",
          radiusMinPixels: 2,
          radiusMaxPixels: 10,
          filled: true,
          getFillColor: [239, 68, 68, 170], // --surcharge
          stroked: false,
          pickable: false,
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
          filled: false,
          stroked: true,
          // Unselected rings sit back; the selected one is the only glow on the map
          // (section 6.4), which is what makes the rail's click legible from a distance.
          getLineColor: (d) =>
            d.id === selectedHotspotId ? [45, 212, 191, 255] : [45, 212, 191, 120], // --tide
          getLineWidth: (d) => (d.id === selectedHotspotId ? 3 : 1),
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
  }, [
    baseSegments, frames, step, rasterBounds, segments, surcharge, hotspots, selectedHotspotId,
    showRaster, showSegments, showSurcharge, showHotspots,
  ]);

  return (
    <div className="absolute inset-0 bg-[var(--ink)]">
      <DeckGL
        initialViewState={viewState as never}
        controller={interactive}
        layers={layers as never}
      />
    </div>
  );
}
