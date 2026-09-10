"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useEffect, useState } from "react";

import { CityMap, type SegmentPath } from "@/components/map/city-map";
import { apiUrl } from "@/lib/api/client";
import { allSegments } from "@/lib/api/run-depth";
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
/** Pipes drawn on the X-ray. Enough to read the network, few enough to stay at 60 fps. */
const MAP_EDGE_LIMIT = 4000;

const EXPORT_REASON = "Available once a run has drain health";
const TOGGLE_REASON = "Available once Pulse has assimilated an observation";

export function DrainsScreen() {
  const [health, setHealth] = useState<DrainHealth | null>(null);
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
  const drains = (health?.edges ?? []).map((edge) => ({
    path: edge.path,
    beta: showPrior ? edge.betaPrior : edge.betaMean,
    diameter: edge.diameterM,
  }));

  const observations: Observation[] = (observed?.observations ?? []).map((o) => ({
    id: o.id,
    kind: o.kind,
    ts: o.ts,
    place: o.place,
    inferredDepthCm: o.depthCm,
    pipeId: o.edgeId ?? undefined,
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
                      surcharge={[]}
                      hotspots={[]}
                      drains={drains}
                      showDrains
                      showRaster={false}
                      showSegments={false}
                      showSurcharge={false}
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
                  description="Every observation Pulse used this cycle, and the blockage it moved."
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
