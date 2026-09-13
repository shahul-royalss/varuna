"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useEffect, useMemo, useState } from "react";

import { CityMap, type SegmentPath } from "@/components/map/city-map";
import { apiUrl } from "@/lib/api/client";
import { loadDrains, type DrainPath as DrainEdge } from "@/lib/api/city-layers";
import { allSegments } from "@/lib/api/run-depth";
import { loadSurcharge, type SurchargeSet } from "@/lib/api/surcharge";
import {
  desiltingCsvUrl,
  loadDrainHealth,
  loadObservations,
  type DrainHealth,
  type ObservationSet,
} from "@/lib/api/drains";
import { DrainHealthTable, type DrainHealthRow } from "@/components/varuna/drain-health-table";
import { EmptyState } from "@/components/varuna/empty-state";
import { MapSlot } from "@/components/varuna/map-slot";
import { ObservationCard, type Observation } from "@/components/varuna/observation-card";
import { AppShell } from "@/components/varuna/app-shell";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";

/*
 * Phase 0 renders the screen with no run loaded: the drain-health table and the assimilation
 * timeline show their empty states, and every control from Phase 7 is present but disabled with
 * the reason it is disabled. Pulse fills these two lists in Phase 7 (CLAUDE.md section 7.3).
 */
/** Learned pipes fetched from the run. The cycle writes the 6,000 worst by blockage; asking for
 * all of them costs nothing extra and means the table and the map rank over the same set. */
const MAP_EDGE_LIMIT = 6000;

const EXPORT_REASON = "Available once a run has drain health";
const TOGGLE_REASON = "Available once Pulse has assimilated an observation";

/**
 * What each observation operator is, in one line. The filter's `H(theta)` is injectable
 * (`services/pulse/varuna_pulse/enkf.py`) and the prototype ships the reduced one, so every
 * blockage on this map came through a stand-in for CLAUDE.md 11.6's "run drain1d per member".
 * Naming it here is the honesty label for that (rule 6); an operator with no entry is still
 * named, because the run stamped it and the reader should see which one ran.
 */
const OPERATOR_NOTES: Record<string, string> = {
  capacity_deficit:
    "an observation is compared against a volume balance over the pipe's catchment, not a drain1d run.",
};

