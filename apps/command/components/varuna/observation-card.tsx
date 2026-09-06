"use client";

import { DepthChip } from "@/components/varuna/depth-chip";
import { formatBeta, formatIst } from "@/lib/format";
import { cssVar } from "@/lib/ramps";
import { cn } from "@/lib/utils";

/** Observation types Pulse assimilates in the prototype (CLAUDE.md section 11.6). */
export type ObservationKindP0 = "traffic" | "report" | "sensor";

const KIND_LABELS: Record<ObservationKindP0, string> = {
  traffic: "Traffic anomaly",
  report: "Citizen report",
  sensor: "Sensor",
};

const KIND_VARS: Record<ObservationKindP0, string> = {
  traffic: "--obs-traffic",
  report: "--obs-report",
  sensor: "--obs-sensor",
};

/** One row of the assimilation timeline: what was seen, where, and what it moved. */
export interface Observation {
  id: string;
  kind: ObservationKindP0;
  /** ISO 8601 with +05:30. */
  ts: string;
  /** Where it was seen, e.g. "Hindmata junction". */
  place: string;
  /** Depth the observation implies, in cm; null when the source gives no depth. */
  inferredDepthCm?: number | null;
  /** Pipe the update landed on, e.g. "E-01842". */
  pipeId?: string;
  /** Posterior blockage before this observation. */
  betaBefore?: number;
  /** Posterior blockage after it. */
  betaAfter?: number;
}

/** "0.31 → 0.48" for the blockage an observation moved. */
export function formatBetaChange(before: number, after: number): string {
  return `${formatBeta(before)} → ${formatBeta(after)}`;
}

export interface ObservationCardProps {
  obs: Observation;
  className?: string;
}

/**
 * One assimilated observation, coloured by type from the Pulse observation ramp. The type chip
 * always prints its name, so the colour is a second cue rather than the only one.
 */
export function ObservationCard({ obs, className }: ObservationCardProps) {
  const hasChange = typeof obs.betaBefore === "number" && typeof obs.betaAfter === "number";

  return (
    <article
      className={cn("rounded-panel border border-line bg-well p-3", className)}
      aria-label={`${KIND_LABELS[obs.kind]} at ${obs.place}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 rounded-chip border border-line px-2 py-0.5 type-micro text-text-2">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: cssVar(KIND_VARS[obs.kind]) }}
          />
          {KIND_LABELS[obs.kind]}
        </span>
        <time dateTime={obs.ts} className="num type-micro text-text-3">
          {formatIst(obs.ts)}
        </time>
      </header>

      <p className="mt-2 type-small font-medium text-text">{obs.place}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <DepthChip cm={obs.inferredDepthCm ?? null} size="sm" />
        <span className="type-micro text-text-3">inferred depth</span>
      </div>

      <p className="mt-2 type-micro text-text-2">
        {hasChange ? (
          <>
            Blockage{obs.pipeId ? ` on ${obs.pipeId}` : ""}{" "}
            <span className="num text-text">
              {formatBetaChange(obs.betaBefore as number, obs.betaAfter as number)}
            </span>
          </>
        ) : (
          <span className="text-text-3">No blockage change recorded for this observation yet.</span>
        )}
      </p>
    </article>
  );
}
