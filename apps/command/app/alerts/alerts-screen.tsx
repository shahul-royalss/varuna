"use client";

import { BellOff, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
import { formatIst } from "@/lib/format";
import { loadAlerts, loadCap, type RunAlert } from "@/lib/api/alerts";

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

/**
 * Alert centre (CLAUDE.md section 7.5). Three columns: the queue grouped by level, the CAP 1.2
 * document of the selected alert, and the ward officer's phone with the delivery log and the
 * escalation matrix. Phase 0 has no runs, so every column shows its empty state; the state
 * machine, CAP generation and the WhatsApp mock arrive in Phase 8.
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

  useEffect(() => {
    const controller = new AbortController();
    loadAlerts(runId, controller.signal)
      .then((set) => setRaised(set?.alerts ?? []))
      .catch(() => setRaised([]));
    return () => controller.abort();
  }, [runId]);

  // A new cycle is a new queue, so the selected alert and its CAP go with it.
  const pickCycle = useCallback((next: string) => {
    setRunId(next);
    setSelectedId(null);
    setCapXml(null);
  }, []);

  // The CAP document of whichever alert is selected, defaulting to the worst one raised.
  const active = selectedId ?? raised[0]?.id ?? null;
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

  const alerts: AlertSummary[] = raised.map((a) => ({
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

  const phoneMessages: PhoneMessage[] = raised.slice(0, 4).map((a) => ({
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
            <Panel
              title="Queue"
              description="Grouped by level, newest first."
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
                        <div className="rounded-control border border-line bg-ink">
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
                            <li key={alert.id}>
                              <AlertCard
                                alert={alert}
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
                <CapViewer xml={capXml} filename={`${active ?? "alert"}.cap.xml`} className="flex-1" />
              </div>
            </Panel>

            <div className="flex min-w-0 flex-col gap-4">
              <Panel
                title="Ward officer's phone"
                description="The WhatsApp card as the ward officer receives it."
              >
                <PhoneMock messages={phoneMessages} />
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