export function DrainsScreen() {
  const [health, setHealth] = useState<DrainHealth | null>(null);
  const [network, setNetwork] = useState<DrainEdge[]>([]);
  const [observed, setObserved] = useState<ObservationSet | null>(null);
  const [streets, setStreets] = useState<SegmentPath[]>([]);
  const [showPrior, setShowPrior] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      loadDrainHealth(undefined, controller.signal, MAP_EDGE_LIMIT),
      loadObservations(undefined, controller.signal),
    ])
      .then(([h, o]) => {
        setHealth(h);
        setObserved(o);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // The full inferred graph, from the city layer. 18 MB, so it arrives behind the run's own
  // ranked pipes rather than in front of them.
  useEffect(() => {
    const controller = new AbortController();
    loadDrains("mumbai", controller.signal)
      .then(setNetwork)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // The streets, drawn under the pipes in the dry colour. Without them the drain graph is a
  // scatter of magenta strokes on black and nobody can tell which junction is which; with them
  // it reads as what it is - a sewer beneath a city, following the roads it was inferred from.
  // Loaded second, because the pipes are the subject and this is the paper they sit on.
  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl("/v1/city/mumbai/layers/segments"), { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { features: [] }))
      .then((geojson) => setStreets(allSegments(geojson)))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // The manholes that surcharge in the same run the blockage map came from - stamped with that
  // run, like the console's set, so a table and rings from two different cycles never share the
  // screen. Section 7.3 asks for them as red rings; they were passed as an empty list, so the one
  // screen about the sewer could not show where it was failing.
  const healthRunId = health?.runId;
  // `failed` is kept apart from `set: null`: null means the run predates the product (a 404), and
  // saying that over a network error would give the reader the wrong fix.
  const [surcharge, setSurcharge] = useState<{
    runId: string;
    set: SurchargeSet | null;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (!healthRunId) return;
    const controller = new AbortController();
    loadSurcharge(healthRunId, controller.signal)
      .then((set) => setSurcharge({ runId: healthRunId, set, failed: false }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("Surcharge failed to load", error);
        setSurcharge({ runId: healthRunId, set: null, failed: true });
      });
    return () => controller.abort();
  }, [healthRunId]);
  const surchargeSet = surcharge?.runId === healthRunId ? surcharge?.set : undefined;

  // **Each manhole at its peak, not at step 0.** This screen has no time bar, and the console's
  // rule - draw only what surcharges *now* - would leave it at the run's first step, where one or
  // two manholes of the 500 stored are surcharging. So every stored manhole is drawn, sized by the
  // most it discharged over the run, and the header says that is what the rings mean.
  const surchargeNodes = useMemo(
    () =>
      (surchargeSet?.nodes ?? []).map((n) => ({ id: n.id, lon: n.lon, lat: n.lat, q: n.peakQ })),
    [surchargeSet],
  );

  const rows: DrainHealthRow[] = (health?.edges ?? []).slice(0, 25).map((edge) => ({
    id: edge.id,
    street: edge.street ?? "Unnamed way",
    betaMean: edge.betaMean,
    betaSd: edge.betaSd,
    capacityReduction: edge.capacityReductionPct / 100,
    hotspotsExplained: edge.explains,
    observations: edge.observations,
    lastUpdated: edge.lastUpdate ?? "",
  }));

  // The cross-fade of motion M12: the same pipes drawn at the prior the city pipeline gave them,
  // or at the posterior Pulse learned. Seeing them side by side is the whole point of the screen
  // - it is the only place the learning is visible as a change rather than as a colour.
  // **The whole network, not just the learned part.** The run's `drain_health` carries the 6,000
  // pipes Pulse ranked; the city layer carries all 49,770. Drawing only the first left the X-ray
  // looking like scattered confetti over an empty city - the reported "add all the pipes". So the
  // full graph is drawn at its prior and the learned pipes are drawn over it at their posterior,
  // which is also the honest picture: most of Mumbai's drains have never been observed, and the
  // ones that have are exactly the ones that stand out.
  const learned = useMemo(() => {
    const byId = new Map<string, number>();
    for (const edge of health?.edges ?? []) {
      byId.set(edge.id, showPrior ? edge.betaPrior : edge.betaMean);
    }
    return byId;
  }, [health, showPrior]);

  const drains = useMemo(() => {
    // The city layer is the base: every pipe, at the prior the pipeline gave it.
    const all = network.map((edge) => ({
      path: edge.path,
      beta: learned.get(edge.id) ?? edge.beta,
      diameter: edge.diameter,
    }));
    if (all.length > 0) return all;
    // Before the city layer arrives, draw whatever the run knows so the panel is never empty.
    return (health?.edges ?? []).map((edge) => ({
      path: edge.path,
      beta: showPrior ? edge.betaPrior : edge.betaMean,
      diameter: edge.diameterM,
    }));
  }, [network, learned, health, showPrior]);

  const observations: Observation[] = (observed?.observations ?? []).map((o) => ({
    id: o.id,
    kind: o.kind,
    ts: o.ts,
    place: o.place,
    inferredDepthCm: o.depthCm,
    pipeId: o.edgeId ?? undefined,
    // Left undefined rather than defaulted, so a run baked before Pulse recorded the pair says
    // it has no change instead of printing "0.00 → 0.00" as though the filter had moved nothing.
    betaBefore: o.betaBefore ?? undefined,
    betaAfter: o.betaAfter ?? undefined,
  }));

  return (
    <AppShell>
      {/*
       * A two-pane screen with the viewport's height, not a scrolling page. The map used to be a
       * grid item with `min-h-[560px]` beside a table of 25 pipes, and a grid row stretches to its
       * tallest item: the map's canvas grew to 7,196 px, the drain graph was framed in the middle
       * of it, and all the viewport showed was the empty top of a very tall picture. The map takes
       * the height it is given here and the panels beside it scroll on their own.
       */}
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-4 p-6">
          <PageHeader
            title="Drain X-ray"
            description="The learned blockage map, the observations that taught it, and the desilting priority list."
            honesty="Inferred drain graph"
          />

          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[62fr_38fr]">
            <PanelErrorBoundary title="Drain map">
              <section
                aria-label="Drain map"
                className="flex min-h-[420px] flex-col overflow-hidden rounded-panel border border-line bg-deep"
              >
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <p className="type-small font-medium text-text">
                      Drain graph inferred from roads and terrain
                    </p>
                    <p className="type-micro text-text-3">
                      Every pipe is dashed on the map: none of it comes from a surveyed drain GIS.
                    </p>
                    {health ? (
                      <p className="type-micro text-text-3">
                        Observation operator: {health.operator.replaceAll("_", " ")}
                        {OPERATOR_NOTES[health.operator]
                          ? ` - ${OPERATOR_NOTES[health.operator]}`
                          : "."}
                      </p>
                    ) : null}
                    {/*
                     * Section 7.3 asks for inlets as small squares coloured by clogging, and 11.6
                     * for clogging to be learned at observed inlets. Neither exists: Pulse's state
                     * vector is blockage alone, and `CityMap` has no point layer to draw an inlet
                     * with. Saying so here is the honest half (rule 6) - a legend swatch for squares
                     * that are not on the map would be the defect this sentence replaces. Remove it
                     * when the inlet layer lands, and label that layer "prior, not learned" until
                     * Pulse updates clogging.
                     */}
                    <p className="type-micro text-text-3">
                      Inlet clogging (κ) is not learned yet, and inlets are not drawn: every inlet
                      keeps the prior the city pipeline gave it.
                    </p>
                    {/*
                     * What the red rings are. Only said once the product has answered: before
                     * that there are no rings to explain, and a run baked before the product
                     * existed gets the reason instead of an empty map that reads as "no surcharge".
                     */}
                    {surchargeSet ? (
                      <p className="type-micro text-text-3">
                        {surchargeSet.nodes.length > 0
                          ? `Red rings: the ${surchargeSet.nodes.length.toLocaleString("en-IN")} manholes that surcharge hardest in this run, each at its peak, sized by discharge.`
                          : "No manhole surcharges in this run."}
                      </p>
                    ) : surcharge && surcharge.runId === healthRunId ? (
                      <p className="type-micro text-text-3">
                        {surcharge.failed
                          ? "Surcharge rings did not load, so manholes are not drawn. Reload the page to try again."
                          : "No surcharge rings: this run has no surcharge product. Bake the run again to draw them."}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <ToggleGroup
                      aria-label="Drain state"
                      aria-describedby="drain-toggle-help"
                      value={showPrior ? ["before"] : ["after"]}
                      onValueChange={(value) => setShowPrior(value.includes("before"))}
                    >
                      <ToggleGroupItem
                        value="before"
                        variant="outline"
                        size="sm"
                        disabled={!health}
                        title={health ? "The prior every pipe started with" : TOGGLE_REASON}
                      >
                        Before
                      </ToggleGroupItem>
                      <ToggleGroupItem
                        value="after"
                        variant="outline"
                        size="sm"
                        disabled={!health}
                        title={health ? "The posterior Pulse learned" : TOGGLE_REASON}
                      >
                        After
                      </ToggleGroupItem>
                    </ToggleGroup>
                    <p id="drain-toggle-help" className="type-micro text-text-3">
                      {health
                        ? `${health.nUpdated.toLocaleString("en-IN")} of ${health.nEdges.toLocaleString("en-IN")} pipes moved this cycle`
                        : TOGGLE_REASON}
                    </p>
                  </div>
                </header>
                <div className="relative min-h-0 flex-1">
                  {drains.length > 0 || streets.length > 0 ? (
                    <CityMap
                      frames={[]}
                      rasterBounds={null}
                      baseSegments={streets}
                      segments={[]}
                      surcharge={surchargeNodes}
                      hotspots={[]}
                      drains={drains}
                      showDrains
                      showRaster={false}
                      showSegments={false}
                      showSurcharge
                      showBuildings={false}
                      step={0}
                    />
                  ) : (
                    <MapSlot />
                  )}
                </div>
              </section>
            </PanelErrorBoundary>

            <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto pr-1">
              <PanelErrorBoundary title="Drain health">
                <Panel
                  title="Drain health"
                  description="Top pipes by posterior blockage, worst first."
                >
                  <DrainHealthTable rows={rows} />
                </Panel>
              </PanelErrorBoundary>

              <PanelErrorBoundary title="Assimilation timeline">
                <Panel
                  title="Assimilation timeline"
                  description="The traffic anomalies Pulse detected at this cycle and the citizen reports filed up to it, with the blockage on the pipe each was about before and after this cycle's update. Earlier cycles' anomalies are not listed."
                >
                  {observations.length === 0 ? (
                    <EmptyState
                      size="sm"
                      title="No observations assimilated yet"
                      description="Press Play on the replay: traffic anomalies and citizen reports arrive with the clock."
                    />
                  ) : (
                    <ol className="flex flex-col gap-2">
                      {observations.map((obs) => (
                        <li key={obs.id}>
                          <ObservationCard obs={obs} />
                        </li>
                      ))}
                    </ol>
                  )}
                </Panel>
              </PanelErrorBoundary>

              <div className="space-y-1">
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={!health}
                  title={health ? "Download the ranked desilting list" : EXPORT_REASON}
                  aria-describedby="drain-export-help"
                  onClick={() => {
                    if (health) window.open(desiltingCsvUrl(health.runId), "_blank");
                  }}
                >
                  <Download size={16} strokeWidth={1.75} aria-hidden="true" />
                  Export desilting priority (CSV)
                </Button>
                <p id="drain-export-help" className="type-micro text-text-3">
                  {health
                    ? "Rank, pipe, street, blockage, spread and capacity lost - worst first."
                    : EXPORT_REASON}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
