"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/varuna/app-shell";
import { BundleCard, type BundleKind, type BundleSummary } from "@/components/varuna/bundle-card";
import { CycleBudgetBar } from "@/components/varuna/cycle-budget-bar";
import { CycleLog, type CycleLogRow } from "@/components/varuna/cycle-log";
import { EmptyState } from "@/components/varuna/empty-state";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import { RADAR_FRAMES_MEMBER } from "@/components/varuna/radar-preview";
import { ReplayPanel } from "@/components/varuna/replay-panel";
import { Skeleton } from "@/components/varuna/skeleton";
import {
  StormDesigner,
  type DesignStormHyetograph,
  type StormCell,
} from "@/components/varuna/storm-designer";
import { useReplayBundles, useReplayControls, type ReplayBundle } from "@/lib/api";
import { apiUrl } from "@/lib/api/client";
import { useRadarPreview } from "@/lib/api/replay";
import { bundleWindowLabel } from "@/lib/format";
import { useReplayStore } from "@/lib/stores/replay";
import { useUiStore } from "@/lib/stores/ui";

/** Cycle rows arrive from the run registry once a bundle is baked. */
/** Stages a baked cycle ran. The run summary carries the total, not the per-stage split, so this
 * names what ran rather than claiming a timing the endpoint did not return. */
const BAKED_STAGES = "decode, sky, twin, pulse, products";

/** A finite number, or undefined: the radar index is read as loose JSON, so nothing is assumed. */
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The convective cells of `GET /v1/replay/bundles/{id}/radar`, in the table's own units.
 *
 * The API converts them (minutes to IST, the design CRS to lon/lat, components to a speed,
 * and the peak through `intensity_scale`), so nothing is recomputed here. A row that is not
 * complete is dropped rather than shown with a blank cell.
 */
function toStormCells(value: unknown): StormCell[] {
  if (!Array.isArray(value)) return [];
  const cells: StormCell[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) continue;
    const cell = row as Record<string, unknown>;
    const lifetimeMin = finite(cell.lifetime_min);
    const startLat = finite(cell.start_lat);
    const startLon = finite(cell.start_lon);
    const velocityMs = finite(cell.velocity_ms);
    const sigmaKm = finite(cell.sigma_km);
    const peakMmH = finite(cell.peak_mm_h);
    if (typeof cell.id !== "string" || typeof cell.birth !== "string") continue;
    if (
      lifetimeMin === undefined ||
      startLat === undefined ||
      startLon === undefined ||
      velocityMs === undefined ||
      sigmaKm === undefined ||
      peakMmH === undefined
    ) {
      continue;
    }
    cells.push({
      id: cell.id,
      birth: cell.birth,
      lifetimeMin,
      startLat,
      startLon,
      velocityMs,
      sigmaKm,
      peakMmH,
    });
  }
  return cells;
}

/** The Chicago hyetograph a design storm carries instead of cells; absent on a replay. */
function toDesignStorm(value: unknown): DesignStormHyetograph | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const storm = value as Record<string, unknown>;
  const stepMin = finite(storm.step_min);
  const totalDepthMm = finite(storm.total_depth_mm);
  const peakPositionR = finite(storm.peak_position_r);
  const blocksMmH = Array.isArray(storm.blocks_mm_h)
    ? storm.blocks_mm_h.map(finite).filter((block): block is number => block !== undefined)
    : [];
  if (stepMin === undefined || totalDepthMm === undefined || peakPositionR === undefined) {
    return undefined;
  }
  if (blocksMmH.length === 0) return undefined;
  return { stepMin, blocksMmH, totalDepthMm, peakPositionR };
}

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
  // **The cycle log reads the run registry.** It was hard-wired to an empty array, so the panel
  // said "No cycles yet - press Play" over a bundle with seven baked cycles sitting on disk. Every
  // row here is a run that exists, with its own mass-balance error and wall-clock.
  const [cycles, setCycles] = useState<CycleLogRow[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    // `city=all`, because the log follows the *bundle* rather than the configured city - the
    // Chennai design storm is selectable here too.
    fetch(apiUrl("/v1/runs?city=all&limit=200"), { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((body: { runs?: Record<string, unknown>[] }) =>
        setCycles(
          (body.runs ?? [])
            .filter((run) => !bundleId || run.bundle === bundleId)
            .map((run) => ({
              time: String(run.cycle_ts ?? ""),
              stages: BAKED_STAGES,
              ms: Number(run.total_ms ?? 0),
              massBalance:
                run.mass_balance_err === null || run.mass_balance_err === undefined
                  ? null
                  : Number(run.mass_balance_err),
            }))
            // Oldest first: the log reads as the morning, top to bottom.
            .sort((a, b) => a.time.localeCompare(b.time)),
        ),
      )
      .catch(() => setCycles([]));
    return () => controller.abort();
  }, [bundleId]);

  const selected = cards.find((card) => card.id === bundleId);
  // The designer needs the manifest row itself, not the card: the radar preview decides whether to
  // fetch from the members `make bundle` has actually written.
  const selectedBundle = bundles.data?.find((bundle) => bundle.id === bundleId);

  // The same index the preview animates, so the cell table costs a cache hit and never a second
  // request: it carries the storm the frames were generated from (CLAUDE.md section 7.8).
  const hasCube =
    (selectedBundle?.built ?? false) &&
    !(selectedBundle?.missing_members ?? []).includes(RADAR_FRAMES_MEMBER);
  const radar = useRadarPreview(selected?.id ?? bundleId, { enabled: hasCube });
  const stormCells = useMemo(() => toStormCells(radar.data?.cells), [radar.data]);
  const designStorm = useMemo(() => toDesignStorm(radar.data?.design_storm), [radar.data]);

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
                    <CycleLog rows={cycles} />
                  </div>
                </Panel>
              </PanelErrorBoundary>

              <PanelErrorBoundary title="Storm designer">
                <Panel
                  title="Storm designer"
                  description="The convective cells the bundle was generated from, and the radar preview."
                >
                  <StormDesigner
                    cells={stormCells}
                    designStorm={designStorm}
                    bundleId={selected?.id ?? bundleId}
                    built={selectedBundle?.built ?? false}
                    missingMembers={selectedBundle?.missing_members ?? []}
                  />
                </Panel>
              </PanelErrorBoundary>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
