"use client";

import { useState } from "react";

import { AppShell } from "@/components/varuna/app-shell";
import { MapSlot } from "@/components/varuna/map-slot";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import { RouteCompare } from "@/components/varuna/route-compare";
import { RouteForm, defaultRouteRequest, type RouteRequest } from "@/components/varuna/route-form";
import { useReplayStore } from "@/lib/stores/replay";

/**
 * The route planner (CLAUDE.md section 7.4). In Phase 0 the form is live and preset to the demo
 * trip, the map slot carries its own empty state, and the comparison waits for a route: routing
 * itself lands in Phase 8, so "Find route" states why it is disabled instead of failing.
 */
export function RouteScreen() {
  const simTime = useReplayStore((s) => s.simTime);
  const [request, setRequest] = useState<RouteRequest>(() => defaultRouteRequest(simTime));

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-6 p-6">
          <PageHeader
            title="Route planner"
            description="Prediction turned into an ambulance route."
          />

          <div className="grid min-h-0 gap-4 lg:grid-cols-[30fr_70fr]">
            <PanelErrorBoundary>
              <Panel
                title="Trip"
                description="KEM Hospital to Sion Hospital at the replay clock."
              >
                <RouteForm value={request} onChange={setRequest} disabled />
              </Panel>
            </PanelErrorBoundary>

            <div className="flex min-w-0 flex-col gap-4">
              <PanelErrorBoundary>
                <section
                  aria-label="Route map"
                  className="min-h-[420px] overflow-hidden rounded-panel border border-line bg-deep"
                >
                  <MapSlot />
                </section>
              </PanelErrorBoundary>

              <PanelErrorBoundary>
                <RouteCompare />
              </PanelErrorBoundary>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
