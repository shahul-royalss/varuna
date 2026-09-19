"use client";

/**
 * The citizen map: a Google basemap with VARUNA's water drawn over it (TECH_SPEC 2, task D-10).
 *
 * The console's map is deck.gl standing alone over aerial imagery, because an operator reads the
 * city from the GIS VARUNA built. A citizen reads it from the city they already know - the shop on
 * the corner, the flyover they take every morning - and that is the one thing Google's basemap is
 * genuinely better at. So this screen, and only this screen, loads Google.
 *
 * Google is a **basemap and nothing else** (TECH_SPEC 0): the key is referrer-restricted and every
 * Google service except the Maps JavaScript bootstrap answers `REQUEST_DENIED`. The streets, their
 * depths, the route and every marker come from VARUNA's own run.
 *
 * **The fallback is the path most likely to run.** The key's referrer list is a human-maintained
 * list in a console this build cannot reach; it has already been measured refusing a dev origin
 * with `RefererNotAllowedMapError`. So a missing key, a refused referrer or a slow bootstrap all
 * land on `<FloodMap>` - the same map the console draws, over aerial imagery - with one sentence
 * saying which map this is. That path is not a consolation: it is the offline demo path
 * (CLAUDE.md 17) and it carries identical water, identical routes and identical numbers.
 *
 * Nothing here logs to the console in either path. CLAUDE.md 14 makes a console error a failing
 * gate, and a key that is absent by design is not an error.
 */

import { ScatterplotLayer } from "@deck.gl/layers";
import { APIProvider, Map as GoogleMap, useMap } from "@vis.gl/react-google-maps";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CityMap } from "@/components/map/city-map";
import { cityBounds } from "@/components/map/basemap";
import { EmptyState } from "@/components/varuna/empty-state";
import { Skeleton } from "@/components/varuna/skeleton";
import { loadFacilityLabels, type FacilityLabel } from "@/lib/api/city-layers";
import { routeLayers, useRouteProgress } from "@/components/map/layers/routes";
import { wetStreetsLayers } from "@/components/map/layers/streets";
import type { RouteLine } from "@/components/map/layers/types";
import { TRUTH_FILL, TRUTH_RING } from "@/components/map/layers/palette";
import type { PublicProfile } from "@/components/varuna/vehicle-selector";
import { useCitizenRun, type CitizenRun, type CitizenRunState } from "@/lib/maps/citizen-run";
import { toLatLngBounds, useGoogleFit, type FittableMap } from "@/lib/maps/fit";
import {
  GOOGLE_BOOTSTRAP_TIMEOUT_MS,
  googleFallbackNotice,
  googleMapsKey,
  type GoogleFallbackReason,
} from "@/lib/maps/google";
import { darkMapStyle } from "@/lib/maps/google-style";
import { useGoogleDeckOverlay } from "@/lib/maps/overlay";
import { usePrefersReducedMotion } from "@/lib/hooks";
import type { RouteCorridor, RoutePlan } from "@/lib/api/route";
import { cn } from "@/lib/utils";

/**
 * Depth at which each vehicle stops, in cm.
 *
 * The same numbers `varuna_route.profiles` routes on and `/map` colours by, so the citizen
 * dashboard and the public map cannot disagree about who is stopped.
 */
export const STOPS_AT_CM: Record<PublicProfile, number> = {
  "two-wheeler": 15,
  car: 30,
  bus: 45,
  pedestrian: 30,
};

/** A point the reader tapped on the map, as a destination for the rail's route form. */
export interface MapPoint {
  lon: number;
  lat: number;
}

export interface CitizenMapProps {
  city?: string;
  runId?: string;
  /** The reader's vehicle; sets the depth at which a street turns red. */
  profile: PublicProfile;
  /** The planned trip, drawn as the shortest way, the safe way and what it went around. */
  route?: RoutePlan | null;
  /** The other safe roads the policy spreads across, drawn dimmed behind the chosen one. */
  corridors?: readonly RouteCorridor[] | null;
  selectedCorridorId?: string | null;
  /** Set to let the reader pick a destination by tapping the map. */
  onPickPoint?: (point: MapPoint) => void;
  /** The run the map drew, so the header can stamp it. */
  onRunLoaded?: (run: CitizenRun) => void;
  className?: string;
}

/** The step a citizen sees: now. The "passable until" times carry the forecast instead. */
const NOW_STEP = 0;

/** Stable empties, so `CityMap`'s memos are not rebuilt by a fresh `[]` on every render. */
const NO_FRAMES: readonly (ImageBitmap | null)[] = [];
const NO_SURCHARGE: readonly [] = [];
const NO_HOTSPOTS: readonly [] = [];

