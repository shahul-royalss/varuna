"use client";

import { Pause, Play, SkipBack, SkipForward, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CycleLog, type CycleLogRow } from "@/components/varuna/cycle-log";
import { EmptyState } from "@/components/varuna/empty-state";
import { Panel } from "@/components/varuna/panel";
import { useReplayBundles, useReplayControls } from "@/lib/api";
import { bundleWindowLabel } from "@/lib/format";
import {
  REPLAY_SPEEDS,
  isReplaySpeed,
  useReplayStore,
  type ReplayMode,
} from "@/lib/stores/replay";
import { addMinutesIso, formatIstDate, formatIstTime } from "@/lib/stores/time";
import { useUiStore } from "@/lib/stores/ui";

const SEEK_STEP_MIN = 5;

/** Cycle rows arrive from the run registry in Phase 5; the empty console has none. */
const NO_CYCLES: CycleLogRow[] = [];

/**
 * Replay control (CLAUDE.md section 7.2): bundle card, clock, transport controls, baked/live mode,
 * the cycle log and the storm summary. Play, pause, seek and speed drive the API's clock, and the
 * store follows the `replay.clock` events it publishes, so every panel shows the same instant.
 */
export function ReplayPanel() {
  const bundleId = useReplayStore((s) => s.bundleId);
  const simTime = useReplayStore((s) => s.simTime);
  const playing = useReplayStore((s) => s.playing);
  const speed = useReplayStore((s) => s.speed);
  const mode = useReplayStore((s) => s.mode);
  const note = useReplayStore((s) => s.note);
  const t0 = useReplayStore((s) => s.t0);
  const t1 = useReplayStore((s) => s.t1);
  const setReplayPanelOpen = useUiStore((s) => s.setReplayPanelOpen);

  const controls = useReplayControls();
  const bundles = useReplayBundles();
  const bundle = bundles.data?.find((row) => row.id === bundleId);

  return (
    <Panel
      title="Replay"
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close the replay panel"
          onClick={() => setReplayPanelOpen(false)}
        >
          <X aria-hidden="true" />
        </Button>
      }
    >
      <div className="space-y-4">
        {/* Bundle card */}
        <section
          className="rounded-[var(--radius-control)] border border-line bg-well p-3"
          aria-label="Selected bundle"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="num type-small font-medium text-text">{bundleId}</span>
            <span className="inline-flex h-6 items-center rounded-full border border-line bg-deep px-2.5 type-micro text-text-2">
              {bundle?.label ?? "Reconstructed replay"}
            </span>
          </div>
          <p className="mt-1 type-small text-text-2">
            {bundleWindowLabel(bundle?.t0 ?? t0, bundle?.t1 ?? t1)}
          </p>
          {controls.apiReady ? null : (
            <p className="mt-2 type-micro text-text-2">
              {controls.error
                ? controls.error.message
                : "The clock is local until the API answers. Start it with make dev."}
            </p>
          )}
        </section>

        {/* Clock and transport */}
        <section aria-label="Replay clock" className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span className="num type-h2 font-display text-text">{formatIstTime(simTime)}</span>
            <span className="num type-small text-text-2">{formatIstDate(simTime)} IST</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Seek back 5 minutes"
              onClick={() => controls.seek(addMinutesIso(simTime, -SEEK_STEP_MIN))}
            >
              <SkipBack aria-hidden="true" />
            </Button>
            <Button
              variant={playing ? "secondary" : "default"}
              size="icon-sm"
              aria-label={playing ? "Pause the replay" : "Play the replay"}
              aria-pressed={playing}
              onClick={() => controls.toggle()}
            >
              {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Seek forward 5 minutes"
              onClick={() => controls.seek(addMinutesIso(simTime, SEEK_STEP_MIN))}
            >
              <SkipForward aria-hidden="true" />
            </Button>
            <ToggleGroup
              aria-label="Replay speed"
              variant="outline"
              size="sm"
              spacing={0}
              value={[String(speed)]}
              onValueChange={(value) => {
                const next = Number((value as string[])[0]);
                if (isReplaySpeed(next)) controls.setSpeed(next);
              }}
              className="ml-auto"
            >
              {REPLAY_SPEEDS.map((s) => (
                <ToggleGroupItem key={s} value={String(s)} aria-label={`${s} times speed`}>
                  <span className="num">{s}×</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          {note ? (
            <p role="status" className="type-micro text-text-2">
              {note}
            </p>
          ) : null}
        </section>

        {/* Baked or live */}
        <section aria-label="Run mode" className="flex items-center justify-between gap-2">
          <span className="type-small text-text-2">Runs</span>
          <ToggleGroup
            aria-label="Baked or live runs"
            variant="outline"
            size="sm"
            spacing={0}
            value={[mode]}
            onValueChange={(value) => {
              const next = (value as string[])[0];
              if (next === "baked" || next === "live") controls.setMode(next as ReplayMode);
            }}
          >
            <ToggleGroupItem value="baked">Baked</ToggleGroupItem>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <ToggleGroupItem value="live" disabled aria-disabled="true">
                  Live
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>Live compute lands in Phase 5</TooltipContent>
            </Tooltip>
          </ToggleGroup>
        </section>

        {/* Cycle log */}
        <section aria-label="Cycle log" className="space-y-2">
          <h3 className="type-small font-medium text-text">Cycle log</h3>
          <CycleLog rows={NO_CYCLES} />
        </section>

        {/* Storm summary */}
        <section aria-label="Storm summary" className="space-y-2">
          <h3 className="type-small font-medium text-text">Storm summary</h3>
          {bundle ? (
            <ul className="space-y-1">
              {bundle.synthetic_notes.slice(0, 3).map((line) => (
                <li key={line} className="type-micro text-text-2">
                  {line}
                </li>
              ))}
              <li className="num type-micro text-text-3">
                Seed {bundle.seed}. {bundle.baked_cycles} of {bundle.total_cycles} cycles baked.
              </li>
            </ul>
          ) : (
            <EmptyState
              title="No storm cells yet"
              description="Storm cells appear when the bundle is generated."
            />
          )}
        </section>
      </div>
    </Panel>
  );
}
