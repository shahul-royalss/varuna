"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { CityMap, type Isochrone, type RouteLine, type SegmentPath } from "@/components/map/city-map";
import { AppShell } from "@/components/varuna/app-shell";
import { EmptyState } from "@/components/varuna/empty-state";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import { RouteCompare, type RouteSummary } from "@/components/varuna/route-compare";
import {
  RouteForm,
  defaultRouteRequest,
  type RoutePlace,
  type RouteRequest,
} from "@/components/varuna/route-form";
import { apiUrl } from "@/lib/api/client";
import { allSegments } from "@/lib/api/run-depth";
import { loadPlaces, planRoute, type Place, type RoutePlan } from "@/lib/api/route";
import { useReplayStore } from "@/lib/stores/replay";

/**
 * The route planner (CLAUDE.md 7.4, task P8.5).
 *
 * The screen's one job is a comparison. A safe route on its own is unfalsifiable - of course the
 * system says its own route is fine. Drawn against the route a navigation app would give you
 * today, with the streets it walks into named and their predicted depth beside them, a dispatcher
 * can see for themselves what the detour bought.
 *
 * Places come from the city's own registers (`/v1/route/facilities` and the chronic hotspot
 * layer), never from coordinates typed into the front end: each one carries a `source_url` there.
 */
