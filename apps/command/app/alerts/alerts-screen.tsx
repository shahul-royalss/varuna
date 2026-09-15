"use client";

import { BellOff, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertCard, type AlertSummary } from "@/components/varuna/alert-card";
import {
  ALERT_LEVELS,
  ALERT_LEVEL_LABELS,
  AlertLevelChip,
  type AlertLevel,
} from "@/components/varuna/alert-level-chip";
import { AppShell } from "@/components/varuna/app-shell";
import { CapViewer } from "@/components/varuna/cap-viewer";
import { EmptyState } from "@/components/varuna/empty-state";
import { EscalationMatrix } from "@/components/varuna/escalation-matrix";
import { CyclePicker } from "@/components/varuna/cycle-picker";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PhoneMock, type PhoneMessage } from "@/components/varuna/phone-mock";
import { alertIdentities, alertIdentity, freshAlertIds } from "@/lib/alert-identity";
import { formatIst } from "@/lib/format";
import { loadAlerts, loadCap, type RunAlert } from "@/lib/api/alerts";
import { useAlertChime } from "@/lib/sound";

/** One line of the delivery log: which channel carried an alert, whether it landed, and when. */
export interface DeliveryLogRow {
  id: string;
  /** "Dashboard", "WhatsApp mock", "SMS mock". */
  channel: string;
  /** "Delivered", "Queued", "Failed". */
  status: string;
  /** ISO 8601 with +05:30. */
  time: string;
}

/** What each level's queue says while no run has been baked (CLAUDE.md section 11.10). */
const QUEUE_EMPTY_HINT: Record<AlertLevel, string> = {
  severe:
    "Severe raises when P(> 45 cm) stays at or above 0.6 for two cycles. Press Play on the replay to fill the queue.",
  moderate:
    "Moderate raises when P(> 30 cm) stays at or above 0.6 for two cycles. Press Play on the replay to fill the queue.",
  watch:
    "Watch raises when P(> 15 cm) stays at or above 0.6 for two cycles. Press Play on the replay to fill the queue.",
};

const NO_FRESH: ReadonlySet<string> = new Set();

/**
 * Alert centre (CLAUDE.md section 7.5). Three columns: the queue grouped by level, the CAP 1.2
 * document of the selected alert, and the ward officer's phone with the delivery log and the
 * escalation matrix. With no run baked every column shows its empty state.
 *
 * Motion M16: when a cycle brings alerts the queue did not show a moment ago, those cards slide
 * in, the phone pops them and shakes once, and the chime plays if sound is on. "New" is decided
 * by `freshAlertIds` on the cycle-independent identity (scope, place, level), because alert ids
 * carry the run and would call every card new on every cycle. The first queue the screen shows
 * is not news, so nothing moves on load; on the replay the trigger is a change of cycle.
 */
