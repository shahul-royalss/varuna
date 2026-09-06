"use client";

import { Waves } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { AlertCard, type AlertSummary } from "@/components/varuna/alert-card";
import { ALERT_LEVELS, AlertLevelChip } from "@/components/varuna/alert-level-chip";
import { CitySwitcher } from "@/components/varuna/city-switcher";
import { CycleBudgetBar, type StageTiming } from "@/components/varuna/cycle-budget-bar";
import { DeltaTable, type DeltaRow } from "@/components/varuna/delta-table";
import { DepthChip } from "@/components/varuna/depth-chip";
import { EmptyState } from "@/components/varuna/empty-state";
import { HotspotRail, type HotspotSummary } from "@/components/varuna/hotspot-rail";
import { IconRail } from "@/components/varuna/icon-rail";
import { Kbd } from "@/components/varuna/kbd";
import { LogStream, type LogLine } from "@/components/varuna/log-stream";
import { ModeBanner } from "@/components/varuna/mode-banner";
import {
  IDLE_ONBOARDING_STEPS,
  OnboardingSteps,
  type OnboardingStepState,
} from "@/components/varuna/onboarding-steps";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";
import { PhoneMock, type PhoneMessage } from "@/components/varuna/phone-mock";
import { ReplayPanel } from "@/components/varuna/replay-panel";
import { RunStamp } from "@/components/varuna/run-stamp";
import { Skeleton, SkeletonRows } from "@/components/varuna/skeleton";
import { TimeBar } from "@/components/varuna/time-bar";
import { HEADLINE_SCORE_TILES, VerificationGrid } from "@/components/varuna/verification-grid";
import { VerificationChip } from "@/components/varuna/verification-chip";
import { useUiStore } from "@/lib/stores/ui";
import { useRunStore, type RunMeta } from "@/lib/stores/run";

import { Demo, DesignSection } from "./section";

/* Sample data. Every string is about the 2 July 2019 Mumbai replay, per CLAUDE.md section 6.8. */

const SAMPLE_RUN: RunMeta = {
  run_id: "MUM-20190702T1210Z-sky1.0-twin1.0-flash0.3-baked",
  city: "mumbai",
  cycle_ts: "2019-07-02T06:40:00+05:30",
  mode: "replay",
  replay_mode: "baked",
  ensemble_n: 50,
  bundle: "MUM-2019-07-02",
  stage_ms: { decode: 210, sky: 4300, twin: 6100, flash: 280, pulse: 1900, products: 640 },
  mass_balance_err: 0.0004,
  versions: { sky: "1.0", twin: "1.0", flash: "0.3" },
};

const SAMPLE_HOTSPOTS: HotspotSummary[] = [
  { id: "hindmata", name: "Hindmata junction", depthCm: 55, timeToPeak: "08:20" },
  { id: "kings-circle", name: "King's Circle", depthCm: 38, timeToPeak: "18:35" },
  { id: "sion-circle", name: "Sion Circle", depthCm: 27, timeToPeak: "18:50" },
];

const SAMPLE_ALERT: AlertSummary = {
  id: "MUM-2019-07-02-hindmata-severe",
  level: "severe",
  headline: "Hindmata junction: depth likely above 45 cm from 08:20 to 10:00",
  area: "Ward F/South · Dr Ambedkar Road",
  triggerProbability: 0.82,
  raisedAt: "2019-07-02T17:45:00+05:30",
  persistsCycles: 2,
  channels: ["Dashboard", "WhatsApp mock"],
};

const SAMPLE_PHONE_MESSAGES: PhoneMessage[] = [
  {
    id: "hindmata-severe",
    time: "17:45",
    text: "Hindmata junction: depth likely above 45 cm from 08:20 to 10:00. Divert traffic at Tilak Bridge. Pumps P-12 and P-15 dispatched.",
  },
];

