/**
 * `CityMap`'s camera: the fit, the fly-to and who owns the view (CLAUDE.md 7.2, motion M10).
 *
 * Not a layer, and kept under `layers/` only because MO1 moved it out of `city-map.tsx` with the
 * layer builders so the host stays a composer. Nothing here changed in the move.
 */

import { FlyToInterpolator, WebMercatorViewport } from "@deck.gl/core";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { boundsCentre, cityBounds, type Bbox } from "../basemap";
import type { MapFocus } from "./types";
import { DUR_MS, FLY_TO_CURVE } from "@/lib/motion";

const MUMBAI_CENTRE = boundsCentre(cityBounds("mumbai"));

/** Used only until the container has been measured; the fit below replaces it on that frame. */
const INITIAL_VIEW = { ...MUMBAI_CENTRE, zoom: 11.4, bearing: 0, pitch: 0 };

export type ViewState = typeof INITIAL_VIEW & {
  transitionDuration?: number;
  transitionInterpolator?: FlyToInterpolator;
};

/** Framing margin in pixels, so the coast and the northern subways are not against the edge.
 *
 * Deliberately small. The layer panel, the legend and the hotspot rail all float *over* the map,
 * so the city already has furniture around it; a wide margin as well leaves it swimming in a
 * panel it is meant to fill. */
const FIT_PADDING = 12;

interface InteractionState {
  isDragging?: boolean;
  isPanning?: boolean;
  isZooming?: boolean;
  isRotating?: boolean;
}

export interface CityCameraInput {
  /** What to fit: the drawn extent, see `drawnExtent`. */
  frame: Bbox;
  focus: MapFocus | null;
  reducedMotion: boolean;
  /** The hero map is read-only and never reports camera changes. */
  interactive: boolean;
}

export interface CityCamera {
  containerRef: RefObject<HTMLDivElement | null>;
  size: { width: number; height: number } | null;
  viewState: ViewState;
  onViewStateChange:
    | ((change: { viewState: ViewState; interactionState?: InteractionState }) => void)
    | undefined;
}

export function useCityCamera({
  frame,
  focus,
  reducedMotion,
  interactive,
}: CityCameraInput): CityCamera {
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

  // deck reports every camera change here, and a controlled view only moves because this writes
  // it back. `interactionState` is what separates the operator's own drags and zooms from deck's
  // internal adjustments; only the former take the camera.
  const onViewStateChange = interactive
    ? ({
        viewState: next,
        interactionState: how,
      }: {
        viewState: ViewState;
        interactionState?: InteractionState;
      }) => {
        if (how?.isDragging || how?.isPanning || how?.isZooming || how?.isRotating) {
          setOwned(true);
        }
        setCamera(next);
      }
    : undefined;

  return { containerRef, size, viewState, onViewStateChange };
}
