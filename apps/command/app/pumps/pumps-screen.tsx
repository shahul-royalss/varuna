"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/varuna/app-shell";
import { DispatchOrder } from "@/components/varuna/dispatch-order";
import { PageHeader } from "@/components/varuna/page-header";
import { PumpBoard } from "@/components/varuna/pump-board";
import { CyclePicker } from "@/components/varuna/cycle-picker";
import { loadPumpPlan, type PumpPlan } from "@/lib/api/pumps";

import { buildPumpBoard } from "./pump-board-state";

/**
 * Pump dispatch board (CLAUDE.md section 7.6, tasks P8.9 and P8.10).
 *
 * The plan is computed when the cycle runs, so the board, the alert queue and the map are all
 * describing one forecast. Two honesty labels ride on every number here and both come from the
 * API rather than being asserted by this file: the inventory is synthetic, and the benefit is a
 * bathtub estimate rather than a physics run (`varuna_products.pumps` states the model in full).
 *
 * **The board opens with every pump in the pool.** Optimise places the optimiser's plan: the
 * cards fly to their hotspots and each column's minutes above 45 cm roll from the no-pump figure
 * to the plan's (motion M17). Both figures are the API's; the optimiser ran when the cycle did,
 * for exactly this starting state, so Optimise places its answer rather than re-deriving it.
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
  // True once Optimise has placed the plan. It survives a cycle pick, so picking another cycle
  // with the plan on the board flies the cards to that cycle's plan and rolls its figures.
  const [applied, setApplied] = useState(false);
  // Where the operator has moved a pump, over the board as it stands. `null` means they pulled
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

  const { available, columns, order } = buildPumpBoard(plan, { applied, moved });
  const movedCount = Object.keys(moved).length;
  const hasPlan = Boolean(plan?.assignments.length);
  // Optimise has something to do until the plan is on the board exactly as computed.
  const canOptimise = hasPlan && (!applied || movedCount > 0);

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-6 p-6">
          <PageHeader
            title="Pump dispatch"
            description={
              plan
                ? `${plan.assignments.length} of ${plan.pumps.length} pumps assigned by the optimiser, saving about ${plan.totalMinutesSaved} minutes above ${plan.thresholdCm} cm.`
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
            planApplied={applied}
            onOptimise={
              canOptimise
                ? () => {
                    setApplied(true);
                    setMoved({});
                  }
                : undefined
            }
            onAssign={
              plan
                ? (pumpId, columnId) => setMoved((current) => ({ ...current, [pumpId]: columnId }))
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

          {movedCount > 0 ? (
            <p className="type-micro text-text-2">
              {movedCount} pump{movedCount === 1 ? " has" : "s have"} been moved by hand.{" "}
              {applied
                ? "The minutes-saved figures above are still the optimiser’s for its own plan; "
                : "The minutes above 45 cm are still the forecast with no pump sent; "}
              recomputing a benefit per drop needs the 50-member emulator. Press Optimise to place
              the computed plan.
            </p>
          ) : null}

          <DispatchOrder order={order} />

          {dispatched ? (
            <p className="type-micro text-text-3">
              Dispatch is recorded in this session only. A real order goes out with the alert
              channels, which are a dashboard render and an on-screen phone mock in the prototype.
            </p>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