const SAMPLE_STAGES: StageTiming[] = [
  { id: "decode", ms: 210 },
  { id: "sky", ms: 4300 },
  { id: "twin", ms: 6100 },
  { id: "flash", ms: 280 },
  { id: "pulse", ms: 1900 },
  { id: "products", ms: 640 },
];

const SAMPLE_DELTAS: DeltaRow[] = [
  {
    id: "hindmata",
    hotspot: "Hindmata junction",
    beforeCm: 55,
    afterCm: 20,
    minutesImpassableBefore: 95,
    minutesImpassableAfter: 20,
  },
  {
    id: "kings-circle",
    hotspot: "King's Circle",
    beforeCm: 38,
    afterCm: 31,
    minutesImpassableBefore: 60,
    minutesImpassableAfter: 45,
  },
];

const SAMPLE_ONBOARD_STEPS: OnboardingStepState[] = IDLE_ONBOARDING_STEPS.map((step, i) => {
  if (i < 2) return { ...step, progress: 1, elapsedS: 34 + i * 12, status: "done" as const };
  if (i === 2) return { ...step, progress: 0.42, elapsedS: 18, status: "running" as const };
  return step;
});

const SAMPLE_LOG_LINES: LogLine[] = [
  { ts: "2026-09-06T10:02:11+05:30", text: "Mosaicked 4 Copernicus GLO-30 tiles for CHN-SOUTH" },
  { ts: "2026-09-06T10:02:48+05:30", text: "Burned 41,206 building footprints, carved 3,180 road centrelines" },
  {
    ts: "2026-09-06T10:03:05+05:30",
    level: "warn",
    text: "12 depressions smaller than 900 m² breached as spurious pits",
  },
];

const SAMPLE_DEPTHS = [2, 8, 20, 35, 50, 80];

const BUTTON_VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;
const BUTTON_SIZES = ["xs", "sm", "default", "lg"] as const;

/**
 * Puts a sample run in the run store while this section is mounted so the chrome components have
 * something real to read, and clears it on unmount so no other screen inherits a fake run.
 */
function WithSampleRun({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    useRunStore.getState().setRun(SAMPLE_RUN);
    return () => useRunStore.getState().clear();
  }, []);
  return <>{children}</>;
}

/** A child that throws on demand, to prove the boundary keeps the rest of the screen alive. */
function Exploder() {
  const [boom, setBoom] = useState(false);
  if (boom) throw new Error("Segment forecast failed to parse");
  return (
    <Button size="sm" variant="outline" onClick={() => setBoom(true)}>
      Throw inside this panel
    </Button>
  );
}

