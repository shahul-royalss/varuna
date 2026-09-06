"use client";

import { AppShell } from "@/components/varuna/app-shell";
import { DispatchOrder, type DispatchOrderPlan } from "@/components/varuna/dispatch-order";
import { PageHeader } from "@/components/varuna/page-header";
import { DEFAULT_PUMP_COLUMNS, PumpBoard } from "@/components/varuna/pump-board";
import type { Pump } from "@/components/varuna/pump-card";

/**
 * Pump dispatch board (CLAUDE.md section 7.6). Phase 0 renders the board with the empty
 * inventory and the three chronic hotspots; the greedy optimiser, the benefit estimate and the
 * drag-to-assign interaction arrive in Phase 8.
 */
export function PumpsScreen() {
  // The synthetic inventory ships with the Mumbai city layers (Phase 1), so the board is empty.
  const pumps: Pump[] = [];
  const order: DispatchOrderPlan | null = null;

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-6 p-6">
          <PageHeader
            title="Pump dispatch"
            description="Assign dewatering pumps to the hotspots that will peak first."
            honesty="Synthetic pump inventory"
          />

          <PumpBoard pumps={pumps} columns={DEFAULT_PUMP_COLUMNS} />

          <DispatchOrder order={order} />
        </div>
      </div>
    </AppShell>
  );
}