/**
 * Which lines to draw, and in what character.
 *
 * The chosen corridor is the VARUNA route; the other corridors are `alternate`, which the palette
 * already draws at half strength, so "this one, and there are others" reads without a legend. The
 * avoided streets are drawn in the depth ramp's deepest red so the detour visibly goes around
 * something (CLAUDE.md 7.4).
 */
export function routeLines(
  plan: RoutePlan | null | undefined,
  corridors: readonly RouteCorridor[] | null | undefined,
  selectedCorridorId: string | null | undefined,
): RouteLine[] {
  if (!plan) return [];
  const lines: RouteLine[] = [];

  if (plan.naive?.path?.length) {
    lines.push({ id: "naive", path: plan.naive.path, kind: "naive" });
  }
  for (const avoided of plan.avoided) {
    if (avoided.path?.length) {
      lines.push({ id: `avoided-${avoided.segmentId}`, path: avoided.path, kind: "avoided" });
    }
  }

  const list = corridors ?? [];
  const chosen =
    list.find((c) => c.id === selectedCorridorId) ?? list.find((c) => c.assigned) ?? null;
  for (const corridor of list) {
    if (!corridor.route?.path?.length) continue;
    if (corridor === chosen) continue;
    lines.push({ id: `corridor-${corridor.id}`, path: corridor.route.path, kind: "alternate" });
  }

  const safe = chosen?.route ?? plan.varuna;
  if (safe?.path?.length) {
    lines.push({ id: "varuna", path: safe.path, kind: "varuna" });
  }
  return lines;
}

/** Everything deck draws on the citizen map, in section 6.7's order: water, routes, the pin. */
function useCitizenLayers(
  run: CitizenRun | null,
  profile: PublicProfile,
  routes: readonly RouteLine[],
  picked: MapPoint | null,
): unknown[] {
  const reducedMotion = usePrefersReducedMotion();
  const progress = useRouteProgress(routes, reducedMotion);

  return useMemo(
    () => [
      ...wetStreetsLayers({
        segments: run?.segments ?? [],
        step: NOW_STEP,
        show: true,
        diffMode: false,
        wipeLon: 0,
        // Three colours, not six bands: a reader needs to know whether to turn around.
        passableBelowCm: STOPS_AT_CM[profile],
        pickable: false,
      }),
      ...routeLayers({ routes, progress }),
      ...(picked
        ? [
            new ScatterplotLayer<MapPoint>({
              id: "citizen-picked-point",
              data: [picked],
              getPosition: (d) => [d.lon, d.lat],
              getRadius: 9,
              radiusUnits: "pixels",
              getFillColor: TRUTH_FILL,
              getLineColor: TRUTH_RING,
              lineWidthUnits: "pixels",
              getLineWidth: 2,
              stroked: true,
              pickable: false,
            }),
          ]
        : []),
    ],
    [run, profile, routes, progress, picked],
  );
}

/** Inside `<Map>`: owns the deck overlay and the fit, both keyed on the live map instance. */
function GoogleLayers({
  layers,
  bounds,
}: {
  layers: unknown[];
  bounds: ReturnType<typeof cityBounds>;
}) {
  const map = useMap() as unknown as (FittableMap & object) | null;
  useGoogleDeckOverlay(map, layers);
  useGoogleFit(map, bounds);
  return null;
}

/**
 * What the map shows when it has no run to draw.
 *
 * Named states, not a blank rectangle (CLAUDE.md 6.11): the load, an empty state carrying the
 * API's own sentence about which command produces a run, and an error that says what failed. A
 * skeleton, never a spinner (6.9).
 */
function RunState({ state }: { state: CitizenRunState }) {
  if (state.kind === "ready") return null;
  return (
    <div className="bg-ink/90 absolute inset-0 z-20 flex items-center justify-center p-6">
      {state.kind === "loading" ? (
        <div className="w-[260px]">
          <Skeleton className="h-2 w-full rounded-full" />
          <p className="type-small text-text-2 mt-3">Loading the streets around you</p>
        </div>
      ) : (
        <EmptyState
          size="sm"
          title={state.kind === "empty" ? "No forecast yet" : "The forecast did not load"}
          description={state.message}
        />
      )}
    </div>
  );
}

/** One sentence, always present, saying which basemap the reader is looking at. */
function FallbackNotice({ reason }: { reason: GoogleFallbackReason }) {
  return (
    <p
      data-slot="basemap-notice"
      className="rounded-control border-line bg-ink/80 text-text-2 type-micro pointer-events-none absolute top-3 left-3 z-10 max-w-[min(90%,34ch)] border px-2.5 py-1.5"
    >
      {googleFallbackNotice(reason)}
    </p>
  );
}