export function AlertsScreen() {
  const [raised, setRaised] = useState<RunAlert[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [capXml, setCapXml] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  // **Which cycle.** An alert is a statement about a forecast, so it only means anything beside
  // the run that raised it - and the newest baked run is 09:10 IST, after the storm, where the
  // queue is nearly empty. The operator picks the cycle here as they do on the console; the row
  // of cycles is the morning's own escalation.
  const [runId, setRunId] = useState<string | undefined>(undefined);
  // The identities of the queue on screen (null until one has been shown), the ids in the current
  // queue that were not in it, and a counter that moves on with each batch of those.
  const shownRef = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NO_FRESH);
  const [batch, setBatch] = useState(0);
  // The cycle `raised` was loaded for (null before the first load). Between a pick and its answer
  // the queue on screen still belongs to the previous cycle.
  const [queueRunId, setQueueRunId] = useState<string | undefined | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadAlerts(runId, controller.signal)
      .then((set) => {
        const next = set?.alerts ?? [];
        const nextFresh = freshAlertIds(shownRef.current, next);
        shownRef.current = alertIdentities(next);
        setRaised(next);
        setQueueRunId(runId);
        setFresh(nextFresh);
        if (nextFresh.size > 0) setBatch((current) => current + 1);
      })
      .catch(() => {
        // A superseded request is not an empty queue: treating it as one would make every alert
        // of the next cycle look new.
        if (controller.signal.aborted) return;
        if (shownRef.current !== null) shownRef.current = new Set();
        setRaised([]);
        setQueueRunId(runId);
        setFresh(NO_FRESH);
      });
    return () => controller.abort();
  }, [runId]);

  useAlertChime(batch);

  // A new cycle is a new queue, so the selected alert and its CAP go with it.
  const pickCycle = useCallback((next: string) => {
    setRunId(next);
    setSelectedId(null);
    setCapXml(null);
  }, []);

  // The CAP document of whichever alert is selected, defaulting to the worst one raised. Only once
  // the queue belongs to the picked cycle: asking the new run for an alert id minted by the old
  // one is a 404, and a console error on every change of cycle.
  const active = queueRunId === runId ? (selectedId ?? raised[0]?.id ?? null) : null;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    loadCap(active, runId, controller.signal)
      .then(setCapXml)
      .catch(() => setCapXml(null));
    return () => controller.abort();
  }, [active, runId]);

  const acknowledge = useCallback(
    (id: string) => setAcknowledged((current) => ({ ...current, [id]: true })),
    [],
  );

  const alerts: (AlertSummary & { identity: string })[] = raised.map((a) => ({
    identity: alertIdentity(a),
    id: a.id,
    level: a.level,
    headline: a.headline,
    area: a.areaDesc,
    triggerProbability: a.triggerP,
    raisedAt: a.raisedTs,
    persistsCycles: a.persistsCycles,
    persistsUnit: "forecast step",
    channels: ["Dashboard", "WhatsApp mock"],
    acknowledged: Boolean(acknowledged[a.id]),
  }));

  // Delivery is a dashboard render plus the on-screen phone mock; CLAUDE.md 3.2 keeps a real
  // WhatsApp sender at P2, so the log says exactly what happened and claims nothing else.
  const deliveryLog: DeliveryLogRow[] = raised.slice(0, 6).flatMap((a) => [
    { id: `${a.id}-dash`, channel: "Dashboard", status: "Delivered", time: a.raisedTs },
    { id: `${a.id}-wa`, channel: "WhatsApp mock", status: "Delivered", time: a.raisedTs },
  ]);

  // The phone carries the newest news: alerts that just arrived come first, then the worst of the
  // rest, so the message that pops is the one the batch brought.
  const phoneMessages: PhoneMessage[] = [
    ...raised.filter((a) => fresh.has(a.id)),
    ...raised.filter((a) => !fresh.has(a.id)),
  ]
    .slice(0, 4)
    .map((a) => ({
      id: a.id,
      time: a.raisedTs,
      text: a.instruction ? `${a.headline}. ${a.instruction}` : a.headline,
    }));

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-6 p-6">
          <PageHeader
            title="Alert centre"
            description="Every alert VARUNA raises, the CAP document it sends, and the message the ward officer receives."
          />

          <CyclePicker currentRunId={runId} onPick={pickCycle} />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.9fr)]">
            <Panel title="Queue" description="Grouped by level, newest first." className="min-w-0">
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
                                onAcknowledge={(id) => acknowledge(id)}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
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
                description="The WhatsApp card as the ward officer receives it."
              >
                <PhoneMock messages={phoneMessages} freshIds={fresh} popKey={batch} />
              </Panel>

              <Panel title="Delivery log" description="Channel, status and time for each send.">
                {deliveryLog.length === 0 ? (
                  <EmptyState
                    size="sm"
                    icon={Send}
                    title="Nothing delivered yet"
                    description="Sends appear here once an alert is raised on the replay."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Channel</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Time</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {deliveryLog.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell>{row.channel}</TableCell>
                            <TableCell>{row.status}</TableCell>
                            <TableCell className="num">{formatIst(row.time)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </Panel>
            </div>
          </div>

          <Panel
            title="Escalation matrix"
            description="Who is told at each level, from config/escalation.yaml."
          >
            <EscalationMatrix />
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
