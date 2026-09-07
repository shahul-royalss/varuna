"use client";

import { ChevronDown, Pause, Play } from "lucide-react";
import { motion } from "motion/react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useReplayControls } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SPRING, useMotionPref } from "@/lib/motion";
import {
  LEAD_FINE,
  LEAD_MAX,
  LEAD_MIN,
  LEAD_TICK,
  REPLAY_SPEEDS,
  isReplaySpeed,
  selectLeadLabel,
  selectValidTimeLabel,
  useReplayStore,
} from "@/lib/stores/replay";
import { registerPlayToggle } from "@/lib/shortcuts";
import { useRunStore } from "@/lib/stores/run";

/** Stages of the five-minute cycle, in order (CLAUDE.md section 11.11). */
const CYCLE_STAGES = ["decode", "sky", "twin", "flash", "pulse", "products"] as const;

const LEAD_SPAN = LEAD_MAX - LEAD_MIN;
const TICKS = Array.from({ length: LEAD_SPAN / LEAD_TICK + 1 }, (_, i) => LEAD_MIN + i * LEAD_TICK);
const LABELLED_TICKS = new Set([-60, 0, 60, 120, 180]);

function leadToPercent(leadMin: number): number {
  return ((leadMin - LEAD_MIN) / LEAD_SPAN) * 100;
}

function speedLabel(speed: number): string {
  return `${speed}×`;
}

/**
 * The console time bar (CLAUDE.md sections 6.5 and 7.2): play, speed, the scrub from -60 to +180 min,
 * the valid time and lead, and the live-compute controls. It is the one glass element in the product.
 * Arrow keys, Shift and Space are handled globally by `useGlobalShortcuts`.
 */
export function TimeBar() {
  const playing = useReplayStore((s) => s.playing);
  const speed = useReplayStore((s) => s.speed);
  const leadMin = useReplayStore((s) => s.leadMin);
  const setLeadMin = useReplayStore((s) => s.setLeadMin);
  const validLabel = useReplayStore(selectValidTimeLabel);
  const leadLabel = useReplayStore(selectLeadLabel);
  const hasRun = useRunStore((s) => s.currentRun !== null);
  const controls = useReplayControls();
  const { reduced } = useMotionPref();

  // Space is a global shortcut; while the time bar is on screen it drives the API's clock.
  const toggle = controls.toggle;
  useEffect(() => registerPlayToggle(toggle), [toggle]);

  const handleTransition = reduced ? { duration: 0 } : SPRING;

  return (
    <div
      className="flex h-24 w-full items-center gap-6 border-t border-line bg-ink/72 px-4 backdrop-blur-[12px]"
      role="toolbar"
      aria-label="Replay time bar"
    >
      {/* Left: play and speed */}
      <div className="flex shrink-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={playing ? "secondary" : "default"}
                size="icon"
                aria-label={playing ? "Pause the replay" : "Play the replay"}
                aria-disabled={!hasRun}
                aria-pressed={playing}
                className={cn(!hasRun && "opacity-60")}
                onClick={() => controls.toggle()}
              />
            }
          >
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </TooltipTrigger>
          <TooltipContent>
            {hasRun
              ? playing
                ? "Pause (Space)"
                : "Play (Space)"
              : "Press Play once a bundle is baked"}
          </TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" aria-label={`Replay speed ${speedLabel(speed)}`} />
            }
          >
            <span className="num">{speedLabel(speed)}</span>
            <ChevronDown aria-hidden="true" data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={String(speed)}
              onValueChange={(value) => {
                const next = Number(value);
                if (isReplaySpeed(next)) controls.setSpeed(next);
              }}
            >
              {REPLAY_SPEEDS.map((s) => (
                <DropdownMenuRadioItem key={s} value={String(s)}>
                  <span className="num">{speedLabel(s)}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Centre: the scrub */}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
        <div className="relative h-8">
          {/* Observed half (-60..0) and forecast half (0..+180) */}
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-1/2 flex h-1.5 -translate-y-1/2 overflow-hidden rounded-full"
          >
            <div className="h-full bg-text-3/50" style={{ width: `${leadToPercent(0)}%` }} />
            <div className="h-full flex-1 bg-tide-soft" />
          </div>

          {/* 15-minute ticks */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {TICKS.map((tick) => (
              <span
                key={tick}
                className={cn(
                  "absolute top-1/2 w-px -translate-x-1/2 bg-line-strong",
                  LABELLED_TICKS.has(tick) ? "h-4 -translate-y-1/2" : "h-2 -translate-y-1/2",
                )}
                style={{ left: `${leadToPercent(tick)}%` }}
              />
            ))}
          </div>

          {/* Springing handle (M6); the slider thumb underneath carries the interaction. */}
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 z-10 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-tide bg-ink"
            initial={false}
            animate={{ left: `${leadToPercent(leadMin)}%` }}
            transition={handleTransition}
          />

          <Slider
            aria-label="Scrub the forecast, minutes from the cycle time"
            min={LEAD_MIN}
            max={LEAD_MAX}
            step={LEAD_FINE}
            value={leadMin}
            onValueChange={(value) => {
              const next = Array.isArray(value) ? value[0] : value;
              if (typeof next === "number") setLeadMin(next);
            }}
            className="absolute inset-x-0 top-1/2 z-20 -translate-y-1/2 [&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-thumb]]:border-tide [&_[data-slot=slider-thumb]]:bg-transparent [&_[data-slot=slider-track]]:bg-transparent"
          />
        </div>

        {/* Tick labels and the spread band placeholder */}
        <div className="relative h-6">
          <div aria-hidden="true" className="absolute inset-x-0 top-0">
            {[...LABELLED_TICKS].map((tick) => (
              <span
                key={tick}
                className="num absolute -translate-x-1/2 type-micro text-text-3"
                style={{ left: `${leadToPercent(tick)}%` }}
              >
                {tick > 0 ? `+${tick}` : tick}
              </span>
            ))}
          </div>
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2">
            <span aria-hidden="true" className="h-px flex-1 bg-line" />
            <span className="type-micro text-text-3">
              Ensemble spread appears with the first run
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-line" />
          </div>
        </div>
      </div>

      {/* Right: valid time, compute live, cycle budget */}
      <div className="flex shrink-0 flex-col items-end gap-2">
        <div className="flex items-center gap-3">
          <span className="num type-h3 text-text" aria-live="polite">
            {validLabel}
          </span>
          <span className="sr-only">Lead {leadLabel}</span>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button variant="outline" size="sm" disabled aria-disabled="true">
                Compute live
              </Button>
            </TooltipTrigger>
            <TooltipContent>Available once a bundle is loaded</TooltipContent>
          </Tooltip>
        </div>
        <CycleBudgetBarPlaceholder />
      </div>
    </div>
  );
}

/** Six empty stage segments; fills stage by stage once `cycle.stage` events arrive (M21). */
function CycleBudgetBarPlaceholder() {
  return (
    <div className="flex w-72 gap-1" role="group" aria-label="Cycle budget, no timings yet">
      {CYCLE_STAGES.map((stage) => (
        <div key={stage} className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="h-1.5 rounded-full border border-line bg-deep" />
          <span className="truncate type-micro text-text-3">{stage}</span>
        </div>
      ))}
    </div>
  );
}
