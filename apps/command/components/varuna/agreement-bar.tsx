"use client";

import { motion } from "motion/react";

import { EmptyState } from "@/components/varuna/empty-state";
import { formatCm } from "@/lib/format";
import { useMotionPref } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Result of a physics check: the emulator against the Twin on the same scenario. */
export interface AgreementResult {
  /** Largest absolute depth difference at any hotspot, in cm. */
  maxDiffCm: number;
  /** Where the largest difference sits, e.g. "Sion Circle". */
  atHotspot?: string;
  /** Twin run time in milliseconds, if known. */
  physicsMs?: number;
}

export interface AgreementBarProps {
  /** Null until a physics check has run. */
  result: AgreementResult | null;
  /** Difference the demo treats as agreement (CLAUDE.md section 7.7); the bar is full at 2x this. */
  toleranceCm?: number;
  className?: string;
}

export const DEFAULT_AGREEMENT_TOLERANCE_CM = 5;

/**
 * "Emulator vs physics: max difference" as a labelled bar. The bar fills against twice the stated
 * tolerance so a difference inside tolerance sits in the left half; beyond it the fill turns to the
 * degraded colour. The disagreement is always printed, never hidden.
 */
export function AgreementBar({
  result,
  toleranceCm = DEFAULT_AGREEMENT_TOLERANCE_CM,
  className,
}: AgreementBarProps) {
  const { preset } = useMotionPref();

  if (!result) {
    return (
      <EmptyState
        title="Physics check not run"
        description="Run a what-if, then press Physics check to compare the emulator with the Twin."
        className={className}
      />
    );
  }

  const scale = toleranceCm * 2;
  const fraction = Math.min(1, Math.max(0, result.maxDiffCm / scale));
  const withinTolerance = result.maxDiffCm <= toleranceCm;
  const where = result.atHotspot ? ` at ${result.atHotspot}` : "";

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="type-small text-text">
          Emulator vs physics: max difference{" "}
          <span className="num font-medium">{formatCm(result.maxDiffCm)}</span>
          {where}
        </p>
        <span
          className={cn(
            "type-micro",
            withinTolerance ? "text-tide" : "text-text-2",
          )}
        >
          {withinTolerance ? "Within tolerance" : "Outside tolerance"}
        </span>
      </div>
      <div
        role="meter"
        aria-label="Maximum difference between emulator and physics"
        aria-valuemin={0}
        aria-valuemax={scale}
        aria-valuenow={Math.min(scale, result.maxDiffCm)}
        aria-valuetext={`${formatCm(result.maxDiffCm)}, tolerance ${formatCm(toleranceCm)}`}
        className="relative h-2 w-full overflow-hidden rounded-chip bg-well"
      >
        <motion.div
          className={cn("h-full rounded-chip", withinTolerance ? "bg-tide" : "")}
          style={withinTolerance ? undefined : { background: "var(--status-degraded)" }}
          initial={false}
          animate={{ width: `${fraction * 100}%` }}
          transition={preset("M21").transition}
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-1/2 w-px bg-line-strong"
        />
      </div>
      <p className="num type-micro text-text-3">
        Tolerance {formatCm(toleranceCm)} at the tick; the bar ends at {formatCm(scale)}.
      </p>
    </div>
  );
}
