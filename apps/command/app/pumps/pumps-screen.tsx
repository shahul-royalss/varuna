"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/varuna/app-shell";
import { CyclePicker } from "@/components/varuna/cycle-picker";
import { DispatchOrder } from "@/components/varuna/dispatch-order";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PhoneMock, type PhoneMessage } from "@/components/varuna/phone-mock";
import { PumpBoard } from "@/components/varuna/pump-board";
import { describeRefusal, dispatchPumps, opsRefusal, readPassphrase } from "@/lib/api/ops";
import { loadPumpPlan, pricePumpPlacements, type PricedPlan, type PumpPlan } from "@/lib/api/pumps";

import { boardPlacements, buildPumpBoard, placementsKey } from "./pump-board-state";

/** The tab holds no passphrase: nothing is recorded, and the screen says where it is entered. */
const NO_PASSPHRASE =
  "This tab holds no desk passphrase. Enter it on the authority desk, then come back.";

/** What a dispatch put on the ward officer's phone, and the sentence each alert now carries. */
interface Dispatched {
  messages: PhoneMessage[];
  instructions: string[];
  notes: string[];
}

/**
 * Pump dispatch board (CLAUDE.md section 7.6, tasks P8.9 and P8.10).
 *
 * **The board opens with every pump in the pool.** Optimise places the plan the optimiser
 * computed when the cycle ran: the cards fly to their hotspots and each column's minutes above
 * 45 cm roll from the no-pump figure to the plan's (motion M17).
 *
 * **A drag is priced, not left stale** (7.6 AC2). Moving a pump sends the board as it now stands
 * to `POST /v1/pumps/price`, which runs the same model and arithmetic as the optimiser - the
 * Flash-lite emulator with the pump's outflow when the run carries its storm - and the columns
 * roll to that answer. Until it arrives the figures stay where they were and the screen says the
 * board is being priced; a drag never moves a number by itself.
 *
 * **Dispatch** (7.6 AC4) goes through the desk's gated client: the order is recorded in the ops
 * log, every alert about a dispatched place carries "Pump P-05 dispatched." from then on, and the
 * ward officer's phone mock shows the message. No lorry moves - the inventory is synthetic, and
 * the header says so.
 */
