"use client";

import { AppShell } from "@/components/varuna/app-shell";
import { MapSlot } from "@/components/varuna/map-slot";
import { ReplayPanel } from "@/components/varuna/replay-panel";
import { RightRail } from "@/components/varuna/right-rail";
import { TimeBar } from "@/components/varuna/time-bar";
import { useUiStore } from "@/lib/stores/ui";

/**
 * The command console (CLAUDE.md section 7.2). In Phase 0 it is the empty console: the map slot with
 * its "No runs yet" state, the replay panel open by default, the right rail and the time bar.
 */
export function ConsoleScreen() {
  const replayPanelOpen = useUiStore((s) => s.replayPanelOpen);

  return (
    <AppShell rightRail={<RightRail />} bottomBar={<TimeBar />}>
      <div className="relative h-full min-h-0 w-full">
        <MapSlot legendClearsRightPanel={replayPanelOpen} />
        {/* The replay panel is capped to the map canvas so it never slides under the time bar
            at 1366 x 768; long cycle logs scroll inside it. */}
        {replayPanelOpen ? (
          <div className="absolute top-4 right-4 z-20 max-h-[calc(100%-2rem)] w-[360px] max-w-[calc(100%-2rem)] overflow-y-auto">
            <ReplayPanel />
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
