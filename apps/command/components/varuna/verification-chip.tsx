import { BadgeCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatScore } from "@/lib/format";

export interface VerificationChipProps {
  /** Critical success index for the current event, 0-1; null or undefined when not scored. */
  csi?: number | null;
  /** Replaces "this event", e.g. "2 Jul 2019". */
  eventLabel?: string;
  className?: string;
}

/** "CSI 0.71 on this event" in the top bar; "Not scored yet" before verification runs. */
export function VerificationChip({ csi, eventLabel, className }: VerificationChipProps) {
  const scored = typeof csi === "number" && Number.isFinite(csi);
  return (
    <span
      data-slot="verification-chip"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-chip border border-line px-2.5 text-small",
        scored ? "bg-tide-soft/60 text-text" : "bg-well/40 text-text-3",
        className,
      )}
    >
      <BadgeCheck
        aria-hidden="true"
        className={cn("size-4 shrink-0", scored ? "text-tide" : "text-text-3")}
        strokeWidth={1.75}
      />
      {scored ? (
        <span>
          CSI <span className="num font-medium">{formatScore(csi)}</span> on {eventLabel ?? "this event"}
        </span>
      ) : (
        <span>Not scored yet</span>
      )}
    </span>
  );
}
