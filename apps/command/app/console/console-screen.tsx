"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/varuna/app-shell";
import { MapSlot } from "@/components/varuna/map-slot";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import { ReplayPanel } from "@/components/varuna/replay-panel";
import { RightRail } from "@/components/varuna/right-rail";
import { SkyPanel } from "@/components/varuna/sky-panel";
import { TimeBar } from "@/components/varuna/time-bar";
import { useUiStore } from "@/lib/stores/ui";

/**
 * The command console (CLAUDE.md section 7.2). The map slot, the replay panel, the right rail and
 * the time bar are the Phase 0 shell; `CityMap`, the real time bar and the hotspot drawer land in
 * Phase 6.
 *
 * The rain panel on the left is Phase 3 scaffolding (task P3.8): it proves the Sky cube is real and
 * readable from the browser before there is a map to draw it on. Phase 6 deletes it - the panel, its
 * toggle and these three lines - and keeps `FanChart`, which the hotspot drawer needs anyway.
 */
export function ConsoleScreen() {
  const replayPanelOpen = useUiStore((s) => s.replayPanelOpen);
  const [skyPanelOpen, setSkyPanelOpen] = useState(true);

  return (
    <AppShell rightRail={<RightRail />} bottomBar={<TimeBar />}>
      <div className="relative h-full min-h-0 w-full">
        <MapSlot legendClearsRightPanel={replayPanelOpen} />

        {/* Capped well above the canvas floor: at 1366 x 768 the depth legend reaches inboard to
            clear the replay panel, and the legend is always visible (CLAUDE.md section 6.7), so the
            rain panel stops short of it and scrolls instead. */}
        <div className="absolute top-4 left-4 z-20 flex max-h-[calc(100%-12rem)] w-[380px] max-w-[calc(100%-2rem)] flex-col items-start gap-2">
          <Button size="sm" variant="outline" onClick={() => setSkyPanelOpen((open) => !open)}>
            {skyPanelOpen ? "Hide the rain nowcast" : "Show the rain nowcast"}
          </Button>
          {skyPanelOpen ? (
            <div className="min-h-0 w-full overflow-y-auto">
              <PanelErrorBoundary title="Rain nowcast">
                <SkyPanel />
              </PanelErrorBoundary>
            </div>
          ) : null}
        </div>

        {replayPanelOpen ? (
          <div className="absolute top-4 right-4 z-20 max-h-[calc(100%-2rem)] w-[360px] max-w-[calc(100%-2rem)] overflow-y-auto">
            <ReplayPanel />
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
