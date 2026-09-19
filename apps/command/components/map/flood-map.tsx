"use client";

/**
 * The console's live flood map: loads one baked run and scrubs it (CLAUDE.md 7.2, tasks P6.2-P6.4).
 *
 * This is the piece that turns everything behind it into something a judge can read from across a
 * room — the conditioned 30 m terrain, the 50,110-node inferred drain graph, the coupled solver's
 * depth field — and it is deliberately thin. All it does is load a run, hold the current step, and
 * hand `CityMap` the frame and the segment colours for that step.
 *
 * Every state it can be in is real and named (CLAUDE.md 6.11): loading with its progress, an empty
 * state that says which command produces a run, an error that says what failed, and the map.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CityMap,
  type Isochrone,
  type MapFocus,
  type SegmentPath,
  type SegmentPick,
  type TruthPin,
} from "./city-map";
import type { CityMapMode } from "./types";
import {
  loadBuildings,
  loadDrains,
  loadFacilityLabels,
  type BuildingPolygon,
  type DrainPath,
  type FacilityLabel,
} from "@/lib/api/city-layers";
import { apiUrl } from "@/lib/api/client";
import { allSegments, joinSegments, loadRunDepth, type RunDepth } from "@/lib/api/run-depth";
import type { Hotspot } from "@/lib/api/hotspots";
import type { SurchargeSet } from "@/lib/api/surcharge";
import { reversedEdgesAtStep } from "./layers/reversed-flow";
import { EmptyState } from "@/components/varuna/empty-state";
import { Button } from "@/components/ui/button";
import { currentCity } from "@/lib/city";

/** Stable empty default for `drains`: a fresh `[]` in the parameter list would change identity on
 * every render and re-run the memo below (and `CityMap`'s layer build) for the screens - the
 * public map, the landing hero - that never pass a posterior. */
const NO_LEARNED_DRAINS: readonly DrainPath[] = [];

type Status =
  | { kind: "loading"; done: number; total: number }
  | { kind: "ready"; run: RunDepth; segments: SegmentPath[]; baseSegments: SegmentPath[] }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string };

/** The load states a screen can react to: loading, ready, empty (nothing baked) or error. */
export type FloodMapStatusKind = Status["kind"];

export interface FloodMapProps {
  /**
   * Which city's layers and - when no `runId` pins one - whose newest run to draw.
   *
   * Defaults to the city in the address bar rather than to Mumbai, so `?city=chennai` opens a
   * Chennai map on any screen that hosts this map without having to thread the slug through
   * itself (task D-09). With no `?city=` that is Mumbai, as it has always been.
   */
  city?: string;
  runId?: string;
  /** Current step, owned by the time bar so keyboard and play share one clock. */
  step: number;
  onLoaded?: (run: RunDepth) => void;
  /** The load's state whenever it changes, for a screen that words its own honesty line. */
  onStatus?: (kind: FloodMapStatusKind) => void;
  /** Hold the run load until the screen knows which run to ask for; the loading state shows. */
  deferLoad?: boolean;
  /** The run's ranked hotspots, drawn as 120 m rings (section 6.7). */
  hotspots?: readonly Hotspot[];
  selectedHotspotId?: string | null;
  /** The run's surcharging manholes; only those active at the current step are drawn. */
  surcharge?: SurchargeSet | null;
  showSurcharge?: boolean;
  showBuildings?: boolean;
  showDrains?: boolean;
  /** Camera target from the rail; a new `key` starts a new flight (motion M10). */
  focus?: MapFocus | null;
  /** Reachability bands from the right rail, drawn over the streets (section 6.7). */
  isochrones?: readonly Isochrone[];
  /**
   * The run's learned pipes, joined onto the city's inferred network by edge id.
   *
   * The city layer carries all 49,770 edges at the prior the pipeline gave them; a run's
   * drain-health product carries the worst 6,000 at the posterior Pulse learned. Passing the
   * latter here re-colours the pipes the filter actually moved and leaves the rest at their
   * prior, which is the honest picture: most of Mumbai's drains have never been observed.
   * Omitted, the map draws the whole network at its prior.
   */
  drains?: readonly DrainPath[];
  /** `hero` makes the map read-only for the landing page's scrub loop (motion M1). */
  mode?: CityMapMode;
  /** Set to draw wet streets in the public map's three colours against this stopping depth. */
  passableBelowCm?: number;
  /** Aerial imagery under everything. On by default, as it is on `CityMap`. */
  showSatellite?: boolean;
  /** Probability mode's threshold in cm; unset draws ordinary depth (task P6.5). */
  probabilityThresholdCm?: number;
  /** Sourced ground-truth pins to drop on the map (task P6.12, motion M18). */
  truthPins?: readonly TruthPin[];
  /** A wet street was clicked (task P6.9); absent leaves the streets unpickable. */
  onSegmentPick?: (pick: SegmentPick | null) => void;
  /** Off where `MapSlot` sits behind this map and draws the credit already. */
  attribution?: boolean;
  showRaster?: boolean;
  showSegments?: boolean;
  showHotspots?: boolean;
}

