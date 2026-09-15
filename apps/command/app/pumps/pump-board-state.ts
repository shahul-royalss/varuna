/**
 * What the pump board shows for one plan (CLAUDE.md 7.6), as a pure function of three things: the
 * plan the API returned, whether the operator has pressed Optimise, and where they have dragged
 * pumps by hand. Kept out of the screen so the rule motion M17 depends on is testable: **a drag moves
 * a card and never a number.**
 */

import type { DispatchOrderPlan } from "@/components/varuna/dispatch-order";
import type { PumpColumn } from "@/components/varuna/pump-board";
import type { Pump } from "@/components/varuna/pump-card";
import type { PumpPlan } from "@/lib/api/pumps";

export interface PumpBoardInputs {
  /** True once Optimise has placed the optimiser's plan on the board. */
  applied: boolean;
  /** Pumps the operator has dragged, over the board as it stood: pump id to column id, or null
   *  for the pool. */
  moved: Readonly<Record<string, string | null>>;
}

export interface PumpBoardState {
  available: Pump[];
  columns: PumpColumn[];
  /** The plan in words; null until Optimise has placed it, since nothing has been decided yet. */
  order: DispatchOrderPlan | null;
}

export function buildPumpBoard(plan: PumpPlan | null, inputs: PumpBoardInputs): PumpBoardState {
  const { applied, moved } = inputs;
  // One column per place the plan sends a pump, worst first. The columns are the targets this
  // cycle floods rather than a fixed three, and they exist before Optimise so the operator can
  // see where the water is and drag a pump there themselves.
  const base = (plan?.assignments ?? []).slice().sort((a, b) => b.minutesSaved - a.minutesSaved);

  const assignment = new Map(base.map((a) => [a.pumpId, a]));

  // Where each pump sits now: the optimiser's target once the plan is applied, the pool before,
  // and the operator's move over either.
  const placed = new Map<string, string | null>();
  for (const pump of plan?.pumps ?? []) {
    placed.set(pump.id, applied ? (assignment.get(pump.id)?.targetId ?? null) : null);
  }
  for (const [pumpId, target] of Object.entries(moved)) placed.set(pumpId, target);

  const cardFor = (pumpId: string): Pump | null => {
    const unit = plan?.pumps.find((p) => p.id === pumpId);
    const planned = assignment.get(pumpId);
    if (!unit && !planned) return null;
    return {
      id: pumpId,
      capacityM3PerHour: unit?.capacityM3PerHour ?? planned?.capacityM3PerHour ?? 0,
      depot: unit?.depot ?? planned?.depot ?? "",
      // The plan is a proposal until Dispatch is pressed, so a placed lorry is still moving.
      status: "moving",
      // The API computed an ETA only for the hotspot the optimiser chose. A pump dragged anywhere
      // else has no route yet, so it says so rather than borrowing that figure.
      etaMinutes: planned && placed.get(pumpId) === planned.targetId ? planned.etaMin : null,
      assignedTo: placed.get(pumpId) ?? undefined,
    };
  };

  const columns: PumpColumn[] = base.map((a) => ({
    id: a.targetId,
    title: a.targetName,
    pumps: [...placed.entries()]
      .filter(([, target]) => target === a.targetId)
      .map(([pumpId]) => cardFor(pumpId))
      .filter((p): p is Pump => p !== null),
    // **The benefit is the optimiser's, for its own plan, and depends only on `applied`.** A drag
    // does not recompute it - that needs the emulator per drop - so a drag must not move it
    // either: rolling a figure to a value nobody computed would be rule 6 in reverse.
    minutesAbove45: { before: a.minutesBefore, after: a.minutesAfter },
  }));

  // A pump whose place is not one of this cycle's columns is in the pool, so no card can vanish.
  const columnIds = new Set(columns.map((c) => c.id));
  const available: Pump[] = (plan?.pumps ?? [])
    .filter((p) => !columnIds.has(placed.get(p.id) ?? ""))
    .map((p) => ({
      id: p.id,
      capacityM3PerHour: p.capacityM3PerHour,
      depot: p.depot,
      status: "available" as const,
      etaMinutes: null,
    }));

  const order: DispatchOrderPlan | null =
    applied && plan?.assignments.length
      ? {
          runId: plan.runId,
          moves: plan.assignments.map((a) => ({
            id: a.pumpId,
            pumpId: a.pumpId,
            from: a.depot,
            to: a.targetName,
            etaMinutes: a.etaMin,
            minutesAvoided: a.minutesSaved,
          })),
        }
      : null;

  return { available, columns, order };
}