export function ComponentsSection() {
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [selectedHotspot, setSelectedHotspot] = useState<string | null>("hindmata");

  return (
    <DesignSection
      id="components"
      title="Components"
      description="Every component of components/varuna in its states, with the sample data the console would show on 2 July 2019. Screens compose these; they never copy them."
    >
      <div className="flex flex-col gap-6">
        <Panel title="Page header" description="Title, description, honesty label and actions.">
          <PageHeader
            title="Drain X-ray"
            description="The learned blockage map, the observations that taught it, and the desilting priority list."
            honesty="Drain graph inferred from roads and terrain"
            actions={
              <Button size="sm" variant="outline">
                Export desilting priority
              </Button>
            }
          />
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Panel" description="Default padding, with a title and a description.">
            <p className="type-small text-text-2">
              Panels are 12 px radius, one pixel of line, deep on ink. There are no drop shadows.
            </p>
          </Panel>
          <Panel
            dense
            title="Panel, dense"
            description="Dense panels carry tables and log rows."
            actions={<Kbd>D</Kbd>}
          >
            <p className="type-small text-text-2">
              Dense drops the padding so a 32 px table row still breathes.
            </p>
          </Panel>
        </div>

        <Panel title="Empty state" description="Empty states say what to do next, never what broke.">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Demo label="Default" bare>
              <EmptyState
                icon={Waves}
                title="No runs yet"
                description="Press Play on the replay, or Compute live."
                action={<Button size="sm">Open the replay panel</Button>}
              />
            </Demo>
            <Demo label="Small" note="Used inside a rail or a drawer." bare>
              <EmptyState
                size="sm"
                title="No observations this cycle"
                description="Pulse assimilates traffic anomalies and citizen reports as they arrive."
              />
            </Demo>
          </div>
        </Panel>

        <Panel title="Depth chip" description="Colour is fixed to the depth ramp; the number is always printed.">
          <div className="flex flex-wrap items-center gap-2">
            {SAMPLE_DEPTHS.map((cm) => (
              <DepthChip key={cm} cm={cm} showBand />
            ))}
            <DepthChip cm={null} />
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Keyboard keys" description="Shortcut hints in rows and in the overlay.">
            <div className="flex flex-wrap items-center gap-2">
              <Kbd>Space</Kbd>
              <Kbd>←</Kbd>
              <Kbd>→</Kbd>
              <Kbd>P</Kbd>
              <Kbd>D</Kbd>
              <Kbd>⌘K</Kbd>
              <Kbd>?</Kbd>
            </div>
          </Panel>
          <Panel title="Skeletons" description="Shimmer, never a spinner (build spec section 6.9).">
            <div className="flex flex-col gap-3">
              <Demo label="Single block" bare>
                <Skeleton className="h-6 w-48" />
              </Demo>
              <Demo label="Rail rows" bare>
                <SkeletonRows rows={3} />
              </Demo>
            </div>
          </Panel>
        </div>

        <Panel
          title="Panel error boundary"
          description="A broken panel never blanks the map: it fails in place with a retry."
        >
          <PanelErrorBoundary title="Segment forecast">
            <Exploder />
          </PanelErrorBoundary>
        </Panel>

        <Panel title="Mode banner" description="One banner per mode; degraded names the missing feed.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Demo label="Replay" bare>
              <ModeBanner mode="replay" label="Replay 30× · 2 Jul 2019 · 06:40 IST" />
            </Demo>
            <Demo label="Live" bare>
              <ModeBanner mode="live" label="Live · 06:40 IST" />
            </Demo>
            <Demo label="Degraded" bare>
              <ModeBanner mode="degraded" label="Degraded: radar offline, using gauges and satellite" />
            </Demo>
            <Demo label="No run" note="The state a cold console opens in." bare>
              <ModeBanner mode="none" />
            </Demo>
          </div>
        </Panel>

        <Panel
          title="Run stamp, verification chip and city switcher"
          description="The provenance chrome of the top bar, with and without a run."
        >
          <div className="flex flex-col gap-4">
            <Demo label="No run" note="Nothing is baked yet." bare>
              <div className="flex flex-wrap items-center gap-3">
                <RunStamp />
                <VerificationChip />
                <CitySwitcher />
              </div>
            </Demo>
            <Demo label="With the 06:40 baked run" bare>
              <WithSampleRun>
                <div className="flex flex-wrap items-center gap-3">
                  <RunStamp />
                  <VerificationChip csi={0.71} eventLabel="2 Jul 2019" />
                  <CitySwitcher />
                </div>
              </WithSampleRun>
            </Demo>
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Icon rail" description="56 px wide; labels appear on hover and focus.">
            <div className="h-[400px] w-icon-rail overflow-hidden rounded-panel border border-line">
              <IconRail />
            </div>
          </Panel>
          <Panel title="Hotspot rail" description="Ranked rows with a depth chip and time to peak.">
            <div className="flex flex-col gap-4">
              <Demo label="Three hotspots" bare>
                <HotspotRail
                  hotspots={SAMPLE_HOTSPOTS}
                  selectedId={selectedHotspot}
                  onSelect={setSelectedHotspot}
                />
              </Demo>
              <Demo label="Empty" note="Before the first run is published." bare>
                <HotspotRail hotspots={[]} />
              </Demo>
            </div>
          </Panel>
        </div>

        <Panel title="Time bar" description="96 px tall; scrub, play, speed and the ensemble spread band.">
          <div className="overflow-hidden rounded-panel border border-line">
            <TimeBar />
          </div>
        </Panel>

        <Panel title="Replay panel" description="Bundle, clock, speed and the cycle log.">
          <ReplayPanel />
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Alerts" description="Level chips carry the threshold; the card carries hysteresis.">
            <div className="flex flex-col gap-4">
              <Demo label="Level chips" bare>
                <div className="flex flex-wrap items-center gap-2">
                  {ALERT_LEVELS.map((level) => (
                    <AlertLevelChip key={level} level={level} showThreshold />
                  ))}
                </div>
              </Demo>
              <Demo label="Severe alert, raised" bare>
                <AlertCard alert={SAMPLE_ALERT} />
              </Demo>
              <Demo label="Acknowledged" bare>
                <AlertCard alert={{ ...SAMPLE_ALERT, acknowledged: true }} />
              </Demo>
            </div>
          </Panel>
          <Panel
            title="Phone mock"
            description="The card the ward officer receives. The real sender arrives with a configured account."
          >
            <PhoneMock messages={SAMPLE_PHONE_MESSAGES} simTime="17:45" />
          </Panel>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Cycle budget bar" description="Stage timings against the 15 s live-cycle budget.">
            <div className="flex flex-col gap-4">
              <Demo label="Complete cycle" bare>
                <CycleBudgetBar stages={SAMPLE_STAGES} totalMs={13430} />
              </Demo>
              <Demo label="No timings yet" bare>
                <CycleBudgetBar />
              </Demo>
            </div>
          </Panel>
          <Panel
            title="Delta table"
            description="What-if results: before and after depth, and minutes impassable."
          >
            <DeltaTable rows={SAMPLE_DELTAS} />
          </Panel>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Onboarding steps" description="Chennai from cache: six steps with elapsed time.">
            <OnboardingSteps steps={SAMPLE_ONBOARD_STEPS} />
          </Panel>
          <Panel title="Log stream" description="Real pipeline lines only; mono is allowed here.">
            <div className="flex flex-col gap-4">
              <Demo label="Streaming" bare>
                <LogStream lines={SAMPLE_LOG_LINES} />
              </Demo>
              <Demo label="Empty" bare>
                <LogStream lines={[]} />
              </Demo>
            </div>
          </Panel>
        </div>

        <Panel
          title="Verification grid"
          description="Headline scores; a tile with no value says so rather than inventing one."
        >
          <VerificationGrid tiles={HEADLINE_SCORE_TILES} groundTruthCount={null} />
        </Panel>

        <Panel title="Buttons" description="The vendor primitive in every variant and size the console uses.">
          <div className="flex flex-col gap-4">
            {BUTTON_VARIANTS.map((variant) => (
              <Demo key={variant} label={variant} bare>
                <div className="flex flex-wrap items-center gap-2">
                  {BUTTON_SIZES.map((size) => (
                    <Button key={size} variant={variant} size={size}>
                      Dispatch pumps
                    </Button>
                  ))}
                  <Button variant={variant} disabled>
                    Compute live
                  </Button>
                </div>
              </Demo>
            ))}
            <p className="type-micro text-text-3">
              The disabled button is the phase 5 control: it runs a real cycle once the orchestrator
              publishes runs.
            </p>
          </div>
        </Panel>

        <Panel
          title="Overlays"
          description="The command palette, the shortcuts overlay and the settings drawer are mounted by the app shell; these buttons open them."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setCommandPaletteOpen(true)}>
              Open the command palette
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShortcutsOpen(true)}>
              Open the shortcuts overlay
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
              Open settings
            </Button>
          </div>
        </Panel>
      </div>
    </DesignSection>
  );
}
