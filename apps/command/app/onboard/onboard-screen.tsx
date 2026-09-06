"use client";

import { MapPinned } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/varuna/app-shell";
import { LogStream } from "@/components/varuna/log-stream";
import { MapSlot } from "@/components/varuna/map-slot";
import {
  IDLE_ONBOARDING_STEPS,
  OnboardingSteps,
} from "@/components/varuna/onboarding-steps";
import { PageHeader } from "@/components/varuna/page-header";
import { Panel } from "@/components/varuna/panel";
import { PanelErrorBoundary } from "@/components/varuna/panel-error-boundary";

/**
 * City-in-a-box wizard (CLAUDE.md section 7.9). In Phase 0 the six steps sit idle, the log area
 * says where its lines come from and the map slot waits for the layers each step stacks. The start
 * button is present and disabled: the pipeline behind it lands in Phase 9.
 */
export function OnboardScreen() {
  return (
    <AppShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-6 p-6">
          <PageHeader
            title="City in a box"
            description="Open data in, digital twin out. Chennai in minutes."
            honesty="Inferred drain graph"
            actions={
              <div className="flex flex-col items-end gap-1">
                <Button disabled aria-disabled="true">
                  <MapPinned aria-hidden="true" />
                  Start onboarding Chennai
                </Button>
                <p className="max-w-[36ch] text-right type-micro text-text-3">
                  The wizard runs from city/cache/chennai in Phase 9.
                </p>
              </div>
            }
          />

          <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <PanelErrorBoundary title="Onboarding steps">
                <Panel
                  title="Steps"
                  description="Every step reports its own progress and elapsed time."
                >
                  <OnboardingSteps steps={IDLE_ONBOARDING_STEPS} />
                </Panel>
              </PanelErrorBoundary>

              <PanelErrorBoundary title="Pipeline log">
                <Panel
                  title="Pipeline log"
                  description="Real lines from services/city, never scripted copy."
                >
                  <LogStream
                    lines={[]}
                    emptyDescription="Logs stream here when the wizard runs."
                  />
                </Panel>
              </PanelErrorBoundary>

              <Panel
                title="Finish card"
                description="What the wizard shows when the first forecast lands."
              >
                <div className="space-y-3 rounded-control border border-line bg-well p-4 opacity-60">
                  <p className="max-w-[52ch] type-body text-text-2">
                    First forecast, uncalibrated. VARUNA learns Chennai&apos;s drains from the next
                    monsoon.
                  </p>
                  <Button variant="outline" size="sm" disabled aria-disabled="true">
                    Open Chennai console
                  </Button>
                  <p className="type-micro text-text-3">
                    The city switcher lists Chennai once the wizard has written city/chennai.
                  </p>
                </div>
              </Panel>
            </div>

            <PanelErrorBoundary title="Onboarding map">
              <Panel
                title="Chennai, Velachery to T. Nagar"
                description="Each completed step stacks its layer here: terrain, roads, drains, then the first depth forecast."
                className="min-h-[32rem] overflow-hidden"
              >
                <div className="h-full min-h-[26rem] overflow-hidden rounded-control border border-line">
                  <MapSlot />
                </div>
              </Panel>
            </PanelErrorBoundary>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
