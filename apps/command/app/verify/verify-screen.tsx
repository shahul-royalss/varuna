"use client";

import { useState } from "react";
import { Activity, MapPinOff, Table, TrendingUp } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppShell } from "@/components/varuna/app-shell";
import { EmptyState } from "@/components/varuna/empty-state";
import { LimitationsList } from "@/components/varuna/limitations-list";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import {
  HEADLINE_SCORE_TILES,
  VerificationGrid,
} from "@/components/varuna/verification-grid";

/** Events that can be scored. Each one is a replay bundle with sourced ground-truth pins. */
const EVENTS = [{ id: "MUM-2019-07-02", label: "MUM-2019-07-02" }] as const;

/**
 * Verification dashboard (CLAUDE.md section 7.10). Every number here is computed by
 * `services/verify` from run artifacts, so in Phase 0 each tile and chart says what it will show
 * and which units it will show it in, rather than standing in for a score.
 */
export function VerifyScreen() {
  const [eventId, setEventId] = useState<string>(EVENTS[0].id);

  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-6 p-6">
          <PageHeader
            title="Verification"
            description="Where VARUNA is right, where it is wrong, and how we score ourselves."
            honesty="Reconstructed replay"
            actions={
              <div className="flex flex-col items-end gap-1">
                <Select
                  value={eventId}
                  onValueChange={(value) => setEventId(String(value))}
                >
                  <SelectTrigger aria-label="Event">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EVENTS.map((event) => (
                      <SelectItem key={event.id} value={event.id}>
                        {event.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="type-micro text-text-3">
                  Scores appear once the event is baked and verified.
                </p>
              </div>
            }
          />

          <PanelErrorBoundary title="Headline scores">
            <Panel
              title="Headline scores"
              description="Computed by services/verify from run artifacts, never typed in."
            >
              <VerificationGrid tiles={HEADLINE_SCORE_TILES} groundTruthCount={null} />
            </Panel>
          </PanelErrorBoundary>

          <div className="grid gap-4 xl:grid-cols-2">
            <PanelErrorBoundary title="Contingency table">
              <Panel
                title="Contingency table"
                description="Depth above 30 cm within the event window."
              >
                <EmptyState
                  icon={Table}
                  title="Not scored yet"
                  description="Hits, misses, false alarms and correct negatives, counted at chronic spots and sourced pins."
                />
              </Panel>
            </PanelErrorBoundary>

            <PanelErrorBoundary title="Reliability diagram">
              <Panel
                title="Reliability diagram"
                description="Probability skill of P(depth above 30 cm)."
              >
                <EmptyState
                  icon={Activity}
                  title="Not scored yet"
                  description="Forecast probability 0 to 1 on the x axis, observed frequency 0 to 1 on the y axis, with the pin count in each bin."
                />
              </Panel>
            </PanelErrorBoundary>

            <PanelErrorBoundary title="Skill by lead time">
              <Panel
                title="Skill by lead time"
                description="Where confidence decays, in the open."
              >
                <EmptyState
                  icon={TrendingUp}
                  title="Not scored yet"
                  description="Rain CSI at 20 and 40 mm/h against lead time in minutes, 0 to 180."
                />
              </Panel>
            </PanelErrorBoundary>

            <PanelErrorBoundary title="Where we are wrong">
              <Panel
                title="Where we are wrong"
                description="Pins the model missed, each with the likely reason."
              >
                <EmptyState
                  icon={MapPinOff}
                  title="No missed pins yet"
                  description="The list fills after a verified event."
                />
              </Panel>
            </PanelErrorBoundary>
          </div>

          <Panel>
            <LimitationsList id="limitations" />
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
