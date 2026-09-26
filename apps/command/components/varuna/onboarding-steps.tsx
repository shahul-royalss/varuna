"use client";

import { Check, CircleDashed, History, Loader, TriangleAlert } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { formatSeconds } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The six steps of city-in-a-box (CLAUDE.md section 7.9), in order. */
export const ONBOARDING_STEP_IDS = [
  "area",
  "fetch",
  "condition",
  "drains",
  "graph",
  "forecast",
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export const ONBOARDING_STEP_LABELS: Record<OnboardingStepId, string> = {
  area: "Choose area",
  fetch: "Fetch open data",
  condition: "Condition terrain",
  drains: "Infer drains",
  graph: "Build graph",
  forecast: "First forecast",
};

/**
 * `cached` is a step this session did not run: the city was already on disk when the screen
 * opened, as it is on the packed demo laptop. It is not `done` - nothing was built in front of the
 * operator, so there is no elapsed time to report - and it is not `waiting`, which is what a built
 * Chennai used to read as on all six rows while the map beside them drew its forecast.
 */
export type OnboardingStepStatus = "waiting" | "running" | "done" | "cached" | "failed";

export const STEP_STATUS_LABELS: Record<OnboardingStepStatus, string> = {
  waiting: "Waiting",
  running: "Running",
  done: "Done",
  cached: "Already built",
  failed: "Failed",
};

export interface OnboardingStepState {
  id: OnboardingStepId;
  /** 0 to 100. */
  progress: number;
  /** Elapsed seconds on this step. */
  elapsedS: number;
  status: OnboardingStepStatus;
  /** One line of detail from the pipeline, e.g. "Copernicus GLO-30, 4 tiles from cache". */
  detail?: string;
}

/** Every step waiting at zero: the wizard before it starts. */
export const IDLE_ONBOARDING_STEPS: OnboardingStepState[] = ONBOARDING_STEP_IDS.map((id) => ({
  id,
  progress: 0,
  elapsedS: 0,
  status: "waiting",
}));

export interface OnboardingStepsProps {
  steps: OnboardingStepState[];
  className?: string;
}

const STATUS_ICONS = {
  waiting: CircleDashed,
  running: Loader,
  done: Check,
  cached: History,
  failed: TriangleAlert,
} as const satisfies Record<OnboardingStepStatus, unknown>;

/** The icon badge's border and colour per status, one class string each rather than overrides. */
const STATUS_TONES: Record<OnboardingStepStatus, string> = {
  waiting: "border-line text-text-3",
  running: "border-line text-text-3",
  done: "border-tide text-tide",
  cached: "border-line-strong text-text-2",
  failed: "border-status-degraded text-status-degraded",
};

/**
 * The wizard's step list: label, status, a progress bar and elapsed time per step. Driven by
 * props so Phase 9 feeds it from `onboard.progress` events; nothing here is scripted.
 */
export function OnboardingSteps({ steps, className }: OnboardingStepsProps) {
  return (
    <ol className={cn("space-y-3", className)} aria-label="Onboarding steps">
      {steps.map((step, index) => {
        const Icon = STATUS_ICONS[step.status];
        const label = ONBOARDING_STEP_LABELS[step.id];
        const progress = Math.min(100, Math.max(0, Math.round(step.progress)));
        return (
          <li
            key={step.id}
            className={cn(
              "rounded-control border-line border p-3",
              step.status === "running" ? "bg-well" : "bg-deep",
            )}
            aria-current={step.status === "running" ? "step" : undefined}
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  "rounded-chip flex size-6 shrink-0 items-center justify-center border",
                  STATUS_TONES[step.status],
                )}
              >
                <Icon size={14} strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="type-small text-text font-medium">
                    <span className="num text-text-3">{index + 1}.</span> {label}
                  </p>
                  {/* A cached step carries no time: this session did not run it, and
                      "Already built · 0 s" would read as a step that took no time at all. */}
                  <p className="num type-micro text-text-2">
                    {step.status === "cached"
                      ? STEP_STATUS_LABELS.cached
                      : `${STEP_STATUS_LABELS[step.status]} · ${formatSeconds(step.elapsedS)}`}
                  </p>
                </div>
                {step.detail ? <p className="type-micro text-text-3">{step.detail}</p> : null}
              </div>
            </div>
            <Progress value={progress} aria-label={`${label} progress`} className="mt-3" />
          </li>
        );
      })}
    </ol>
  );
}
