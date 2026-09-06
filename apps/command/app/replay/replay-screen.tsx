"use client";

import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/varuna/app-shell";
import { BundleCard, type BundleSummary } from "@/components/varuna/bundle-card";
import { CycleBudgetBar } from "@/components/varuna/cycle-budget-bar";
import { CycleLog, type CycleLogRow } from "@/components/varuna/cycle-log";
import { EmptyState } from "@/components/varuna/empty-state";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import { ReplayPanel } from "@/components/varuna/replay-panel";
import { StormDesigner, type StormCell } from "@/components/varuna/storm-designer";
import { useReplayStore } from "@/lib/stores/replay";
import { useUiStore } from "@/lib/stores/ui";

/**
 * The three bundles of the demo (CLAUDE.md section 10.2). `available` stays false until
 * `make bundle` has written the folder, so a card never claims a bundle is on disk.
 */
const BUNDLES: readonly BundleSummary[] = [
  {
    id: "MUM-2019-07-02",
    kind: "Reconstructed replay",
    city: "Mumbai, MUM-CENTRAL",
    window: "2 July 2019, 05:40 to 09:40 IST",
    note: "Storm designer calibrated to the public gauge totals for 2 July 2019; sources listed in the bundle manifest",
    available: false,
    t0: "2019-07-02T05:40:00+05:30",
    t1: "2019-07-02T09:40:00+05:30",
    simTime: "2019-07-02T06:40:00+05:30",
  },
  {
    id: "MUM-IDF-25yr",
    kind: "Design storm",
    city: "Mumbai, MUM-CENTRAL",
    window: "Six-hour design window, 05:40 to 09:40 IST on a nominal day",
    note: "25-year Chicago hyetograph for Mumbai",
    available: false,
    t0: "2026-06-15T05:40:00+05:30",
    t1: "2026-06-15T09:40:00+05:30",
    simTime: "2026-06-15T05:40:00+05:30",
  },
  {
    id: "CHN-IDF-25yr",
    kind: "Design storm",
    city: "Chennai, CHN-SOUTH",
    window: "Six-hour design window, 05:40 to 09:40 IST on a nominal day",
    note: "25-year Chicago hyetograph for Chennai",
    available: false,
    t0: "2026-11-05T05:40:00+05:30",
    t1: "2026-11-05T09:40:00+05:30",
    simTime: "2026-11-05T05:40:00+05:30",
  },
];

/** Cycle rows arrive from the run registry once a bundle is baked. */
const NO_CYCLES: CycleLogRow[] = [];

/** Storm cells are read from the bundle manifest once `make bundle` has run. */
const NO_CELLS: StormCell[] = [];

/**
 * Replay control and storm designer (CLAUDE.md section 7.8): pick a bundle, drive the same clock
 * the console uses, read the cycle log, and look at the storm the bundle was built from. Editing
 * the storm is a pilot feature; the demo storm is read-only and seeded.
 */
export function ReplayScreen() {
  const bundleId = useReplayStore((s) => s.bundleId);
  const setBundle = useReplayStore((s) => s.setBundle);
  const replayPanelOpen = useUiStore((s) => s.replayPanelOpen);
  const setReplayPanelOpen = useUiStore((s) => s.setReplayPanelOpen);

  const selected = BUNDLES.find((bundle) => bundle.id === bundleId);

  const handleSelect = (bundle: BundleSummary) => {
    setBundle(bundle.id, { t0: bundle.t0, t1: bundle.t1, simTime: bundle.simTime });
  };

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-6 p-6">
          <PageHeader
            title="Replay"
            description="Stream a past event through the live pipeline."
          />

          <PanelErrorBoundary title="Bundles">
            <Panel
              title="Bundles"
              description="The clock, the cycle log and the storm below follow the selected bundle."
            >
              <ul className="grid gap-3 lg:grid-cols-3">
                {BUNDLES.map((bundle) => (
                  <li key={bundle.id} className="min-w-0">
                    <BundleCard
                      bundle={bundle}
                      selected={bundle.id === bundleId}
                      onSelect={handleSelect}
                    />
                  </li>
                ))}
              </ul>
            </Panel>
          </PanelErrorBoundary>

          <div className="grid min-h-0 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <PanelErrorBoundary title="Clock and controls">
              <div className="min-w-0">
                {replayPanelOpen ? (
                  <ReplayPanel />
                ) : (
                  <Panel title="Replay">
                    <EmptyState
                      title="Replay controls hidden"
                      description="Show the controls to play, pause, seek and change the speed."
                      action={
                        <Button variant="outline" onClick={() => setReplayPanelOpen(true)}>
                          Show replay controls
                        </Button>
                      }
                    />
                  </Panel>
                )}
              </div>
            </PanelErrorBoundary>

            <div className="flex min-w-0 flex-col gap-4">
              <PanelErrorBoundary title="Cycle log">
                <Panel
                  title="Cycle log"
                  description="One row per published cycle, with stage timings and mass-balance error."
                >
                  <div className="space-y-4">
                    <CycleBudgetBar />
                    <CycleLog rows={NO_CYCLES} />
                  </div>
                </Panel>
              </PanelErrorBoundary>

              <PanelErrorBoundary title="Storm designer">
                <Panel
                  title="Storm designer"
                  description="The convective cells the bundle was generated from, and the radar preview."
                >
                  <StormDesigner cells={NO_CELLS} bundleId={selected?.id ?? bundleId} />
                </Panel>
              </PanelErrorBoundary>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
