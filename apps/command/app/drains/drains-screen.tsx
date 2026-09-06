"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
const ROWS: DrainHealthRow[] = [];
const OBSERVATIONS: Observation[] = [];

const EXPORT_REASON = "Available once a run has drain health";
const TOGGLE_REASON = "Available once Pulse has assimilated an observation";

export function DrainsScreen() {
  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-6 p-6">
          <PageHeader
            title="Drain X-ray"
            description="The learned blockage map, the observations that taught it, and the desilting priority list."
            honesty="Inferred drain graph"
          />

          <div className="grid min-h-0 gap-4 lg:grid-cols-[62fr_38fr]">
            <PanelErrorBoundary title="Drain map">
              <section
                aria-label="Drain map"
                className="flex min-h-[560px] flex-col overflow-hidden rounded-panel border border-line bg-deep"
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
                    <ToggleGroup aria-label="Drain state" aria-describedby="drain-toggle-help">
                      <ToggleGroupItem
                        value="before"
                        variant="outline"
                        size="sm"
                        disabled
                        title={TOGGLE_REASON}
                      >
                        Before
                      </ToggleGroupItem>
                      <ToggleGroupItem
                        value="after"
                        variant="outline"
                        size="sm"
                        disabled
                        title={TOGGLE_REASON}
                      >
                        After
                      </ToggleGroupItem>
                    </ToggleGroup>
                    <p id="drain-toggle-help" className="type-micro text-text-3">
                      {TOGGLE_REASON}
                    </p>
                  </div>
                </header>
                <div className="min-h-0 flex-1">
                  <MapSlot />
                </div>
              </section>
            </PanelErrorBoundary>

            <div className="flex min-w-0 flex-col gap-4">
              <PanelErrorBoundary title="Drain health">
                <Panel
                  title="Drain health"
                  description="Top pipes by posterior blockage, worst first."
                >
                  <DrainHealthTable rows={ROWS} />
                </Panel>
              </PanelErrorBoundary>

              <PanelErrorBoundary title="Assimilation timeline">
                <Panel
                  title="Assimilation timeline"
                  description="Every observation Pulse used this cycle, and the blockage it moved."
                >
                  {OBSERVATIONS.length === 0 ? (
                    <EmptyState
                      size="sm"
                      title="No observations assimilated yet"
                      description="Press Play on the replay: traffic anomalies and citizen reports arrive with the clock."
                    />
                  ) : (
                    <ol className="flex flex-col gap-2">
                      {OBSERVATIONS.map((obs) => (
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
                  disabled
                  title={EXPORT_REASON}
                  aria-describedby="drain-export-help"
                >
                  <Download size={16} strokeWidth={1.75} aria-hidden="true" />
                  Export desilting priority (CSV)
                </Button>
                <p id="drain-export-help" className="type-micro text-text-3">
                  {EXPORT_REASON}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
