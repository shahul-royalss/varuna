"use client";

import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/varuna/app-shell";
import { BundleCard, type BundleKind, type BundleSummary } from "@/components/varuna/bundle-card";
import { CycleBudgetBar } from "@/components/varuna/cycle-budget-bar";
import { CycleLog, type CycleLogRow } from "@/components/varuna/cycle-log";
import { EmptyState } from "@/components/varuna/empty-state";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import { ReplayPanel } from "@/components/varuna/replay-panel";
import { Skeleton } from "@/components/varuna/skeleton";
import { StormDesigner, type StormCell } from "@/components/varuna/storm-designer";
import { useReplayBundles, useReplayControls, type ReplayBundle } from "@/lib/api";
import { bundleWindowLabel } from "@/lib/format";
import { useReplayStore } from "@/lib/stores/replay";
import { useUiStore } from "@/lib/stores/ui";

/** Cycle rows arrive from the run registry once a bundle is baked. */
const NO_CYCLES: CycleLogRow[] = [];

/** Storm cells are read from the bundle manifest once `make bundle` has run. */
const NO_CELLS: StormCell[] = [];

/** "mumbai" is how the manifest names the city; the card says it the way a person would. */
function cityLabel(city: string): string {
  return city ? city.charAt(0).toUpperCase() + city.slice(1) : "Unknown city";
}

/** What the card says about the bundle: its own honesty note first, then the description. */
function bundleNote(bundle: ReplayBundle): string {
  if (!bundle.built) {
    return `Missing ${bundle.missing_members.join(", ")}. The manifest is on disk; the data is not.`;
  }
  return (
    bundle.synthetic_notes[0] ??
    bundle.description ??
    `Seed ${bundle.seed}. ${bundle.baked_cycles} of ${bundle.total_cycles} cycles baked.`
  );
}

function toCard(bundle: ReplayBundle): BundleSummary {
  return {
    id: bundle.id,
    kind: bundle.label as BundleKind,
    city: cityLabel(bundle.city),
    window: bundleWindowLabel(bundle.t0, bundle.t1),
    note: bundleNote(bundle),
    available: bundle.built,
    t0: bundle.t0,
    t1: bundle.t1,
    simTime: bundle.t0,
  };
}

/**
 * Replay control and storm designer (CLAUDE.md section 7.8): pick a bundle, drive the same clock
 * the console uses, read the cycle log, and look at the storm the bundle was built from. The
 * cards are what `GET /v1/replay/bundles` reports, never a hard-coded list, so a folder that
 * `make bundle` has not written yet is absent rather than pretended into existence. Editing the
 * storm is a pilot feature; the demo storm is read-only and seeded.
 */
export function ReplayScreen() {
  const bundleId = useReplayStore((s) => s.bundleId);
  const replayPanelOpen = useUiStore((s) => s.replayPanelOpen);
  const setReplayPanelOpen = useUiStore((s) => s.setReplayPanelOpen);

  const bundles = useReplayBundles();
  const controls = useReplayControls();

  const cards = useMemo(() => (bundles.data ?? []).map(toCard), [bundles.data]);
  const selected = cards.find((card) => card.id === bundleId);

  const handleSelect = (bundle: BundleSummary) => {
    controls.selectBundle(bundle.id, {
      t0: bundle.t0,
      t1: bundle.t1,
      simTime: bundle.simTime,
    });
  };

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-6 p-6">
          <PageHeader title="Replay" description="Stream a past event through the live pipeline." />

          <PanelErrorBoundary title="Bundles">
            <Panel
              title="Bundles"
              description="The clock, the cycle log and the storm below follow the selected bundle."
            >
              {bundles.isPending ? (
                <div className="grid gap-3 lg:grid-cols-3">
                  <Skeleton className="h-32" />
                  <Skeleton className="h-32" />
                  <Skeleton className="h-32" />
                </div>
              ) : cards.length > 0 ? (
                <ul className="grid gap-3 lg:grid-cols-3">
                  {cards.map((card) => (
                    <li key={card.id} className="min-w-0">
                      <BundleCard
                        bundle={card}
                        selected={card.id === bundleId}
                        onSelect={handleSelect}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title={bundles.isError ? "The bundle list is unavailable" : "No bundles yet"}
                  description={
                    bundles.isError
                      ? bundles.error.message
                      : "Run make bundle BUNDLE=MUM-2019-07-02 to generate the reconstructed replay, then reload."
                  }
                  action={
                    bundles.isError ? (
                      <Button variant="outline" onClick={() => void bundles.refetch()}>
                        Try again
                      </Button>
                    ) : undefined
                  }
                />
              )}
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
