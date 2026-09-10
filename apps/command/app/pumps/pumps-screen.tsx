"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/varuna/app-shell";
import { DispatchOrder, type DispatchOrderPlan } from "@/components/varuna/dispatch-order";
import { PageHeader } from "@/components/varuna/page-header";
import { PumpBoard, type PumpColumn } from "@/components/varuna/pump-board";
import type { Pump } from "@/components/varuna/pump-card";
import { CyclePicker } from "@/components/varuna/cycle-picker";
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
  // **Which cycle.** The board used to load whichever run was newest, which on the baked bundle
  // is 09:10 IST - after the storm, when one pump is worth sending. The storm's own peak at
  // 08:40 assigns all twelve and avoids 925 minutes above 45 cm. Neither is the "right" cycle to
  // hard-code: the operator picks, the same way they do on the console, and the row of cycles is
  // itself the story of the morning.
  const [runId, setRunId] = useState<string | undefined>(undefined);
  // Where the operator has moved a pump, over the optimiser's own plan. `null` means they pulled
  // it back to the pool.
  const [moved, setMoved] = useState<Record<string, string | null>>({});

  useEffect(() => {
    const controller = new AbortController();
    loadPumpPlan(runId, controller.signal)
      .then(setPlan)
      .catch(() => setPlan(null));
    return () => controller.abort();
  }, [runId]);

  // Picking a cycle is picking a different plan, so the operator's overrides go with it: keeping
  // them would put pumps on hotspots this cycle does not have. Done here rather than in the fetch
  // effect, because it is a consequence of the *choice*, not of the request.
  const pickCycle = useCallback((next: string) => {
    setRunId(next);
    setMoved({});
  }, []);

  // One column per place a pump was sent, worst first. The board's Phase 0 placeholder listed
  // three fixed hotspots; the real plan targets whatever this cycle floods, which on most
  // cycles is not the chronic register at all.
  // The optimiser's plan, with the operator's moves applied over it. The columns are the
  // targets the *plan* chose - a hotspot nobody was sent to has no column to drop onto, which is
  // correct: the board dispatches to places this cycle floods, not to a fixed three.
  const columns: PumpColumn[] = (() => {
    const base = (plan?.assignments ?? []).slice().sort((a, b) => b.minutesSaved - a.minutesSaved);
    const cards = new Map(
      base.map((a) => [
        a.pumpId,
        {
          id: a.pumpId,
          capacityM3PerHour: a.capacityM3PerHour,
          depot: a.depot,
          // The plan is a proposal until Dispatch is pressed, so the lorry is still moving.
          status: "moving" as const,
          etaMinutes: a.etaMin,
          assignedTo: a.targetName,
        },
      ]),
    );
    for (const pump of plan?.pumps ?? []) {
      if (cards.has(pump.id)) continue;
      cards.set(pump.id, {
        id: pump.id,
        capacityM3PerHour: pump.capacityM3PerHour,
        depot: pump.depot,
        status: "moving" as const,
        etaMinutes: 0,
        assignedTo: "",
      });
    }

    // Where each pump sits now: the optimiser's target unless the operator moved it.
    const placed = new Map<string, string | null>();
    for (const a of base) placed.set(a.pumpId, a.targetId);
    for (const [pumpId, target] of Object.entries(moved)) placed.set(pumpId, target);

    return base.map((a) => ({
      id: a.targetId,
      title: a.targetName,
      pumps: [...placed.entries()]
        .filter(([, target]) => target === a.targetId)
        .map(([pumpId]) => cards.get(pumpId))
        .filter((p): p is NonNullable<typeof p> => Boolean(p)),
      // **The benefit is the optimiser's, and it stops being true the moment a pump is moved.**
      // Recomputing it needs the emulator per drop (P7.6); until then the number is shown for
      // the plan as computed and the note below the board says a moved pump invalidates it.
      // Printing a recomputed-looking figure this screen had guessed would be rule 6 in reverse.
      minutesAbove45: { before: a.minutesBefore, after: a.minutesAfter },
    }));
  })();

  const assignedNow = new Set(
    columns.flatMap((c) => c.pumps.map((p) => p.id)),
  );

  const available: Pump[] = (plan?.pumps ?? [])
    .filter((p) => !assignedNow.has(p.id))
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

          <CyclePicker currentRunId={plan?.runId ?? runId} onPick={pickCycle} />

          {plan?.benefitLabel ? (
            <p className="type-micro text-text-3">
              Benefit: {plan.benefitLabel}. A pump lowers the ponded depth over its 45 m
              neighbourhood at its rated capacity; the emulator replaces this in Phase 7.
            </p>
          ) : null}

          <PumpBoard
            pumps={available}
            columns={columns}
            onOptimise={Object.keys(moved).length > 0 ? () => setMoved({}) : undefined}
            onAssign={
              plan
                ? (pumpId, columnId) =>
                    setMoved((current) => ({ ...current, [pumpId]: columnId }))
                : undefined
            }
            onDispatch={
              order
                ? () => {
                    setDispatched(true);
                    toast("Pumps dispatched");
                  }
                : undefined
            }
          />

          {Object.keys(moved).length > 0 ? (
            <p className="type-micro text-text-2">
              {Object.keys(moved).length} pump
              {Object.keys(moved).length === 1 ? " has" : "s have"} been moved by hand. The
              minutes-saved figures above are still the optimiser&rsquo;s for its own plan;
              recomputing a benefit per drop needs the 50-member emulator. Press Optimise to go
              back to the computed plan.
            </p>
          ) : null}

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
