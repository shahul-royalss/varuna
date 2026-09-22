"use client";

import { BellOff, ListTree, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AlertCard, type AlertSummary } from "@/components/varuna/alert-card";
import {
  ALERT_LEVELS,
  ALERT_LEVEL_LABELS,
  AlertLevelChip,
  type AlertLevel,
} from "@/components/varuna/alert-level-chip";
import { AppShell } from "@/components/varuna/app-shell";
import { CapViewer } from "@/components/varuna/cap-viewer";
import { CyclePicker } from "@/components/varuna/cycle-picker";
import { DeliveryLog } from "@/components/varuna/delivery-log";
import { EmptyState } from "@/components/varuna/empty-state";
import { EscalationMatrix } from "@/components/varuna/escalation-matrix";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PhoneMock, type PhoneMessage } from "@/components/varuna/phone-mock";
import { Skeleton } from "@/components/varuna/skeleton";
import { alertIdentities, alertIdentity, freshAlertIds } from "@/lib/alert-identity";
import { formatIst } from "@/lib/format";
import {
  loadAlerts,
  loadCap,
  loadDelivery,
  loadEscalation,
  loadSender,
  nextEscalation,
  persistenceUnit,
  type AlertSet,
  type DeliveryLog as DeliveryLogData,
  type EscalationStep,
  type RunAlert,
  type SenderStatus,
} from "@/lib/api/alerts";
import {
  describeRefusal,
  opsRefusal,
  postAlertAction,
  readPassphrase,
  sendAlertToPhone,
} from "@/lib/api/ops";
import { useAlertChime } from "@/lib/sound";

/** What each level's queue says while nothing is raised (CLAUDE.md section 11.10). */
const QUEUE_EMPTY_HINT: Record<AlertLevel, string> = {
  severe:
    "Severe raises when P(> 45 cm) stays at or above 0.6 for two cycles. Press Play on the replay to fill the queue.",
  moderate:
    "Moderate raises when P(> 30 cm) stays at or above 0.6 for two cycles. Press Play on the replay to fill the queue.",
  watch:
    "Watch raises when P(> 15 cm) stays at or above 0.6 for two cycles. Press Play on the replay to fill the queue.",
};

/** The tab holds no passphrase: the act is not sent, and the screen says where it is entered. */
const NO_PASSPHRASE =
  "This tab holds no desk passphrase. Enter it on the authority desk, then come back.";

const NO_FRESH: ReadonlySet<string> = new Set();

/** The phone's text for an alert: headline, instruction and any pumps the desk sent there. */
function phoneText(alert: RunAlert): string {
  return [alert.headline, alert.instruction, alert.dispatchNote]
    .filter((part): part is string => Boolean(part))
    .join(". ")
    .replace(/\.\./g, ".");
}

/**
 * Alert centre (CLAUDE.md section 7.5). Three columns: the queue grouped by level, the CAP 1.2
 * document of the selected alert, and the ward officer's phone with the delivery log; the
 * escalation matrix from `config/escalation.yaml` underneath.
 *
 * **The hysteresis is across cycles** (CLAUDE.md 11.10): a level raises after two consecutive
 * cycles at P >= 0.6 and clears at P <= 0.3, and each card says when it was raised and for how
 * many cycles it has held. What crossed once and raises next cycle if it holds is listed under the
 * queue, as is what this cycle cleared. A run baked before the rule is labelled as such.
 *
 * **Every state here is the API's.** Acknowledge and escalate go through the desk's gated client
 * and the queue is read again, so a reload shows the same thing (7.5 AC4). "Send to my phone"
 * exists only when the API reports a configured sender (7.5 AC3); the delivery log lists the mock
 * renders as renders and a real send only when the API recorded one.
 *
 * Motion M16: when a cycle brings alerts the queue did not show a moment ago, those cards slide
 * in, the phone pops them and shakes once, and the chime plays if sound is on. "New" is decided
 * by `freshAlertIds` on the cycle-independent identity (scope, place, level), because alert ids
 * carry the run and would call every card new on every cycle.
 */
