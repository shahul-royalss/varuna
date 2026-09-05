"use client";

import { cn } from "@/lib/utils";
import { formatSpeed } from "@/lib/format";
import { selectSimDateLabel, selectSimTimeLabel, useReplayStore } from "@/lib/stores/replay";
import { useRunStore, type SystemMode } from "@/lib/stores/run";

export interface ModeBannerProps {
  /** Overrides the mode derived from the run store (used by /design and tests). */
  mode?: SystemMode;
  /** Overrides the banner text; the colour still follows the mode. */
  label?: string;
  className?: string;
}

/** Status colours per mode (CLAUDE.md section 6.2, `--status-*`). */
const STYLES: Record<SystemMode, { dot: string; text: string; surface: string }> = {
  none: { dot: "bg-text-3", text: "text-text-2", surface: "border-line bg-well/60" },
  replay: {
    dot: "bg-status-replay",
    text: "text-status-replay",
    surface: "border-status-replay/30 bg-status-replay/10",
  },
  live: {
    dot: "bg-status-live",
    text: "text-status-live",
    surface: "border-status-live/30 bg-status-live/10",
  },
  degraded: {
    dot: "bg-status-degraded",
    text: "text-status-degraded",
    surface: "border-status-degraded/30 bg-status-degraded/10",
  },
};

/** "radar" -> "radar offline"; ["radar", "traffic"] -> "radar and traffic offline". */
export function degradedLabel(feeds: readonly string[] | undefined): string {
  const list = feeds && feeds.length > 0 ? feeds : ["radar"];
  const joined =
    list.length === 1
      ? list[0]
      : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return `Degraded: ${joined} offline, using gauges and satellite`;
}

/**
 * The mode banner in the top bar (CLAUDE.md section 7.2, motion M20). Colour cross-fades in
 * 300 ms; the degraded state pulses once. Under reduced motion only the colour changes.
 */
export function ModeBanner({ mode: modeProp, label: labelProp, className }: ModeBannerProps) {
  const storeMode = useRunStore((s) => s.mode);
  const status = useRunStore((s) => s.status);
  const currentRun = useRunStore((s) => s.currentRun);
  const speed = useReplayStore((s) => s.speed);
  const dateLabel = useReplayStore(selectSimDateLabel);
  const timeLabel = useReplayStore(selectSimTimeLabel);

  const mode: SystemMode = modeProp ?? storeMode;

  let label = labelProp;
  if (label === undefined) {
    if (mode === "none") {
      label = status === "loading" ? "Loading run" : "No runs yet";
    } else if (mode === "live") {
      label = "Live";
    } else if (mode === "degraded") {
      label = degradedLabel(currentRun?.degraded_feeds);
    } else {
      label = `Replay ${formatSpeed(speed)} · ${dateLabel} · ${timeLabel}`;
    }
  }

  const baked = modeProp === undefined && currentRun?.replay_mode === "baked";
  const style = STYLES[mode];

  return (
    <div
      role="status"
      aria-live="polite"
      data-mode={mode}
      className={cn("inline-flex min-w-0 items-center gap-2", className)}
    >
      <span
        // The key restarts the one-shot pulse each time the banner enters the degraded state.
        key={mode === "degraded" ? "degraded" : "steady"}
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-2 rounded-chip border px-3 text-small font-medium",
          "transition-[background-color,color,border-color] duration-300 ease-ui",
          style.surface,
          style.text,
          mode === "degraded" && "banner-pulse-once motion-reduce:animate-none",
        )}
      >
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-chip", style.dot)} />
        <span className="num truncate">{label}</span>
      </span>
      {baked ? (
        <span className="inline-flex h-7 items-center rounded-chip border border-status-baked/40 bg-status-baked/10 px-2.5 text-small font-medium text-status-baked">
          baked
        </span>
      ) : null}
    </div>
  );
}
