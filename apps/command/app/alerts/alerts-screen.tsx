"use client";

import { BellOff, Send } from "lucide-react";

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
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PhoneMock, type PhoneMessage } from "@/components/varuna/phone-mock";
import { formatIst } from "@/lib/format";

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
  // No run has been baked in Phase 0, so nothing has been raised or delivered yet.
  const alerts: AlertSummary[] = [];
  const deliveryLog: DeliveryLogRow[] = [];
  const phoneMessages: PhoneMessage[] = [];
  const capXml: string | null = null;

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-6 p-6">
          <PageHeader
            title="Alert centre"
            description="Every alert VARUNA raises, the CAP document it sends, and the message the ward officer receives."
          />

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
                              <AlertCard alert={alert} />
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
                <CapViewer xml={capXml} filename="alert.cap.xml" className="flex-1" />
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