export function CitizenMap({
  city = "mumbai",
  runId,
  profile,
  route = null,
  corridors = null,
  selectedCorridorId = null,
  onPickPoint,
  onRunLoaded,
  className,
}: CitizenMapProps) {
  // Read once: the key is inlined at build time and cannot change while the page is open.
  const [apiKey] = useState(() => googleMapsKey());
  const [fallback, setFallback] = useState<GoogleFallbackReason | null>(apiKey ? null : "no-key");
  const [loaded, setLoaded] = useState(false);
  const [picked, setPicked] = useState<MapPoint | null>(null);

  const state = useCitizenRun(city, runId);
  const run = state.kind === "ready" ? state.run : null;

  useEffect(() => {
    if (run) onRunLoaded?.(run);
  }, [run, onRunLoaded]);

  // TECH_SPEC 2.5: a bootstrap that has not finished in four seconds is a bootstrap the reader
  // should stop waiting for. Google's own script has no timeout of its own.
  useEffect(() => {
    if (!apiKey || loaded || fallback) return;
    const timer = window.setTimeout(
      () => setFallback((current) => current ?? "timeout"),
      GOOGLE_BOOTSTRAP_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [apiKey, loaded, fallback]);

  const onError = useCallback(() => setFallback((current) => current ?? "error"), []);
  const onLoad = useCallback(() => setLoaded(true), []);

  const routes = useMemo(
    () => routeLines(route, corridors, selectedCorridorId),
    [route, corridors, selectedCorridorId],
  );
  const layers = useCitizenLayers(run, profile, routes, picked);

  // Named places, so the map says "KEM Hospital" rather than showing an unlabelled junction. A
  // few hundred points, unlike the building and drain layers, which this screen never loads.
  const [facilities, setFacilities] = useState<readonly FacilityLabel[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    loadFacilityLabels(city, controller.signal)
      .then(setFacilities)
      // A map without names is still a map; nothing here is worth an error state.
      .catch(() => undefined);
    return () => controller.abort();
  }, [city]);
  const labels = useMemo(
    () => facilities.map((f) => ({ id: f.id, text: f.text, lon: f.lon, lat: f.lat, kind: f.kind })),
    [facilities],
  );

  const bounds = useMemo(() => cityBounds(city), [city]);
  // Resolved inside the component, not at module scope, so a theme override reaches the tiles.
  const styles = useMemo(() => darkMapStyle(), []);

  const pick = useCallback(
    (event: { detail?: { latLng?: { lat: number; lng: number } | null } }) => {
      const at = event.detail?.latLng;
      if (!at) return;
      const point = { lon: at.lng, lat: at.lat };
      setPicked(point);
      onPickPoint?.(point);
    },
    [onPickPoint],
  );

  if (fallback || !apiKey) {
    const reason: GoogleFallbackReason = fallback ?? "no-key";
    return (
      <div className={cn("bg-ink absolute inset-0", className)} data-slot="citizen-map">
        {/* VARUNA's own map, over Esri's aerial imagery, built from the same layer modules the
            Google path uses - so the water, the chosen route and the dimmed corridors are
            identical either way, and the fallback is a different basemap rather than a lesser
            answer. The depth raster and the building footprints stay off: 36 decoded frames and
            11 MB of footprints are an operator's load, not a phone's. */}
        <CityMap
          frames={NO_FRAMES}
          rasterBounds={null}
          baseSegments={run?.baseSegments ?? []}
          segments={run?.segments ?? []}
          surcharge={NO_SURCHARGE}
          hotspots={NO_HOTSPOTS}
          routes={routes}
          labels={labels}
          passableBelowCm={STOPS_AT_CM[profile]}
          step={NOW_STEP}
          bounds={bounds}
          showRaster={false}
          showBuildings={false}
          showSurcharge={false}
          showHotspots={false}
          showSatellite
        />
        <RunState state={state} />
        <FallbackNotice reason={reason} />
      </div>
    );
  }

  return (
    <div className={cn("bg-ink absolute inset-0", className)} data-slot="citizen-map">
      <APIProvider apiKey={apiKey} onLoad={onLoad} onError={onError}>
        <GoogleMap
          className="size-full"
          // A raster map: Google refuses an inline `styles` array on a vector map, and no cloud
          // Map ID exists for this project (TECH_SPEC 2.3).
          renderingType="RASTER"
          styles={styles}
          defaultBounds={{ ...toLatLngBounds(bounds), padding: 16 }}
          gestureHandling="greedy"
          disableDefaultUI
          zoomControl
          clickableIcons={false}
          onClick={onPickPoint ? pick : undefined}
        >
          <GoogleLayers layers={layers} bounds={bounds} />
        </GoogleMap>
      </APIProvider>
    </div>
  );
}
