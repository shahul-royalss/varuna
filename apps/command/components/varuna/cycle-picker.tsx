"use client";

import { useEffect, useState } from "react";

import { apiUrl } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { formatIstTime } from "@/lib/stores/time";

export interface BakedCycle {
  runId: string;
  cycleTs: string;
  massBalanceErr: number | null;
}

export interface CyclePickerProps {
  /** The run currently on screen, so its chip reads as selected. */
  currentRunId?: string | null;
  onPick?: (runId: string) => void;
  className?: string;
}

/**
 * The baked cycles of the replay, as a row of clock times (CLAUDE.md 7.8, task P6.11).
 *
 * Without this the console shows whichever run is newest, and on a replay that is the calm
 * cycle after the storm has passed - a judge landing on the deployed console would see the city
 * draining rather than flooding. The bundle's cycles are all there; this makes them reachable
 * without knowing to type `?run=` into the address bar.
 *
 * The times are the cycle's own, in IST, because that is what the demo script and the
 * ground-truth pins are quoted in.
 */
export function CyclePicker({ currentRunId, onPick, className }: CyclePickerProps) {
  const [cycles, setCycles] = useState<BakedCycle[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl("/v1/runs"), { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((body: { runs?: { run_id: string; cycle_ts: string; mass_balance_err?: number }[] }) => {
        const runs = (body.runs ?? [])
          .map((r) => ({
            runId: r.run_id,
            cycleTs: r.cycle_ts,
            massBalanceErr: r.mass_balance_err ?? null,
          }))
          // Oldest first: the row then reads as the storm's timeline, left to right.
          .sort((a, b) => a.cycleTs.localeCompare(b.cycleTs));
        setCycles(runs);
      })
      .catch(() => setCycles([]));
    return () => controller.abort();
  }, []);

  if (cycles.length === 0) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-panel border border-line bg-[var(--ink)]/85 px-2 py-1.5 backdrop-blur-[12px]",
        className,
      )}
    >
      <span className="shrink-0 pr-1 type-micro text-text-3">Cycle</span>
      {cycles.map((cycle) => {
        const selected = cycle.runId === currentRunId;
        return (
          <button
            key={cycle.runId}
            type="button"
            aria-current={selected ? "true" : undefined}
            onClick={() => onPick?.(cycle.runId)}
            title={`Forecast from ${formatIstTime(cycle.cycleTs)} IST, 2 July 2019`}
            className={cn(
              "num rounded-chip border px-2 py-0.5 type-micro transition-colors",
              selected
                ? "border-tide bg-tide/15 text-tide"
                : "border-line bg-well text-text-2 hover:text-text",
            )}
          >
            {formatIstTime(cycle.cycleTs)}
          </button>
        );
      })}
    </div>
  );
}