export function FloodMap({
  city = currentCity(),
  runId,
  step,
  onLoaded,
  onStatus,
  deferLoad = false,
  hotspots: ranked = [],
  selectedHotspotId = null,
  surcharge: surchargeSet = null,
  showSurcharge = true,
  showBuildings = true,
  showDrains = false,
  drains: learned = NO_LEARNED_DRAINS,
  focus = null,
  isochrones = [],
  mode = "console",
  passableBelowCm,
  probabilityThresholdCm,
  truthPins,
  onSegmentPick,
  showSatellite = true,
  attribution = true,
  showRaster = true,
  showSegments = true,
  showHotspots = true,
}: FloodMapProps) {
  const [status, setStatus] = useState<Status>({ kind: "loading", done: 0, total: 36 });
  const [attempt, setAttempt] = useState(0);
  const loadedRef = useRef<string | null>(null);

  useEffect(() => {
    if (deferLoad) return;
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        setStatus({ kind: "loading", done: 0, total: 36 });
        const [run, geojson] = await Promise.all([
          loadRunDepth(
            runId,
            controller.signal,
            (done, total) => {
              if (!cancelled) setStatus({ kind: "loading", done, total });
            },
            // Only read when no `runId` pins the load: it picks whose newest run answers (D-09).
            city,
          ),
          fetch(apiUrl(`/v1/city/${city}/layers/segments`), { signal: controller.signal })
            .then((r) => (r.ok ? r.json() : { features: [] }))
            .catch(() => ({ features: [] })),
        ]);
        if (cancelled) return;
        const segments = joinSegments(geojson, run.depthCm);
        const baseSegments = allSegments(geojson);
        setStatus({ kind: "ready", run, segments, baseSegments });
        if (loadedRef.current !== run.provenance.runId) {
          loadedRef.current = run.provenance.runId;
          onLoaded?.(run);
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        // The API's 404 for "nothing baked yet" is not a failure of the console; it is the
        // honest empty state, and it already carries the command that fixes it.
        const isEmpty = /No baked run|make bake|Compute live/i.test(message);
        setStatus(isEmpty ? { kind: "empty", message } : { kind: "error", message });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [city, runId, attempt, onLoaded, deferLoad]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    onStatus?.(status.kind);
  }, [status.kind, onStatus]);

  // The city's context layers, fetched *after* the run so they never delay the flood. Buildings
  // are 11 MB and the drain graph is 18 MB; putting either on the critical path would mean
  // staring at a progress bar before seeing a single street.
  const [buildings, setBuildings] = useState<readonly BuildingPolygon[]>([]);
  useEffect(() => {
    if (!showBuildings || buildings.length > 0) return;
    const controller = new AbortController();
    loadBuildings(city, controller.signal)
      .then(setBuildings)
      // A map without footprints is still a map. Nothing here is worth an error state.
      .catch(() => undefined);
    return () => controller.abort();
  }, [city, showBuildings, buildings.length]);

  // Drains only when asked for: section 6.7 has them off by default, and they are the biggest
  // layer VARUNA serves.
  const [network, setNetwork] = useState<readonly DrainPath[]>([]);
  useEffect(() => {
    if (!showDrains || network.length > 0) return;
    const controller = new AbortController();
    loadDrains(city, controller.signal)
      .then(setNetwork)
      .catch(() => undefined);
    return () => controller.abort();
  }, [city, showDrains, network.length]);

  // The whole network at its prior, with the run's learned pipes drawn over it at their
  // posterior - the same join `/drains` makes, so the console's Drains mode and the X-ray
  // colour the same pipe the same way. Before the 18 MB network arrives, the learned pipes are
  // what there is to draw, so the layer is never empty once the operator has asked for it.
  const drains = useMemo(() => {
    if (learned.length === 0) return network;
    if (network.length === 0) return learned;
    const posterior = new Map(learned.map((edge) => [edge.id, edge.beta]));
    return network.map((edge) => {
      const beta = posterior.get(edge.id);
      return beta === undefined ? edge : { ...edge, beta };
    });
  }, [network, learned]);

  // Named facilities, for the label layer. Small (a few hundred points) and worth having early:
  // "KEM Hospital" on the map is what turns a route from two lines into a trip.
  const [facilities, setFacilities] = useState<readonly FacilityLabel[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    loadFacilityLabels(city, controller.signal)
      .then(setFacilities)
      .catch(() => undefined);
    return () => controller.abort();
  }, [city]);

  // Facilities plus the chronic register: the two sets of places this product is about. Street
  // names come from the segments themselves, inside `CityMap`.
  const labels = useMemo(
    () => [
      ...facilities.map((f) => ({
        id: f.id,
        text: f.text,
        lon: f.lon,
        lat: f.lat,
        kind: f.kind,
      })),
      ...ranked.map((h) => ({
        id: `hotspot-${h.id}`,
        text: h.name,
        lon: h.lon,
        lat: h.lat,
        kind: "hotspot" as const,
      })),
    ],
    [facilities, ranked],
  );

  // The rings only need a position and an identity; the rail owns everything else about a
  // hotspot, so the map is not re-created when the scrub moves its depth chips.
  const rings = useMemo(
    () => ranked.map((h) => ({ id: h.id, name: h.name, lon: h.lon, lat: h.lat })),
    [ranked],
  );
  // Only the manholes actually surcharging *now*: a marker that stayed put for the whole run
  // would say the drain is failing at 06:40, when it is not yet.
  const surcharge = useMemo(() => {
    if (!surchargeSet) return [];
    return surchargeSet.nodes
      .map((n) => ({ id: n.id, lon: n.lon, lat: n.lat, q: n.q[step] ?? 0 }))
      .filter((n) => n.q > 0);
  }, [surchargeSet, step]);
  // Pipes running backwards *now* that carry geometry (motion M9). A run baked before the product
  // carried paths yields none, so the layer draws nothing rather than failing.
  const reversedEdges = useMemo(
    () => reversedEdgesAtStep(surchargeSet?.reversedEdges ?? [], step),
    [surchargeSet, step],
  );

  if (status.kind === "loading") {
    const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[var(--ink)]">
        <div className="w-[280px]">
          {/* Skeleton shimmer, never a spinner (CLAUDE.md 6.9). */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--well)]">
            <div
              className="h-full rounded-full bg-[var(--tide)] transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="num mt-3 text-[13px] text-[var(--text-2)]">
            Loading the run: {status.done} of {status.total} depth frames
          </p>
        </div>
      </div>
    );
  }

  if (status.kind === "empty") {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[var(--ink)] p-6">
        <EmptyState
          title="No runs yet"
          description="Press Play on the replay, or Compute live. A baked run brings the map to life."
        />
      </div>
    );
  }

  if (status.kind === "error") {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[var(--ink)] p-6">
        <div className="max-w-[420px] text-center">
          <p className="text-[15px] text-[var(--text)]">The map could not load this run.</p>
          <p className="mt-2 text-[13px] text-[var(--text-2)]">{status.message}</p>
          <Button size="sm" variant="outline" className="mt-4" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <CityMap
      mode={mode}
      frames={status.run.frames}
      rasterBounds={status.run.bounds}
      baseSegments={status.baseSegments}
      segments={status.segments}
      surcharge={surcharge}
      reversedEdges={reversedEdges}
      showSurcharge={showSurcharge}
      buildings={buildings}
      drains={drains}
      showBuildings={showBuildings}
      showDrains={showDrains}
      hotspots={rings}
      labels={labels}
      isochrones={isochrones}
      passableBelowCm={passableBelowCm}
      probabilityThresholdCm={probabilityThresholdCm}
      truthPins={truthPins}
      onSegmentPick={onSegmentPick}
      showSatellite={showSatellite}
      attribution={attribution}
      selectedHotspotId={selectedHotspotId}
      focus={focus}
      step={Math.min(step, status.run.provenance.nSteps - 1)}
      showRaster={showRaster}
      showSegments={showSegments}
      showHotspots={showHotspots}
    />
  );
}
