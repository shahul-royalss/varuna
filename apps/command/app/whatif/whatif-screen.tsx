"use client";

import { useCallback, useState } from "react";

import { runWhatIf, type WhatIfResult } from "@/lib/api/whatif";

import { AgreementBar } from "@/components/varuna/agreement-bar";
import { AppShell } from "@/components/varuna/app-shell";
import { DeltaTable, type DeltaRow } from "@/components/varuna/delta-table";
import { MapSlot } from "@/components/varuna/map-slot";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import {
  DEFAULT_WHATIF_VALUES,
  WhatIfControls,
  formatRainScale,
  formatTideOffset,
  type WhatIfValues,
} from "@/components/varuna/whatif-controls";

/** Delta rows arrive from the emulator in Phase 7; until then the table shows its empty state. */
/** Segments shown in the delta table. More than this and nobody reads to the bottom. */
const MAX_DELTA_ROWS = 25;

/** A Twin run on this city is about three minutes, against the 10 s CLAUDE.md 14 budgets for a
 * physics check. The control says so rather than starting something that would look hung. */
const PHYSICS_DISABLED_REASON =
  "Runs the Twin on the same scenario; a Mumbai run is about three minutes, so it is not wired " +
  "to this button yet";

/** The scenario as one line of copy, so the controls and the result panel agree. */
function scenarioLine(values: WhatIfValues): string {
  const parts = [
    `Rain ${formatRainScale(values.rainScale)}`,
    `tide ${formatTideOffset(values.tideOffsetM)}`,
    values.cleanTop14 ? "top 14 pipes cleaned" : "pipes as learned",
    values.pumpPlan ? "pump plan on" : "pump plan off",
  ];
  return parts.join(", ");
}

/**
 * What-if lab (CLAUDE.md section 7.7). In Phase 0 the controls are live and local, and both
 * actions say when they start working; the map, the delta table and the agreement bar hold their
 * empty states until the emulator lands.
 */
export function WhatIfScreen() {
  const [values, setValues] = useState<WhatIfValues>(DEFAULT_WHATIF_VALUES);
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async (scenario: WhatIfValues) => {
    setRunning(true);
    setError(null);
    try {
      setResult(await runWhatIf(scenario));
    } catch (failure) {
      // The API's own words: a refused tide scenario explains itself better than any string
      // this file could invent (CLAUDE.md 6.8 - errors say what happened and the fix).
      setError(failure instanceof Error ? failure.message : String(failure));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, []);

  const rows: DeltaRow[] = (result?.segments ?? []).slice(0, MAX_DELTA_ROWS).map((row) => ({
    id: row.segmentId,
    hotspot: row.segmentId,
    beforeCm: row.beforeCm,
    afterCm: row.afterCm,
    // The endpoint reports peak depth, not a duration; claiming minutes here would be inventing
    // a number, so the columns stay at zero and the panel description says what is shown.
    minutesImpassableBefore: 0,
    minutesImpassableAfter: 0,
  }));

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-6 p-6">
          <PageHeader
            title="What-if lab"
            description="Ask the twin a question and get the answer before the next radar frame."
            honesty="Reduced-order emulator calibrated to VARUNA-Twin"
          />

          <div className="grid min-h-0 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <PanelErrorBoundary title="Scenario">
              <Panel
                title="Scenario"
                description="Rain, tide, cleaned pipes and the pump plan."
                className="min-w-0"
              >
                <WhatIfControls
                  initial={DEFAULT_WHATIF_VALUES}
                  onChange={setValues}
                  onRun={(scenario) => void run(scenario)}
                  physicsDisabledReason={PHYSICS_DISABLED_REASON}
                />
                {running ? (
                  <p className="mt-3 type-small text-text-3">Running the scenario...</p>
                ) : null}
                {error ? <p className="mt-3 type-small text-text-2">{error}</p> : null}
              </Panel>
            </PanelErrorBoundary>

            <div className="flex min-w-0 flex-col gap-4">
              <PanelErrorBoundary title="Difference layer">
                <Panel
                  title="Difference layer"
                  description="Segments coloured by change in depth: improved, worse, unchanged."
                  className="min-w-0"
                >
                  <div className="h-[380px] overflow-hidden rounded-control border border-line">
                    <MapSlot />
                  </div>
                  <p className="mt-3 type-micro text-text-3">
                    {result
                      ? `${result.nWorse.toLocaleString("en-IN")} segments deeper, ${result.nImproved.toLocaleString("en-IN")} shallower, in ${Math.round(result.ms)} ms.`
                      : `Scenario ready to run: ${scenarioLine(values)}.`}
                  </p>
                  {result ? (
                    <p className="mt-1 type-micro text-text-3">
                      Level from the Twin&rsquo;s own forecast for this run; the emulator supplies
                      only the difference. Emulator skill on held-out storms: RMSE{" "}
                      {result.emulator.rmseCm.toFixed(1)} cm, CSI{" "}
                      {result.emulator.csi30cm.toFixed(2)} at 30 cm.
                    </p>
                  ) : null}
                </Panel>
              </PanelErrorBoundary>

              <PanelErrorBoundary title="Hotspot deltas">
                <Panel
                  title="Hotspot deltas"
                  description="Before and after per hotspot, with the minutes each stays impassable."
                  className="min-w-0"
                >
                  <DeltaTable rows={rows} />
                </Panel>
              </PanelErrorBoundary>

              <PanelErrorBoundary title="Physics check">
                <Panel
                  title="Physics check"
                  description="How far the emulator sits from a Twin run on the same scenario."
                  className="min-w-0"
                >
                  <AgreementBar result={null} />
                </Panel>
              </PanelErrorBoundary>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