export function RouteScreen() {
  const simTime = useReplayStore((s) => s.simTime);
  const [request, setRequest] = useState<RouteRequest>(() => defaultRouteRequest(simTime));
  const [places, setPlaces] = useState<Place[]>([]);
  const [streets, setStreets] = useState<SegmentPath[]>([]);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    loadPlaces("mumbai", controller.signal)
      .then((loaded) => {
        setPlaces(loaded);
        // Preselect the demo trip: KEM Hospital to Sion Hospital (CLAUDE.md 3.3, 15).
        const kem = loaded.find((p) => p.name.includes("(KEM)"));
        const sion = loaded.find((p) => p.name.includes("(LTMG)"));
        if (kem && sion) {
          setRequest((current) => ({ ...current, originId: kem.id, destinationId: sion.id }));
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // The street network, for context under the route. Without it a route is two lines in the dark.
  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl("/v1/city/mumbai/layers/segments"), { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { features: [] }))
      .then((geojson) => setStreets(allSegments(geojson)))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // The demo's two hospitals first, then the chronic junctions, then the rest of the register.
  // Mumbai has 354 hospitals in the AOI and the ambulance trip is between two named ones; a picker
  // that makes you scroll past 300 clinics to find KEM is a picker nobody uses on stage.
  const options: RoutePlace[] = useMemo(() => {
    const demo = new Set(
      places.filter((p) => p.name.includes("(KEM)") || p.name.includes("(LTMG)")).map((p) => p.id),
    );
    const group = (p: Place): string => {
      if (demo.has(p.id)) return "Demo trip";
      if (p.kind === "hotspot") return "Chronic junctions";
      return p.kind === "fire_station" ? "Fire stations" : "Hospitals";
    };
    return places.map((p) => ({ id: p.id, name: p.name, group: group(p) }));
  }, [places]);

  const run = useCallback(
    async (next: RouteRequest) => {
      const origin = places.find((p) => p.id === next.originId);
      const destination = places.find((p) => p.id === next.destinationId);
      if (!origin || !destination) {
        setError("Pick an origin and a destination from the city's registers.");
        return;
      }
      setRunning(true);
      setError(null);
      try {
        setPlan(
          await planRoute({
            origin,
            destination,
            departAt: next.departAt,
            profile: next.profile,
            riskTolerance: next.riskTolerance,
          }),
        );
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setPlan(null);
      } finally {
        setRunning(false);
      }
    },
    [places],
  );

  // Motion M14: the naive route in dashed grey, the VARUNA route over it in `--tide`. Both are
  // handed to the map together; deck draws them in the order section 6.7 sets.
  const routes: RouteLine[] = useMemo(() => {
    if (!plan) return [];
    const lines: RouteLine[] = [];
    if (plan.naive) lines.push({ id: "naive", path: plan.naive.path, kind: "naive" });
    plan.alternates.forEach((alt, i) =>
      lines.push({ id: `alt-${i}`, path: alt.path, kind: "alternate" }),
    );
    if (plan.varuna) lines.push({ id: "varuna", path: plan.varuna.path, kind: "varuna" });
    return lines;
  }, [plan]);

  const noIsochrones: Isochrone[] = useMemo(() => [], []);

  const naive: RouteSummary | null = plan?.naive
    ? {
        etaMin: plan.naive.minutes,
        distanceM: plan.naive.distanceM,
        maxDepthCm: plan.naive.maxDepthCm,
        safeUntil: plan.naive.safeUntil ?? undefined,
        avoided: [],
      }
    : null;

  const varuna: RouteSummary | null = plan?.varuna
    ? {
        etaMin: plan.varuna.minutes,
        distanceM: plan.varuna.distanceM,
        maxDepthCm: plan.varuna.maxDepthCm,
        safeUntil: plan.varuna.safeUntil ?? undefined,
        avoided: plan.avoided.map((a) => ({
          segmentId: a.segmentId,
          name: a.name,
          probability: a.probability,
          atTs: a.at,
        })),
        alternates: plan.alternates.map((alt, i) => ({
          id: `alt-${i}`,
          label: `Alternate ${i + 1}`,
          etaMin: alt.minutes,
          maxDepthCm: alt.maxDepthCm,
        })),
      }
    : null;

  return (
    <AppShell>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-4 p-6">
          <PageHeader
            title="Route planner"
            description="Prediction turned into an ambulance route."
          />

          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[30fr_70fr]">
            <PanelErrorBoundary>
              <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
                <Panel title="Trip" description="KEM Hospital to Sion Hospital at the replay clock.">
                  <RouteForm
                    value={request}
                    onChange={setRequest}
                    onSubmit={(next) => void run(next)}
                    places={options.length > 0 ? options : undefined}
                    disabled={places.length === 0}
                    submitDisabledReason="Loading the city's hospitals and chronic junctions"
                  />
                  {running ? (
                    <p className="mt-3 type-small text-text-3">Routing...</p>
                  ) : null}
                  {error ? <p className="mt-3 type-small text-text-2">{error}</p> : null}
                  {plan ? (
                    <p className="mt-3 type-micro text-text-3">
                      Routed on run <span className="num">{plan.runId}</span> in{" "}
                      <span className="num">{Math.round(plan.ms)}</span> ms.
                    </p>
                  ) : null}
                  {plan?.notes.map((note) => (
                    <p key={note} className="mt-2 type-micro text-text-3">
                      {note}
                    </p>
                  ))}
                </Panel>
              </div>
            </PanelErrorBoundary>

            <div className="flex min-h-0 min-w-0 flex-col gap-4">
              <PanelErrorBoundary>
                <section
                  aria-label="Route map"
                  className="relative min-h-[300px] flex-1 overflow-hidden rounded-panel border border-line bg-deep"
                >
                  {streets.length > 0 ? (
                    <CityMap
                      frames={[]}
                      rasterBounds={null}
                      baseSegments={streets}
                      segments={[]}
                      surcharge={[]}
                      hotspots={[]}
                      routes={routes}
                      isochrones={noIsochrones}
                      showRaster={false}
                      showSegments={false}
                      showSurcharge={false}
                      showBuildings={false}
                      showHotspots={false}
                      step={0}
                    />
                  ) : (
                    <EmptyState
                      title="Loading the city"
                      description="The street network arrives from the city VARUNA built; the route draws on it."
                    />
                  )}
                </section>
              </PanelErrorBoundary>

              <PanelErrorBoundary>
                <RouteCompare naive={naive} varuna={varuna} />
              </PanelErrorBoundary>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
