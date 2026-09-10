"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/varuna/app-shell";
import { DispatchOrder, type DispatchOrderPlan } from "@/components/varuna/dispatch-order";
import { PageHeader } from "@/components/varuna/page-header";
import { PumpBoard, type PumpColumn } from "@/components/varuna/pump-board";
import type { Pump } from "@/components/varuna/pump-card";
import { loadPumpPlan, type PumpPlan } from "@/lib/api/pumps";

/**
 * Pump dispatch board (CLAUDE.md section 7.6, tasks P8.9 and P8.10).
 *
 * The plan is computed when the cycle runs, so the board, the alert queue and the map are all
 * describing one forecast. Two honesty labels ride on every number here and both come from the
 * API rather than being asserted by this file: the inventory is synthetic, and the benefit is a
 * bathtub estimate rather than a physics run (`varuna_products.pumps` states the model in full).
 */
export function PumpsScreen() {
  const [plan, setPlan] = useState<PumpPlan | null>(null);
  const [dispatched, setDispatched] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    loadPumpPlan(undefined, controller.signal)
      .then(setPlan)
      .catch(() => setPlan(null));
    return () => controller.abort();
  }, []);

  // One column per place a pump was sent, worst first. The board's Phase 0 placeholder listed
  // three fixed hotspots; the real plan targets whatever this cycle floods, which on most
  // cycles is not the chronic register at all.
  const assigned = new Set(plan?.assignments.map((a) => a.pumpId) ?? []);
  const columns: PumpColumn[] = (plan?.assignments ?? [])
    .slice()
    .sort((a, b) => b.minutesSaved - a.minutesSaved)
    .map((a) => ({
      id: a.targetId,
      title: a.targetName,
      pumps: [
        {
          id: a.pumpId,
          capacityM3PerHour: a.capacityM3PerHour,
          depot: a.depot,
          // The plan is a proposal until Dispatch is pressed, so the lorry is still moving.
          status: "moving" as const,
          etaMinutes: a.etaMin,
          assignedTo: a.targetName,
        },
      ],
      minutesAbove45: { before: a.minutesBefore, after: a.minutesAfter },
    }));

  const available: Pump[] = (plan?.pumps ?? [])
    .filter((p) => !assigned.has(p.id))
    .map((p) => ({
      id: p.id,
      capacityM3PerHour: p.capacityM3PerHour,
      depot: p.depot,
      status: "available" as const,
      etaMinutes: null,
    }));

  const order: DispatchOrderPlan | null = plan?.assignments.length
    ? {
        runId: plan.runId,
        moves: plan.assignments.map((a) => ({
          id: `${a.pumpId}-${a.targetId}`,
          pumpId: a.pumpId,
          from: a.depot,
          to: a.targetName,
          etaMinutes: a.etaMin,
          minutesAvoided: a.minutesSaved,
        })),
      }
    : null;

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-6 p-6">
          <PageHeader
            title="Pump dispatch"
            description={
              plan
                ? `${plan.assignments.length} of ${plan.pumps.length} pumps assigned, saving about ${plan.totalMinutesSaved} minutes above ${plan.thresholdCm} cm.`
                : "Assign dewatering pumps to the hotspots that will peak first."
            }
            honesty="Synthetic pump inventory"
          />

          {plan?.benefitLabel ? (
            <p className="type-micro text-text-3">
              Benefit: {plan.benefitLabel}. A pump lowers the ponded depth over its 45 m
              neighbourhood at its rated capacity; the emulator replaces this in Phase 7.
            </p>
          ) : null}

          <PumpBoard
            pumps={available}
            columns={columns}
            onDispatch={
              order
                ? () => {
                    setDispatched(true);
                    toast("Pumps dispatched");
                  }
                : undefined
            }
          />

          <DispatchOrder order={order} />

          {dispatched ? (
            <p className="type-micro text-text-3">
              Dispatch is recorded in this session only. A real order goes out with the alert
              channels, which are a dashboard render and an on-screen phone mock in the
              prototype.
            </p>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