export function PumpsScreen() {
  const [plan, setPlan] = useState<PumpPlan | null>(null);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [applied, setApplied] = useState(false);
  const [moved, setMoved] = useState<Record<string, string | null>>({});
  // The last price the API returned, with the board it priced; drawn only while that board is
  // still the one on screen.
  const [price, setPrice] = useState<{ key: string; plan: PricedPlan } | null>(null);
  const [priceError, setPriceError] = useState<{ key: string; message: string } | null>(null);
  const [dispatched, setDispatched] = useState<Dispatched | null>(null);
  const [dispatching, setDispatching] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    loadPumpPlan(runId, controller.signal)
      .then(setPlan)
      .catch(() => setPlan(null));
    return () => controller.abort();
  }, [runId]);

  // Picking a cycle is picking a different plan, so the operator's overrides go with it.
  const pickCycle = useCallback((next: string) => {
    setRunId(next);
    setMoved({});
    setDispatched(null);
  }, []);

  const movedCount = Object.keys(moved).length;
  const placements = useMemo(
    () => boardPlacements(plan, { applied, moved }),
    [plan, applied, moved],
  );
  const key = placementsKey(placements);

  // Re-price whenever the operator has changed the board by hand. The answer is kept with the
  // placements it was asked about, so a slow answer for an older board is never drawn.
  useEffect(() => {
    if (!plan || movedCount === 0) return;
    const controller = new AbortController();
    pricePumpPlacements({ runId: plan.runId, placements }, controller.signal)
      .then((priced) => setPrice({ key, plan: priced }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPriceError({
          key,
          message:
            error instanceof Error
              ? `The board could not be priced: ${error.message}`
              : "The board could not be priced.",
        });
      });
    return () => controller.abort();
  }, [plan, movedCount, placements, key]);

  const priced = movedCount > 0 && price?.key === key ? price.plan : null;
  const failed = movedCount > 0 && priceError?.key === key ? priceError.message : null;
  const pricing = movedCount > 0 && !priced && !failed;

  const { available, columns, order } = buildPumpBoard(plan, { applied, moved, priced });
  const hasPlan = Boolean(plan?.assignments.length);
  const canOptimise = hasPlan && (!applied || movedCount > 0);
  // The API dispatches what the optimiser assigns, not a board arranged by hand: a hand-made
  // plan is priced here, and put back with Optimise before it is sent.
  const canDispatch = Boolean(order) && applied && movedCount === 0 && !dispatching;

  const dispatch = useCallback(async () => {
    if (!plan) return;
    if (!readPassphrase()) {
      toast("Dispatched nothing", { description: NO_PASSPHRASE });
      return;
    }
    setDispatching(true);
    try {
      const done = await dispatchPumps({ runId: plan.runId, user: "control room" });
      setDispatched({
        messages: done.phoneMessages.map((m, i) => ({
          // No time on the bubble: the order was given now, on the wall clock, and the phone's
          // status bar reads the replay's 2019 clock - two clocks on one card read as one.
          id: m.alertId ?? `${m.hotspotId}-${i}`,
          text: m.text,
        })),
        instructions: done.alertInstructions,
        notes: done.notes,
      });
      toast("Pumps dispatched", {
        description: `${done.orders.length} orders recorded in the ops log. The inventory is synthetic, so no lorry moves.`,
      });
    } catch (error) {
      toast("Not dispatched", { description: describeRefusal(opsRefusal(error)) });
    } finally {
      setDispatching(false);
    }
  }, [plan]);

  const total = priced ? priced.totalMinutesSaved : plan?.totalMinutesSaved;
  const label = priced ? priced.benefitLabel : plan?.benefitLabel;

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

          {label ? (
            <p className="type-micro text-text-3">
              Benefit: {label}.{" "}
              {priced
                ? `The board as arranged saves about ${total} minutes above 45 cm, priced in ${priced.priceMs} ms.`
                : "The optimiser's figures, computed when the cycle ran."}
            </p>
          ) : null}

          <PumpBoard
            pumps={available}
            columns={columns}
            planApplied={applied || priced !== null}
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
            onDispatch={canDispatch ? () => void dispatch() : undefined}
          />

          {movedCount > 0 ? (
            <p className="type-micro text-text-2" role="status">
              {movedCount} pump{movedCount === 1 ? " has" : "s have"} been moved by hand.{" "}
              {pricing
                ? "Pricing the board as arranged through the same model the optimiser uses."
                : failed
                  ? `${failed} The figures above are still the optimiser's for its own plan.`
                  : "The figures above are the board as arranged, priced by the API."}{" "}
              Dispatch sends the optimiser&rsquo;s plan: press Optimise to put it back first.
            </p>
          ) : null}

          {priced?.refused.length ? (
            <ul className="type-micro text-text-3 flex flex-col gap-1">
              {priced.refused.map((r) => (
                <li key={`${r.pumpId}-${r.targetId}`}>{r.reason}</li>
              ))}
            </ul>
          ) : null}

          <DispatchOrder order={order} />

          {dispatched ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
              <Panel
                title="Alert instruction"
                description="What each alert about a dispatched place now says, on /alerts and the phone."
              >
                <ul className="flex flex-col gap-2">
                  {dispatched.instructions.map((line, i) => (
                    <li key={`${line}-${i}`} className="type-body text-text">
                      {line}
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-col gap-1">
                  {dispatched.notes.map((note) => (
                    <p key={note} className="type-micro text-text-3">
                      {note}
                    </p>
                  ))}
                </div>
              </Panel>
              <Panel
                title="Ward officer's phone"
                description="The WhatsApp card the dispatch produced. On-screen mock."
              >
                <PhoneMock
                  messages={dispatched.messages}
                  freshIds={new Set(dispatched.messages.map((m) => m.id))}
                  popKey={1}
                />
              </Panel>
            </div>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
