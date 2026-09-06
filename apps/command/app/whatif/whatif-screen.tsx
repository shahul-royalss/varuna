"use client";

import { useState } from "react";

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
const NO_DELTAS: DeltaRow[] = [];

const RUN_DISABLED_REASON = "The emulator lands in Phase 7";
const PHYSICS_DISABLED_REASON = "Runs the Twin on the same scenario once Phase 7 lands";

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
                  runDisabledReason={RUN_DISABLED_REASON}
                  physicsDisabledReason={PHYSICS_DISABLED_REASON}
                />
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
                    Scenario ready to run: {scenarioLine(values)}.
                  </p>
                </Panel>
              </PanelErrorBoundary>

              <PanelErrorBoundary title="Hotspot deltas">
                <Panel
                  title="Hotspot deltas"
                  description="Before and after per hotspot, with the minutes each stays impassable."
                  className="min-w-0"
                >
                  <DeltaTable rows={NO_DELTAS} />
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
