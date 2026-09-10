"use client";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/varuna/empty-state";
import { HotspotRail } from "@/components/varuna/hotspot-rail";
import { ReachabilityPanel } from "@/components/varuna/reachability-panel";
import type { Hotspot, HotspotSet } from "@/lib/api/hotspots";
import { RIGHT_RAIL_TABS, useUiStore, type RightRailTab } from "@/lib/stores/ui";

const TAB_LABELS: Record<RightRailTab, string> = {
  hotspots: "Hotspots",
  alerts: "Alerts",
  pumps: "Pumps",
  reachability: "Reachability",
};

export interface RightRailProps {
  /** The current run's ranked hotspots; null before one has loaded. */
  hotspots?: HotspotSet | null;
  /** Step on the time bar, so the rail's depth chips track the map. */
  step?: number;
  selectedHotspotId?: string | null;
  onSelectHotspot?: (hotspot: Hotspot) => void;
  hotspotsLoading?: boolean;
  /** The scrub time the catchment is measured at; the tab is empty without one. */
  simTime?: string | null;
  /** The console draws the bands this hands back on its own map. */
  onIsochrones?: (rings: { minutes: number; rings: [number, number][][] }[]) => void;
}

function isRightRailTab(value: unknown): value is RightRailTab {
  return typeof value === "string" && (RIGHT_RAIL_TABS as readonly string[]).includes(value);
}

/** The console's right rail (CLAUDE.md section 6.5): Hotspots, Alerts, Pumps and Reachability tabs. */
export function RightRail({
  hotspots = null,
  step = 0,
  selectedHotspotId = null,
  onSelectHotspot,
  hotspotsLoading = false,
  simTime = null,
  onIsochrones,
}: RightRailProps = {}) {
  const tab = useUiStore((s) => s.rightRailTab);
  const setTab = useUiStore((s) => s.setRightRailTab);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isRightRailTab(value)) setTab(value);
      }}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <TabsList variant="line" className="h-10 w-full shrink-0 border-b border-line px-2">
        {RIGHT_RAIL_TABS.map((t) => (
          <TabsTrigger key={t} value={t}>
            {TAB_LABELS[t]}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="hotspots" className="min-h-0 flex-1">
        <HotspotRail
          hotspots={hotspots?.hotspots ?? []}
          step={step}
          selectedId={selectedHotspotId}
          onSelect={onSelectHotspot}
          ranking={hotspots?.ranking}
          impassableThresholdCm={hotspots?.impassableThresholdCm}
          loading={hotspotsLoading}
        />
      </TabsContent>

      <TabsContent value="alerts" className="min-h-0 flex-1 overflow-y-auto p-4">
        <EmptyState
          title="No alerts yet"
          description="Alerts raise when a segment stays above its threshold for two cycles."
        />
      </TabsContent>

      <TabsContent value="pumps" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex h-10 items-center justify-between border-b border-line px-4">
          <span className="type-small text-text-2">Synthetic pump inventory</span>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button variant="outline" size="sm" disabled aria-disabled="true">
                Optimise
              </Button>
            </TooltipTrigger>
            <TooltipContent>Available once a run is loaded</TooltipContent>
          </Tooltip>
        </div>
        <div className="p-4">
          <EmptyState
            title="No pump plan yet"
            description="Press Optimise once a run is loaded."
          />
        </div>
      </TabsContent>

      <TabsContent value="reachability" className="min-h-0 flex-1 overflow-y-auto p-4">
        {simTime ? (
          <ReachabilityPanel at={simTime} onIsochrones={onIsochrones} />
        ) : (
          <EmptyState
            title="No reachability clocks yet"
            description="Reachability clocks appear with the first run."
          />
        )}
      </TabsContent>
    </Tabs>
  );
}