export function AlertsScreen() {
  const [set, setSet] = useState<AlertSet | null>(null);
  const raised = useMemo(() => set?.alerts ?? [], [set]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [capXml, setCapXml] = useState<string | null>(null);
  // Bumped after a write, to re-read the queue. The desk's state is the API's, never this
  // screen's: a local boolean was the old behaviour and it vanished on reload (B1).
  const [reload, setReload] = useState(0);
  // **Which cycle.** An alert is a statement about a forecast, so it only means anything beside
  // the run that raised it. The operator picks the cycle here as they do on the console.
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const shownRef = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NO_FRESH);
  const [batch, setBatch] = useState(0);
  const [queueRunId, setQueueRunId] = useState<string | undefined | null>(null);

  const [steps, setSteps] = useState<EscalationStep[] | null>(null);
  const [stepsError, setStepsError] = useState<string | null>(null);
  const [sender, setSender] = useState<SenderStatus | null>(null);
  const [delivery, setDelivery] = useState<DeliveryLogData | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    loadAlerts(runId, controller.signal)
      .then((next) => {
        const alerts = next?.alerts ?? [];
        const nextFresh = freshAlertIds(shownRef.current, alerts);
        shownRef.current = alertIdentities(alerts);
        setSet(next);
        setQueueRunId(runId);
        setFresh(nextFresh);
        if (nextFresh.size > 0) setBatch((current) => current + 1);
      })
      .catch(() => {
        // A superseded request is not an empty queue: treating it as one would make every alert
        // of the next cycle look new.
        if (controller.signal.aborted) return;
        if (shownRef.current !== null) shownRef.current = new Set();
        setSet(null);
        setQueueRunId(runId);
        setFresh(NO_FRESH);
      });
    return () => controller.abort();
  }, [runId, reload]);

  // The delivery log moves with the queue: a new cycle, an acknowledgement or a real send.
  useEffect(() => {
    const controller = new AbortController();
    // The worst four alerts: three renders each, plus any real send. A log of sixty alerts is
    // one nobody reads, and the queue beside it already lists every alert.
    loadDelivery(runId, controller.signal, 4)
      .then((log) => {
        setDelivery(log);
        setDeliveryError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDelivery(null);
        setDeliveryError(
          error instanceof Error
            ? `The delivery log could not be read: ${error.message}`
            : "The delivery log could not be read.",
        );
      });
    return () => controller.abort();
  }, [runId, reload]);

  // The matrix and the sender are configuration: read once.
  useEffect(() => {
    const controller = new AbortController();
    loadEscalation(controller.signal)
      .then(setSteps)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStepsError(
          error instanceof Error
            ? `config/escalation.yaml could not be read: ${error.message}`
            : "config/escalation.yaml could not be read.",
        );
      });
    loadSender(controller.signal)
      .then(setSender)
      .catch(() => {
        // No answer is no sender: the button stays away rather than promising a send.
        if (!controller.signal.aborted) setSender(null);
      });
    return () => controller.abort();
  }, []);

  useAlertChime(batch);

  const pickCycle = useCallback((next: string) => {
    setRunId(next);
    setSelectedId(null);
    setCapXml(null);
  }, []);

  const active = queueRunId === runId ? (selectedId ?? raised[0]?.id ?? null) : null;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    loadCap(active, runId, controller.signal)
      .then(setCapXml)
      .catch(() => setCapXml(null));
    return () => controller.abort();
  }, [active, runId]);

  /**
   * Acknowledge an alert, then re-read the queue so what is on screen is what the API holds.
   * The acknowledgement lives in the ops log and is folded into `GET /v1/alerts`, so it survives
   * a reload and the change of cycle that renames every alert.
   */
  const acknowledge = useCallback(
    async (id: string) => {
      if (!readPassphrase()) {
        toast("Acknowledged nothing", { description: NO_PASSPHRASE });
        return;
      }
      try {
        const done = await postAlertAction({ action: "ack", alertId: id, user: "console", runId });
        toast("Acknowledged", { description: done.notes[0] });
        setReload((current) => current + 1);
      } catch (error) {
        toast("Not acknowledged", { description: describeRefusal(opsRefusal(error)) });
      }
    },
    [runId],
  );

  /** Escalate one step up `config/escalation.yaml`, past every tier the level already reached. */
  const escalate = useCallback(
    async (id: string) => {
      const alert = raised.find((a) => a.id === id);
      const next = alert && steps ? nextEscalation(alert, steps) : null;
      if (!next) {
        toast("Escalated nothing", {
          description: steps
            ? "This alert has reached every step of the escalation matrix."
            : "The escalation matrix is not loaded, so there is no next step to name.",
        });
        return;
      }
      if (!readPassphrase()) {
        toast("Escalated nothing", { description: NO_PASSPHRASE });
        return;
      }
      try {
        await postAlertAction({
          action: "escalate",
          alertId: id,
          user: "console",
          runId,
          escalateTo: next.id,
        });
        toast("Escalated", {
          description: `To ${next.recipient}. Recorded in the ops log with who and when.`,
        });
        setReload((current) => current + 1);
      } catch (error) {
        toast("Not escalated", { description: describeRefusal(opsRefusal(error)) });
      }
    },
    [raised, steps, runId],
  );

  /** A real send, only ever offered when the API has a sender configured (7.5 AC3). */
  const sendToPhone = useCallback(async () => {
    if (!active) return;
    if (!readPassphrase()) {
      toast("Sent nothing", { description: NO_PASSPHRASE });
      return;
    }
    setSending(true);
    try {
      const done = await sendAlertToPhone({ alertId: active, user: "console", runId });
      toast("Sent to my phone", {
        description: done.toMasked ? `Delivered to the provider for ${done.toMasked}.` : undefined,
      });
    } catch (error) {
      toast("Not sent", { description: describeRefusal(opsRefusal(error)) });
    } finally {
      setSending(false);
      setReload((current) => current + 1);
    }
  }, [active, runId]);

  const alerts: (AlertSummary & { identity: string })[] = raised.map((a) => ({
    identity: alertIdentity(a),
    id: a.id,
    level: a.level,
    headline: a.headline,
    area: a.areaDesc,
    triggerProbability: a.triggerP,
    raisedAt: a.raisedTs,
    persistsCycles: a.persistsCycles,
    persistsUnit: persistenceUnit(a.persistsUnit),
    channels: ["Dashboard", "WhatsApp mock", "SMS mock"],
    acknowledged: Boolean(a.acknowledgedBy),
    escalated: a.state === "escalated",
  }));

  const phoneMessages: PhoneMessage[] = [
    ...raised.filter((a) => fresh.has(a.id)),
    ...raised.filter((a) => !fresh.has(a.id)),
  ]
    .slice(0, 4)
    .map((a) => ({ id: a.id, time: a.sentTs ?? a.raisedTs, text: phoneText(a) }));

  const pending = set?.pending ?? [];
  const cleared = set?.cleared ?? [];

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-6 p-6">
          <PageHeader
            title="Alert centre"
            description="Every alert VARUNA raises, the CAP document it sends, and the message the ward officer receives."
          />

          <CyclePicker currentRunId={runId} onPick={pickCycle} />

          {set && !set.crossCycle ? (
            <p className="type-small text-text-2">
              This cycle was baked before alerts needed two consecutive cycles: its queue raised on
              this cycle alone, and persistence is counted in forecast steps.
            </p>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.9fr)]">
            <Panel
              title="Queue"
              description="Grouped by level. Raised after two cycles at P ≥ 0.6, cleared at P ≤ 0.3."
              className="min-w-0"
            >
              <div className="flex flex-col gap-5">
                {ALERT_LEVELS.map((level) => {
                  const group = alerts.filter((alert) => alert.level === level);
                  return (
                    <section key={level} aria-label={`${ALERT_LEVEL_LABELS[level]} alerts`}>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <AlertLevelChip level={level} size="sm" showThreshold />
                        <span className="num type-micro text-text-3">
                          {group.length} {group.length === 1 ? "alert" : "alerts"}
                        </span>
                      </div>
                      {group.length === 0 ? (
                        <div className="rounded-control border-line bg-ink border">
                          <EmptyState
                            size="sm"
                            icon={BellOff}
                            title={`No ${level} alerts`}
                            description={QUEUE_EMPTY_HINT[level]}
                          />
                        </div>
                      ) : (
                        <ul className="flex flex-col gap-3">
                          {group.map((alert) => (
                            // Keyed by identity, not id: a street still warned about at the same
                            // level keeps its card across cycles, so only new cards slide in.
                            <li key={alert.identity}>
                              <AlertCard
                                alert={alert}
                                entering={fresh.has(alert.id)}
                                selected={alert.id === active}
                                onSelect={(id) => setSelectedId(id)}
                                onAcknowledge={(id) => void acknowledge(id)}
                                onEscalate={(id) => void escalate(id)}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}

                {set?.crossCycle ? (
                  <section
                    aria-label="Raises next cycle if it holds"
                    className="flex flex-col gap-2"
                  >
                    <h3 className="type-small text-text font-medium">
                      Raises next cycle if it holds
                    </h3>
                    {pending.length === 0 ? (
                      <p className="type-micro text-text-3">
                        Nothing crossed P ≥ 0.6 for the first time this cycle.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-1.5">
                        {pending.slice(0, 5).map((p) => (
                          <li key={p.id} className="type-small text-text-2 flex items-start gap-2">
                            <AlertLevelChip level={p.level} size="sm" />
                            <span className="min-w-0">
                              {p.headline}
                              <span className="num type-micro text-text-3 block">
                                first at {formatIst(p.sinceTs)}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {set.nPending > 5 ? (
                      <p className="num type-micro text-text-3">
                        and {set.nPending - 5} more places this cycle
                      </p>
                    ) : null}
                    {set.nCleared > 0 ? (
                      <p className="num type-micro text-text-2">
                        Cleared this cycle at P ≤ 0.3: {set.nCleared}{" "}
                        {set.nCleared === 1 ? "level" : "levels"}
                        {cleared[0]
                          ? `, first ${cleared[0].name ?? cleared[0].areaDesc} (${cleared[0].level})`
                          : ""}
                        .
                      </p>
                    ) : null}
                  </section>
                ) : null}
              </div>
            </Panel>

            <Panel
              title="CAP 1.2 document"
              description="Replay alerts carry CAP status Exercise; live alerts carry Actual."
              className="min-w-0"
            >
              <div className="flex min-h-[520px] flex-col">
                <CapViewer
                  xml={capXml}
                  filename={`${active ?? "alert"}.cap.xml`}
                  className="flex-1"
                />
              </div>
            </Panel>

            <div className="flex min-w-0 flex-col gap-4">
              <Panel
                title="Ward officer's phone"
                description="The WhatsApp card as the ward officer receives it. On-screen mock."
              >
                <PhoneMock messages={phoneMessages} freshIds={fresh} popKey={batch} />
                {sender?.configured && active ? (
                  <div className="mt-3 flex flex-col gap-1">
                    <Button
                      size="sm"
                      onClick={() => void sendToPhone()}
                      disabled={sending}
                      aria-disabled={sending}
                    >
                      <Send size={16} strokeWidth={1.75} aria-hidden="true" />
                      Send to my phone
                    </Button>
                    <p className="type-micro text-text-3">
                      A real {sender.channel === "sms" ? "SMS" : "WhatsApp message"} through{" "}
                      {sender.provider === "twilio" ? "Twilio" : "WhatsApp Cloud"} to{" "}
                      {sender.toMasked}, the number configured where the API runs.
                    </p>
                  </div>
                ) : null}
              </Panel>

              <Panel
                title="Delivery log"
                description="Channel, status and time. The mocks are renders on this screen."
              >
                <DeliveryLog
                  rows={
                    delivery?.rows.map((row) => ({
                      ...row,
                      alert: raised.find((a) => a.id === row.alertId)?.areaDesc ?? null,
                    })) ?? null
                  }
                  loading={delivery === null && deliveryError === null}
                  error={deliveryError}
                  notes={delivery?.notes}
                />
              </Panel>
            </div>
          </div>

          <Panel
            title="Escalation matrix"
            description="Who is told at each level, from config/escalation.yaml. Escalate moves an alert one step down this list."
          >
            {steps ? (
              <EscalationMatrix
                tiers={steps.map((step) => ({
                  id: step.id,
                  recipient: step.recipient,
                  trigger: step.trigger,
                  channel: step.channel,
                }))}
              />
            ) : stepsError ? (
              <EmptyState
                size="sm"
                icon={ListTree}
                title="Escalation matrix unavailable"
                description={stepsError}
              />
            ) : (
              <Skeleton lines={5} />
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
